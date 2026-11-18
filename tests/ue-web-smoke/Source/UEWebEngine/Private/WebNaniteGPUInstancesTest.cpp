#include "CoreMinimal.h"
#include "WebNaniteGPUComponent.h"
#include "InstanceDataSceneProxy.h"
#include "PrimitiveSceneProxy.h"
#include "PrimitiveSceneInfo.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/StaticMeshComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SplineMeshComponent.h"
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
int MotionStep = 0, MotionFrame = 0;
float PreviousPhase = 0;
bool PhaseStressRequested = false;
bool UnboundedPhaseRequested = false;
bool CaptureWriterFinal = false;
bool RecreateEveryFrame = false;
const TCHAR* CVarNames[] = {TEXT("r.Nanite.WebResidentSceneDepth"), TEXT("r.Nanite.WebResidentGBuffer"),
    TEXT("r.Nanite.WebMaterialGraphs"), TEXT("r.Nanite.WebHZB"), TEXT("r.Nanite.MaxPixelsPerEdge"),
    TEXT("r.AntiAliasingMethod"), TEXT("r.ViewDistanceScale"), TEXT("r.Nanite.AllowProgrammableDistances"), TEXT("r.Nanite.Culling.WPODisableDistance"), TEXT("r.Nanite.Culling.DrawDistance")};
float SavedCVars[UE_ARRAY_COUNT(CVarNames)];
int Step = 0, Settled = 0;
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
    const int Expected = Step == 17 || Step == 19 ? 1 : Step == 21 ? 6 : Step >= 22 ? 3 : 4;
    if (!Consecutive || Saved.Cull->Entries.Num() != Expected || Old.Num() != Expected) { Settled = 0; return; }
    if (++Settled < 16 || (!GWebGPUInstanceLegacyWriter && Expected > 1 && GWebGPUInstanceTestFrame.Step != uint32(Step))) return;
    Requested = false; Report = MakeShared<FJsonObject>();
    const auto& View = *Saved.Cull->View; const auto Rect = Saved.Raster.Rect;
    Report->SetNumberField(TEXT("step"), Step); Report->SetNumberField(TEXT("frame"), View.Family->FrameNumber);
    Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(uint32(Rect.Width()), 8u));
    Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(uint32(Rect.Height()), 8u));
    Report->SetNumberField(TEXT("viewWidth"), Rect.Width()); Report->SetNumberField(TEXT("viewHeight"), Rect.Height());
    Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected);
    Report->SetNumberField(TEXT("phase"), GWebGPUInstanceTestFrame.Phase);
    Report->SetNumberField(TEXT("previousPhase"), GWebGPUInstanceTestFrame.PreviousPhase);
    Report->SetNumberField(TEXT("gpuCount"), GWebGPUInstanceTestFrame.Count);
    Report->SetNumberField(TEXT("writerFirst"), GWebGPUInstanceWriterFirst);
    Report->SetNumberField(TEXT("writerPrimitive"), GWebGPUInstanceWriterPrimitive);
    Report->SetNumberField(TEXT("renderFrame"), GFrameNumberRenderThread);
    Report->SetNumberField(TEXT("writerRenderFrame"), GWebGPUInstanceWriterRenderFrame);
    const FVector Origin = View.ViewMatrices.GetViewOrigin();
    Report->SetArrayField(TEXT("viewOrigin"), {MakeShared<FJsonValueNumber>(Origin.X), MakeShared<FJsonValueNumber>(Origin.Y), MakeShared<FJsonValueNumber>(Origin.Z)});
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
        J->SetBoolField(TEXT("pixelProgrammable"), E.PixelProgrammable);
        J->SetBoolField(TEXT("gpuOnly"), E.Input.GPUInstance.Buffer != nullptr);
        if (E.Input.GPUInstance.Buffer)
        {
            check(E.Proxy->GetInstanceSceneDataBuffers()->IsInstanceDataGPUOnly());
            check(E.Proxy->GetInstanceSceneDataBuffers()->GetReadView().InstanceToPrimitiveRelative.IsEmpty());
            J->SetNumberField(TEXT("relativeInstance"), E.Input.GPUInstance.Offset / Nanite::WebInstanceDataStride);
            J->SetNumberField(TEXT("primitive"), E.Proxy->GetPrimitiveSceneInfo()->GetPersistentIndex().Index);
            if (E.Input.GPUInstance.Offset == 0)
            {
                Copy(Graph, E.Input.GPUInstance.Buffer->Desc.Buffer, TEXT("gpuInstances"));
                if (GWebGPUInstanceWriterSnapshot) Copy(Graph, GWebGPUInstanceWriterSnapshot, TEXT("writerSnapshot"));
                if (CaptureWriterFinal)
                {
                auto* Source = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(16, GWebGPUInstanceTestFrame.Count * 4), TEXT("Nanite.Web.GPUWriterFinal"));
                for (uint32 K = 0; K < GWebGPUInstanceTestFrame.Count; ++K) for (uint32 Row = 0; Row < 4; ++Row)
                {
                    const uint32 ID = GWebGPUInstanceWriterFirst + K;
                    const uint32 Index = GWebGPUInstanceWriterLayout.Z * (ID >> GWebGPUInstanceWriterLayout.X) +
                        (Row << GWebGPUInstanceWriterLayout.X) + (ID & GWebGPUInstanceWriterLayout.Y);
                    AddCopyBufferPass(Graph, Source, (K * 4 + Row) * 16, GWebGPUInstanceWriterSource, Index * 16, 16);
                }
                Copy(Graph, Source, TEXT("writerFinal"));
                }
                Report->SetArrayField(TEXT("primitiveLocalToWorld"), Matrix(E.Proxy->GetLocalToWorld()));
            }
        }
        J->SetBoolField(TEXT("spline"), E.Input.Spline);
        if (E.Input.Spline)
        {
            TArray<TSharedPtr<FJsonValue>> Params;
            for (const auto& P : E.Input.SplineParams) for (int32 K = 0; K < 4; ++K)
            { const float Value = P[K]; uint32 Bits; FMemory::Memcpy(&Bits, &Value, 4); Params.Add(MakeShared<FJsonValueNumber>(Bits)); }
            J->SetArrayField(TEXT("splineParams"), Params);
        }
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
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteGPUInstancesTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}

