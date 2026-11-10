#include "CoreMinimal.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/Base64.h"
#include "Rendering/NaniteResources.h"
#include "Rendering/NaniteWebMaterial.h"
#include "Rendering/NaniteWebRaster.h"
#include "Rendering/NaniteStreamingManager.h"
#include "RenderingThread.h"
#include "StaticMeshResources.h"
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
UStaticMesh* Meshes[3]{};
UStaticMeshComponent* Component;
UMaterialInstanceDynamic* WPOMaterial;
bool WPO = false;
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FDelegateHandle Observer;
int Step = 0, Settled = 0;
bool Requested = false;
uint32 Bytes = 0;
TUniquePtr<FRHIGPUBufferReadback> Readback;
TSharedPtr<FJsonObject> Report;
TArray<TSharedPtr<FJsonValue>> History;
const TCHAR* CVarNames[] = {TEXT("r.Nanite.WebResidentSceneDepth"), TEXT("r.Nanite.WebResidentGBuffer"), TEXT("r.Nanite.WebMaterialGraphs"), TEXT("r.Nanite.WebHZB"), TEXT("r.Nanite.MaxPixelsPerEdge"), TEXT("r.Nanite.Streaming.QualityScale.MinQuality"), TEXT("r.AntiAliasingMethod")};
float SavedCVars[7];
TArray<TSharedPtr<FJsonValue>> Matrix(const FMatrix& M)
{
    TArray<TSharedPtr<FJsonValue>> Values;
    for (int Y = 0; Y < 4; ++Y) for (int X = 0; X < 4; ++X) Values.Add(MakeShared<FJsonValueNumber>(M.M[Y][X]));
    return Values;
}
void Observe(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebCompositionSnapshot& Snapshot)
{
    if (!Requested || Report || !Saved.Cull || Saved.Cull->Entries.Num() != 1) return;
    const auto& Entry = Saved.Cull->Entries[0];
    const int Active = Step == 2 ? 1 : Step == 4 ? 2 : 0;
    const auto& Resource = *Meshes[Active]->GetRenderData()->NaniteResourcesPtr;
    if (Entry.RuntimeResourceID != Resource.RuntimeResourceID) return;
    auto H = MakeShared<FJsonObject>(); H->SetNumberField(TEXT("frame"), Saved.Cull->View->Family->FrameNumber);
    H->SetNumberField(TEXT("residentClusters"), Resource.NumResidentClusters);
    H->SetNumberField(TEXT("runtimeID"), Resource.RuntimeResourceID);
    H->SetNumberField(TEXT("requestVersion"), Nanite::GStreamingManager.GetStreamingRequestsBufferVersion());
    History.Add(MakeShared<FJsonValueObject>(H));
    // Capture the first visible frame to prove coarse coverage, then let real
    // GPU feedback and bulk IO settle before comparing against resident geometry.
    if (Step != 1 && ++Settled < 100) return;
    Requested = false; Report = MakeShared<FJsonObject>();
    Report->SetNumberField(TEXT("step"), Step); Report->SetNumberField(TEXT("asset"), Active);
    Report->SetBoolField(TEXT("wpo"), WPO); Report->SetBoolField(TEXT("evaluateWPO"), Entry.EvaluateWPO);
    Report->SetBoolField(TEXT("hasVelocity"), Snapshot.HasVelocity); Report->SetBoolField(TEXT("cameraCut"), Snapshot.CameraCut);
    Report->SetArrayField(TEXT("worldToClip"), Matrix(Saved.Cull->View->ViewMatrices.GetViewProjectionMatrix()));
    Report->SetArrayField(TEXT("previousWorldToClip"), Matrix(Snapshot.PreviousWorldToClip));
    Report->SetArrayField(TEXT("localToWorld"), Matrix(Entry.LocalToWorld));
    Report->SetNumberField(TEXT("viewWidth"), Saved.Raster.Rect.Width());
    Report->SetNumberField(TEXT("viewHeight"), Saved.Raster.Rect.Height());
    Report->SetNumberField(TEXT("width"), Snapshot.Size.X); Report->SetNumberField(TEXT("height"), Snapshot.Size.Y);
    Report->SetNumberField(TEXT("runtimeID"), Resource.RuntimeResourceID);
    Report->SetNumberField(TEXT("residentClusters"), Resource.NumResidentClusters); Report->SetNumberField(TEXT("totalClusters"), Resource.NumClusters);
    Report->SetNumberField(TEXT("bulkBytes"), Resource.StreamablePages.GetBulkDataSize());
    Report->SetNumberField(TEXT("rootPages"), Resource.NumRootPages); Report->SetNumberField(TEXT("totalPages"), Resource.PageStreamingStates.Num());
    Report->SetNumberField(TEXT("poolPages"), Entry.Input.MaxStreamingPages); Report->SetNumberField(TEXT("firstRoot"), Entry.Input.FirstRootPage);
    Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected); Report->SetArrayField(TEXT("history"), History); History.Reset();
    const uint32 PixelBytes = Snapshot.Buffer->Desc.GetSize();
    const uint32 OwnerBytes = Entry.Input.MaxStreamingPages * sizeof(uint32);
    const uint32 RequestBytes = Entry.Input.StreamingRequests->Desc.GetSize();
    // A loaded page with another resource's owner must invalidate the draw.
    auto Foreign = Entry.Input; Foreign.StreamingRequests = nullptr;
    TArray<uint32> ForeignOwners; ForeignOwners.Init(MAX_uint32, Foreign.MaxStreamingPages);
    Foreign.StreamingPageOwners = Graph.CreateSRV(CreateStructuredBuffer(Graph, TEXT("Nanite.Web.ForeignPageOwners"), ForeignOwners));
    Nanite::FWebHierarchyCullResult RejectedPages;
    check(Nanite::AddWebResidentHierarchyCullPasses(Graph, Foreign, RejectedPages));
    const uint32 GeometryOffset = PixelBytes + OwnerBytes + RequestBytes + 32;
    const uint32 RecordBytes = WPO ? Saved.Raster.VisibleClusters->Desc.GetSize() : 0;
    const uint32 StreamBytes = WPO ? Entry.Input.MaxStreamingPages * (1u << 17) : 0;
    const uint32 RootBytes = WPO ? Entry.Input.NumRootPages * (1u << 15) : 0;
    Bytes = GeometryOffset + RecordBytes + StreamBytes + RootBytes;
    auto* Combined = Graph.CreateBuffer(FRDGBufferDesc::CreateByteAddressDesc(Bytes), TEXT("Nanite.Web.StreamingEvidence"));
    AddCopyBufferPass(Graph, Combined, 0, Snapshot.Buffer, 0, PixelBytes);
    AddCopyBufferPass(Graph, Combined, PixelBytes, Entry.Input.StreamingPageOwners->Desc.Buffer, 0, OwnerBytes);
    AddCopyBufferPass(Graph, Combined, PixelBytes + OwnerBytes, Entry.Input.StreamingRequests, 0, RequestBytes);
    AddCopyBufferPass(Graph, Combined, PixelBytes + OwnerBytes + RequestBytes, Entry.Result.State, 0, 16);
    AddCopyBufferPass(Graph, Combined, PixelBytes + OwnerBytes + RequestBytes + 16, RejectedPages.State, 0, 16);
    if (WPO)
    {
        // Preserve the actual LOD triangles and page contents from this frame.
        // The CPU oracle decodes these bytes independently, rather than using
        // hardware depth as the analytic material interpolation surface.
        AddCopyBufferPass(Graph, Combined, GeometryOffset, Saved.Raster.VisibleClusters, 0, RecordBytes);
        AddCopyBufferPass(Graph, Combined, GeometryOffset + RecordBytes, Entry.Input.ClusterPageData->Desc.Buffer, 0, StreamBytes);
        const uint32 RootOffset = StreamBytes + (Entry.Input.FirstRootPage - Entry.Input.MaxStreamingPages) * (1u << 15);
        AddCopyBufferPass(Graph, Combined, GeometryOffset + RecordBytes + StreamBytes, Entry.Input.ClusterPageData->Desc.Buffer, RootOffset, RootBytes);
    }
    Report->SetNumberField(TEXT("recordBytes"), RecordBytes); Report->SetNumberField(TEXT("streamBytes"), StreamBytes);
    Report->SetNumberField(TEXT("rootBytes"), RootBytes);
    Report->SetNumberField(TEXT("pixelWords"), PixelBytes / 4); Report->SetNumberField(TEXT("ownerWords"), OwnerBytes / 4);
    Report->SetNumberField(TEXT("requestWords"), RequestBytes / 4);
    Readback = MakeUnique<FRHIGPUBufferReadback>(TEXT("Nanite.Web.StreamingTest")); AddEnqueueCopyPass(Graph, Readback.Get(), Combined, Bytes);
}
void Poll()
{
    if (!Report || !Readback->IsReady()) return;
    const auto* Data = static_cast<const uint32*>(Readback->Lock(Bytes)); check(Data);
    TArray<TSharedPtr<FJsonValue>> Values;
    const uint32 PixelWords = Report->GetNumberField(TEXT("pixelWords")), OwnerWords = Report->GetNumberField(TEXT("ownerWords"));
    const uint32 RequestWords = Report->GetNumberField(TEXT("requestWords"));
    for (uint32 I = 0; I < PixelWords; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
    Report->SetArrayField(TEXT("pixels"), Values); Values.Reset();
    for (uint32 I = 0; I < OwnerWords; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[PixelWords + I]));
    Report->SetArrayField(TEXT("owners"), Values); Values.Reset();
    const uint32 Count = Data[PixelWords + OwnerWords]; Report->SetNumberField(TEXT("requestCount"), Count);
    for (uint32 I = 0; I < FMath::Min(Count + 1, RequestWords / 3) * 3; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[PixelWords + OwnerWords + I]));
    Report->SetArrayField(TEXT("requests"), Values); Values.Reset();
    for (uint32 I = 0; I < 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[PixelWords + OwnerWords + RequestWords + I]));
    Report->SetArrayField(TEXT("cullState"), Values); Values.Reset();
    for (uint32 I = 0; I < 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[PixelWords + OwnerWords + RequestWords + 4 + I]));
    Report->SetArrayField(TEXT("foreignPageState"), Values);
    if (WPO)
    {
        const uint8* Geometry = reinterpret_cast<const uint8*>(Data + PixelWords + OwnerWords + RequestWords + 8);
        const uint32 RecordBytes = Report->GetNumberField(TEXT("recordBytes")), StreamBytes = Report->GetNumberField(TEXT("streamBytes"));
        const uint32 RootBytes = Report->GetNumberField(TEXT("rootBytes"));
        Report->SetStringField(TEXT("visibleRecords"), FBase64::Encode(Geometry, RecordBytes));
        Report->SetStringField(TEXT("streamPages"), FBase64::Encode(Geometry + RecordBytes, StreamBytes));
        Report->SetStringField(TEXT("rootPagesData"), FBase64::Encode(Geometry + RecordBytes + StreamBytes, RootBytes));
    }
    Readback->Unlock();
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteStreamingTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Readback.Reset(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteStreamingTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep == -1) { if (Last != 0) return 0; WPO = true; return 1; }
    if (RequestedStep < 0 || RequestedStep > 10 || !GEngine || !Nanite::GStreamingManager.IsWebStreamingMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebStreaming)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        const TCHAR* Paths[] = {TEXT("/Game/WebNaniteStreaming/NaniteStreamingSphere.NaniteStreamingSphere"),
            TEXT("/Game/WebNaniteStreaming/NaniteResidentSphere.NaniteResidentSphere"), TEXT("/Game/WebNaniteStreaming/NaniteStreamingSphereB.NaniteStreamingSphereB")};
        for (int I = 0; I < 3; ++I)
        {
            Meshes[I] = LoadObject<UStaticMesh>(nullptr, Paths[I]); if (!Meshes[I] || !Meshes[I]->GetRenderData()->NaniteResourcesPtr) return 0;
            Meshes[I]->AddToRoot();
            // This diagnostic suppresses every fallback section before making
            // the proxy: any visible surface must come from Nanite pages.
            for (auto& LOD : Meshes[I]->GetRenderData()->LODResources) for (auto& Section : LOD.Sections) Section.NumTriangles = 0;
        }
        auto* Material = LoadObject<UMaterialInterface>(nullptr, WPO ?
            TEXT("/Game/WebNaniteProgrammable/NaniteProgrammable4.NaniteProgrammable4") :
            TEXT("/Game/WebNaniteMaterials/NaniteMaterial1.NaniteMaterial1")); if (!Material) return 0;
        if (WPO)
        {
            WPOMaterial = UMaterialInstanceDynamic::Create(Material, GetTransientPackage()); WPOMaterial->AddToRoot();
            WPOMaterial->SetVectorParameterValue(TEXT("NaniteWorldOffset"), FLinearColor(40, 25, 15));
            WPOMaterial->SetVectorParameterValue(TEXT("NanitePreviousWorldOffset"), FLinearColor(15, -10, -20));
            Material = WPOMaterial;
        }
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); check(Camera.IsValid());
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        Component = NewObject<UStaticMeshComponent>(); Component->AddToRoot(); Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        Component->SetMobility(EComponentMobility::Movable); Component->SetStaticMesh(Meshes[0]); Component->SetMaterial(0, Material);
        Component->SetWorldLocation(FVector(100250, 0, 100000)); Component->RegisterComponentWithWorld(World);
        // Fix sample positions for the independent resident/streaming geometry
        // comparison; temporal jitter/velocity is covered by the composition suite.
        const float Values[] = {1, 0, 1, 0, 0.01f, 1, 0};
        for (int I = 0; I < 7; ++I) { auto* C = IConsoleManager::Get().FindConsoleVariable(CVarNames[I]); check(C); SavedCVars[I] = C->GetFloat(); C->Set(Values[I], ECVF_SetByCode); }
        ENQUEUE_RENDER_COMMAND(ObserveWebStreaming)([](FRHICommandListImmediate&) { Observer = Nanite::GetWebNativeCompositionDelegate().AddStatic(&Observe); });
    }
    if (RequestedStep == 10)
    {
        Component->RemoveFromRoot(); Component->DestroyComponent();
        for (auto* Mesh : Meshes) Mesh->RemoveFromRoot();
        if (WPOMaterial) { WPOMaterial->RemoveFromRoot(); WPOMaterial = nullptr; }
        if (Controller.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); if (Camera.IsValid()) Camera->Destroy();
        for (int I = 0; I < 7; ++I) IConsoleManager::Get().FindConsoleVariable(CVarNames[I])->Set(SavedCVars[I], ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveWebStreaming)([](FRHICommandListImmediate&) { check(!Requested && !Report && !Readback); Nanite::GetWebNativeCompositionDelegate().Remove(Observer); }); Last = 10; return 1;
    }
    Component->SetStaticMesh(Meshes[RequestedStep == 2 ? 1 : RequestedStep == 4 ? 2 : 0]);
    if (RequestedStep == 6)
    {
        // Release/reinitialize the resource while old GPU requests may still
        // be queued. Native resource versions must reject stale requests.
        Component->UnregisterComponent(); Meshes[0]->ReleaseResources(); FlushRenderingCommands(); Meshes[0]->InitResources();
        Component->RegisterComponentWithWorld(Camera->GetWorld());
    }
    if (RequestedStep == 7) Camera->SetActorLocation(FVector(99000, 0, 100000));
    if (RequestedStep == 8)
    {
        Camera->SetActorLocation(FVector(100000, 0, 100000));
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->Set(1, ECVF_SetByCode);
    }
    if (RequestedStep == 9)
        IConsoleManager::Get().ProcessUserConsoleInput(TEXT("r.Nanite.Streaming.ResetStreamingPool"), *GLog, Camera->GetWorld());
    ENQUEUE_RENDER_COMMAND(RequestWebStreaming)([RequestedStep](FRHICommandListImmediate&) { check(!Requested && !Report && !Readback); Step = RequestedStep; Settled = 0; Requested = true; });
    Last = RequestedStep; return 1;
}
