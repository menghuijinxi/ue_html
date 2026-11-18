#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Camera/PlayerCameraManager.h"
#include "Camera/CameraComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInterface.h"
#include "Rendering/NaniteWebMaterial.h"
#include "Rendering/NaniteWebRaster.h"
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
namespace
{
UStaticMesh* Mesh;
UStaticMeshComponent* Components[3]{};
UStaticMeshComponent* Occluder;
FPrimitiveComponentId IDs[3];
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FDelegateHandle Observer, Tick;
const TCHAR* CVarNames[] = {TEXT("r.Nanite.WebResidentSceneDepth"), TEXT("r.Nanite.WebResidentGBuffer"), TEXT("r.Nanite.WebMaterialGraphs"), TEXT("r.Nanite.WebHZB"), TEXT("r.Nanite.MaxPixelsPerEdge")};
float SavedCVars[5];
int Step = 0, MotionStep = 0, Settled = 0, TickIndex = 0;
uint32 LastFrame = MAX_uint32, Bytes = 0;
bool Requested = false;
TMap<uint32, FMatrix> PreviousTransforms;
TUniquePtr<FRHIGPUBufferReadback> Readback;
TSharedPtr<FJsonObject> Report;
TArray<TSharedPtr<FJsonValue>> Matrix(const FMatrix& M)
{
    TArray<TSharedPtr<FJsonValue>> Result;
    for (int R = 0; R < 4; ++R) for (int C = 0; C < 4; ++C) Result.Add(MakeShared<FJsonValueNumber>(M.M[R][C]));
    return Result;
}
void Observe(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebCompositionSnapshot& Snapshot)
{
    const auto& View = *Saved.Cull->View; const uint32 Frame = View.Family->FrameNumber;
    TMap<uint32, FMatrix> Old = MoveTemp(PreviousTransforms);
    for (const auto& E : Saved.Cull->Entries) PreviousTransforms.Add(E.InstanceSceneDataOffset, FMatrix(E.LocalToWorld));
    const bool Consecutive = Frame == LastFrame + 1; LastFrame = Frame;
    if (!Requested) return;
    if (!Consecutive || Saved.Cull->Entries.Num() != 3 || Old.Num() != 3) { Settled = 0; return; }
    if (Step == 9 ? !Snapshot.CameraCut : ++Settled < 12) return;
    Requested = false; Report = MakeShared<FJsonObject>();
    const auto Rect = Saved.Raster.Rect;
    Report->SetNumberField(TEXT("step"), Step); Report->SetNumberField(TEXT("frame"), Frame);
    Report->SetNumberField(TEXT("width"), Snapshot.Size.X); Report->SetNumberField(TEXT("height"), Snapshot.Size.Y);
    Report->SetNumberField(TEXT("viewWidth"), Rect.Width()); Report->SetNumberField(TEXT("viewHeight"), Rect.Height());
    Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected); Report->SetBoolField(TEXT("hasVelocity"), Snapshot.HasVelocity);
    Report->SetBoolField(TEXT("hasLightingChannels"), Snapshot.HasLightingChannels); Report->SetBoolField(TEXT("cameraCut"), Snapshot.CameraCut);
    Report->SetArrayField(TEXT("worldToClip"), Matrix(View.ViewMatrices.GetViewProjectionMatrix()));
    Report->SetArrayField(TEXT("previousWorldToClip"), Matrix(Snapshot.PreviousWorldToClip));
    const auto Jitter = View.ViewMatrices.GetTemporalAAJitter();
    TArray<TSharedPtr<FJsonValue>> Jitters;
    for (double V : {Jitter.X, Jitter.Y, Snapshot.PreviousJitter.X, Snapshot.PreviousJitter.Y}) Jitters.Add(MakeShared<FJsonValueNumber>(V));
    Report->SetArrayField(TEXT("jitter"), Jitters);
    TArray<TSharedPtr<FJsonValue>> Entries;
    for (const auto& E : Saved.Cull->Entries)
    {
        auto J = MakeShared<FJsonObject>(); int Component = -1;
        for (int K = 0; K < 3; ++K) if (IDs[K] == E.ComponentId) Component = K;
        J->SetNumberField(TEXT("component"), Component); J->SetNumberField(TEXT("instance"), E.InstanceSceneDataOffset);
        J->SetArrayField(TEXT("localToWorld"), Matrix(FMatrix(E.LocalToWorld)));
        check(Old.Contains(E.InstanceSceneDataOffset));
        J->SetArrayField(TEXT("previousLocalToWorld"), Matrix(Old[E.InstanceSceneDataOffset]));
        Entries.Add(MakeShared<FJsonValueObject>(J));
    }
    Report->SetArrayField(TEXT("entries"), Entries);
    Bytes = Snapshot.Buffer->Desc.GetSize(); Readback = MakeUnique<FRHIGPUBufferReadback>(TEXT("Nanite.Web.CompositionTest"));
    AddEnqueueCopyPass(Graph, Readback.Get(), Snapshot.Buffer, Bytes);
}
void Poll()
{
    if (!Report || !Readback->IsReady()) return;
    const auto* Data = static_cast<const uint32*>(Readback->Lock(Bytes)); check(Data);
    TArray<TSharedPtr<FJsonValue>> Values;
    for (uint32 I = 0; I < Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
    Readback->Unlock(); Report->SetArrayField(TEXT("pixels"), Values);
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteCompositionTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Readback.Reset(); Report.Reset();
}
void Animate(UWorld* World, ELevelTick, float)
{
    if (!Camera.IsValid() || World != Camera->GetWorld()) return;
    const double Phase = ++TickIndex * 0.043;
    const bool MoveObject = MotionStep == 2 || MotionStep == 5 || MotionStep == 7 || MotionStep == 8;
    const bool MoveCamera = MotionStep == 3 || MotionStep == 5;
    Components[0]->SetWorldLocation(FVector(100400, -160 + (MoveObject ? 25 * FMath::Sin(Phase) : 0), 100000));
    Components[0]->SetWorldRotation(MotionStep == 4 ? FRotator(Phase * 13, Phase * 27, Phase * 19) : FRotator::ZeroRotator);
    Camera->SetActorLocation(FVector(100000, MoveCamera ? 30 * FMath::Sin(Phase) : 0, 100000));
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteCompositionTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep < 0 || RequestedStep > 10 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebComposition)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        auto* Material = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/WebNaniteMaterials/NaniteMaterial1.NaniteMaterial1")); if (!Material) return 0;
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); check(Camera.IsValid());
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get()); Mesh = CreateWebNaniteDepthFixture(); check(Mesh);
        for (int I = 0; I < 3; ++I)
        {
            auto*& C = Components[I]; C = NewObject<UStaticMeshComponent>(); C->AddToRoot();
            C->SetCollisionEnabled(ECollisionEnabled::NoCollision); C->SetMobility(EComponentMobility::Movable);
            C->SetStaticMesh(Mesh); C->SetMaterial(0, Material); C->SetWorldLocation(FVector(100400, (I - 1) * 160, 100000));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        Occluder = NewObject<UStaticMeshComponent>(); Occluder->AddToRoot(); Occluder->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        Occluder->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"))); Occluder->SetMaterial(0, Material);
        Occluder->SetWorldLocation(FVector(100260, 0, 100000)); Occluder->SetWorldScale3D(FVector(0.5, 0.8, 0.8));
        Occluder->SetVisibility(false); Occluder->RegisterComponentWithWorld(World);
        const float Values[] = {1, 0, 1, 0, 0.01f};
        for (int I = 0; I < 5; ++I) { auto* C = IConsoleManager::Get().FindConsoleVariable(CVarNames[I]); check(C); SavedCVars[I] = C->GetFloat(); C->Set(Values[I], ECVF_SetByCode); }
        Tick = FWorldDelegates::OnWorldTickStart.AddStatic(&Animate);
        ENQUEUE_RENDER_COMMAND(ObserveWebComposition)([](FRHICommandListImmediate&) { Observer = Nanite::GetWebNativeCompositionDelegate().AddStatic(&Observe); });
    }
    MotionStep = RequestedStep;
    Components[0]->SetWorldScale3D(RequestedStep == 4 ? FVector(-0.8, 1.2, 0.9) : FVector::OneVector);
    if (RequestedStep == 6) for (int I = 0; I < 3; ++I)
    {
        Components[I]->SetLightingChannels(I == 0, I == 1, I == 2);
        Components[I]->SetReceivesDecals(I != 1); Components[I]->SetCastShadow(I != 2);
    }
    if (RequestedStep == 7) Occluder->SetVisibility(true);
    if (RequestedStep == 8)
    {
        Occluder->SetVisibility(false); Camera->GetCameraComponent()->SetProjectionMode(ECameraProjectionMode::Orthographic);
        Camera->GetCameraComponent()->SetOrthoWidth(800); Camera->GetCameraComponent()->bAutoCalculateOrthoPlanes = false;
        Camera->GetCameraComponent()->SetOrthoNearClipPlane(1); Camera->GetCameraComponent()->SetOrthoFarClipPlane(2000);
    }
    if (RequestedStep == 9) { Camera->GetCameraComponent()->SetProjectionMode(ECameraProjectionMode::Perspective); Controller->PlayerCameraManager->SetGameCameraCutThisFrame(); }
    if (RequestedStep == 10)
    {
        FWorldDelegates::OnWorldTickStart.Remove(Tick);
        for (auto* C : Components) { C->RemoveFromRoot(); C->DestroyComponent(); }
        Occluder->RemoveFromRoot(); Occluder->DestroyComponent(); Mesh->RemoveFromRoot();
        if (Controller.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); if (Camera.IsValid()) Camera->Destroy();
        for (int I = 0; I < 5; ++I) IConsoleManager::Get().FindConsoleVariable(CVarNames[I])->Set(SavedCVars[I], ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveWebComposition)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && !Readback); Nanite::GetWebNativeCompositionDelegate().Remove(Observer); PreviousTransforms.Empty();
        }); Last = 10; return 1;
    }
    ENQUEUE_RENDER_COMMAND(RequestWebComposition)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && !Readback); Step = RequestedStep; Requested = true; Settled = 0;
    }); Last = RequestedStep; return 1;
}
