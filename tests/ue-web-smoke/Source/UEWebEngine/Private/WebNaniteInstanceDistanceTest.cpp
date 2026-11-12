#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "HAL/IConsoleManager.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialRenderProxy.h"
#include "PipelineStateCache.h"
#include "PrimitiveSceneInfo.h"
#include "Rendering/NaniteWebScene.h"
#include "Rendering/NaniteWebRaster.h"
#include "RenderingThread.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "SceneView.h"
#include "SceneInterface.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshSceneProxy.h"
#include <emscripten.h>

namespace
{
UInstancedStaticMeshComponent* Components[2] = {};
FPrimitiveComponentId IDs[2];
TWeakObjectPtr<APlayerController> Controller;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<ACameraActor> Camera;
FDelegateHandle Observer;
const FVector Origin(1000000, 0, 1000000);
const FIntPoint Extent(256, 192);
int Last = 0, Step = 0, Settled = 0, SavedCull = 1;
float SavedScale = 1;
bool Requested = false;
TSharedPtr<FJsonObject> Report, Inputs;
TUniquePtr<FRHIGPUBufferReadback> Pixels, States;
uint32 StateBytes = 0;

TArray<TSharedPtr<FJsonValue>> VectorJSON(const FVector& V)
{
    return {MakeShared<FJsonValueNumber>(V.X), MakeShared<FJsonValueNumber>(V.Y), MakeShared<FJsonValueNumber>(V.Z)};
}
TArray<TSharedPtr<FJsonValue>> MatrixJSON(const FMatrix& M)
{
    TArray<TSharedPtr<FJsonValue>> R;
    for (int I = 0; I < 4; ++I) for (int J = 0; J < 4; ++J) R.Add(MakeShared<FJsonValueNumber>(M.M[I][J]));
    return R;
}
void Observe(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& View)
{
    if (!Requested || View.View->bIsSceneCapture) return;
    if (PipelineStateCache::NumActivePrecacheRequests()) { Settled = 0; return; }
    if (++Settled < 30) return;
    Requested = false; Report = MakeShared<FJsonObject>();
    Report->SetNumberField(TEXT("step"), Step); Report->SetNumberField(TEXT("frame"), View.View->Family->FrameNumber);
    Report->SetNumberField(TEXT("rejected"), View.Rejected); Report->SetObjectField(TEXT("inputs"), Inputs);
    Report->SetArrayField(TEXT("camera"), VectorJSON(View.View->ViewMatrices.GetViewOrigin()));
    Report->SetArrayField(TEXT("worldToClip"), MatrixJSON(View.View->ViewMatrices.GetWorldToClip()));
    TArray<TSharedPtr<FJsonValue>> Entries, Batches;
    Nanite::FWebSceneCullView Selected; Selected.View = View.View; Selected.RasterViewRect = View.RasterViewRect;
    for (const auto& Entry : View.Entries)
    {
        const int Component = Entry.ComponentId == IDs[0] ? 0 : Entry.ComponentId == IDs[1] ? 1 : -1;
        if (Component < 0) continue;
        Selected.Entries.Add(Entry);
        auto Item = MakeShared<FJsonObject>(); Item->SetNumberField(TEXT("component"), Component);
        Item->SetNumberField(TEXT("instanceId"), Entry.InstanceSceneDataOffset);
        Item->SetArrayField(TEXT("localToWorld"), MatrixJSON(Entry.LocalToWorld));
        check(!Entry.Materials.IsEmpty() && Entry.Materials[0].Material);
        Item->SetStringField(TEXT("material"), Entry.Materials[0].Material->GetMaterialName());
        Entries.Add(MakeShared<FJsonValueObject>(Item));
    }
    for (int I = 0; I < 2; ++I)
    {
        const auto* Info = View.View->Family->Scene->GetPrimitiveSceneInfo(IDs[I]);
        if (!Info || !Info->Proxy) continue;
        FMeshBatch Batch;
        const bool Created = static_cast<const FStaticMeshSceneProxy*>(Info->Proxy)->GetMeshElement(0, 0, 0, SDPG_World, false, false, Batch);
        auto Item = MakeShared<FJsonObject>(); Item->SetNumberField(TEXT("component"), I);
        Item->SetBoolField(TEXT("created"), Created); Item->SetBoolField(TEXT("material"), Created && Batch.bUseForMaterial);
        Item->SetBoolField(TEXT("depth"), Created && Batch.bUseForDepthPass);
        Batches.Add(MakeShared<FJsonValueObject>(Item));
    }
    Report->SetArrayField(TEXT("entries"), Entries); Report->SetArrayField(TEXT("batches"), Batches);
    Nanite::FWebRasterVisibility Raster;
    check(Nanite::AddWebResidentRasterPasses(Graph, Selected, Extent, FIntRect(FIntPoint::ZeroValue, Extent), Raster));
    Pixels = MakeUnique<FRHIGPUBufferReadback>(TEXT("Nanite.InstanceDistance.Pixels"));
    AddEnqueueCopyPass(Graph, Pixels.Get(), Raster.Pixels, Extent.X * Extent.Y * 8);
    StateBytes = Selected.Entries.Num() * 16;
    if (StateBytes)
    {
        auto* Buffer = Graph.CreateBuffer(FRDGBufferDesc::CreateByteAddressDesc(StateBytes), TEXT("Nanite.InstanceDistance.States"));
        for (int I = 0; I < Selected.Entries.Num(); ++I) AddCopyBufferPass(Graph, Buffer, I * 16, Selected.Entries[I].Result.State, Selected.Entries[I].Result.StateOffset * 4, 16);
        States = MakeUnique<FRHIGPUBufferReadback>(TEXT("Nanite.InstanceDistance.States"));
        AddEnqueueCopyPass(Graph, States.Get(), Buffer, StateBytes);
    }
}
void Poll()
{
    if (!Report || !Pixels->IsReady() || (States && !States->IsReady())) return;
    const auto Read = [](FRHIGPUBufferReadback& Copy, uint32 Bytes)
    {
        const auto* Data = static_cast<const uint32*>(Copy.Lock(Bytes)); check(Data);
        TArray<TSharedPtr<FJsonValue>> Values;
        for (uint32 I = 0; I < Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
        Copy.Unlock(); return Values;
    };
    Report->SetArrayField(TEXT("pixels"), Read(*Pixels, Extent.X * Extent.Y * 8));
    if (States) Report->SetArrayField(TEXT("states"), Read(*States, StateBytes));
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteInstanceDistanceTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Pixels.Reset(); States.Reset(); Report.Reset();
}
void SetRange(int Min, int Start, int End)
{
    for (auto* C : Components)
    {
        if (C->InstanceMinDrawDistance != Min) { C->InstanceMinDrawDistance = Min; C->MarkRenderStateDirty(); }
        C->SetCullDistances(Start, End);
    }
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteInstanceDistanceTest(int Next)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (Next < 0 || Next > 18 || !GEngine || !Nanite::IsWebSceneRenderingEnabled()) return 0;
    if (!Next) { ENQUEUE_RENDER_COMMAND(PollNaniteInstanceDistance)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (Next != Last + 1) return 0;
    auto* Scale = IConsoleManager::Get().FindConsoleVariable(TEXT("r.ViewDistanceScale"));
    auto* Cull = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.Culling.DrawDistance")); check(Scale && Cull);
    if (Next == 1)
    {
        UWorld* World = nullptr; for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        SavedScale = Scale->GetFloat(); SavedCull = Cull->GetInt(); Scale->Set(1.0f, ECVF_SetByCode); Cull->Set(1, ECVF_SetByCode);
        Camera = World->SpawnActor<ACameraActor>(); check(Camera.IsValid()); Camera->SetActorLocationAndRotation(Origin, FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetConstraintAspectRatio(false); Controller->SetViewTarget(Camera.Get());
        auto* Mesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Game/DefaultTemplateSamples/SM_TestSphere.SM_TestSphere"));
        auto* Material = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/DefaultTemplateSamples/M_Default_0_3.M_Default_0_3")); check(Mesh && Material);
        const FVector Positions[2][6] = {
            {{300,-100,-80},{600,0,0},{600,120,0},{800,0,0},{1000,200,60},{1400,-300,80}},
            {{300,100,80},{480,360,0},{600,-120,0},{640,-480,0},{1000,-200,-60},{1400,300,-80}}};
        Components[0] = NewObject<UInstancedStaticMeshComponent>(); Components[1] = NewObject<UHierarchicalInstancedStaticMeshComponent>();
        for (int I = 0; I < 2; ++I)
        {
            auto* C = Components[I]; C->AddToRoot(); C->SetMobility(EComponentMobility::Movable); C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
            C->SetStaticMesh(Mesh); C->SetMaterial(0, Material); C->SetWorldLocation(Origin); C->SetCastShadow(false);
            C->InstanceMinDrawDistance = 400; C->SetCullDistances(800, 900);
            for (const FVector& P : Positions[I]) C->AddInstance(FTransform(FRotator::ZeroRotator, P, FVector(.4)));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        ENQUEUE_RENDER_COMMAND(ObserveNaniteInstanceDistance)([](FRHICommandListImmediate&) { Observer = Nanite::GetWebSceneCullDelegate().AddStatic(&Observe); });
    }
    if (Next == 2) SetRange(400, 0, 600);
    if (Next == 3) SetRange(400, 0, 599);
    if (Next == 4) SetRange(400, 0, 800);
    if (Next == 5) SetRange(800, 0, 800);
    if (Next == 6) SetRange(801, 0, 800);
    if (Next == 7) SetRange(801, 0, 0);
    if (Next == 8) { SetRange(400, 800, 900); Scale->Set(.5f, ECVF_SetByCode); }
    if (Next == 9) Scale->Set(2.0f, ECVF_SetByCode);
    if (Next == 10) Cull->Set(0, ECVF_SetByCode);
    if (Next == 11) { Cull->Set(1, ECVF_SetByCode); Scale->Set(1.0f, ECVF_SetByCode); }
    if (Next == 12) Camera->SetActorLocation(Origin + FVector(500, 0, 0));
    if (Next == 13) Components[1]->UnregisterComponent();
    if (Next == 14) Components[1]->RegisterComponentWithWorld(Controller->GetWorld());
    if (Next == 15)
    {
        Camera->SetActorLocation(Origin);
        check(Components[0]->UpdateInstanceTransform(4, FTransform(FRotator::ZeroRotator, FVector(500, 0, 200), FVector(.4)), false, true, true));
        check(Components[0]->UpdateInstanceTransform(1, FTransform(FRotator(0, 40, 20), FVector(600, 0, 0), FVector(-.4, .6, .3)), false, true, true));
    }
    if (Next == 16) check(Components[0]->RemoveInstance(1));
    if (Next == 17) Components[1]->ClearInstances();
    if (Next == 18)
    {
        for (auto*& C : Components) { C->UnregisterComponent(); C->RemoveFromRoot(); C->DestroyComponent(); C = nullptr; }
        Scale->Set(SavedScale, ECVF_SetByCode); Cull->Set(SavedCull, ECVF_SetByCode);
        if (SavedTarget.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); Camera->Destroy(); Camera.Reset();
        ENQUEUE_RENDER_COMMAND(RemoveNaniteInstanceDistance)([](FRHICommandListImmediate&) {
            check(!Requested && !Report); Nanite::GetWebSceneCullDelegate().Remove(Observer); Inputs.Reset();
        }); Last = Next; return 1;
    }
    CastChecked<UHierarchicalInstancedStaticMeshComponent>(Components[1])->BuildTreeIfOutdated(false, true);
    auto Snapshot = MakeShared<FJsonObject>(); Snapshot->SetNumberField(TEXT("scale"), Scale->GetFloat()); Snapshot->SetBoolField(TEXT("cull"), Cull->GetInt() != 0);
    TArray<TSharedPtr<FJsonValue>> Instances;
    for (int I = 0; I < 2; ++I) if (Components[I]->IsRegistered()) for (int J = 0; J < Components[I]->GetInstanceCount(); ++J)
    {
        auto* C = Components[I]; FTransform T; check(C->GetInstanceTransform(J, T, true));
        auto Item = MakeShared<FJsonObject>(); Item->SetNumberField(TEXT("component"), I); Item->SetNumberField(TEXT("index"), J);
        Item->SetNumberField(TEXT("min"), C->InstanceMinDrawDistance); Item->SetNumberField(TEXT("start"), C->InstanceStartCullDistance); Item->SetNumberField(TEXT("end"), C->InstanceEndCullDistance);
        Item->SetArrayField(TEXT("localToWorld"), MatrixJSON(T.ToMatrixWithScale()));
        Item->SetArrayField(TEXT("localCenter"), VectorJSON(C->GetStaticMesh()->GetBounds().Origin)); Instances.Add(MakeShared<FJsonValueObject>(Item));
    }
    Snapshot->SetArrayField(TEXT("instances"), Instances);
    ENQUEUE_RENDER_COMMAND(RequestNaniteInstanceDistance)([Next, Snapshot](FRHICommandListImmediate&) {
        check(!Requested && !Report); Step = Next; Settled = 0; Inputs = Snapshot; Requested = true;
    }); Last = Next; return 1;
}
