#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInterface.h"
#include "PrimitiveSceneProxy.h"
#include "Rendering/NaniteWebMaterial.h"
#include "Rendering/NaniteWebGBuffer.h"
#include "Rendering/NaniteStreamingManager.h"
#include "RenderingThread.h"
#include "StaticMeshResources.h"
#include "SceneView.h"
#include "HAL/IConsoleManager.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

namespace
{
UStaticMesh* Mesh;
UStaticMeshComponent* Component;
UMaterialInterface* Materials[2]{};
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FDelegateHandle Observer;
int Step = 0, Settled = 0;
bool Requested = false;
TSharedPtr<FJsonObject> Report;
struct FCopy { FString Name; uint32 Bytes; TUniquePtr<FRHIGPUBufferReadback> Readback; };
TArray<FCopy> Copies;
const TCHAR* CVarNames[] = {TEXT("r.Nanite.WebResidentSceneDepth"), TEXT("r.Nanite.WebResidentGBuffer"),
    TEXT("r.Nanite.WebMaterialGraphs"), TEXT("r.Nanite.WebHZB"), TEXT("r.Nanite.MaxPixelsPerEdge"),
    TEXT("r.AntiAliasingMethod"), TEXT("r.Nanite.WebMicroRasterSpan")};
float SavedCVars[UE_ARRAY_COUNT(CVarNames)];
void Copy(FRDGBuilder& Graph, FRDGBufferRef Buffer, const TCHAR* Name)
{
    check(Buffer); auto& C = Copies.AddDefaulted_GetRef(); C.Name = Name; C.Bytes = Buffer->Desc.GetSize();
    C.Readback = MakeUnique<FRHIGPUBufferReadback>(Name); AddEnqueueCopyPass(Graph, C.Readback.Get(), Buffer, C.Bytes);
}
void Observe(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebGBufferTargets& Targets)
{
    if (!Requested || Report || !Saved.Cull || Saved.Cull->Entries.Num() != 1) return;
    if (++Settled < 12) return;
    const auto& Entry = Saved.Cull->Entries[0];
    Requested = false; Report = MakeShared<FJsonObject>(); const auto Rect = Saved.Raster.Rect;
    Report->SetNumberField(TEXT("step"), Step);
    Report->SetNumberField(TEXT("frame"), Saved.Cull->View->Family->FrameNumber);
    Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(uint32(Rect.Width()), 8u));
    Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(uint32(Rect.Height()), 8u));
    Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected);
    Report->SetNumberField(TEXT("microSpan"), IConsoleManager::Get().FindConsoleVariable(CVarNames[6])->GetInt());
    Report->SetNumberField(TEXT("clusterBase"), Saved.Raster.ClusterBases[0]);
    Report->SetNumberField(TEXT("clusterCount"), Entry.Input.MaxVisibleClusters);
    Report->SetNumberField(TEXT("instance"), Entry.InstanceSceneDataOffset);
    Report->SetBoolField(TEXT("reverseComponent"), Entry.Proxy->IsCullingReversedByComponent());
    Report->SetBoolField(TEXT("reverseView"), Saved.Cull->View->bReverseCulling);
    TArray<TSharedPtr<FJsonValue>> Values;
    for (int I = 0; I < 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(I < 2 ? Rect.Min[I] : Rect.Max[I - 2]));
    Report->SetArrayField(TEXT("rect"), Values); Values.Reset();
    for (int R = 0; R < 4; ++R) for (int C = 0; C < 4; ++C) Values.Add(MakeShared<FJsonValueNumber>(Entry.LocalToWorld.M[R][C]));
    Report->SetArrayField(TEXT("localToWorld"), Values); Values.Reset();
    const auto Matrix = FMatrix44f(Entry.LocalToWorld * Saved.Cull->View->ViewMatrices.GetWorldToClip());
    for (int R = 0; R < 4; ++R) for (int C = 0; C < 4; ++C) Values.Add(MakeShared<FJsonValueNumber>(Matrix.M[R][C]));
    Report->SetArrayField(TEXT("localToClip"), Values);
    Copy(Graph, Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Targets, 8), TEXT("pixels"));
    Copy(Graph, Nanite::AddWebMaterialInputResolvePasses(Graph, *Saved.Cull, Saved.Raster, 8), TEXT("inputs"));
    Copy(Graph, Entry.Result.State, TEXT("cullState"));
}
void Poll()
{
    if (!Report) return;
    for (const auto& C : Copies) if (!C.Readback->IsReady()) return;
    for (auto& C : Copies)
    {
        const auto* Data = static_cast<const uint32*>(C.Readback->Lock(C.Bytes)); check(Data);
        TArray<TSharedPtr<FJsonValue>> Values;
        for (uint32 I = 0; I < C.Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
        C.Readback->Unlock(); Report->SetArrayField(C.Name, Values);
    }
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteSidednessTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteSidednessTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep < 0 || RequestedStep > 23 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebSidedness)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Mesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Game/WebNaniteSidedness/NaniteMixedSidedPlane.NaniteMixedSidedPlane"));
        if (!Mesh || !Mesh->GetRenderData()) return 0;
        Mesh->AddToRoot();
        for (auto& LOD : Mesh->GetRenderData()->LODResources) for (auto& Section : LOD.Sections) Section.NumTriangles = 0;
        Materials[0] = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/WebNaniteSidedness/NaniteOneSided.NaniteOneSided"));
        Materials[1] = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/WebNaniteSidedness/NaniteTwoSided.NaniteTwoSided"));
        if (!Materials[0] || !Materials[1]) return 0;
        for (auto* M : Materials) M->AddToRoot();
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); check(Camera.IsValid());
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        Component = NewObject<UStaticMeshComponent>(); Component->AddToRoot();
        Component->SetCollisionEnabled(ECollisionEnabled::NoCollision); Component->SetMobility(EComponentMobility::Movable);
        Component->SetStaticMesh(Mesh); Component->SetWorldLocation(FVector(100400, 0, 100000));
        for (int I = 0; I < 2; ++I) Component->SetMaterial(I, Materials[I]);
        Component->RegisterComponentWithWorld(World);
        const float Values[] = {1, 0, 1, 0, .001f, 0, 0};
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I)
        { auto* C = IConsoleManager::Get().FindConsoleVariable(CVarNames[I]); check(C); SavedCVars[I] = C->GetFloat(); C->Set(Values[I], ECVF_SetByCode); }
        ENQUEUE_RENDER_COMMAND(ObserveWebSidedness)([](FRHICommandListImmediate&) {
            Observer = Nanite::GetWebNativeMaterialGBufferDelegate().AddStatic(&Observe);
        });
    }
    if (RequestedStep == 23)
    {
        Component->RemoveFromRoot(); Component->DestroyComponent(); Mesh->RemoveFromRoot();
        for (auto* M : Materials) M->RemoveFromRoot();
        if (Controller.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); if (Camera.IsValid()) Camera->Destroy();
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I) IConsoleManager::Get().FindConsoleVariable(CVarNames[I])->Set(SavedCVars[I], ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveWebSidedness)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Copies.IsEmpty()); Nanite::GetWebNativeMaterialGBufferDelegate().Remove(Observer);
        }); Last = RequestedStep; return 1;
    }
    IConsoleManager::Get().FindConsoleVariable(CVarNames[6])->Set(RequestedStep % 2 ? 0 : 8, ECVF_SetByCode);
    const int Case = (RequestedStep - 1) / 2;
    Component->SetReverseCulling(Case == 5 || Case == 6);
    Component->SetWorldScale3D(Case == 2 || Case == 3 ? FVector(1, -1, 1) : Case == 4 ? FVector(.75, 1.4, .6) : FVector::OneVector);
    const bool Back = Case == 1 || Case == 3 || Case == 6 || Case == 8 || Case == 9 || Case == 10;
    Component->SetWorldRotation(Case == 4 ? FRotator(15, 10, 5) : FRotator(0, Back ? 180 : 0, 0));
    Camera->GetCameraComponent()->SetProjectionMode(Case == 7 || Case == 8 ? ECameraProjectionMode::Orthographic : ECameraProjectionMode::Perspective);
    Camera->GetCameraComponent()->SetOrthoWidth(800);
    Camera->GetCameraComponent()->bAutoCalculateOrthoPlanes = false;
    Camera->GetCameraComponent()->SetOrthoNearClipPlane(1);
    Camera->GetCameraComponent()->SetOrthoFarClipPlane(2000);
    Component->SetMaterial(0, Materials[Case == 10 ? 1 : 0]);
    Component->SetMaterial(1, Materials[Case == 9 ? 0 : 1]);
    ENQUEUE_RENDER_COMMAND(RequestWebSidedness)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && Copies.IsEmpty()); Step = RequestedStep; Settled = 0; Requested = true;
    }); Last = RequestedStep; return 1;
}
