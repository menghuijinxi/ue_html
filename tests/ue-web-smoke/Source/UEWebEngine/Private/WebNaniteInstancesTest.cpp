#include "CoreMinimal.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/PlayerController.h"
#include "SceneView.h"
#include "SceneViewExtension.h"
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
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

UStaticMesh* CreateWebNaniteSceneFixture();
UStaticMesh* CreateWebNaniteOrdinaryFixture();
UStaticMesh* CreateWebNaniteDepthFixture();

namespace
{
UStaticMesh* Mesh;
UInstancedStaticMeshComponent* Components[2];
FPrimitiveComponentId IDs[2];
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FDelegateHandle Observer;
int Step = 0, Settled = 0;
int ViewPolicy = 0;
class FPolicy : public FSceneViewExtensionBase
{
public:
    FPolicy(const FAutoRegister& Auto) : FSceneViewExtensionBase(Auto) {}
    virtual void SetupViewFamily(FSceneViewFamily& Family) override
    { if (ViewPolicy == 13) Family.EngineShowFlags.SetNaniteMeshes(false); }
    virtual void SetupView(FSceneViewFamily&, FSceneView& View) override
    {
        if (ViewPolicy == 10) View.HiddenPrimitives.Add(IDs[0]);
        if (ViewPolicy == 11) View.ShowOnlyPrimitives = TSet<FPrimitiveComponentId>();
        if (ViewPolicy == 12) { View.ShowOnlyPrimitives = TSet<FPrimitiveComponentId>(); View.ShowOnlyPrimitives->Add(IDs[0]); }
    }
    virtual void BeginRenderViewFamily(FSceneViewFamily&) override {}
};
TSharedPtr<FPolicy, ESPMode::ThreadSafe> Policy;
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
TUniquePtr<FRHIGPUBufferReadback> Visibility, VisibleRecords, MaterialInputs, HardwareVisibility;
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
    if (!Requested || View.View->bIsSceneCapture) return;
    if (PipelineStateCache::NumActivePrecacheRequests()) { Settled = 0; return; }
    if (++Settled < 4) return;
    Requested = false;
    Report = MakeShared<FJsonObject>(); Report->SetNumberField(TEXT("step"), Step);
    Report->SetNumberField(TEXT("frame"), View.View->Family->FrameNumber);
    Report->SetNumberField(TEXT("registered"), View.Registered); Report->SetNumberField(TEXT("rejected"), View.Rejected);
    Report->SetNumberField(TEXT("skipped"), View.Skipped); Report->SetNumberField(TEXT("pendingPSOs"), 0);
    Report->SetArrayField(TEXT("expected"), Expected);
    Report->SetArrayField(TEXT("worldToClip"), MatrixJSON(View.View->ViewMatrices.GetWorldToClip()));
    const int32 MicroSpan = (Step - 1) % 4 == 0 ? 0 : (Step - 1) % 4 == 1 ? 1 : (Step - 1) % 4 == 2 ? 4 : 8;
    Report->SetNumberField(TEXT("microSpan"), MicroSpan);
    Nanite::FWebRasterVisibility Raster, Hardware;
    check(Nanite::AddWebResidentRasterPasses(Graph, View, RasterExtent, RasterRect, Raster, MicroSpan));
    check(Nanite::AddWebResidentRasterPasses(Graph, View, RasterExtent, RasterRect, Hardware, 0));
    HardwareVisibility = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebInstancesHardwareVisibility"));
    AddEnqueueCopyPass(Graph, HardwareVisibility.Get(), Hardware.Pixels, RasterExtent.X * RasterExtent.Y * 8);
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
        AddEnqueueCopyPass(Graph, C.Keys.Get(), E.Result.ClusterKeys, C.Capacity * 4);
        AddEnqueueCopyPass(Graph, C.State.Get(), E.Result.State, 16);
    }
}
void Poll()
{
    if (!Report) return;
    if (!HardwareVisibility->IsReady() || !Visibility->IsReady() || !VisibleRecords->IsReady() || !MaterialInputs->IsReady()) return;
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
    Report->SetArrayField(TEXT("hardwareVisibility"), ReadWords(*HardwareVisibility, RasterExtent.X * RasterExtent.Y * 8));
    HardwareVisibility.Reset();
    VisibleRecords.Reset(); MaterialInputs.Reset();
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json));
    FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteInstancesTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Pending.Empty(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteInstancesTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (!GEngine || !Nanite::GStreamingManager.IsWebResidentMode() || RequestedStep < 0 || RequestedStep > 15) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollInstances)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep == 15)
    {
        if (Last < 1 || Last > 13) return 0;
        ENQUEUE_RENDER_COMMAND(RepeatInstances)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Pending.IsEmpty()); Settled = 0; Requested = true;
        }); return 1;
    }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); if (!Camera.IsValid()) return 0;
        Camera->SetActorLocationAndRotation(Origin, FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get()); Mesh = CreateWebNaniteDepthFixture(); check(Mesh);
        Components[0] = NewObject<UInstancedStaticMeshComponent>();
        Components[1] = NewObject<UHierarchicalInstancedStaticMeshComponent>();
        for (int I = 0; I < 2; ++I)
        {
            auto* C = Components[I]; C->AddToRoot(); C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
            C->SetMobility(EComponentMobility::Movable); C->SetStaticMesh(Mesh); C->SetWorldLocation(Origin);
            for (int J = 0; J < (I ? 2 : 3); ++J)
                C->AddInstance(FTransform(FRotator(J * 13, J * 17, 0), FVector(400 + I * 120, (J - 1) * 130, I * 120),
                    FVector(J == 1 ? -1 : 1, 1 + J * 0.2, 1 - J * 0.1)));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        Policy = FSceneViewExtensions::NewExtension<FPolicy>();
        auto* Pixels = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge"));
        SavedPixels = Pixels->GetFloat(); Pixels->Set(0.01f, ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(ObserveInstances)([](FRHICommandListImmediate&) { Observer = Nanite::GetWebSceneCullDelegate().AddStatic(&Observe); });
    }
    if (RequestedStep == 2) check(Components[0]->UpdateInstanceTransform(1, FTransform(FVector(400, 1200, 0)), false, true, true));
    if (RequestedStep == 3) check(Components[0]->RemoveInstance(0));
    if (RequestedStep == 4)
    {
        Components[0]->AddInstance(FTransform(FRotator(15, 25, 5), FVector(380, -120, 40), FVector(-1, 1.2, 0.7)));
        Components[0]->SetWorldLocationAndRotation(Origin + FVector(10, 20, 30), FRotator(0, 10, 0));
    }
    if (RequestedStep == 5) Components[0]->SetVisibility(false);
    if (RequestedStep == 6) { Components[0]->SetVisibility(true); UWorld* World = Components[1]->GetWorld(); Components[1]->UnregisterComponent(); Components[1]->RegisterComponentWithWorld(World); }
    if (RequestedStep == 7) Components[0]->ClearInstances();
    if (RequestedStep == 8)
    {
        for (int I = 0; I < 48; ++I) Components[0]->AddInstance(FTransform(FRotator(0, I * 17, 0),
            FVector(400 + (I / 16) * 90, (I % 8 - 4) * 45, (I % 16 / 8) * 65), FVector(0.3)));
    }
    if (RequestedStep == 9) Components[1]->SetVisibility(false);
    if (RequestedStep == 10) Components[1]->SetVisibility(true);
    ViewPolicy = RequestedStep;
    if (RequestedStep == 14)
    {
        Policy.Reset(); ViewPolicy = 0;
        for (auto*& C : Components) { C->UnregisterComponent(); C->RemoveFromRoot(); C->DestroyComponent(); C = nullptr; }
        Mesh->ReleaseResources(); Mesh->RemoveFromRoot(); Mesh = nullptr;
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge"))->Set(SavedPixels, ECVF_SetByCode);
        if (SavedTarget.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); Camera->Destroy(); Camera.Reset();
        ENQUEUE_RENDER_COMMAND(RemoveInstances)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Pending.IsEmpty()); Nanite::GetWebSceneCullDelegate().Remove(Observer); Expected.Empty();
        }); Last = RequestedStep; return 1;
    }
    CastChecked<UHierarchicalInstancedStaticMeshComponent>(Components[1])->BuildTreeIfOutdated(false, true);
    TArray<TSharedPtr<FJsonValue>> Transforms;
    for (int I = 0; I < 2; ++I) if (Components[I]->IsVisible() && RequestedStep != 11 && RequestedStep != 13 &&
        !(RequestedStep == 10 && I == 0) && !(RequestedStep == 12 && I == 1))
    {
        for (int J = 0; J < Components[I]->GetInstanceCount(); ++J)
        {
            FTransform Transform; check(Components[I]->GetInstanceTransform(J, Transform, true));
            auto Json = MakeShared<FJsonObject>(); Json->SetNumberField(TEXT("component"), I);
            Json->SetArrayField(TEXT("localToWorld"), MatrixJSON(Transform.ToMatrixWithScale()));
            Transforms.Add(MakeShared<FJsonValueObject>(Json));
        }
    }
    Last = RequestedStep;
    ENQUEUE_RENDER_COMMAND(RequestInstances)([RequestedStep, Transforms = MoveTemp(Transforms)](FRHICommandListImmediate&) mutable {
        check(!Requested && !Report && Pending.IsEmpty()); Step = RequestedStep; Settled = 0; Expected = MoveTemp(Transforms); Requested = true;
    }); return 1;
}
