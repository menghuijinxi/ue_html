#include "CoreMinimal.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/PlayerController.h"
#include "SceneView.h"
#include "Rendering/NaniteStreamingManager.h"
#include "Rendering/NaniteWebScene.h"
#include "Rendering/NaniteWebRaster.h"
#include "Rendering/NaniteWebDepth.h"
#include "HAL/IConsoleManager.h"
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
UStaticMeshComponent* Components[2];
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedViewTarget;
TWeakObjectPtr<APlayerController> Controller;
FPrimitiveComponentId IDs[2];
FDelegateHandle Observer;
FDelegateHandle DepthObserver;
UStaticMesh* OrdinaryMesh;
UStaticMeshComponent* OrdinaryComponent;
int SavedDepthMode = 0;
TUniquePtr<FRHIGPUBufferReadback> DepthBefore, DepthAfter;
uint32 DepthBytes = 0;
bool DepthCapture = false;
int ActiveStep = 0, SettledFrames = 0;
bool Requested = false;
struct FReadback
{
    uint32 Capacity;
    TSharedPtr<FJsonObject> Json;
    TUniquePtr<FRHIGPUBufferReadback> Keys, State;
};
TArray<FReadback> Pending;
TSharedPtr<FJsonObject> Report;
TUniquePtr<FRHIGPUBufferReadback> Visibility;
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
    if (ActiveStep >= 20) return;
    if (!Requested || ++SettledFrames < 4) return;
    Requested = false;
    Report = MakeShared<FJsonObject>();
    Report->SetNumberField(TEXT("step"), ActiveStep);
    Report->SetNumberField(TEXT("frame"), View.View->Family->FrameNumber);
    Report->SetNumberField(TEXT("registered"), View.Registered);
    Report->SetNumberField(TEXT("skipped"), View.Skipped);
    Report->SetNumberField(TEXT("rejected"), View.Rejected);
    Report->SetBoolField(TEXT("perspective"), View.View->IsPerspectiveProjection());
    Report->SetArrayField(TEXT("worldToClip"), MatrixJSON(View.View->ViewMatrices.GetWorldToClip()));
    Nanite::FWebSceneCullView RasterView = View;
    if (ActiveStep >= 14)
    {
        // Simulate a failed GPU cull, including a count that exceeds capacity.
        // The raster API must suppress the entire entry without reading keys.
        for (auto& Entry : RasterView.Entries)
        {
            Entry.Result.State = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(4, 4), TEXT("WebRasterInvalidCullState"));
            TArray<uint32> Invalid = {Entry.Input.MaxVisibleClusters + (ActiveStep == 19 ? 1u : 0u),
                ActiveStep == 19 ? 0u : 1u << (ActiveStep - 14), 0, 0};
            Graph.QueueBufferUpload(Entry.Result.State, MakeArrayView(Invalid));
        }
    }
    Nanite::FWebRasterVisibility Raster;
    check(Nanite::AddWebResidentRasterPasses(Graph, RasterView, RasterExtent, RasterRect, Raster));
    Report->SetBoolField(TEXT("invalidCullState"), ActiveStep >= 14);
    if (ActiveStep == 1)
    {
        Nanite::FWebRasterVisibility Invalid;
        check(!Nanite::AddWebResidentRasterPasses(Graph, View, FIntPoint(0, 128), RasterRect, Invalid) && !Invalid.Pixels);
        check(!Nanite::AddWebResidentRasterPasses(Graph, View, FIntPoint(32768, 32768), RasterRect, Invalid) && !Invalid.Pixels);
        check(!Nanite::AddWebResidentRasterPasses(Graph, View, RasterExtent, FIntRect(-1, 0, 10, 10), Invalid) && !Invalid.Pixels);
        check(!Nanite::AddWebResidentRasterPasses(Graph, View, RasterExtent, FIntRect(0, 0, 193, 128), Invalid) && !Invalid.Pixels);
        check(!Nanite::AddWebResidentRasterPasses(Graph, View, RasterExtent, FIntRect(5, 5, 5, 5), Invalid) && !Invalid.Pixels);
        auto BadView = View; BadView.Entries[0].Result.State = nullptr;
        check(!Nanite::AddWebResidentRasterPasses(Graph, BadView, RasterExtent, RasterRect, Invalid) && !Invalid.Pixels);
        Report->SetNumberField(TEXT("rasterInputRejections"), 6);
    }
    Report->SetNumberField(TEXT("rasterWidth"), RasterExtent.X); Report->SetNumberField(TEXT("rasterHeight"), RasterExtent.Y);
    Visibility = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebSceneRasterVisibility"));
    AddEnqueueCopyPass(Graph, Visibility.Get(), Raster.Pixels, RasterExtent.X * RasterExtent.Y * 8);
    for (int32 EntryIndex = 0; EntryIndex < View.Entries.Num(); ++EntryIndex)
    {
        const auto& Entry = View.Entries[EntryIndex];
        const int Index = Entry.ComponentId == IDs[0] ? 0 : Entry.ComponentId == IDs[1] ? 1 : -1;
        if (Index < 0) continue;
        auto& Copy = Pending.AddDefaulted_GetRef();
        Copy.Capacity = Entry.Input.MaxVisibleClusters; Copy.Json = MakeShared<FJsonObject>();
        Copy.Json->SetNumberField(TEXT("component"), Index);
        Copy.Json->SetNumberField(TEXT("id"), Entry.RuntimeResourceID);
        Copy.Json->SetNumberField(TEXT("page"), Entry.Input.FirstRootPage);
        Copy.Json->SetNumberField(TEXT("levels"), Entry.Input.MaxLevels);
        Copy.Json->SetNumberField(TEXT("clusterBase"), Raster.ClusterBases[EntryIndex]);
        Copy.Json->SetArrayField(TEXT("localToWorld"), MatrixJSON(Entry.LocalToWorld));
        Copy.Keys = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebSceneCullKeys"));
        Copy.State = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebSceneCullState"));
        AddEnqueueCopyPass(Graph, Copy.Keys.Get(), Entry.Result.ClusterKeys, Copy.Capacity * 4);
        AddEnqueueCopyPass(Graph, Copy.State.Get(), Entry.Result.State, 16);
    }
}