void Animate(UWorld* World, ELevelTick, float)
{
    if (!Camera.IsValid() || World != Camera->GetWorld() || !Components[0] || MotionStep == 0) return;
    auto* Front = Cast<UWebNaniteGPUComponent>(Components[0]); check(Front);
    // Bound the argument so the independent reference does not confuse GPU
    // trigonometric range-reduction error with instance-transform corruption.
    const bool PhaseStress = MotionStep == 7 && PhaseStressRequested;
    const float ElapsedPhase = float(++MotionFrame) * .043f;
    const float Phase = PhaseStress ? 103.97400665283203f : UnboundedPhaseRequested ? ElapsedPhase : FMath::Fmod(ElapsedPhase, 2.0f * PI);
    WriteWebGPUInstances(Front, {uint32(MotionStep), uint32(Front->GPUInstanceCount), Phase, PhaseStress ? 103.93099975585938f : PreviousPhase});
    if (RecreateEveryFrame) Front->MarkRenderStateDirty();
    PreviousPhase = Phase;
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteGPUInstancesTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep == -1 && Last == 0) { PhaseStressRequested = true; return 1; }
    if (RequestedStep == -2 && Last == 0) { UnboundedPhaseRequested = true; return 1; }
    if (RequestedStep == -3 && Last == 0) { GWebGPUInstanceSnapshotAfterWrite = true; return 1; }
    if (RequestedStep == -4 && Last == 0) { CaptureWriterFinal = true; return 1; }
    if (RequestedStep == -5 && Last == 0) { RecreateEveryFrame = true; return 1; }
    if (RequestedStep == -6 && Last == 0) { GWebGPUInstanceLegacyWriter = true; return 1; }
    if (RequestedStep < 0 || RequestedStep > 30 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
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
            const int N = I == 0 ? 2 : I == 1 ? 5 : I == 2 ? 6 : I == 3 ? -1 : 1;
            auto* Parent = LoadObject<UMaterialInterface>(nullptr,
                N < 0 ? TEXT("/Game/WebNaniteMaterials/NaniteMaterial1.NaniteMaterial1") : *FString::Printf(TEXT("/Game/WebNaniteProgrammable/NaniteProgrammable%d.NaniteProgrammable%d"), N, N));
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
        for (int I = 0; I < 2; ++I)
        {
            auto*& C = Components[I]; C = I ? NewObject<UStaticMeshComponent>() : NewObject<UWebNaniteGPUComponent>(); C->AddToRoot();
            C->bAffectDynamicIndirectLighting = false; C->bAffectDistanceFieldLighting = false;
            C->SetCollisionEnabled(ECollisionEnabled::NoCollision); C->SetMobility(EComponentMobility::Movable);
            C->SetStaticMesh(Mesh); for (int Slot = 0; Slot < 2; ++Slot) C->SetMaterial(Slot, Materials[I ? 4 : 3]);
            C->SetWorldLocation(FVector(100400 + 300 * I, 0, 100000));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        const float Values[] = {1, 0, 1, 0, .001f, 0, 1, 1, 1, 1};
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I)
        { auto* C = IConsoleManager::Get().FindConsoleVariable(CVarNames[I]); check(C); SavedCVars[I] = C->GetFloat(); C->Set(Values[I], ECVF_SetByCode); }
        Tick = FWorldDelegates::OnWorldTickStart.AddStatic(&Animate);
        ENQUEUE_RENDER_COMMAND(ObserveWebWPO)([](FRHICommandListImmediate&) {
            BufferObserver = Nanite::GetWebNativeMaterialGBufferDelegate().AddStatic(&ObserveBuffer);
            CompositionObserver = Nanite::GetWebNativeCompositionDelegate().AddStatic(&ObserveComposition);
        });
    }
    if (RequestedStep == 30)
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
    const int S = RequestedStep; MotionStep = S;
    auto* Front = Cast<UWebNaniteGPUComponent>(Components[0]); check(Front);
    if (S == 21 || S == 22) { Front->GPUInstanceCount = S == 21 ? 5 : 2; Front->MarkRenderStateDirty(); }
    Front->SetWorldLocation(FVector(100400, 0, 100000));
    Front->SetWorldScale3D(S == 26 ? FVector(.8, 1.3, .7) : FVector::OneVector);
    Front->SetWorldRotation(S == 26 ? FRotator(10, 15, 5) : FRotator::ZeroRotator);
    Front->NanitePixelProgrammableDistance = S == 5 || S == 10 ? 450 : 0;
    Front->GPUInstanceDistance = S == 27 || S == 28 ? FVector2f(0, 450) : FVector2f::ZeroVector;
    Front->MarkRenderStateDirty();
    Front->SetEvaluateWorldPositionOffset(S != 11);
    Front->SetWorldPositionOffsetDisableDistance(S == 8 || S == 9 ? 450 : 0);
    Front->SetVisibility(S != 17);
    if (S == 19) Front->UnregisterComponent();
    if (S == 20) { Front->RegisterComponentWithWorld(Components[1]->GetWorld()); IDs[0] = Front->GetPrimitiveSceneId(); }
    const int Material = S <= 3 || S == 29 ? 3 : S <= 6 ? 0 : S == 12 ? 2 : 1;
    for (int Slot = 0; Slot < 2; ++Slot) Front->SetMaterial(Slot, Materials[Material]);
    for (int I = 0; I < 4; ++I)
    {
        Materials[I]->SetVectorParameterValue(TEXT("NaniteWorldOffset"), FLinearColor(40, 25, 15));
        Materials[I]->SetVectorParameterValue(TEXT("NanitePreviousWorldOffset"), FLinearColor(15, -10, -20));
        Materials[I]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 80);
    }
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->Set(S == 23 || S == 24 ? 1 : 0, ECVF_SetByCode);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.ViewDistanceScale"))->Set(S == 28 ? 2.0f : 1.0f, ECVF_SetByCode);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.Culling.WPODisableDistance"))->Set(S == 9 ? 0 : 1, ECVF_SetByCode);
    Camera->SetActorLocation(FVector(100000, S == 24 ? 40 : 0, 100000));
    auto* C = Camera->GetCameraComponent();
    C->SetProjectionMode(S == 25 ? ECameraProjectionMode::Orthographic : ECameraProjectionMode::Perspective);
    C->SetOrthoWidth(600); C->bAutoCalculateOrthoPlanes = false; C->SetOrthoNearClipPlane(1); C->SetOrthoFarClipPlane(2000);
    ENQUEUE_RENDER_COMMAND(RequestWebWPO)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && Copies.IsEmpty()); Step = RequestedStep; Requested = true; Settled = 0;
    }); Last = S; return 1;
}
