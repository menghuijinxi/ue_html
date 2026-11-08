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
#include "RenderingThread.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

UStaticMesh* CreateWebNaniteSceneFixture();

namespace
{
UStaticMesh* Mesh;
UStaticMeshComponent* Components[2];
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedViewTarget;
TWeakObjectPtr<APlayerController> Controller;
FPrimitiveComponentId IDs[2];
FDelegateHandle Observer;
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

TArray<TSharedPtr<FJsonValue>> MatrixJSON(const FMatrix& Matrix)
{
    TArray<TSharedPtr<FJsonValue>> Values;
    for (int32 Row = 0; Row < 4; ++Row) for (int32 Col = 0; Col < 4; ++Col)
        Values.Add(MakeShared<FJsonValueNumber>(Matrix.M[Row][Col]));
    return Values;
}

void Observe(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& View)
{
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
    for (const auto& Entry : View.Entries)
    {
        const int Index = Entry.ComponentId == IDs[0] ? 0 : Entry.ComponentId == IDs[1] ? 1 : -1;
        if (Index < 0) continue;
        auto& Copy = Pending.AddDefaulted_GetRef();
        Copy.Capacity = Entry.Input.MaxVisibleClusters; Copy.Json = MakeShared<FJsonObject>();
        Copy.Json->SetNumberField(TEXT("component"), Index);
        Copy.Json->SetNumberField(TEXT("id"), Entry.RuntimeResourceID);
        Copy.Json->SetNumberField(TEXT("page"), Entry.Input.FirstRootPage);
        Copy.Json->SetNumberField(TEXT("levels"), Entry.Input.MaxLevels);
        Copy.Json->SetArrayField(TEXT("localToWorld"), MatrixJSON(Entry.LocalToWorld));
        Copy.Keys = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebSceneCullKeys"));
        Copy.State = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebSceneCullState"));
        AddEnqueueCopyPass(Graph, Copy.Keys.Get(), Entry.Result.ClusterKeys, Copy.Capacity * 4);
        AddEnqueueCopyPass(Graph, Copy.State.Get(), Entry.Result.State, 16);
    }
}

void Poll()
{
    if (!Report) return;
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
    if (Step < 0 || Step > 11 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
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
        for (auto*& Component : Components) { Component->UnregisterComponent(); Component->RemoveFromRoot(); Component->DestroyComponent(); Component = nullptr; }
        Mesh->ReleaseResources(); Mesh->RemoveFromRoot(); Mesh = nullptr;
        if (SavedViewTarget.IsValid()) Controller->SetViewTarget(SavedViewTarget.Get());
        Camera->Destroy(); Camera.Reset();
        ENQUEUE_RENDER_COMMAND(RemoveWebSceneCullObserver)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Pending.IsEmpty()); Nanite::GetWebSceneCullDelegate().Remove(Observer);
        });
        LastStep = Step; return 1;
    }
    LastStep = Step;
    ENQUEUE_RENDER_COMMAND(RequestWebSceneCull)([Step](FRHICommandListImmediate&) {
        check(!Requested && !Report && Pending.IsEmpty()); ActiveStep = Step; Requested = true; SettledFrames = 0;
        MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteSceneCullTest = ({pending:true,step:$0});}, Step);
    });
    return 1;
}
