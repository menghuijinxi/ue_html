#include "CoreMinimal.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/PlayerController.h"
#include "Rendering/NaniteWebHZB.h"
#include "Rendering/NaniteWebDepth.h"
#include "Rendering/NaniteStreamingManager.h"
#include "RenderingThread.h"
#include "SceneView.h"
#include "HAL/IConsoleManager.h"
#include "PipelineStateCache.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "WebNaniteCullReadback.h"
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

UStaticMesh* CreateWebNaniteDepthFixture();
UStaticMesh* CreateWebNaniteOrdinaryFixture();
namespace
{
UStaticMesh* Mesh;
UStaticMesh* OccluderMesh;
UStaticMeshComponent* Component;
UStaticMeshComponent* Occluder;
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FDelegateHandle CullHandle, OcclusionHandle, DepthHandle;
int SavedHZB = 1, SavedDepth = 0, Step = 0, Settled = 0;
float SavedPixels = 1;
bool Requested = false, Capture = false;
uint32 CaptureFrame = MAX_uint32;
TSharedPtr<FJsonObject> Report;
struct FCopy { FString Name; uint32 Bytes; TUniquePtr<FRHIGPUBufferReadback> Readback; };
TArray<FCopy> Copies;
const FVector Origin(100000, 0, 100000);
void Copy(FRDGBuilder& Graph, FRDGBufferRef Buffer, const FString& Name)
{
    check(Buffer); auto& C = Copies.AddDefaulted_GetRef(); C.Name = Name; C.Bytes = Buffer->Desc.GetSize();
    C.Readback = MakeUnique<FRHIGPUBufferReadback>(*Name); AddEnqueueCopyPass(Graph, C.Readback.Get(), Buffer, C.Bytes);
}
void Cull(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& View)
{
    if (!Requested) return;
    if (PipelineStateCache::NumActivePrecacheRequests()) { Settled = 0; return; }
    const int Warmup = Step == 1 ? 12 : (Step == 3 || Step == 8) ? 4 : 1;
    if (++Settled < Warmup) return;
    Requested = false; Capture = !View.Entries.IsEmpty(); CaptureFrame = View.View->Family->FrameNumber;
    Report = MakeShared<FJsonObject>(); Report->SetNumberField(TEXT("step"), Step);
    Report->SetNumberField(TEXT("frame"), CaptureFrame); Report->SetNumberField(TEXT("entries"), View.Entries.Num());
    Report->SetNumberField(TEXT("viewKey"), View.View->GetViewKey());
    Report->SetNumberField(TEXT("pendingPSOs"), PipelineStateCache::NumActivePrecacheRequests());
    Report->SetBoolField(TEXT("cameraCut"), View.View->bCameraCut);
    check(View.Entries.Num() <= 1);
    if (!View.Entries.IsEmpty())
    {
        const auto& E = View.Entries[0];
        Copy(Graph, WebNaniteCullReadbackRange(Graph, E.Result.State, E.Result.StateOffset, 4), TEXT("candidateState"));
        Copy(Graph, WebNaniteCullReadbackRange(Graph, E.Result.ClusterKeys, E.Result.ClusterOffset, E.Input.MaxVisibleClusters), TEXT("candidateKeys"));
    }
}
void Occlusion(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& Candidates,
    const Nanite::FWebSceneCullView& Output, bool Final)
{
    if (!Capture || Candidates.View->Family->FrameNumber != CaptureFrame) return;
    check(Output.Entries.Num() == 1);
    const auto& E = Output.Entries[0];
    Copy(Graph, WebNaniteCullReadbackRange(Graph, E.Result.State, E.Result.StateOffset, 4), Final ? TEXT("finalState") : TEXT("mainState"));
    Copy(Graph, WebNaniteCullReadbackRange(Graph, E.Result.ClusterKeys, E.Result.ClusterOffset, E.Input.MaxVisibleClusters), Final ? TEXT("finalKeys") : TEXT("mainKeys"));
}
void Depth(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& View, FIntRect Rect,
    FRDGTextureRef Visibility, FRDGTextureRef DepthTexture, bool After)
{
    if (!Capture || !After || View.View->Family->FrameNumber != CaptureFrame) return;
    Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(Rect.Width(), 4));
    Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(Rect.Height(), 4));
    Copy(Graph, Nanite::AddWebDepthSnapshotPass(Graph, Visibility, DepthTexture, Rect, 4), TEXT("pixels"));
    if (Step == 1)
    {
        const auto Matrix = View.View->ViewMatrices.GetWorldToClip();
        check(!Nanite::AddWebHZBBuildPasses(Graph, nullptr, Rect, Matrix).Texture);
        auto BadRect = Rect; BadRect.Min.X = -1;
        check(!Nanite::AddWebHZBBuildPasses(Graph, DepthTexture, BadRect, Matrix).Texture);
        BadRect = Rect; BadRect.Max.X = DepthTexture->Desc.Extent.X + 1;
        check(!Nanite::AddWebHZBBuildPasses(Graph, DepthTexture, BadRect, Matrix).Texture);
        BadRect = Rect; BadRect.Min.X = MAX_int32; BadRect.Max.X = MIN_int32;
        check(!Nanite::AddWebHZBBuildPasses(Graph, DepthTexture, BadRect, Matrix).Texture);
        auto BadMatrix = Matrix; BadMatrix.M[0][0] = std::numeric_limits<double>::quiet_NaN();
        check(!Nanite::AddWebHZBBuildPasses(Graph, DepthTexture, Rect, BadMatrix).Texture);
        const auto Valid = Nanite::AddWebHZBBuildPasses(Graph, DepthTexture, Rect, Matrix); check(Valid.Texture);
        check(!Nanite::AddWebOcclusionCullPasses(Graph, View, {}, nullptr));
        auto BadHZB = Valid; BadHZB.WorldToClip = BadMatrix;
        check(!Nanite::AddWebOcclusionCullPasses(Graph, View, BadHZB, nullptr));
        BadHZB = Valid; BadHZB.ViewRect.Min.Y = -1;
        check(!Nanite::AddWebOcclusionCullPasses(Graph, View, Valid, &BadHZB));
        auto BadView = View; BadView.View = nullptr;
        check(!Nanite::AddWebOcclusionCullPasses(Graph, BadView, Valid, nullptr));
        BadView = View; BadView.Entries[0].Input.MaxVisibleClusters = 0;
        check(!Nanite::AddWebOcclusionCullPasses(Graph, BadView, Valid, nullptr));
        BadView = View; BadView.Entries[0].Result.State = nullptr;
        check(!Nanite::AddWebOcclusionCullPasses(Graph, BadView, Valid, nullptr));
        BadView = View; BadView.Entries[0].Input.NumRootPages = MAX_uint32;
        check(!Nanite::AddWebOcclusionCullPasses(Graph, BadView, Valid, nullptr));
        BadView = View; BadView.Entries[0].LocalToWorld = BadMatrix;
        check(!Nanite::AddWebOcclusionCullPasses(Graph, BadView, Valid, nullptr));
        Report->SetNumberField(TEXT("invalidInputRejections"), 13);
    }
    Capture = false;
}
void Poll()
{
    if (!Report || Capture) return;
    for (auto& C : Copies) if (!C.Readback->IsReady()) return;
    for (auto& C : Copies)
    {
        const auto* Data = static_cast<const uint32*>(C.Readback->Lock(C.Bytes)); check(Data);
        TArray<TSharedPtr<FJsonValue>> Values;
        for (uint32 I = 0; I < C.Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
        C.Readback->Unlock(); Report->SetArrayField(C.Name, Values);
    }
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteHZBTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteHZBTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (!GEngine || !Nanite::GStreamingManager.IsWebResidentMode() || RequestedStep < 0 || RequestedStep > 10) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollHZB)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr;
        for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); if (!Camera.IsValid()) return 0;
        Camera->SetActorLocationAndRotation(Origin, FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        Mesh = CreateWebNaniteDepthFixture(); OccluderMesh = CreateWebNaniteOrdinaryFixture(); check(Mesh && OccluderMesh);
        auto Create = [&](UStaticMesh* Asset, FVector Location, FVector Scale) {
            auto* C = NewObject<UStaticMeshComponent>(); C->AddToRoot(); C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
            C->SetMobility(EComponentMobility::Movable); C->SetStaticMesh(Asset); C->SetWorldLocation(Location); C->SetWorldScale3D(Scale);
            C->RegisterComponentWithWorld(World); return C;
        };
        Component = Create(Mesh, Origin + FVector(500, 0, 0), FVector(1));
        Occluder = Create(OccluderMesh, Origin + FVector(300, 0, 0), FVector(4));
        auto* HZB = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"));
        auto* DepthMode = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"));
        auto* Pixels = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge"));
        SavedHZB = HZB->GetInt(); SavedDepth = DepthMode->GetInt(); SavedPixels = Pixels->GetFloat();
        HZB->Set(1, ECVF_SetByCode); DepthMode->Set(1, ECVF_SetByCode); Pixels->Set(0.01f, ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(ObserveHZB)([](FRHICommandListImmediate&) {
            CullHandle = Nanite::GetWebSceneCullDelegate().AddStatic(&Cull);
            OcclusionHandle = Nanite::GetWebOcclusionDelegate().AddStatic(&Occlusion);
            DepthHandle = Nanite::GetWebSceneDepthDelegate().AddStatic(&Depth);
        });
    }
    if (RequestedStep == 2) Occluder->SetVisibility(false);
    if (RequestedStep == 3) Occluder->SetVisibility(true);
    if (RequestedStep == 4) Component->SetWorldLocation(Origin + FVector(500, 450, 0));
    if (RequestedStep == 5) Component->SetWorldLocation(Origin + FVector(70, 0, 0));
    if (RequestedStep == 6)
    {
        Component->SetWorldLocation(Origin + FVector(500, 0, 0));
        Camera->SetActorLocationAndRotation(Origin + FVector(1000, 0, 0), FRotator(0, 180, 0));
    }
    if (RequestedStep == 7)
    {
        Camera->GetCameraComponent()->SetProjectionMode(ECameraProjectionMode::Orthographic);
        Camera->GetCameraComponent()->SetOrthoWidth(1200); Camera->GetCameraComponent()->SetAutoCalculateOrthoPlanes(false);
        Camera->GetCameraComponent()->SetOrthoNearClipPlane(10); Camera->GetCameraComponent()->SetOrthoFarClipPlane(4000);
    }
    if (RequestedStep == 8)
    {
        Camera->GetCameraComponent()->SetProjectionMode(ECameraProjectionMode::Perspective);
        Camera->SetActorLocationAndRotation(Origin, FRotator::ZeroRotator);
    }
    if (RequestedStep == 9) Component->SetVisibility(false);
    if (RequestedStep == 10)
    {
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->Set(SavedHZB, ECVF_SetByCode);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"))->Set(SavedDepth, ECVF_SetByCode);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge"))->Set(SavedPixels, ECVF_SetByCode);
        for (auto* C : {Component, Occluder}) { C->UnregisterComponent(); C->RemoveFromRoot(); C->DestroyComponent(); }
        Component = Occluder = nullptr;
        for (auto* M : {Mesh, OccluderMesh}) { M->ReleaseResources(); M->RemoveFromRoot(); } Mesh = OccluderMesh = nullptr;
        if (SavedTarget.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); Camera->Destroy(); Camera.Reset();
        ENQUEUE_RENDER_COMMAND(RemoveHZB)([](FRHICommandListImmediate&) {
            check(!Requested && !Capture && !Report && Copies.IsEmpty());
            Nanite::GetWebSceneCullDelegate().Remove(CullHandle); Nanite::GetWebOcclusionDelegate().Remove(OcclusionHandle);
            Nanite::GetWebSceneDepthDelegate().Remove(DepthHandle);
        });
        Last = RequestedStep; return 1;
    }
    Last = RequestedStep;
    ENQUEUE_RENDER_COMMAND(RequestHZB)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Capture && !Report && Copies.IsEmpty()); Step = RequestedStep; Settled = 0; Requested = true;
    });
    return 1;
}
