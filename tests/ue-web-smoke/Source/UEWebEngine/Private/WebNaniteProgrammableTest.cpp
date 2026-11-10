#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "TextureResource.h"
#include "StaticMeshResources.h"
#include "Engine/World.h"
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
UMaterialInstanceDynamic* Materials[6]{};
UTexture2D* MaskOverride;
FPrimitiveComponentId IDs[2];
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FDelegateHandle GraphObserver, BufferObserver;
const TCHAR* CVarNames[] = {TEXT("r.Nanite.WebResidentSceneDepth"), TEXT("r.Nanite.WebResidentGBuffer"), TEXT("r.Nanite.WebMaterialGraphs"), TEXT("r.Nanite.WebHZB"), TEXT("r.Nanite.MaxPixelsPerEdge"), TEXT("r.AntiAliasingMethod")};
float SavedCVars[UE_ARRAY_COUNT(CVarNames)];
int Step = 0, Settled = 0;
uint32 Bins = 0; bool Complete = false, Requested = false;
TSharedPtr<FJsonObject> Report;
struct FCopy { FString Name; uint32 Bytes; TUniquePtr<FRHIGPUBufferReadback> Readback; };
TArray<FCopy> Copies;
void Copy(FRDGBuilder& Graph, FRDGBufferRef Buffer, const TCHAR* Name)
{
    check(Buffer); auto& C = Copies.AddDefaulted_GetRef(); C.Name = Name; C.Bytes = Buffer->Desc.GetSize();
    C.Readback = MakeUnique<FRHIGPUBufferReadback>(Name); AddEnqueueCopyPass(Graph, C.Readback.Get(), Buffer, C.Bytes);
}
void ObserveGraph(FRDGBuilder&, const Nanite::FWebSceneRasterView&, uint32 NumBins, bool AllCompiled)
{ Bins = NumBins; Complete = AllCompiled; }
void ObserveBuffer(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebGBufferTargets& Targets)
{
    if (!Requested) return;
    // Component PSO precaching can defer initial proxy creation. Wait for the
    // requested scene state; the browser gives this a bounded timeout.
    const bool Baseline = Step > 16 && (Step - 17) % 4 < 2;
    const int Expected = Step == 1 || Step == 2 || Step == 13 || Step == 15 || Baseline ? 1 : 2;
    if (Saved.Cull->Entries.Num() != Expected) { Settled = 0; return; }
    if (++Settled < 8) return;
    Requested = false; Report = MakeShared<FJsonObject>();
    const auto Rect = Saved.Raster.Rect;
    Report->SetNumberField(TEXT("step"), Step); Report->SetBoolField(TEXT("complete"), Complete);
    Report->SetBoolField(TEXT("hzb"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->GetBool());
    Report->SetNumberField(TEXT("bins"), Bins); Report->SetNumberField(TEXT("frame"), Saved.Cull->View->Family->FrameNumber);
    Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(uint32(Rect.Width()), 8u));
    Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(uint32(Rect.Height()), 8u));
    Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected);
    Report->SetBoolField(TEXT("perspective"), Saved.Cull->View->IsPerspectiveProjection());
    Report->SetNumberField(TEXT("worldDepthScale"), Saved.Cull->View->ViewMatrices.GetWorldToClip().M[0][2]);
    TArray<TSharedPtr<FJsonValue>> Entries;
    for (int32 I = 0; I < Saved.Cull->Entries.Num(); ++I)
    {
        const auto& E = Saved.Cull->Entries[I]; auto J = MakeShared<FJsonObject>();
        int Component = -1; for (int K = 0; K < 2; ++K) if (IDs[K] == E.ComponentId) Component = K;
        J->SetNumberField(TEXT("component"), Component); J->SetNumberField(TEXT("instance"), E.InstanceSceneDataOffset);
        J->SetNumberField(TEXT("clusterBase"), Saved.Raster.ClusterBases[I]);
        J->SetNumberField(TEXT("clusterCount"), E.Input.MaxVisibleClusters);
        J->SetNumberField(TEXT("materialSlots"), E.Materials.Num());
        TArray<TSharedPtr<FJsonValue>> Transform;
        for (int R = 0; R < 4; ++R) for (int C = 0; C < 4; ++C) Transform.Add(MakeShared<FJsonValueNumber>(E.LocalToWorld.M[R][C]));
        J->SetArrayField(TEXT("localToWorld"), Transform);
        Transform.Reset(); const FMatrix44f Clip(E.LocalToWorld * Saved.Cull->View->ViewMatrices.GetWorldToClip());
        for (int R = 0; R < 4; ++R) for (int C = 0; C < 4; ++C) Transform.Add(MakeShared<FJsonValueNumber>(Clip.M[R][C]));
        J->SetArrayField(TEXT("localToClip"), Transform);
        Entries.Add(MakeShared<FJsonValueObject>(J));
    }
    Report->SetArrayField(TEXT("entries"), Entries);
    Copy(Graph, Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Targets, 8), TEXT("pixels"));
    Copy(Graph, Nanite::AddWebMaterialInputResolvePasses(Graph, *Saved.Cull, Saved.Raster, 8), TEXT("inputs"));
}
void Poll()
{
    if (!Report) return;
    for (const auto& C : Copies) if (!C.Readback->IsReady()) return;
    for (auto& C : Copies)
    {
        const auto* Data = static_cast<const uint32*>(C.Readback->Lock(C.Bytes)); check(Data);
        TArray<TSharedPtr<FJsonValue>> Values; for (uint32 I = 0; I < C.Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
        C.Readback->Unlock(); Report->SetArrayField(C.Name, Values);
    }
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteProgrammableTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteProgrammableTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep < 0 || RequestedStep > 53 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebProgrammable)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Mesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Game/WebNaniteSidedness/NaniteMixedSidedPlane.NaniteMixedSidedPlane"));
        if (!Mesh || !Mesh->GetRenderData()) return 0; Mesh->AddToRoot();
        // This diagnostic requires the real Nanite surface to own every pixel.
        for (auto& LOD : Mesh->GetRenderData()->LODResources) for (auto& Section : LOD.Sections) Section.NumTriangles = 0;
        for (int I = 0; I < 6; ++I)
        {
            const FString Path = I < 4 ? FString::Printf(TEXT("/Game/WebNaniteProgrammable/NaniteProgrammable%d.NaniteProgrammable%d"), I, I) :
                I == 5 ? TEXT("/Game/WebNaniteSidedness/NaniteTwoSided.NaniteTwoSided") :
                TEXT("/Game/WebNaniteMaterials/NaniteMaterial1.NaniteMaterial1");
            auto* Parent = LoadObject<UMaterialInterface>(nullptr, *Path); if (!Parent) return 0;
            Materials[I] = UMaterialInstanceDynamic::Create(Parent, GetTransientPackage()); Materials[I]->AddToRoot();
        }
        Materials[4]->SetVectorParameterValue(TEXT("NaniteColor"), FLinearColor(.1f, .7f, .2f));
        Materials[5]->SetVectorParameterValue(TEXT("SurfaceColor"), FLinearColor(.2f, .4f, .7f));
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); check(Camera.IsValid());
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        for (int I = 0; I < 2; ++I)
        {
            auto*& C = Components[I]; C = NewObject<UStaticMeshComponent>(); C->AddToRoot();
            C->SetCollisionEnabled(ECollisionEnabled::NoCollision); C->SetMobility(EComponentMobility::Movable);
            C->SetStaticMesh(Mesh); for (int Slot = 0; Slot < 2; ++Slot) C->SetMaterial(Slot, Materials[I ? 4 : 5]);
            C->SetWorldLocation(FVector(100400 + 30 * I, 0, 100000)); C->SetVisibility(I == 0);
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        const float Values[] = {1, 0, 1, 0, .001f, 0};
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I)
        { auto* C = IConsoleManager::Get().FindConsoleVariable(CVarNames[I]); check(C); SavedCVars[I] = C->GetFloat(); C->Set(Values[I], ECVF_SetByCode); }
        ENQUEUE_RENDER_COMMAND(ObserveWebProgrammable)([](FRHICommandListImmediate&) {
            GraphObserver = Nanite::GetWebNativeMaterialGraphDelegate().AddStatic(&ObserveGraph);
            BufferObserver = Nanite::GetWebNativeMaterialGBufferDelegate().AddStatic(&ObserveBuffer);
        });
    }
    auto SetFrontMaterial = [](int Index) { for (int Slot = 0; Slot < 2; ++Slot) Components[0]->SetMaterial(Slot, Materials[Index]); };
    if (RequestedStep == 2) { Components[0]->SetVisibility(false); Components[1]->SetVisibility(true); }
    if (RequestedStep == 3) Components[0]->SetVisibility(true);
    if (RequestedStep == 4) SetFrontMaterial(0);
    if (RequestedStep == 5) SetFrontMaterial(1);
    if (RequestedStep == 6) Materials[1]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 80);
    if (RequestedStep == 7) Materials[1]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), -20);
    if (RequestedStep == 8) { SetFrontMaterial(2); Materials[2]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 80); }
    if (RequestedStep == 9) Materials[2]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 0);
    if (RequestedStep == 10 || RequestedStep == 11)
    {
        if (MaskOverride) MaskOverride->RemoveFromRoot();
        MaskOverride = UTexture2D::CreateTransient(8, 8, PF_B8G8R8A8); check(MaskOverride); MaskOverride->AddToRoot();
        MaskOverride->SRGB = false; MaskOverride->CompressionSettings = TC_Masks; MaskOverride->Filter = TF_Nearest;
        auto& Mip = MaskOverride->GetPlatformData()->Mips[0]; auto* Data = static_cast<uint8*>(Mip.BulkData.Lock(LOCK_READ_WRITE));
        FMemory::Memset(Data, RequestedStep == 10 ? 255 : 0, 8 * 8 * 4);
        Mip.BulkData.Unlock(); MaskOverride->UpdateResource(); Materials[2]->SetTextureParameterValue(TEXT("NaniteMask"), MaskOverride);
    }
    if (RequestedStep == 12)
    {
        Materials[2]->ClearParameterValues(); Materials[2]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 0);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->Set(1, ECVF_SetByCode);
    }
    if (RequestedStep == 13) Components[0]->SetVisibility(false);
    if (RequestedStep == 14) Components[0]->SetVisibility(true);
    if (RequestedStep == 15) Components[0]->UnregisterComponent();
    if (RequestedStep == 16) { Components[0]->RegisterComponentWithWorld(Components[1]->GetWorld()); IDs[0] = Components[0]->GetPrimitiveSceneId(); }
    // Independent opaque baselines are captured for each transform and camera.
    // The last two frames then test a one-sided mask and a two-sided mask+PDO.
    if (RequestedStep >= 17 && RequestedStep <= 52)
    {
        const int Case = (RequestedStep - 17) / 4, Phase = (RequestedStep - 17) % 4;
        const bool Back = Case == 1 || Case == 3 || Case == 5 || Case == 8;
        Components[0]->SetReverseCulling(Case == 4 || Case == 5);
        Components[0]->SetWorldScale3D(Case == 2 || Case == 3 ? FVector(1, -1, 1) :
            Case == 6 ? FVector(.75, 1.4, .6) : FVector::OneVector);
        Components[0]->SetWorldRotation(Case == 6 ? FRotator(15, 10, 5) : FRotator(0, Back ? 180 : 0, 0));
        auto* C = Camera->GetCameraComponent();
        C->SetProjectionMode(Case >= 7 ? ECameraProjectionMode::Orthographic : ECameraProjectionMode::Perspective);
        C->SetOrthoWidth(800); C->bAutoCalculateOrthoPlanes = false;
        C->SetOrthoNearClipPlane(1); C->SetOrthoFarClipPlane(2000);
        Components[0]->SetVisibility(Phase != 1); Components[1]->SetVisibility(Phase != 0);
        SetFrontMaterial(Phase < 2 ? 5 : Phase == 2 ? 3 : 2);
        Materials[2]->SetScalarParameterValue(TEXT("NaniteDepthOffset"), 80);
    }
    if (RequestedStep == 53)
    {
        for (auto* C : Components) { C->RemoveFromRoot(); C->DestroyComponent(); }
        for (auto* M : Materials) M->RemoveFromRoot();
        if (MaskOverride) MaskOverride->RemoveFromRoot(); Mesh->RemoveFromRoot();
        if (Controller.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); if (Camera.IsValid()) Camera->Destroy();
        for (int I = 0; I < UE_ARRAY_COUNT(CVarNames); ++I) IConsoleManager::Get().FindConsoleVariable(CVarNames[I])->Set(SavedCVars[I], ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveWebProgrammable)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Copies.IsEmpty()); Nanite::GetWebNativeMaterialGraphDelegate().Remove(GraphObserver);
            Nanite::GetWebNativeMaterialGBufferDelegate().Remove(BufferObserver);
        }); Last = RequestedStep; return 1;
    }
    ENQUEUE_RENDER_COMMAND(RequestWebProgrammable)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && Copies.IsEmpty()); Step = RequestedStep; Requested = true; Settled = 0;
    }); Last = RequestedStep; return 1;
}