void ObserveDepth(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& View, FIntRect Rect,
    FRDGTextureRef Resolved, FRDGTextureRef SceneDepth, bool After)
{
    if (ActiveStep < 20) return;
    if (!After)
    {
        if (!Requested || ++SettledFrames < 4) return;
        Requested = false; DepthCapture = true;
        Report = MakeShared<FJsonObject>();
        Report->SetNumberField(TEXT("step"), ActiveStep);
        Report->SetNumberField(TEXT("frame"), View.View->Family->FrameNumber);
        Report->SetNumberField(TEXT("entries"), View.Entries.Num());
        Report->SetNumberField(TEXT("registered"), View.Registered);
        Report->SetNumberField(TEXT("rejected"), View.Rejected);
        Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(Rect.Width(), 4));
        Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(Rect.Height(), 4));
        Report->SetNumberField(TEXT("stride"), 4);
        Report->SetStringField(TEXT("depthFormat"), GPixelFormats[SceneDepth->Desc.Format].Name);
        if (ActiveStep == 20)
        {
            check(!Nanite::AddWebDepthExportPass(Graph, nullptr, SceneDepth, Rect));
            check(!Nanite::AddWebDepthExportPass(Graph, Resolved, nullptr, Rect));
            check(!Nanite::AddWebDepthExportPass(Graph, Resolved, SceneDepth, FIntRect(0, 0, 0, 0)));
            check(!Nanite::AddWebDepthExportPass(Graph, Resolved, SceneDepth, FIntRect(MAX_int32, 0, MIN_int32, 1)));
            check(!Nanite::AddWebDepthSnapshotPass(Graph, Resolved, SceneDepth, Rect, 0));
            Report->SetNumberField(TEXT("inputRejections"), 5);
        }
    }
    if (!DepthCapture) return;
    auto* Buffer = Nanite::AddWebDepthSnapshotPass(Graph, Resolved, SceneDepth, Rect, 4);
    check(Buffer); DepthBytes = Buffer->Desc.GetSize();
    auto& Copy = After ? DepthAfter : DepthBefore;
    Copy = MakeUnique<FRHIGPUBufferReadback>(After ? TEXT("WebSceneDepthAfter") : TEXT("WebSceneDepthBefore"));
    AddEnqueueCopyPass(Graph, Copy.Get(), Buffer, DepthBytes);
    if (After) DepthCapture = false;
}

