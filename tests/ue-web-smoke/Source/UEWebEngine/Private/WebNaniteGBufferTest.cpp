#include "CoreMinimal.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/PlayerController.h"
#include "Rendering/NaniteWebGBuffer.h"
#include "Rendering/NaniteStreamingManager.h"
#include "RenderingThread.h"
#include "SceneView.h"
#include "HAL/IConsoleManager.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

UStaticMesh* CreateWebNaniteDepthFixture();
UStaticMesh* CreateWebNaniteOrdinaryFixture();
namespace
{
UStaticMesh* NaniteMesh;
UStaticMesh* OrdinaryMesh;
UStaticMeshComponent* Components[2];
UStaticMeshComponent* Ordinary;
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FPrimitiveComponentId IDs[2];
FDelegateHandle CullObserver, GBufferObserver;
int SavedDepth = 0, SavedGBuffer = 0, Step = 0, Settled = 0;
bool Requested = false, Capturing = false;
TSharedPtr<FJsonObject> Report;
struct FCopy { FString Field; uint32 Bytes; TUniquePtr<FRHIGPUBufferReadback> Readback; TSharedPtr<FJsonObject> Json; };
TArray<FCopy> Copies;
const uint32 Stride = 8;

TArray<TSharedPtr<FJsonValue>> MatrixJSON(const FMatrix& Matrix)
{
    TArray<TSharedPtr<FJsonValue>> Values;
    for (int32 R = 0; R < 4; ++R) for (int32 C = 0; C < 4; ++C) Values.Add(MakeShared<FJsonValueNumber>(Matrix.M[R][C]));
    return Values;
}
TArray<TSharedPtr<FJsonValue>> VectorJSON(const FVector3f& V)
{ return {MakeShared<FJsonValueNumber>(V.X), MakeShared<FJsonValueNumber>(V.Y), MakeShared<FJsonValueNumber>(V.Z)}; }
Nanite::FWebConstantMaterial Material(int Index)
{
    Nanite::FWebConstantMaterial M;
    M.BaseColor = Index ? FVector3f(0.08f, 0.25f, 0.7f) : Step == 1 ? FVector3f(0.7f, 0.12f, 0.04f) : FVector3f(0.1f, 0.65f, 0.2f);
    M.Emissive = Index ? FVector3f(0.005f, 0.015f, 0.03f) : FVector3f(0.03f, 0.01f, 0.005f);
    M.Metallic = Index ? 0.7f : 0.2f; M.Specular = Index ? 0.25f : 0.6f; M.Roughness = Index ? 0.8f : 0.35f;
    if (Step == 6 && !Index) { M.BaseColor = FVector3f(0.4f, 0.08f, 0.65f); M.Emissive = FVector3f(0.12f, 0.03f, 0.2f); M.Roughness = 0.65f; }
    return M;
}
void BindMaterials(FRDGBuilder&, const Nanite::FWebSceneCullView& View)
{
    if (Step < 1 || Step > 6) return;
    for (const auto& Entry : View.Entries)
    {
        const int Index = Entry.ComponentId == IDs[0] ? 0 : Entry.ComponentId == IDs[1] ? 1 : -1;
        if (Index < 0) continue;
        // Step 4 deliberately holds a stale resource binding; step 5 uses a
        // valid but absent material slot on the first object.
        check(Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID + (Step == 4 ? 1 : 0),
            Step == 5 && Index == 0 ? 1 : 0, Material(Index)));
    }
}
void CopyBuffer(FRDGBuilder& Graph, FRDGBufferRef Buffer, const TCHAR* Field, TSharedPtr<FJsonObject> Json)
{
    check(Buffer); auto& Copy = Copies.AddDefaulted_GetRef();
    Copy.Field = Field; Copy.Bytes = Buffer->Desc.GetSize(); Copy.Json = Json;
    Copy.Readback = MakeUnique<FRHIGPUBufferReadback>(Field);
    AddEnqueueCopyPass(Graph, Copy.Readback.Get(), Buffer, Copy.Bytes);
}
void Observe(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebGBufferTargets& Targets, bool After)
{
    if (Step < 1 || Step > 6) return;
    if (!After)
    {
        if (!Requested || ++Settled < 4) return;
        Requested = false; Capturing = true; Report = MakeShared<FJsonObject>();
        const auto Rect = Saved.Raster.Rect;
        Report->SetNumberField(TEXT("step"), Step);
        Report->SetNumberField(TEXT("frame"), Saved.Cull->View->Family->FrameNumber);
        Report->SetNumberField(TEXT("registered"), Saved.Cull->Registered); Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected);
        Report->SetNumberField(TEXT("materialStride"), Stride);
        Report->SetNumberField(TEXT("materialWidth"), FMath::DivideAndRoundUp(uint32(Rect.Width()), Stride));
        Report->SetNumberField(TEXT("materialHeight"), FMath::DivideAndRoundUp(uint32(Rect.Height()), Stride));
        Report->SetArrayField(TEXT("rect"), {MakeShared<FJsonValueNumber>(Rect.Min.X), MakeShared<FJsonValueNumber>(Rect.Min.Y), MakeShared<FJsonValueNumber>(Rect.Max.X), MakeShared<FJsonValueNumber>(Rect.Max.Y)});
        Report->SetArrayField(TEXT("worldToClip"), MatrixJSON(Saved.Cull->View->ViewMatrices.GetWorldToClip()));
        Report->SetStringField(TEXT("colorFormat"), GPixelFormats[Targets.Color->Desc.Format].Name);
        Report->SetBoolField(TEXT("srgbBaseColor"), EnumHasAnyFlags(Targets.C->Desc.Flags, TexCreate_SRGB));
        CopyBuffer(Graph, Saved.Raster.VisibleClusters, TEXT("visibleRecords"), Report);
        CopyBuffer(Graph, Nanite::AddWebMaterialInputResolvePasses(Graph, *Saved.Cull, Saved.Raster, Stride), TEXT("materialInputs"), Report);
        TArray<TSharedPtr<FJsonValue>> Entries;
        for (int32 I = 0; I < Saved.Cull->Entries.Num(); ++I)
        {
            const auto& Entry = Saved.Cull->Entries[I]; const int Index = Entry.ComponentId == IDs[0] ? 0 : 1;
            auto Json = MakeShared<FJsonObject>(); const auto M = Material(Index);
            Json->SetNumberField(TEXT("component"), Index); Json->SetNumberField(TEXT("instanceId"), Entry.InstanceSceneDataOffset);
            Json->SetNumberField(TEXT("clusterBase"), Saved.Raster.ClusterBases[I]);
            Json->SetArrayField(TEXT("localToWorld"), MatrixJSON(Entry.LocalToWorld));
            Json->SetBoolField(TEXT("bindingCurrent"), Step != 4);
            Json->SetNumberField(TEXT("materialSlot"), Step == 5 && Index == 0 ? 1 : 0);
            Json->SetArrayField(TEXT("baseColor"), VectorJSON(M.BaseColor)); Json->SetArrayField(TEXT("emissive"), VectorJSON(M.Emissive));
            Json->SetNumberField(TEXT("metallic"), M.Metallic); Json->SetNumberField(TEXT("specular"), M.Specular); Json->SetNumberField(TEXT("roughness"), M.Roughness);
            CopyBuffer(Graph, Entry.Result.ClusterKeys, TEXT("keys"), Json); CopyBuffer(Graph, Entry.Result.State, TEXT("state"), Json);
            Entries.Add(MakeShared<FJsonValueObject>(Json));
        }
        Report->SetArrayField(TEXT("entries"), Entries);
        if (Step == 1)
        {
            const auto& Entry = Saved.Cull->Entries[0]; auto M = Material(0);
            check(!Nanite::SetWebConstantMaterial({}, Entry.RuntimeResourceID, 0, M));
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, MAX_uint32, 0, M));
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 64, M));
            M.Roughness = -1; check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            M = Material(0); M.BaseColor.X = 2; check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Targets, 0));
            auto Invalid = Targets; Invalid.A = nullptr;
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Invalid, Stride));
            Invalid = Targets; Invalid.C = Targets.B;
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Invalid, Stride));
            check(!Nanite::AddWebResidentGBufferPasses(Graph, *Saved.Cull->View, Invalid));
            auto InvalidSaved = Saved; InvalidSaved.Cull = nullptr;
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, InvalidSaved, Targets, Stride));
            InvalidSaved = Saved; InvalidSaved.Raster.SourceView = nullptr;
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, InvalidSaved, Targets, Stride));
            Report->SetNumberField(TEXT("inputRejections"), 11);
        }
    }
    if (!Capturing) return;
    CopyBuffer(Graph, Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Targets, Stride), After ? TEXT("after") : TEXT("before"), Report);
    if (After) Capturing = false;
}
void Poll()
{
    if (!Report || Capturing) return;
    for (const auto& Copy : Copies) if (!Copy.Readback->IsReady()) return;
    for (auto& Copy : Copies)
    {
        const auto* Data = static_cast<const uint32*>(Copy.Readback->Lock(Copy.Bytes)); check(Data);
        TArray<TSharedPtr<FJsonValue>> Values;
        for (uint32 I = 0; I < Copy.Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
        Copy.Readback->Unlock(); Copy.Json->SetArrayField(Copy.Field, Values);
    }
    Report->SetBoolField(TEXT("pending"), false);
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteGBufferTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteGBufferTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int LastStep = 0;
    if (RequestedStep < 0 || RequestedStep > 7 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebGBuffer)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != LastStep + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& Context : GEngine->GetWorldContexts()) if (Context.WorldType == EWorldType::Game) World = Context.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); if (!Camera.IsValid()) return 0;
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        NaniteMesh = CreateWebNaniteDepthFixture(); OrdinaryMesh = CreateWebNaniteOrdinaryFixture(); if (!NaniteMesh || !OrdinaryMesh) return 0;
        for (int I = 0; I < 2; ++I)
        {
            auto*& C = Components[I]; C = NewObject<UStaticMeshComponent>(); C->AddToRoot(); C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
            C->SetMobility(EComponentMobility::Movable); C->SetStaticMesh(NaniteMesh); C->SetWorldLocation(FVector(100500, I ? 130 : 0, 100000));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        Ordinary = NewObject<UStaticMeshComponent>(); Ordinary->AddToRoot(); Ordinary->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        Ordinary->SetMobility(EComponentMobility::Movable); Ordinary->SetStaticMesh(OrdinaryMesh);
        Ordinary->SetWorldLocation(FVector(100350, 0, 100000)); Ordinary->SetWorldScale3D(FVector(0.65)); Ordinary->RegisterComponentWithWorld(World);
        auto* Depth = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"));
        auto* GBuffer = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentGBuffer")); check(Depth && GBuffer);
        SavedDepth = Depth->GetInt(); SavedGBuffer = GBuffer->GetInt(); Depth->Set(1, ECVF_SetByCode); GBuffer->Set(1, ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(ObserveWebGBuffer)([](FRHICommandListImmediate&) {
            CullObserver = Nanite::GetWebSceneCullDelegate().AddStatic(&BindMaterials); GBufferObserver = Nanite::GetWebGBufferDelegate().AddStatic(&Observe);
        });
    }
    if (RequestedStep == 2) { Ordinary->SetWorldLocation(FVector(100700, 0, 100000)); Ordinary->SetWorldScale3D(FVector(1)); }
    if (RequestedStep == 3)
    {
        Ordinary->SetWorldLocation(FVector(100350, 35, 100000));
        Components[0]->SetWorldTransform(FTransform(FRotator(20, 30, 10), FVector(100500, 0, 100000), FVector(-1, 1.5, 0.6)));
    }
    if (RequestedStep == 4) Components[0]->SetHiddenInGame(true);
    if (RequestedStep == 5) { Components[0]->SetHiddenInGame(false); Ordinary->SetHiddenInGame(true); }
    if (RequestedStep == 6) Components[1]->SetHiddenInGame(true);
    if (RequestedStep == 7)
    {
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"))->Set(SavedDepth, ECVF_SetByCode);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentGBuffer"))->Set(SavedGBuffer, ECVF_SetByCode);
        for (auto* C : {Components[0], Components[1], Ordinary}) { C->UnregisterComponent(); C->RemoveFromRoot(); C->DestroyComponent(); }
        for (auto* Mesh : {NaniteMesh, OrdinaryMesh}) { Mesh->ReleaseResources(); Mesh->RemoveFromRoot(); }
        if (SavedTarget.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); Camera->Destroy(); Camera.Reset();
        ENQUEUE_RENDER_COMMAND(RemoveWebGBufferObserver)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Copies.IsEmpty()); Step = 7;
            Nanite::GetWebSceneCullDelegate().Remove(CullObserver); Nanite::GetWebGBufferDelegate().Remove(GBufferObserver);
            for (auto ID : IDs) Nanite::RemoveWebConstantMaterial(ID);
        });
        LastStep = RequestedStep; return 1;
    }
    LastStep = RequestedStep;
    ENQUEUE_RENDER_COMMAND(RequestWebGBuffer)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && Copies.IsEmpty()); Step = RequestedStep; Requested = true; Settled = 0;
        MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteGBufferTest = ({pending:true,step:$0});}, RequestedStep);
    });
    return 1;
}
