#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/StaticMeshComponent.h"
#include "WebNaniteSkinningComponent.h"
#include "Engine/Engine.h"
#include "Engine/SkeletalMesh.h"
#include "Rendering/SkeletalMeshRenderData.h"
#include "Engine/World.h"
#include "StaticMeshResources.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Rendering/NaniteWebMaterial.h"
#include "Rendering/NaniteWebGBuffer.h"
#include "Rendering/NaniteStreamingManager.h"
#include "RenderingThread.h"
#include "SceneView.h"
#include "PrimitiveSceneProxy.h"
#include "HAL/IConsoleManager.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include <emscripten.h>

namespace
{
USkeletalMesh* Mesh;
UWebNaniteSkinningComponent* Components[2]{};
UMaterialInstanceDynamic* Materials[6]{};
FPrimitiveComponentId IDs[2];
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> PlayerController;
FDelegateHandle BufferObserver, CompositionObserver, Tick;
const TCHAR* CVarNames[] = {TEXT("r.Nanite.WebResidentSceneDepth"), TEXT("r.Nanite.WebResidentGBuffer"),
    TEXT("r.Nanite.WebMaterialGraphs"), TEXT("r.Nanite.WebHZB"), TEXT("r.Nanite.MaxPixelsPerEdge"),
    TEXT("r.AntiAliasingMethod"), TEXT("r.ViewDistanceScale"), TEXT("r.Skinning.DefaultAnimationMinScreenSize")};
float SavedCVars[UE_ARRAY_COUNT(CVarNames)];
int Step = 0, Settled = 0;
int MotionStep = 0, TickIndex = 0;
uint32 LastFrame = MAX_uint32;
TMap<uint32, FMatrix> PreviousTransforms;
bool Requested = false;
TSharedPtr<FJsonObject> Report;
struct FCopy { FString Name; uint32 Bytes; TUniquePtr<FRHIGPUBufferReadback> Readback; };
TArray<FCopy> Copies;
TArray<TSharedPtr<FJsonValue>> Matrix(const FMatrix& M)
{
    TArray<TSharedPtr<FJsonValue>> R;
    for (int Y = 0; Y < 4; ++Y) for (int X = 0; X < 4; ++X) R.Add(MakeShared<FJsonValueNumber>(M.M[Y][X]));
    return R;
}
void Copy(FRDGBuilder& Graph, FRDGBufferRef Buffer, const TCHAR* Name)
{
    check(Buffer); auto& C = Copies.AddDefaulted_GetRef(); C.Name = Name; C.Bytes = Buffer->Desc.GetSize();
    C.Readback = MakeUnique<FRHIGPUBufferReadback>(Name); AddEnqueueCopyPass(Graph, C.Readback.Get(), Buffer, C.Bytes);
}
void ObserveBuffer(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebGBufferTargets& Targets)
{
    // Capture consecutive transforms even between requested snapshots so the
    // velocity oracle compares the same two frames as the native material pass.
    TMap<uint32, FMatrix> Old = MoveTemp(PreviousTransforms);
    for (const auto& E : Saved.Cull->Entries) PreviousTransforms.Add(E.InstanceSceneDataOffset, E.LocalToWorld);
    const uint32 Frame = Saved.Cull->View->Family->FrameNumber;
    const bool Consecutive = Frame == LastFrame + 1; LastFrame = Frame;
    if (!Requested) return;
    const int Expected = Step == 14 || Step == 16 ? 1 : 2;
    if (!Consecutive || Saved.Cull->Entries.Num() != Expected || Old.Num() != Expected) { Settled = 0; return; }
    if (Step == 27 ? !Saved.Cull->View->bCameraCut : ++Settled < 16) return;
    Requested = false; Report = MakeShared<FJsonObject>();
    const auto& View = *Saved.Cull->View; const auto Rect = Saved.Raster.Rect;
    Report->SetNumberField(TEXT("step"), Step); Report->SetNumberField(TEXT("frame"), View.Family->FrameNumber);
    Report->SetNumberField(TEXT("renderFrame"), GFrameNumberRenderThread);
    Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(uint32(Rect.Width()), 8u));
    Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(uint32(Rect.Height()), 8u));
    Report->SetNumberField(TEXT("viewWidth"), Rect.Width()); Report->SetNumberField(TEXT("viewHeight"), Rect.Height());
    Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected);
    Report->SetBoolField(TEXT("perspective"), View.IsPerspectiveProjection());
    Report->SetArrayField(TEXT("worldToClip"), Matrix(View.ViewMatrices.GetWorldToClip()));
    Report->SetArrayField(TEXT("translatedWorldToClip"), Matrix(View.ViewMatrices.GetTranslatedWorldToClip()));
    const FVector Translation = View.ViewMatrices.GetPreViewTranslation();
    Report->SetArrayField(TEXT("preViewTranslation"), {MakeShared<FJsonValueNumber>(Translation.X),
        MakeShared<FJsonValueNumber>(Translation.Y), MakeShared<FJsonValueNumber>(Translation.Z)});
    Report->SetNumberField(TEXT("jitterX"), View.ViewMatrices.GetTemporalAAJitter().X);
    Report->SetNumberField(TEXT("jitterY"), View.ViewMatrices.GetTemporalAAJitter().Y);
    TArray<TSharedPtr<FJsonValue>> Entries;
    for (int I = 0; I < Saved.Cull->Entries.Num(); ++I)
    {
        const auto& E = Saved.Cull->Entries[I]; auto J = MakeShared<FJsonObject>();
        int Component = -1; for (int K = 0; K < 2; ++K) if (IDs[K] == E.ComponentId) Component = K;
        J->SetNumberField(TEXT("component"), Component); J->SetNumberField(TEXT("instance"), E.InstanceSceneDataOffset);
        J->SetNumberField(TEXT("clusterBase"), Saved.Raster.ClusterBases[I]);
        J->SetNumberField(TEXT("clusterCount"), E.Input.MaxVisibleClusters);
        check(Component >= 0 && Component < 2);
        const auto& Pose = GWebSkinningPoses[Component];
        J->SetBoolField(TEXT("skinning"), E.Input.Skinning);
        J->SetNumberField(TEXT("animationMinScreenSize"), E.Proxy->GetAnimationMinScreenSize());
        J->SetNumberField(TEXT("poseFrame"), Pose.Frame);
        TArray<TSharedPtr<FJsonValue>> Bones, PreviousBones;
        for (int Bone = 0; Bone < 2; ++Bone)
        {
            Bones.Add(MakeShared<FJsonValueArray>(Matrix(Pose.Bones[Bone])));
            PreviousBones.Add(MakeShared<FJsonValueArray>(Matrix(Pose.Frame == GFrameNumberRenderThread ? Pose.PreviousBones[Bone] : Pose.Bones[Bone])));
        }
        J->SetArrayField(TEXT("bones"), Bones); J->SetArrayField(TEXT("previousBones"), PreviousBones);
        J->SetBoolField(TEXT("evaluateWPO"), E.EvaluateWPO); J->SetBoolField(TEXT("unboundedWPO"), E.UnboundedWPO);
        J->SetArrayField(TEXT("localWPOExtent"), {MakeShared<FJsonValueNumber>(E.LocalWPOExtent.X),
            MakeShared<FJsonValueNumber>(E.LocalWPOExtent.Y), MakeShared<FJsonValueNumber>(E.LocalWPOExtent.Z)});
        J->SetArrayField(TEXT("localToWorld"), Matrix(E.LocalToWorld));
        if (!Old.Contains(E.InstanceSceneDataOffset)) { Report.Reset(); Requested = true; Settled = 0; return; }
        J->SetArrayField(TEXT("previousLocalToWorld"), Matrix(Old[E.InstanceSceneDataOffset]));
        Entries.Add(MakeShared<FJsonValueObject>(J));
    }
    Report->SetArrayField(TEXT("entries"), Entries);
    Copy(Graph, Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Targets, 8), TEXT("gbuffer"));
}
void ObserveComposition(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebCompositionSnapshot& Snapshot)
{
    if (!Report || Report->HasField(TEXT("hasVelocity"))) return;
    check(Report->GetIntegerField(TEXT("frame")) == Saved.Cull->View->Family->FrameNumber);
    Report->SetBoolField(TEXT("hasVelocity"), Snapshot.HasVelocity);
    Report->SetBoolField(TEXT("cameraCut"), Snapshot.CameraCut);
    Report->SetArrayField(TEXT("previousWorldToClip"), Matrix(Snapshot.PreviousWorldToClip));
    Report->SetNumberField(TEXT("previousJitterX"), Snapshot.PreviousJitter.X);
    Report->SetNumberField(TEXT("previousJitterY"), Snapshot.PreviousJitter.Y);
    Copy(Graph, Snapshot.Buffer, TEXT("pixels"));
}
void Poll()
{
    if (!Report || !Report->HasField(TEXT("hasVelocity"))) return;
    for (const auto& C : Copies) if (!C.Readback->IsReady()) return;
    for (auto& C : Copies)
    {
        const auto* Data = static_cast<const uint32*>(C.Readback->Lock(C.Bytes)); check(Data);
        TArray<TSharedPtr<FJsonValue>> Values;
        for (uint32 I = 0; I < C.Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
        C.Readback->Unlock(); Report->SetArrayField(C.Name, Values);
    }
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteSkinningTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
void SetPose(int S, double Phase)
{
    FTransform Root = FTransform::Identity, Bend = FTransform::Identity;
    if (S != 1)
        Bend = FTransform(FRotator(15, 30, 10), FVector(35, 0, 15));
    if (S == 3) Bend = FTransform(FVector(55, 20, -15));
    if (S == 4) Root = FTransform(FRotator(-10, -15, 5), FVector(-15, 10, 0));
    if (S == 5) Bend.SetScale3D(FVector(.8, 1.3, .7));
    if (S == 18) { Root.SetTranslation(FVector(0, -500, 0)); Bend.SetTranslation(FVector(25, -500, 15)); }
    if (S >= 22 && S <= 26 && S != 24)
    {
        Root = FTransform(FRotator(0, 5 * FMath::Sin(Phase * .7), 0), FVector(0, 8 * FMath::Sin(Phase), 0));
        Bend = FTransform(FRotator(15 * FMath::Sin(Phase), 30 * FMath::Cos(Phase), 10 * FMath::Sin(Phase * .7)),
            FVector(35 + 20 * FMath::Sin(Phase), 0, 15 * FMath::Cos(Phase)));
    }
    Components[0]->SetTestPose(Root, Bend);
}
void Animate(UWorld* World, ELevelTick, float)
{
    if (!Camera.IsValid() || World != Camera->GetWorld()) return;
    if (MotionStep == 32) { Components[0]->MarkRenderStateDirty(); return; }
    if (MotionStep < 22 || MotionStep > 26) return;
    const double Phase = ++TickIndex * .043;
    SetPose(MotionStep, Phase);
    Components[0]->SetWorldLocation(FVector(100400, MotionStep == 22 || MotionStep == 24 ? 0 : 25 * FMath::Sin(Phase), 100000));
    Components[0]->SetWorldRotation(MotionStep >= 25 ? FRotator(15 * FMath::Sin(Phase), 25 * FMath::Cos(Phase), 20 * FMath::Sin(Phase * .7)) : FRotator::ZeroRotator);
    Camera->SetActorLocation(FVector(100000, MotionStep == 22 || MotionStep == 23 ? 0 : 30 * FMath::Sin(Phase), 100000));
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteSkinningTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep < 0 || RequestedStep > 33 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebSkinning)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr;
        for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Mesh = LoadObject<USkeletalMesh>(nullptr, TEXT("/Game/WebNaniteSkinning/NaniteSkinPlane.NaniteSkinPlane"));
        if (!Mesh || !Mesh->GetResourceForRendering()) return 0; Mesh->AddToRoot();
        // A missing Nanite path must not be hidden by the skeletal fallback.
        for (auto& LOD : Mesh->GetResourceForRendering()->LODRenderData)
            for (auto& Section : LOD.RenderSections) Section.NumTriangles = 0;
        for (int I = 0; I < 6; ++I)
        {
            const FString Name = I == 0 || I == 5 ? TEXT("NaniteSkinMaterial") : FString::Printf(TEXT("NaniteSkinMaterial%d"), I);
            auto* Parent = LoadObject<UMaterialInterface>(nullptr, *(TEXT("/Game/WebNaniteSkinning/") + Name + TEXT(".") + Name));
            if (!Parent) return 0;
            Materials[I] = UMaterialInstanceDynamic::Create(Parent, GetTransientPackage()); Materials[I]->AddToRoot();
        }
        Materials[5]->SetVectorParameterValue(TEXT("NaniteColor"), FLinearColor(.1f, .7f, .2f));
        PlayerController = World->GetFirstPlayerController(); SavedTarget = PlayerController->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); check(Camera.IsValid());
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        PlayerController->SetViewTarget(Camera.Get());
        Tick = FWorldDelegates::OnWorldTickStart.AddStatic(&Animate);
        for (int I = 0; I < 2; ++I)
        {
            auto*& C = Components[I]; C = NewObject<UWebNaniteSkinningComponent>(); C->AddToRoot(); C->TestIndex = I;
            C->SetCollisionEnabled(ECollisionEnabled::NoCollision); C->SetMobility(EComponentMobility::Movable);
            C->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
            C->SetSkinnedAssetAndUpdate(Mesh); C->SetMaterial(0, Materials[I ? 5 : 0]);
            C->SetWorldLocation(FVector(100400 + 50 * I, 0, 100000));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
            C->SetTestPose(FTransform::Identity, FTransform::Identity);
        }
        const float Values[] = {1, 0, 1, 0, .001f, 0, 1, 0};
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I)
        { auto* C = IConsoleManager::Get().FindConsoleVariable(CVarNames[I]); check(C); SavedCVars[I] = C->GetFloat(); C->Set(Values[I], ECVF_SetByCode); }
        ENQUEUE_RENDER_COMMAND(ObserveWebSkinning)([](FRHICommandListImmediate&) {
            BufferObserver = Nanite::GetWebNativeMaterialGBufferDelegate().AddStatic(&ObserveBuffer);
            CompositionObserver = Nanite::GetWebNativeCompositionDelegate().AddStatic(&ObserveComposition);
        });
    }
    if (RequestedStep == 33)
    {
        FWorldDelegates::OnWorldTickStart.Remove(Tick);
        for (auto* C : Components) { C->RemoveFromRoot(); C->DestroyComponent(); }
        for (auto* M : Materials) M->RemoveFromRoot(); Mesh->RemoveFromRoot();
        if (PlayerController.IsValid()) PlayerController->SetViewTarget(SavedTarget.Get()); if (Camera.IsValid()) Camera->Destroy();
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I) IConsoleManager::Get().FindConsoleVariable(CVarNames[I])->Set(SavedCVars[I], ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveWebSkinning)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Copies.IsEmpty());
            Nanite::GetWebNativeMaterialGBufferDelegate().Remove(BufferObserver);
            Nanite::GetWebNativeCompositionDelegate().Remove(CompositionObserver);
            PreviousTransforms.Empty();
        }); Last = RequestedStep; return 1;
    }
    const int S = RequestedStep; MotionStep = S; TickIndex = 0;
    auto* Front = Components[0];
    Front->SetWorldLocation(FVector(S == 19 ? 100500 : 100400, S == 18 ? 500 : 0, 100000));
    Front->SetWorldScale3D(S == 7 || S == 9 || S == 25 ? FVector(1, -1, 1) : S == 6 ? FVector(.75, 1.4, .6) : FVector::OneVector);
    Front->SetWorldRotation(S == 8 ? FRotator(0, 180, 0) : S == 6 ? FRotator(15, 10, 5) : FRotator::ZeroRotator);
    Front->SetEvaluateWorldPositionOffset(S != 30);
    Front->SetWorldPositionOffsetDisableDistance(S == 31 ? 100 : 0);
    Front->SetVisibility(S != 14);
    if (S == 16) Front->UnregisterComponent();
    const int Material = S == 11 ? 1 : S == 12 || S == 13 || S == 30 || S == 31 ? 2 : S == 8 || S == 9 ? 3 : S == 21 ? 4 : 0;
    Front->SetMaterial(0, Materials[Material]);
    FLinearColor Offset(40, 25, 15), Previous = S == 13 ? FLinearColor(15, -10, -20) : Offset;
    Materials[2]->SetVectorParameterValue(TEXT("NaniteWorldOffset"), Offset);
    Materials[2]->SetVectorParameterValue(TEXT("NanitePreviousWorldOffset"), Previous);
    Materials[2]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 0);
    Materials[1]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 25);
    if (S == 17) { Front->RegisterComponentWithWorld(Components[1]->GetWorld()); IDs[0] = Front->GetPrimitiveSceneId(); }
    SetPose(S, 0);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->Set(S >= 18 && S <= 20 ? 1 : 0, ECVF_SetByCode);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.Skinning.DefaultAnimationMinScreenSize"))->Set(S == 28 ? 10000 : 0, ECVF_SetByCode);
    Camera->SetActorLocation(FVector(100000, 0, 100000));
    auto* C = Camera->GetCameraComponent();
    C->SetProjectionMode(S == 10 ? ECameraProjectionMode::Orthographic : ECameraProjectionMode::Perspective);
    C->SetOrthoWidth(800); C->bAutoCalculateOrthoPlanes = false; C->SetOrthoNearClipPlane(1); C->SetOrthoFarClipPlane(2000);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.AntiAliasingMethod"))->Set(S == 26 || S == 27 ? 2 : 0, ECVF_SetByCode);
    if (S == 27) PlayerController->PlayerCameraManager->SetGameCameraCutThisFrame();
    ENQUEUE_RENDER_COMMAND(RequestWebSkinning)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && Copies.IsEmpty()); Step = RequestedStep; Requested = true; Settled = 0;
    }); Last = S; return 1;
}