void Poll()
{
    if (!Report) return;
    if (ActiveStep >= 20)
    {
        if (!DepthBefore || !DepthAfter || !DepthBefore->IsReady() || !DepthAfter->IsReady()) return;
        const auto Read = [](FRHIGPUBufferReadback& Copy)
        {
            const auto* Data = static_cast<const uint32*>(Copy.Lock(DepthBytes)); check(Data);
            TArray<TSharedPtr<FJsonValue>> Values;
            for (uint32 I = 0; I < DepthBytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
            Copy.Unlock(); return Values;
        };
        Report->SetArrayField(TEXT("before"), Read(*DepthBefore));
        Report->SetArrayField(TEXT("after"), Read(*DepthAfter));
        Report->SetBoolField(TEXT("pending"), false);
        FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json));
        FTCHARToUTF8 Utf8(*Json);
        MAIN_THREAD_EM_ASM({globalThis.__webNaniteSceneDepthTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
        DepthBefore.Reset(); DepthAfter.Reset(); Report.Reset(); return;
    }
    if (!Visibility->IsReady()) return;
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
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json));
    FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteSceneCullTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Pending.Empty(); Report.Reset();
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteSceneCullTest(int Step)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    static int LastStep = 0;
    if (Step < 0 || Step > 25 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!Step) { ENQUEUE_RENDER_COMMAND(PollWebSceneCull)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (Step != LastStep + 1) return 0;
    if (Step == 1)
    {
        UWorld* World = nullptr;
        for (const auto& Context : GEngine->GetWorldContexts()) if (Context.WorldType == EWorldType::Game) World = Context.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Controller = World->GetFirstPlayerController(); SavedViewTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); if (!Camera.IsValid()) return 0;
        Camera->SetActorLocationAndRotation(FVector::ZeroVector, FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        Mesh = CreateWebNaniteSceneFixture(); if (!Mesh) return 0;
        for (int32 I = 0; I < 2; ++I)
        {
            Components[I] = NewObject<UStaticMeshComponent>(); Components[I]->AddToRoot();
            Components[I]->SetCollisionEnabled(ECollisionEnabled::NoCollision);
            Components[I]->SetMobility(EComponentMobility::Movable); Components[I]->SetStaticMesh(Mesh);
            Components[I]->SetWorldLocation(FVector(500, I ? 100 : -100, 0));
            Components[I]->RegisterComponentWithWorld(World); IDs[I] = Components[I]->GetPrimitiveSceneId();
        }
        ENQUEUE_RENDER_COMMAND(ObserveWebSceneCull)([](FRHICommandListImmediate&) {
            Observer = Nanite::GetWebSceneCullDelegate().AddStatic(&Observe);
        });
    }
    if (Step == 2) Components[1]->SetWorldLocation(FVector(500, 2000, 0));
    if (Step == 3)
    {
        Components[1]->SetWorldTransform(FTransform(FRotator(20, 30, 10), FVector(500, 550, 0), FVector(-1, 2, 0.5)));
    }
    if (Step == 4) Camera->SetActorRotation(FRotator(0, 180, 0));
    if (Step == 5)
    {
        Camera->SetActorRotation(FRotator::ZeroRotator);
        auto* Lens = Camera->GetCameraComponent(); Lens->SetProjectionMode(ECameraProjectionMode::Orthographic);
        Lens->SetOrthoWidth(800); Lens->SetAutoCalculateOrthoPlanes(false); Lens->SetOrthoNearClipPlane(10); Lens->SetOrthoFarClipPlane(2000);
    }
    if (Step == 6) Components[0]->SetHiddenInGame(true);
    if (Step == 7) Components[1]->UnregisterComponent();
    if (Step == 8)
    {
        Components[0]->SetHiddenInGame(false); Components[1]->RegisterComponentWithWorld(Controller->GetWorld());
        Components[1]->SetWorldTransform(FTransform(FRotator::ZeroRotator, FVector(500, 100, 0)));
        Camera->GetCameraComponent()->SetProjectionMode(ECameraProjectionMode::Perspective);
    }
    if (Step == 9) { for (auto* Component : Components) Component->UnregisterComponent(); Mesh->ReleaseResources(); }
    if (Step == 10)
    {
        Mesh->InitResources(); for (auto* Component : Components) Component->RegisterComponentWithWorld(Controller->GetWorld());
    }
    if (Step == 11)
    {
        Components[0]->SetWorldLocation(FVector(500, 0, 0)); Components[1]->SetWorldLocation(FVector(600, 0, 0));
    }
    if (Step == 12) Components[1]->SetWorldLocation(FVector(500, 0, 0));
    if (Step == 13)
    {
        Components[0]->SetWorldLocation(FVector(10, 0, 0)); Components[1]->SetWorldLocation(FVector(500, 2000, 0));
    }
    if (Step == 14)
    {
        Components[0]->SetWorldLocation(FVector(500, -100, 0)); Components[1]->SetWorldLocation(FVector(500, 100, 0));
    }
    if (Step == 20)
    {
        for (auto* Component : Components) Component->UnregisterComponent();
        Mesh->ReleaseResources(); Mesh->RemoveFromRoot();
        Mesh = CreateWebNaniteDepthFixture(); if (!Mesh) return 0;
        for (auto* Component : Components) Component->SetStaticMesh(Mesh);
        const FVector Origin(100000, 0, 100000);
        Camera->SetActorLocationAndRotation(Origin, FRotator::ZeroRotator);
        Components[0]->SetWorldLocation(Origin + FVector(500, 0, 0));
        Components[1]->SetWorldLocation(Origin + FVector(500, 2000, 0));
        for (auto* Component : Components) Component->RegisterComponentWithWorld(Controller->GetWorld());
        OrdinaryMesh = CreateWebNaniteOrdinaryFixture(); if (!OrdinaryMesh) return 0;
        OrdinaryComponent = NewObject<UStaticMeshComponent>(); OrdinaryComponent->AddToRoot();
        OrdinaryComponent->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        OrdinaryComponent->SetMobility(EComponentMobility::Movable); OrdinaryComponent->SetStaticMesh(OrdinaryMesh);
        OrdinaryComponent->SetWorldLocation(Origin + FVector(350, 0, 0)); OrdinaryComponent->SetWorldScale3D(FVector(0.65));
        OrdinaryComponent->RegisterComponentWithWorld(Controller->GetWorld());
        auto* Mode = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth")); check(Mode);
        SavedDepthMode = Mode->GetInt(); Mode->Set(1, ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(ObserveWebSceneDepth)([](FRHICommandListImmediate&) {
            DepthObserver = Nanite::GetWebSceneDepthDelegate().AddStatic(&ObserveDepth);
        });
    }
    if (Step == 21) { OrdinaryComponent->SetWorldLocation(FVector(100700, 0, 100000)); OrdinaryComponent->SetWorldScale3D(FVector(1)); }
    if (Step == 22) OrdinaryComponent->SetWorldLocation(FVector(100350, 35, 100000));
    if (Step == 23) for (auto* Component : Components) Component->SetHiddenInGame(true);
    if (Step == 24) { for (auto* Component : Components) Component->SetHiddenInGame(false); OrdinaryComponent->SetHiddenInGame(true); }
    if (Step == 25)
    {
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"))->Set(SavedDepthMode, ECVF_SetByCode);
        OrdinaryComponent->UnregisterComponent(); OrdinaryComponent->RemoveFromRoot(); OrdinaryComponent->DestroyComponent(); OrdinaryComponent = nullptr;
        OrdinaryMesh->ReleaseResources(); OrdinaryMesh->RemoveFromRoot(); OrdinaryMesh = nullptr;
        for (auto*& Component : Components) { Component->UnregisterComponent(); Component->RemoveFromRoot(); Component->DestroyComponent(); Component = nullptr; }
        Mesh->ReleaseResources(); Mesh->RemoveFromRoot(); Mesh = nullptr;
        if (SavedViewTarget.IsValid()) Controller->SetViewTarget(SavedViewTarget.Get());
        Camera->Destroy(); Camera.Reset();
        ENQUEUE_RENDER_COMMAND(RemoveWebSceneCullObserver)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Pending.IsEmpty()); Nanite::GetWebSceneCullDelegate().Remove(Observer);
            Nanite::GetWebSceneDepthDelegate().Remove(DepthObserver);
        });
        LastStep = Step; return 1;
    }
    LastStep = Step;
    ENQUEUE_RENDER_COMMAND(RequestWebSceneCull)([Step](FRHICommandListImmediate&) {
        check(!Requested && !Report && Pending.IsEmpty()); ActiveStep = Step; Requested = true; SettledFrames = 0;
        MAIN_THREAD_ASYNC_EM_ASM({
            if ($0 >= 20) globalThis.__webNaniteSceneDepthTest = ({pending:true,step:$0});
            else globalThis.__webNaniteSceneCullTest = ({pending:true,step:$0});
        }, Step);
    });
    return 1;
}
