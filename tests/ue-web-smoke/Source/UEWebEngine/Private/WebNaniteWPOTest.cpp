#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "StaticMeshResources.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Rendering/NaniteWebMaterial.h"
#include "Rendering/NaniteWebGBuffer.h"
#include "Rendering/NaniteStreamingManager.h"
#include "RenderingThread.h"
#include "SceneView.h"
#include "HAL/IConsoleManager.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include <emscripten.h>

namespace
{
UStaticMesh* Mesh;
UStaticMeshComponent* Components[2]{};
UMaterialInstanceDynamic* Materials[5]{};
FPrimitiveComponentId IDs[2];
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FDelegateHandle BufferObserver, CompositionObserver, Tick;
const TCHAR* CVarNames[] = {TEXT("r.Nanite.WebResidentSceneDepth"), TEXT("r.Nanite.WebResidentGBuffer"),
    TEXT("r.Nanite.WebMaterialGraphs"), TEXT("r.Nanite.WebHZB"), TEXT("r.Nanite.MaxPixelsPerEdge"),
    TEXT("r.AntiAliasingMethod"), TEXT("r.ViewDistanceScale")};
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
    const int Expected = Step == 22 || Step == 24 ? 1 : 2;
    if (!Consecutive || Saved.Cull->Entries.Num() != Expected || Old.Num() != Expected) { Settled = 0; return; }
    if (Step == 36 ? !Saved.Cull->View->bCameraCut : ++Settled < 16) return;
    Requested = false; Report = MakeShared<FJsonObject>();
    const auto& View = *Saved.Cull->View; const auto Rect = Saved.Raster.Rect;
    Report->SetNumberField(TEXT("step"), Step); Report->SetNumberField(TEXT("frame"), View.Family->FrameNumber);
    Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(uint32(Rect.Width()), 8u));
    Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(uint32(Rect.Height()), 8u));
    Report->SetNumberField(TEXT("viewWidth"), Rect.Width()); Report->SetNumberField(TEXT("viewHeight"), Rect.Height());
    Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected);
    Report->SetBoolField(TEXT("perspective"), View.IsPerspectiveProjection());
    Report->SetArrayField(TEXT("worldToClip"), Matrix(View.ViewMatrices.GetViewProjectionMatrix()));
    Report->SetArrayField(TEXT("translatedWorldToClip"), Matrix(View.ViewMatrices.GetTranslatedViewProjectionMatrix()));
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
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteWPOTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
void Animate(UWorld* World, ELevelTick, float)
{
    if (!Camera.IsValid() || World != Camera->GetWorld() || MotionStep < 30) return;
    const double Phase = ++TickIndex * .043;
    Components[0]->SetWorldLocation(FVector(100400, MotionStep == 31 ? 0 : 25 * FMath::Sin(Phase), 100000));
    // Keep enough of the moving surface visible for the velocity sample count
    // regardless of how many frames elapse between asynchronous RPC requests.
    Components[0]->SetWorldRotation(MotionStep >= 33 ? FRotator(25 * FMath::Sin(Phase),
        35 * FMath::Cos(Phase), 30 * FMath::Sin(Phase * .7)) : FRotator::ZeroRotator);
    Camera->SetActorLocation(FVector(100000, MotionStep == 30 ? 0 : 30 * FMath::Sin(Phase), 100000));
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteWPOTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep < 0 || RequestedStep > 37 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebWPO)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr;
        for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Mesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Game/WebNaniteProgrammable/NaniteWPOPlane.NaniteWPOPlane"));
        if (!Mesh || !Mesh->GetRenderData()) return 0; Mesh->AddToRoot();
        // No fallback triangle may hide a failed programmable Nanite path.
        for (auto& LOD : Mesh->GetRenderData()->LODResources) for (auto& Section : LOD.Sections) Section.NumTriangles = 0;
        for (int I = 0; I < 5; ++I)
        {
            const int N = I < 4 ? I + 4 : 1;
            auto* Parent = LoadObject<UMaterialInterface>(nullptr,
                *FString::Printf(TEXT("/Game/WebNaniteProgrammable/NaniteProgrammable%d.NaniteProgrammable%d"), N, N));
            if (!Parent) return 0;
            Materials[I] = UMaterialInstanceDynamic::Create(Parent, GetTransientPackage()); Materials[I]->AddToRoot();
        }
        Materials[4]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 0);
        Materials[4]->SetVectorParameterValue(TEXT("NaniteColor"), FLinearColor(.1f, .7f, .2f));
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); check(Camera.IsValid());
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        Tick = FWorldDelegates::OnWorldTickStart.AddStatic(&Animate);
        for (int I = 0; I < 2; ++I)
        {
            auto*& C = Components[I]; C = NewObject<UStaticMeshComponent>(); C->AddToRoot();
            C->SetCollisionEnabled(ECollisionEnabled::NoCollision); C->SetMobility(EComponentMobility::Movable);
            C->SetStaticMesh(Mesh); for (int Slot = 0; Slot < 2; ++Slot) C->SetMaterial(Slot, Materials[I ? 4 : 0]);
            C->SetWorldLocation(FVector(100400 + 30 * I, 0, 100000));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        const float Values[] = {1, 0, 1, 0, .001f, 0, 1};
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I)
        { auto* C = IConsoleManager::Get().FindConsoleVariable(CVarNames[I]); check(C); SavedCVars[I] = C->GetFloat(); C->Set(Values[I], ECVF_SetByCode); }
        ENQUEUE_RENDER_COMMAND(ObserveWebWPO)([](FRHICommandListImmediate&) {
            BufferObserver = Nanite::GetWebNativeMaterialGBufferDelegate().AddStatic(&ObserveBuffer);
            CompositionObserver = Nanite::GetWebNativeCompositionDelegate().AddStatic(&ObserveComposition);
        });
    }
    if (RequestedStep == 37)
    {
        FWorldDelegates::OnWorldTickStart.Remove(Tick);
        for (auto* C : Components) { C->RemoveFromRoot(); C->DestroyComponent(); }
        for (auto* M : Materials) M->RemoveFromRoot(); Mesh->RemoveFromRoot();
        if (Controller.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); if (Camera.IsValid()) Camera->Destroy();
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I) IConsoleManager::Get().FindConsoleVariable(CVarNames[I])->Set(SavedCVars[I], ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveWebWPO)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Copies.IsEmpty());
            Nanite::GetWebNativeMaterialGBufferDelegate().Remove(BufferObserver);
            Nanite::GetWebNativeCompositionDelegate().Remove(CompositionObserver);
            PreviousTransforms.Empty();
        }); Last = RequestedStep; return 1;
    }
    const int S = RequestedStep;
    MotionStep = S;
    auto* Front = Components[0];
    Front->SetWorldLocation(FVector(100400, S == 15 ? 550 : S == 16 || S == 17 ? 480 : 0, 100000));
    Front->SetWorldScale3D(S == 4 ? FVector(.75, 1.4, .6) : S == 5 || S >= 33 ? FVector(1, -1, 1) : FVector::OneVector);
    Front->SetWorldRotation(S == 4 ? FRotator(15, 10, 5) : FRotator(0, S == 19 || S == 20 ? 180 : 0, 0));
    Front->SetReverseCulling(S == 20);
    Front->SetEvaluateWorldPositionOffset(S != 8 && S != 14 && S != 26 && S != 29);
    Front->SetWorldPositionOffsetDisableDistance(S == 10 || S == 27 ? 399 : S == 11 ? 400 : S == 12 || S == 28 ? 401 : S == 13 ? 250 : S == 14 || S == 26 || S == 29 ? 1 : 0);
    Front->SetVisibility(S != 22);
    if (S == 24) Front->UnregisterComponent();
    if (S == 25) { Front->RegisterComponentWithWorld(Components[1]->GetWorld()); IDs[0] = Front->GetPrimitiveSceneId(); }
    const int Material = S == 6 ? 1 : S == 14 || S == 15 ? 3 : S >= 18 && S <= 20 ? 2 : 0;
    const bool Mixed = S >= 26 && S <= 29;
    for (int Slot = 0; Slot < 2; ++Slot)
        Front->SetMaterial(Slot, Materials[Mixed ? ((Slot == 1) != (S == 29) ? 3 : 0) : Material]);
    FLinearColor Offset(40, 25, 15), Previous = Offset;
    if (S == 1) Offset = Previous = FLinearColor::Black;
    if (S == 3 || S >= 30) Previous = FLinearColor(15, -10, -20);
    if (S == 7) Offset = Previous = FLinearColor(240, -180, 300);
    if (S == 15) Offset = Previous = FLinearColor(-50, -300, 0);
    if (S == 16 || S == 17) Offset = Previous = FLinearColor(0, -120, 0);
    Materials[Material]->SetVectorParameterValue(TEXT("NaniteWorldOffset"), Offset);
    Materials[Material]->SetVectorParameterValue(TEXT("NanitePreviousWorldOffset"), Previous);
    Materials[Material]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), S == 6 ? 80 : 0);
    if (Mixed)
    {
        Materials[3]->SetVectorParameterValue(TEXT("NaniteWorldOffset"), FLinearColor(20, -30, 35));
        Materials[3]->SetVectorParameterValue(TEXT("NanitePreviousWorldOffset"), FLinearColor(20, -30, 35));
    }
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->Set(S == 17 ? 1 : 0, ECVF_SetByCode);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.ViewDistanceScale"))->Set(S == 13 ? 2.0f : 1.0f, ECVF_SetByCode);
    auto* C = Camera->GetCameraComponent();
    C->SetProjectionMode(S == 21 || S == 34 ? ECameraProjectionMode::Orthographic : ECameraProjectionMode::Perspective);
    C->SetOrthoWidth(800); C->bAutoCalculateOrthoPlanes = false; C->SetOrthoNearClipPlane(1); C->SetOrthoFarClipPlane(2000);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.AntiAliasingMethod"))->Set(S >= 35 ? 2 : 0, ECVF_SetByCode);
    if (S == 36) Controller->PlayerCameraManager->SetGameCameraCutThisFrame();
    ENQUEUE_RENDER_COMMAND(RequestWebWPO)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && Copies.IsEmpty()); Step = RequestedStep; Requested = true; Settled = 0;
    }); Last = S; return 1;
}
