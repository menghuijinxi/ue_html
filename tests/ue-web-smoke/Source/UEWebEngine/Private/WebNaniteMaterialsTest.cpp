#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "TextureResource.h"
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

UStaticMesh* CreateWebNaniteDepthFixture();
namespace
{
UStaticMesh* Mesh;
UStaticMeshComponent* Components[3]{};
UMaterialInstanceDynamic* Materials[3]{};
UTexture2D* TiltedNormal;
FPrimitiveComponentId IDs[3];
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FDelegateHandle GraphObserver, BufferObserver;
const TCHAR* CVarNames[] = {TEXT("r.Nanite.WebResidentSceneDepth"), TEXT("r.Nanite.WebResidentGBuffer"), TEXT("r.Nanite.WebMaterialGraphs"), TEXT("r.Nanite.WebHZB"), TEXT("r.Nanite.MaxPixelsPerEdge")};
float SavedCVars[5];
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
    const int Expected = Step == 5 || Step == 7 ? 2 : 3;
    if (Saved.Cull->Entries.Num() != Expected) { Settled = 0; return; }
    if (++Settled < 8) return;
    Requested = false; Report = MakeShared<FJsonObject>();
    const auto Rect = Saved.Raster.Rect;
    Report->SetNumberField(TEXT("step"), Step); Report->SetBoolField(TEXT("complete"), Complete);
    Report->SetNumberField(TEXT("bins"), Bins); Report->SetNumberField(TEXT("frame"), Saved.Cull->View->Family->FrameNumber);
    Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(uint32(Rect.Width()), 8u));
    Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(uint32(Rect.Height()), 8u));
    Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected);
    TArray<TSharedPtr<FJsonValue>> Entries;
    for (int32 I = 0; I < Saved.Cull->Entries.Num(); ++I)
    {
        const auto& E = Saved.Cull->Entries[I]; auto J = MakeShared<FJsonObject>();
        int Component = -1; for (int K = 0; K < 3; ++K) if (IDs[K] == E.ComponentId) Component = K;
        J->SetNumberField(TEXT("component"), Component); J->SetNumberField(TEXT("instance"), E.InstanceSceneDataOffset);
        J->SetNumberField(TEXT("clusterBase"), Saved.Raster.ClusterBases[I]);
        J->SetNumberField(TEXT("clusterCount"), E.Input.MaxVisibleClusters);
        J->SetNumberField(TEXT("materialSlots"), E.Materials.Num());
        TArray<TSharedPtr<FJsonValue>> Transform;
        for (int R = 0; R < 4; ++R) for (int C = 0; C < 4; ++C) Transform.Add(MakeShared<FJsonValueNumber>(E.LocalToWorld.M[R][C]));
        J->SetArrayField(TEXT("localToWorld"), Transform);
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
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteMaterialsTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteMaterialsTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep < 0 || RequestedStep > 11 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebMaterials)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        for (int I = 0; I < 3; ++I)
        {
            const FString Path = FString::Printf(TEXT("/Game/WebNaniteMaterials/NaniteMaterial%d.NaniteMaterial%d"), I, I);
            UMaterialInterface* Material = LoadObject<UMaterialInterface>(nullptr, *Path); if (!Material) return 0;
            Materials[I] = UMaterialInstanceDynamic::Create(Material, GetTransientPackage()); Materials[I]->AddToRoot();
        }
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); check(Camera.IsValid());
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get()); Mesh = CreateWebNaniteDepthFixture(); check(Mesh);
        for (int I = 0; I < 3; ++I)
        {
            auto*& C = Components[I]; C = NewObject<UStaticMeshComponent>(); C->AddToRoot();
            C->SetCollisionEnabled(ECollisionEnabled::NoCollision); C->SetMobility(EComponentMobility::Movable);
            C->SetStaticMesh(Mesh); C->SetMaterial(0, Materials[I]); C->SetWorldLocation(FVector(100400, (I - 1) * 160, 100000));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        const float Values[] = {1, 0, 1, 0, 0.01f};
        for (int I = 0; I < 5; ++I) { auto* C = IConsoleManager::Get().FindConsoleVariable(CVarNames[I]); check(C); SavedCVars[I] = C->GetFloat(); C->Set(Values[I], ECVF_SetByCode); }
        ENQUEUE_RENDER_COMMAND(ObserveWebMaterials)([](FRHICommandListImmediate&) {
            GraphObserver = Nanite::GetWebNativeMaterialGraphDelegate().AddStatic(&ObserveGraph);
            BufferObserver = Nanite::GetWebNativeMaterialGBufferDelegate().AddStatic(&ObserveBuffer);
        });
    }
    if (RequestedStep == 2) Materials[1]->SetVectorParameterValue(TEXT("NaniteColor"), FLinearColor(0.7f, 0.1f, 0.25f));
    if (RequestedStep == 3) Components[0]->SetMaterial(0, Materials[1]);
    if (RequestedStep == 4) Components[2]->SetWorldRotation(FRotator(15, 25, 10));
    if (RequestedStep == 5) Components[1]->UnregisterComponent();
    if (RequestedStep == 6) { Components[1]->RegisterComponentWithWorld(Components[0]->GetWorld()); IDs[1] = Components[1]->GetPrimitiveSceneId(); }
    if (RequestedStep == 7) Components[0]->SetVisibility(false);
    if (RequestedStep == 8) { Components[0]->SetVisibility(true); Components[0]->SetMaterial(0, Materials[0]); }
    if (RequestedStep == 9)
    {
        TiltedNormal = UTexture2D::CreateTransient(2, 2, PF_B8G8R8A8); check(TiltedNormal); TiltedNormal->AddToRoot();
        TiltedNormal->SRGB = false; TiltedNormal->CompressionSettings = TC_Normalmap;
        auto& Mip = TiltedNormal->GetPlatformData()->Mips[0]; auto* Data = static_cast<uint8*>(Mip.BulkData.Lock(LOCK_READ_WRITE));
        for (int I = 0; I < 4; ++I) { Data[I*4] = 230; Data[I*4+1] = 128; Data[I*4+2] = 204; Data[I*4+3] = 255; }
        Mip.BulkData.Unlock(); TiltedNormal->UpdateResource();
        Materials[2]->SetTextureParameterValue(TEXT("NaniteNormal"), TiltedNormal);
    }
    if (RequestedStep == 10) Materials[2]->ClearParameterValues();
    if (RequestedStep == 11)
    {
        for (int I = 0; I < 3; ++I) { Components[I]->RemoveFromRoot(); Components[I]->DestroyComponent(); Materials[I]->RemoveFromRoot(); }
        TiltedNormal->RemoveFromRoot();
        Mesh->RemoveFromRoot(); if (Controller.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); if (Camera.IsValid()) Camera->Destroy();
        for (int I = 0; I < 5; ++I) IConsoleManager::Get().FindConsoleVariable(CVarNames[I])->Set(SavedCVars[I], ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveWebMaterials)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Copies.IsEmpty()); Nanite::GetWebNativeMaterialGraphDelegate().Remove(GraphObserver);
            Nanite::GetWebNativeMaterialGBufferDelegate().Remove(BufferObserver);
        }); Last = 11; return 1;
    }
    ENQUEUE_RENDER_COMMAND(RequestWebMaterials)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && Copies.IsEmpty()); Step = RequestedStep; Requested = true; Settled = 0;
    }); Last = RequestedStep; return 1;
}
