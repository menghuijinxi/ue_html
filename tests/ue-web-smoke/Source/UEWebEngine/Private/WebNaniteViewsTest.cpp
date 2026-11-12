#include "CoreMinimal.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "SceneView.h"
#include "Rendering/NaniteStreamingManager.h"
#include "Rendering/NaniteWebScene.h"
#include "Rendering/NaniteWebRaster.h"
#include "Rendering/NaniteWebDepth.h"
#include "HAL/IConsoleManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "WebNaniteCullReadback.h"
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

UStaticMesh* CreateWebNaniteDepthFixture();

namespace
{
UStaticMesh* Mesh;
UInstancedStaticMeshComponent* Components[2];
FPrimitiveComponentId IDs[2];
FDelegateHandle Observer;
int Step = 0, Settled = 0;
USceneCaptureComponent2D* CaptureComponent = nullptr;
UTextureRenderTarget2D* CaptureTarget = nullptr;
FDelegateHandle DepthObserver;
const FSceneView* CapturedView = nullptr;
TUniquePtr<FRHIGPUBufferReadback> ScenePixels;
uint32 ScenePixelBytes = 0;
int SavedDepth = 0, SavedHZB = 1;
float SavedPixels = 1;
bool Requested = false;
TSharedPtr<FJsonObject> Report;
TArray<TSharedPtr<FJsonValue>> Expected;
struct FReadback
{
    uint32 Capacity;
    TSharedPtr<FJsonObject> Json;
    TUniquePtr<FRHIGPUBufferReadback> Keys, State;
};
TArray<FReadback> Pending;
TUniquePtr<FRHIGPUBufferReadback> Visibility, VisibleRecords, MaterialInputs;
uint32 VisibleRecordBytes = 0, MaterialInputBytes = 0;
const FVector Origin(100000, 0, 100000);
const FIntPoint RasterExtent(192, 128);
const FIntRect RasterRect(7, 5, 185, 123);
TArray<TSharedPtr<FJsonValue>> MatrixJSON(const FMatrix& Matrix)
{
    TArray<TSharedPtr<FJsonValue>> Values;
    for (int32 Row = 0; Row < 4; ++Row) for (int32 Col = 0; Col < 4; ++Col)
        Values.Add(MakeShared<FJsonValueNumber>(Matrix.M[Row][Col]));
    return Values;
}

void Observe(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& View)
{
    if (!Requested || !View.View->bIsSceneCapture) return;
    if (PipelineStateCache::NumActivePrecacheRequests()) { Settled = 0; return; }
    if (++Settled < 4) return;
    Requested = false; CapturedView = View.View;
    Report = MakeShared<FJsonObject>(); Report->SetNumberField(TEXT("step"), Step);
    Report->SetNumberField(TEXT("frame"), View.View->Family->FrameNumber);
    Report->SetBoolField(TEXT("sceneCapture"), View.View->bIsSceneCapture);
    Report->SetBoolField(TEXT("perspective"), View.View->IsPerspectiveProjection());
    Report->SetNumberField(TEXT("viewKey"), View.View->GetViewKey());
    Report->SetNumberField(TEXT("registered"), View.Registered); Report->SetNumberField(TEXT("rejected"), View.Rejected);
    Report->SetNumberField(TEXT("skipped"), View.Skipped); Report->SetNumberField(TEXT("pendingPSOs"), 0);
    Report->SetArrayField(TEXT("expected"), Expected);
    Report->SetBoolField(TEXT("cullBackfaces"), true); // The fixture uses the single-sided default material.
    Report->SetBoolField(TEXT("reverseView"), View.View->bReverseCulling);
    Report->SetArrayField(TEXT("worldToClip"), MatrixJSON(View.View->ViewMatrices.GetWorldToClip()));
    Nanite::FWebRasterVisibility Raster;
    check(Nanite::AddWebResidentRasterPasses(Graph, View, RasterExtent, RasterRect, Raster));
    Report->SetNumberField(TEXT("rasterWidth"), RasterExtent.X); Report->SetNumberField(TEXT("rasterHeight"), RasterExtent.Y);
    Visibility = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebInstancesVisibility"));
    AddEnqueueCopyPass(Graph, Visibility.Get(), Raster.Pixels, RasterExtent.X * RasterExtent.Y * 8);
    VisibleRecordBytes = Raster.VisibleClusters->Desc.GetSize();
    VisibleRecords = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebInstancesRecords"));
    AddEnqueueCopyPass(Graph, VisibleRecords.Get(), Raster.VisibleClusters, VisibleRecordBytes);
    auto* Inputs = Nanite::AddWebMaterialInputResolvePasses(Graph, View, Raster, 4); check(Inputs);
    MaterialInputBytes = Inputs->Desc.GetSize(); MaterialInputs = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebInstancesInputs"));
    AddEnqueueCopyPass(Graph, MaterialInputs.Get(), Inputs, MaterialInputBytes);
    Report->SetNumberField(TEXT("materialStride"), 4);
    Report->SetNumberField(TEXT("materialWidth"), FMath::DivideAndRoundUp(RasterRect.Width(), 4));
    Report->SetNumberField(TEXT("materialHeight"), FMath::DivideAndRoundUp(RasterRect.Height(), 4));
    for (int32 Index = 0; Index < View.Entries.Num(); ++Index)
    {
        const auto& E = View.Entries[Index];
        const int ComponentIndex = E.ComponentId == IDs[0] ? 0 : E.ComponentId == IDs[1] ? 1 : -1; check(ComponentIndex >= 0);
        auto& C = Pending.AddDefaulted_GetRef(); C.Capacity = E.Input.MaxVisibleClusters; C.Json = MakeShared<FJsonObject>();
        C.Json->SetNumberField(TEXT("component"), ComponentIndex); C.Json->SetNumberField(TEXT("id"), E.RuntimeResourceID);
        C.Json->SetNumberField(TEXT("page"), E.Input.FirstRootPage); C.Json->SetNumberField(TEXT("clusterBase"), Raster.ClusterBases[Index]);
        C.Json->SetNumberField(TEXT("instanceId"), E.InstanceSceneDataOffset); C.Json->SetArrayField(TEXT("localToWorld"), MatrixJSON(E.LocalToWorld));
        C.Keys = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebInstancesKeys"));
        C.State = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebInstancesState"));
        AddEnqueueCopyPass(Graph, C.Keys.Get(), WebNaniteCullReadbackRange(Graph, E.Result.ClusterKeys, E.Result.ClusterOffset, C.Capacity), C.Capacity * 4);
        AddEnqueueCopyPass(Graph, C.State.Get(), WebNaniteCullReadbackRange(Graph, E.Result.State, E.Result.StateOffset, 4), 16);
    }
}
void ObserveDepth(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& View, FIntRect Rect,
    FRDGTextureRef Resolved, FRDGTextureRef Depth, bool After)
{
    if (!Report || View.View != CapturedView || !After || ScenePixels) return;
    auto* Buffer = Nanite::AddWebDepthSnapshotPass(Graph, Resolved, Depth, Rect, 2); check(Buffer);
    Report->SetNumberField(TEXT("sceneWidth"), FMath::DivideAndRoundUp(Rect.Width(), 2));
    Report->SetNumberField(TEXT("sceneHeight"), FMath::DivideAndRoundUp(Rect.Height(), 2));
    ScenePixelBytes = Buffer->Desc.GetSize(); ScenePixels = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebCaptureDepth"));
    AddEnqueueCopyPass(Graph, ScenePixels.Get(), Buffer, ScenePixelBytes);
}
void Poll()
{
    if (!Report) return;
    if (!ScenePixels || !ScenePixels->IsReady()) return;
    if (!Visibility->IsReady() || !VisibleRecords->IsReady() || !MaterialInputs->IsReady()) return;
    for (const auto& Copy : Pending) if (!Copy.Keys->IsReady() || !Copy.State->IsReady()) return;
    TArray<TSharedPtr<FJsonValue>> Entries;
    for (auto& Copy : Pending)
    {
        const auto* Keys = static_cast<const uint32*>(Copy.Keys->Lock(Copy.Capacity * 4));
        const auto* State = static_cast<const uint32*>(Copy.State->Lock(16));
        check(Keys && State);
        TArray<TSharedPtr<FJsonValue>> KeysJSON, StateJSON;
        for (uint32 I = 0; I < Copy.Capacity; ++I) KeysJSON.Add(MakeShared<FJsonValueNumber>(Keys[I]));
        for (int32 I = 0; I < 4; ++I) StateJSON.Add(MakeShared<FJsonValueNumber>(State[I]));
        Copy.Json->SetArrayField(TEXT("keys"), KeysJSON); Copy.Json->SetArrayField(TEXT("state"), StateJSON);
        Entries.Add(MakeShared<FJsonValueObject>(Copy.Json));
        Copy.Keys->Unlock(); Copy.State->Unlock();
    }
    Report->SetArrayField(TEXT("entries"), Entries); Report->SetBoolField(TEXT("pending"), false);
    const auto* Pixels = static_cast<const uint32*>(Visibility->Lock(RasterExtent.X * RasterExtent.Y * 8));
    check(Pixels);
    TArray<TSharedPtr<FJsonValue>> PixelsJSON;
    for (int32 I = 0; I < RasterExtent.X * RasterExtent.Y * 2; ++I) PixelsJSON.Add(MakeShared<FJsonValueNumber>(Pixels[I]));
    Report->SetArrayField(TEXT("visibility"), PixelsJSON);
    Visibility->Unlock(); Visibility.Reset();
    const auto ReadWords = [](FRHIGPUBufferReadback& Copy, uint32 Bytes)
    {
        const auto* Data = static_cast<const uint32*>(Copy.Lock(Bytes)); check(Data);
        TArray<TSharedPtr<FJsonValue>> Values;
        for (uint32 I = 0; I < Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
        Copy.Unlock(); return Values;
    };
    Report->SetArrayField(TEXT("visibleRecords"), ReadWords(*VisibleRecords, VisibleRecordBytes));
    Report->SetArrayField(TEXT("materialInputs"), ReadWords(*MaterialInputs, MaterialInputBytes));
    Report->SetArrayField(TEXT("scenePixels"), ReadWords(*ScenePixels, ScenePixelBytes));
    VisibleRecords.Reset(); MaterialInputs.Reset(); ScenePixels.Reset(); CapturedView = nullptr;
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json));
    FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteViewsTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Pending.Empty(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteViewsTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (!GEngine || !Nanite::GStreamingManager.IsWebResidentMode() || RequestedStep < 0 || RequestedStep > 11) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollViews)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World) return 0;
        Mesh = CreateWebNaniteDepthFixture(); check(Mesh);
        Components[0] = NewObject<UInstancedStaticMeshComponent>();
        Components[1] = NewObject<UHierarchicalInstancedStaticMeshComponent>();
        for (int I = 0; I < 2; ++I)
        {
            auto* C = Components[I]; C->AddToRoot(); C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
            C->SetMobility(EComponentMobility::Movable); C->SetStaticMesh(Mesh); C->SetWorldLocation(Origin);
            for (int J = 0; J < (I ? 2 : 3); ++J) C->AddInstance(FTransform(FRotator(J * 13, J * 17, 0),
                FVector(400 + I * 120, (J - 1) * 130, I * 120), FVector(J == 1 ? -1 : 1, 1 + J * 0.2, 1 - J * 0.1)));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        CastChecked<UHierarchicalInstancedStaticMeshComponent>(Components[1])->BuildTreeIfOutdated(false, true);
        CaptureTarget = NewObject<UTextureRenderTarget2D>(); CaptureTarget->AddToRoot();
        CaptureTarget->InitCustomFormat(256, 192, PF_FloatRGBA, false); CaptureTarget->UpdateResourceImmediate();
        CaptureComponent = NewObject<USceneCaptureComponent2D>(); CaptureComponent->AddToRoot();
        CaptureComponent->TextureTarget = CaptureTarget; CaptureComponent->CaptureSource = SCS_SceneDepth;
        CaptureComponent->bAutoCalculateOrthoPlanes = false; CaptureComponent->bUpdateOrthoPlanes = false;
        CaptureComponent->MaxViewDistanceOverride = 2000; CaptureComponent->bOverride_CustomNearClippingPlane = true; CaptureComponent->CustomNearClippingPlane = 10;
        CaptureComponent->bCaptureEveryFrame = true; CaptureComponent->bAlwaysPersistRenderingState = true;
        CaptureComponent->SetWorldLocationAndRotation(Origin, FRotator::ZeroRotator); CaptureComponent->FOVAngle = 90;
        CaptureComponent->RegisterComponentWithWorld(World);
        auto* Pixels = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge"));
        SavedPixels = Pixels->GetFloat(); Pixels->Set(0.01f, ECVF_SetByCode);
        auto* Depth = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"));
        SavedDepth = Depth->GetInt(); Depth->Set(1, ECVF_SetByCode);
        auto* HZB = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"));
        SavedHZB = HZB->GetInt(); HZB->Set(0, ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(ObserveViews)([](FRHICommandListImmediate&) {
            Observer = Nanite::GetWebSceneCullDelegate().AddStatic(&Observe);
            DepthObserver = Nanite::GetWebSceneDepthDelegate().AddStatic(&ObserveDepth);
        });
    }
    if (RequestedStep == 2) CaptureComponent->HiddenComponents.Add(Components[0]);
    if (RequestedStep == 3) { CaptureComponent->HiddenComponents.Empty(); CaptureComponent->PrimitiveRenderMode = ESceneCapturePrimitiveRenderMode::PRM_UseShowOnlyList; CaptureComponent->ShowOnlyComponents.Add(Components[0]); }
    if (RequestedStep == 4) CaptureComponent->ShowOnlyComponents.Empty();
    if (RequestedStep == 5) { CaptureComponent->PrimitiveRenderMode = ESceneCapturePrimitiveRenderMode::PRM_RenderScenePrimitives; CaptureComponent->ProjectionType = ECameraProjectionMode::Orthographic; CaptureComponent->OrthoWidth = 1200; }
    if (RequestedStep == 6) CaptureComponent->SetWorldRotation(FRotator(0, 180, 0));
    if (RequestedStep == 7) { CaptureComponent->ProjectionType = ECameraProjectionMode::Perspective; CaptureComponent->SetWorldLocation(Origin + FVector(1000, 0, 0)); }
    if (RequestedStep == 8) CaptureComponent->ShowFlags.SetNaniteMeshes(false);
    if (RequestedStep == 9) { CaptureComponent->ShowFlags.SetNaniteMeshes(true); CaptureComponent->SetWorldLocationAndRotation(Origin, FRotator::ZeroRotator); UWorld* World = CaptureComponent->GetWorld(); CaptureComponent->UnregisterComponent(); CaptureComponent->RegisterComponentWithWorld(World); }
    if (RequestedStep == 10) { CaptureComponent->TextureTarget = nullptr; CaptureTarget->ResizeTarget(320, 160); CaptureComponent->TextureTarget = CaptureTarget; }
    if (RequestedStep == 11)
    {
        CaptureComponent->UnregisterComponent(); CaptureComponent->RemoveFromRoot(); CaptureComponent->DestroyComponent(); CaptureComponent = nullptr;
        CaptureTarget->ReleaseResource(); CaptureTarget->RemoveFromRoot(); CaptureTarget = nullptr;
        for (auto*& C : Components) { C->UnregisterComponent(); C->RemoveFromRoot(); C->DestroyComponent(); C = nullptr; }
        Mesh->ReleaseResources(); Mesh->RemoveFromRoot(); Mesh = nullptr;
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge"))->Set(SavedPixels, ECVF_SetByCode);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"))->Set(SavedDepth, ECVF_SetByCode);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->Set(SavedHZB, ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveViews)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Pending.IsEmpty()); Nanite::GetWebSceneCullDelegate().Remove(Observer);
            Nanite::GetWebSceneDepthDelegate().Remove(DepthObserver); Expected.Empty();
        }); Last = RequestedStep; return 1;
    }
    TArray<TSharedPtr<FJsonValue>> Transforms;
    for (int I = 0; I < 2; ++I) if (RequestedStep != 4 && RequestedStep != 8 && !(RequestedStep == 2 && I == 0) && !(RequestedStep == 3 && I == 1))
    {
        for (int J = 0; J < Components[I]->GetInstanceCount(); ++J)
        {
            FTransform Transform; check(Components[I]->GetInstanceTransform(J, Transform, true));
            auto Json = MakeShared<FJsonObject>(); Json->SetNumberField(TEXT("component"), I);
            Json->SetArrayField(TEXT("localToWorld"), MatrixJSON(Transform.ToMatrixWithScale())); Transforms.Add(MakeShared<FJsonValueObject>(Json));
        }
    }
    Last = RequestedStep;
    ENQUEUE_RENDER_COMMAND(RequestViews)([RequestedStep, Transforms = MoveTemp(Transforms)](FRHICommandListImmediate&) mutable {
        check(!Requested && !Report && Pending.IsEmpty()); Step = RequestedStep; Settled = 0; Expected = MoveTemp(Transforms); Requested = true;
    }); return 1;
}
