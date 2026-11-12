#include "CoreMinimal.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/PlayerController.h"
#include "Camera/PlayerCameraManager.h"
#include "HAL/IConsoleManager.h"
#include "PipelineStateCache.h"
#include "PrimitiveSceneInfo.h"
#include "Rendering/NaniteResources.h"
#include "Rendering/NaniteWebMaterial.h"
#include "Rendering/NaniteWebGBuffer.h"
#include "Rendering/NaniteWebHZB.h"
#include "Rendering/NaniteStreamingManager.h"
#include "RenderingThread.h"
#include "StaticMeshSceneProxy.h"
#include "StaticMeshResources.h"
#include "SceneInterface.h"
#include "SceneView.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

namespace
{
FDelegateHandle CullObserver, GraphObserver, GBufferObserver, OcclusionObserver;
TArray<FPrimitiveComponentId> Candidates;
TArray<TSharedPtr<FJsonValue>> Assets;
TSharedPtr<FJsonObject> Report;
int Step = 0, Settled = 0, SavedNanite = 1;
bool Requested = false, MaterialComplete = false, HierarchyCaptured = false;
uint32 MaterialFrame = MAX_uint32, MaterialDraws = 0;
uint32 HierarchyFrame = MAX_uint32, HierarchyBatchedEntries = 0, HierarchyBuffers = 0;
uint32 HierarchySnapshotFrame = MAX_uint32;
uint32 OcclusionFrames[2] = {MAX_uint32, MAX_uint32}, OcclusionBatchedEntries[2] = {}, OcclusionBuffers[2] = {};
struct FCopy { FString Name; uint32 Bytes; TUniquePtr<FRHIGPUBufferReadback> Readback; };
TArray<FCopy> Copies;

void Copy(FRDGBuilder& Graph, FRDGBufferRef Buffer, const TCHAR* Name)
{
    check(Buffer); auto& Item = Copies.AddDefaulted_GetRef(); Item.Name = Name; Item.Bytes = Buffer->Desc.GetSize();
    Item.Readback = MakeUnique<FRHIGPUBufferReadback>(Name);
    AddEnqueueCopyPass(Graph, Item.Readback.Get(), Buffer, Item.Bytes);
}

void Describe(const Nanite::FWebSceneCullView& Cull)
{
    Requested = false; Report = MakeShared<FJsonObject>();
    Report->SetNumberField(TEXT("step"), Step);
    Report->SetNumberField(TEXT("frame"), Cull.View->Family->FrameNumber);
    Report->SetBoolField(TEXT("automatic"), Nanite::IsWebSceneRequested());
    Report->SetBoolField(TEXT("enabled"), Nanite::IsWebSceneRenderingEnabled());
    Report->SetNumberField(TEXT("registered"), Cull.Registered);
    Report->SetNumberField(TEXT("entries"), Cull.Entries.Num());
    Report->SetNumberField(TEXT("skipped"), Cull.Skipped);
    Report->SetNumberField(TEXT("primitiveVisibilitySkipped"), Cull.PrimitiveVisibilitySkipped);
    Report->SetBoolField(TEXT("primitiveVisibility"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebPrimitiveVisibility"))->GetInt() != 0);
    Report->SetBoolField(TEXT("hierarchyBatch"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebBatchHierarchy"))->GetInt() != 0);
    Report->SetBoolField(TEXT("occlusionBatch"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebBatchOcclusion"))->GetInt() != 0);
    Report->SetBoolField(TEXT("materialPrecache"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebMaterialPrecache"))->GetInt() != 0);
    for (uint32 Final = 0; Final < 2; ++Final)
    {
        const bool Valid = OcclusionFrames[Final] == Cull.View->Family->FrameNumber;
        const FString Prefix = Final ? TEXT("finalOcclusion") : TEXT("mainOcclusion");
        Report->SetNumberField(Prefix + TEXT("Frame"), Valid ? OcclusionFrames[Final] : -1.0);
        Report->SetNumberField(Prefix + TEXT("BatchedEntries"), Valid ? OcclusionBatchedEntries[Final] : 0);
        Report->SetNumberField(Prefix + TEXT("DispatchBuffers"), Valid ? OcclusionBuffers[Final] : 0);
    }
    check(HierarchyFrame == Cull.View->Family->FrameNumber);
    Report->SetNumberField(TEXT("hierarchyBatchedEntries"), HierarchyBatchedEntries);
    Report->SetNumberField(TEXT("hierarchyDispatchBuffers"), HierarchyBuffers);
    if (!Cull.Entries.IsEmpty()) Report->SetNumberField(TEXT("hierarchySnapshotFrame"), HierarchySnapshotFrame);
    Report->SetNumberField(TEXT("rejected"), Cull.Rejected);
    Report->SetArrayField(TEXT("assets"), Assets);
    if (!Cull.Entries.IsEmpty())
    {
        const auto& Input = Cull.Entries[0].Input;
        Report->SetNumberField(TEXT("poolPages"), Input.MaxStreamingPages);
        Report->SetNumberField(TEXT("poolBytes"), double(Input.ClusterPageData->Desc.Buffer->Desc.GetSize()));
        for (const auto& Entry : Cull.Entries) check(Entry.Input.MaxStreamingPages == Input.MaxStreamingPages);
    }
    uint64 UnboundedPixels = 0, BoundedPixels = 0;
    uint32 Levels = 0;
    TArray<TSharedPtr<FJsonValue>> EntryIDs;
    for (const auto& Entry : Cull.Entries)
    {
        const FIntRect Bounds = Nanite::GetWebSceneEntryPixelBounds(Entry, *Cull.View, Cull.RasterViewRect);
        UnboundedPixels += uint64(Cull.RasterViewRect.Width()) * Cull.RasterViewRect.Height();
        BoundedPixels += uint64(FMath::Max(0, Bounds.Width())) * FMath::Max(0, Bounds.Height());
        Levels += Entry.Input.MaxLevels;
        EntryIDs.Add(MakeShared<FJsonValueNumber>(Entry.InstanceSceneDataOffset));
    }
    Report->SetNumberField(TEXT("unboundedEntryPixels"), double(UnboundedPixels));
    Report->SetNumberField(TEXT("boundedEntryPixels"), double(BoundedPixels));
    Report->SetNumberField(TEXT("hierarchyDispatchLevels"), Levels);
    Report->SetArrayField(TEXT("entryInstanceIDs"), EntryIDs);
    TArray<TSharedPtr<FJsonValue>> Capacities;
    for (const auto& E : Cull.Entries) Capacities.Add(MakeShared<FJsonValueNumber>(E.Input.MaxVisibleClusters));
    Report->SetArrayField(TEXT("hierarchyCapacities"), Capacities);
    Report->SetBoolField(TEXT("instanceFrustum"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebInstanceFrustum"))->GetInt() != 0);
    Report->SetBoolField(TEXT("materialBins"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebMaterialBins"))->GetInt() != 0);
    Report->SetBoolField(TEXT("rasterBatch"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebRasterBatch"))->GetInt() != 0);
    Report->SetBoolField(TEXT("materialPassBatch"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebMaterialPassBatch"))->GetInt() != 0);
    Report->SetNumberField(TEXT("materialPassBatchMode"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebMaterialPassBatch"))->GetInt());
    const bool LocalHierarchy = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebLocalHierarchyQueue"))->GetInt() != 0;
    uint32 LocalEntries = 0, MaxHierarchyNodes = 0;
    for (const auto& Entry : Cull.Entries)
    {
        MaxHierarchyNodes = FMath::Max(MaxHierarchyNodes, Entry.Input.NumHierarchyNodes);
        if (LocalHierarchy && (Entry.Input.QueueCapacity ? Entry.Input.QueueCapacity : Entry.Input.NumHierarchyNodes) <= 256 && Entry.Input.MaxVisibleClusters <= 16384) ++LocalEntries;
    }
    Report->SetBoolField(TEXT("localHierarchy"), LocalHierarchy);
    Report->SetNumberField(TEXT("localHierarchyEntries"), LocalEntries);
    Report->SetNumberField(TEXT("maxHierarchyNodes"), MaxHierarchyNodes);
    const bool LocalOcclusion = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebLocalOcclusion"))->GetInt() != 0;
    uint32 LocalOcclusionEntries = 0;
    for (const auto& Entry : Cull.Entries)
        if (LocalOcclusion && Entry.Input.MaxVisibleClusters <= 16384) ++LocalOcclusionEntries;
    Report->SetBoolField(TEXT("localOcclusion"), LocalOcclusion);
    Report->SetNumberField(TEXT("localOcclusionEntries"), LocalOcclusionEntries);
    // Use the effective render projection, not the requested camera FOV: UE's
    // MaintainYFOV policy changes horizontal FOV with the viewport aspect ratio.
    const FMatrix& Projection = Cull.View->ViewMatrices.GetProjectionNoAAMatrix();
    auto View = MakeShared<FJsonObject>();
    View->SetNumberField(TEXT("projectionX"), Projection.M[0][0]);
    View->SetNumberField(TEXT("projectionY"), Projection.M[1][1]);
    View->SetNumberField(TEXT("jitterX"), Cull.View->ViewMatrices.GetProjectionMatrix().M[2][0] - Projection.M[2][0]);
    View->SetNumberField(TEXT("jitterY"), Cull.View->ViewMatrices.GetProjectionMatrix().M[2][1] - Projection.M[2][1]);
    View->SetNumberField(TEXT("horizontalFOV"), FMath::RadiansToDegrees(2.0 * FMath::Atan(1.0 / Projection.M[0][0])));
    const FVector Origin = Cull.View->ViewMatrices.GetViewOrigin();
    View->SetNumberField(TEXT("x"), Origin.X);
    View->SetNumberField(TEXT("y"), Origin.Y);
    View->SetNumberField(TEXT("z"), Origin.Z);
    View->SetNumberField(TEXT("width"), Cull.View->UnscaledViewRect.Width());
    View->SetNumberField(TEXT("height"), Cull.View->UnscaledViewRect.Height());
    Report->SetObjectField(TEXT("view"), View);
    TArray<TSharedPtr<FJsonValue>> Batches;
    for (const auto Id : Candidates)
    {
        const auto* Info = Cull.View->Family->Scene->GetPrimitiveSceneInfo(Id);
        if (!Info || !Info->Proxy) continue;
        // These IDs originate only from actual UStaticMeshComponents. Exercise
        // the same virtual mesh-batch producer used by the normal renderer.
        const auto* Proxy = static_cast<const FStaticMeshSceneProxy*>(Info->Proxy);
        FMeshBatch Batch;
        const bool Created = Proxy->GetMeshElement(0, 0, 0, SDPG_World, false, false, Batch);
        auto Item = MakeShared<FJsonObject>();
        Item->SetBoolField(TEXT("created"), Created);
        Item->SetBoolField(TEXT("material"), Created && Batch.bUseForMaterial);
        Item->SetBoolField(TEXT("depth"), Created && Batch.bUseForDepthPass);
        Item->SetBoolField(TEXT("occluder"), Created && Batch.bUseAsOccluder);
        Item->SetBoolField(TEXT("shadow"), Created && Batch.CastShadow);
        Item->SetNumberField(TEXT("triangles"), Created ? Batch.Elements[0].NumPrimitives : 0);
        Batches.Add(MakeShared<FJsonValueObject>(Item));
    }
    Report->SetArrayField(TEXT("batches"), Batches);
}

void ObserveCull(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& Cull)
{
    if (!Requested || Report || Cull.View->bIsSceneCapture) return;
    HierarchyFrame = Cull.View->Family->FrameNumber; HierarchyBatchedEntries = 0;
    TSet<FRDGBufferRef> Buffers;
    for (const auto& E : Cull.Entries)
    {
        Buffers.Add(E.Result.State);
        HierarchyBatchedEntries += E.Result.State->Desc.NumElements > 4 ? 1u : 0u;
    }
    HierarchyBuffers = Buffers.Num();
    if (Cull.View->Family->FrameNumber % 120 == 0)
        MAIN_THREAD_ASYNC_EM_ASM({ globalThis.__webNaniteAutomaticProgress = ({registered: $0, entries: $1,
            rejected: $2, settled: $3, pendingPipelines: $4, materialFrame: $5, materialDraws: $6, materialComplete: !!$7}); },
            Cull.Registered, Cull.Entries.Num(), Cull.Rejected, Settled, PipelineStateCache::NumActivePrecacheRequests(),
            MaterialFrame, MaterialDraws, MaterialComplete);
    if (PipelineStateCache::NumActivePrecacheRequests()) { Settled = 0; return; }
    if (++Settled < 60) return;
    if (Cull.Entries.IsEmpty()) Describe(Cull);
    else if (!HierarchyCaptured)
    {
        HierarchyCaptured = true;
        HierarchySnapshotFrame = Cull.View->Family->FrameNumber;
        uint32 Total = 0;
        for (const auto& E : Cull.Entries) Total += E.Input.MaxVisibleClusters;
        auto* Keys = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(4, Total), TEXT("Nanite.Web.TestHierarchyKeys"));
        auto* States = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(4, Cull.Entries.Num() * 4), TEXT("Nanite.Web.TestHierarchyStates"));
        uint32 Base = 0;
        for (int32 Index = 0; Index < Cull.Entries.Num(); ++Index)
        {
            const auto& E = Cull.Entries[Index];
            AddCopyBufferPass(Graph, Keys, uint64(Base) * 4, E.Result.ClusterKeys, uint64(E.Result.ClusterOffset) * 4, uint64(E.Input.MaxVisibleClusters) * 4);
            AddCopyBufferPass(Graph, States, Index * 16, E.Result.State, uint64(E.Result.StateOffset) * 4, 16);
            Base += E.Input.MaxVisibleClusters;
        }
        Copy(Graph, Keys, TEXT("hierarchyKeys")); Copy(Graph, States, TEXT("hierarchyStates"));
    }
}

void ObserveGraph(FRDGBuilder&, const Nanite::FWebSceneRasterView& Saved, uint32 Draws, bool Complete)
{
    if (!Saved.Cull || Saved.Cull->View->bIsSceneCapture) return;
    MaterialFrame = Saved.Cull->View->Family->FrameNumber; MaterialDraws = Draws; MaterialComplete = Complete;
}

void ObserveOcclusion(FRDGBuilder& Graph, const Nanite::FWebSceneCullView& Candidates,
    const Nanite::FWebSceneCullView& Output, bool Final)
{
    if (!Requested || Report || !HierarchyCaptured || Candidates.View->bIsSceneCapture ||
        Candidates.View->Family->FrameNumber != HierarchySnapshotFrame) return;
    check(OcclusionFrames[Final] != HierarchySnapshotFrame);
    OcclusionFrames[Final] = HierarchySnapshotFrame; OcclusionBatchedEntries[Final] = 0;
    TSet<FRDGBufferRef> Buffers;
    uint32 Total = 0;
    for (const auto& E : Output.Entries)
    {
        Total += E.Input.MaxVisibleClusters; Buffers.Add(E.Result.State);
        OcclusionBatchedEntries[Final] += E.Result.State->Desc.NumElements > 4 ? 1u : 0u;
    }
    OcclusionBuffers[Final] = Buffers.Num();
    if (Output.Entries.IsEmpty()) return;
    auto* Keys = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(4, Total), TEXT("Nanite.Web.TestOcclusionKeys"));
    auto* States = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(4, Output.Entries.Num() * 4), TEXT("Nanite.Web.TestOcclusionStates"));
    uint32 Base = 0;
    for (int32 Index = 0; Index < Output.Entries.Num(); ++Index)
    {
        const auto& E = Output.Entries[Index];
        AddCopyBufferPass(Graph, Keys, uint64(Base) * 4, E.Result.ClusterKeys, uint64(E.Result.ClusterOffset) * 4, uint64(E.Input.MaxVisibleClusters) * 4);
        AddCopyBufferPass(Graph, States, Index * 16, E.Result.State, uint64(E.Result.StateOffset) * 4, 16);
        Base += E.Input.MaxVisibleClusters;
    }
    Copy(Graph, Keys, Final ? TEXT("finalOcclusionKeys") : TEXT("mainOcclusionKeys"));
    Copy(Graph, States, Final ? TEXT("finalOcclusionStates") : TEXT("mainOcclusionStates"));
}

void ObserveGBuffer(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebGBufferTargets& Targets)
{
    if (!Requested || Report || Settled < 60 || !Saved.Cull || Saved.Cull->View->bIsSceneCapture) return;
    Describe(*Saved.Cull);
    Report->SetBoolField(TEXT("materialComplete"), MaterialComplete && MaterialFrame == Saved.Cull->View->Family->FrameNumber);
    Report->SetNumberField(TEXT("materialDraws"), MaterialDraws);
    Report->SetBoolField(TEXT("customDataTarget"), Targets.D != nullptr);
    Report->SetBoolField(TEXT("precomputedShadowTarget"), Targets.E != nullptr);
    Report->SetNumberField(TEXT("width"), FMath::DivideAndRoundUp(uint32(Saved.Raster.Rect.Width()), 8u));
    Report->SetNumberField(TEXT("height"), FMath::DivideAndRoundUp(uint32(Saved.Raster.Rect.Height()), 8u));
    Copy(Graph, Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Targets, 8), TEXT("pixels"));
    auto* States = Graph.CreateBuffer(FRDGBufferDesc::CreateByteAddressDesc(Saved.Cull->Entries.Num() * 16), TEXT("Nanite.Web.AutomaticStates"));
    for (int32 I = 0; I < Saved.Cull->Entries.Num(); ++I) AddCopyBufferPass(Graph, States, I * 16, Saved.Cull->Entries[I].Result.State,
        uint64(Saved.Cull->Entries[I].Result.StateOffset) * 4, 16);
    Copy(Graph, States, TEXT("cullStates"));
    const auto& Input = Saved.Cull->Entries[0].Input;
    if (Input.MaxStreamingPages && Input.StreamingPageOwners)
        Copy(Graph, Input.StreamingPageOwners->Desc.Buffer, TEXT("poolOwners"));
}

void Poll()
{
    if (!Report) return;
    for (const auto& Item : Copies) if (!Item.Readback->IsReady()) return;
    for (auto& Item : Copies)
    {
        const auto* Words = static_cast<const uint32*>(Item.Readback->Lock(Item.Bytes)); check(Words);
        TArray<TSharedPtr<FJsonValue>> Values;
        for (uint32 I = 0; I < Item.Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Words[I]));
        Item.Readback->Unlock(); Report->SetArrayField(Item.Name, Values);
    }
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({ globalThis.__webNaniteAutomaticSceneTest = JSON.parse(UTF8ToString($0)); }, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteMaterialBoundsTest(int Enabled, int TemporalIndex, int FrustumEnabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebBoundedMaterialTiles"));
    auto* Jitter = IConsoleManager::Get().FindConsoleVariable(TEXT("r.TemporalAA.Debug.OverrideTemporalIndex"));
    auto* Frustum = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebInstanceFrustum"));
    static int SavedBounds = -1, SavedJitter = -1, SavedFrustum = 1;
    if (!CVar || !Jitter || !Frustum || Enabled < -1 || Enabled > 1 || TemporalIndex < 0 || TemporalIndex > 7 || FrustumEnabled < 0 || FrustumEnabled > 1) return 0;
    if (Enabled == -1)
    {
        if (SavedBounds < 0) return 0;
        CVar->Set(SavedBounds, ECVF_SetByCode); Jitter->Set(SavedJitter, ECVF_SetByCode); Frustum->Set(SavedFrustum, ECVF_SetByCode); SavedBounds = -1; return 1;
    }
    if (SavedBounds < 0) { SavedBounds = CVar->GetInt(); SavedJitter = Jitter->GetInt(); SavedFrustum = Frustum->GetInt(); }
    CVar->Set(Enabled, ECVF_SetByCode); Jitter->Set(TemporalIndex, ECVF_SetByCode); Frustum->Set(FrustumEnabled, ECVF_SetByCode); return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteOcclusionModeTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebLocalOcclusion"));
    static int Saved = -1;
    if (!CVar || Enabled < -1 || Enabled > 1) return 0;
    if (Enabled < 0)
    {
        if (Saved < 0) return 0;
        CVar->Set(Saved, ECVF_SetByCode); Saved = -1; return 1;
    }
    if (Saved < 0) Saved = CVar->GetInt();
    CVar->Set(Enabled, ECVF_SetByCode); return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteHierarchyBatchTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebBatchHierarchy"));
    static int Saved = -1;
    if (!CVar || Enabled < -1 || Enabled > 1) return 0;
    if (Enabled < 0)
    {
        if (Saved < 0) return 0;
        CVar->Set(Saved, ECVF_SetByCode); Saved = -1; return 1;
    }
    if (Saved < 0) Saved = CVar->GetInt();
    CVar->Set(Enabled, ECVF_SetByCode); return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteOcclusionBatchTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebBatchOcclusion"));
    static int Saved = -1;
    if (!CVar || Enabled < -1 || Enabled > 1) return 0;
    if (Enabled < 0)
    {
        if (Saved < 0) return 0;
        CVar->Set(Saved, ECVF_SetByCode); Saved = -1; return 1;
    }
    if (Saved < 0) Saved = CVar->GetInt();
    CVar->Set(Enabled, ECVF_SetByCode); return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteHierarchyModeTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebLocalHierarchyQueue"));
    static int Saved = -1;
    if (!CVar || Enabled < -1 || Enabled > 1) return 0;
    if (Enabled < 0)
    {
        if (Saved < 0) return 0;
        CVar->Set(Saved, ECVF_SetByCode); Saved = -1; return 1;
    }
    if (Saved < 0) Saved = CVar->GetInt();
    CVar->Set(Enabled, ECVF_SetByCode); return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteMaterialBinsTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebMaterialBins"));
    static int Saved = -1;
    if (!CVar || Enabled < -1 || Enabled > 1) return 0;
    if (Enabled == -1)
    {
        if (Saved < 0) return 0;
        CVar->Set(Saved, ECVF_SetByCode); Saved = -1; return 1;
    }
    if (Saved < 0) Saved = CVar->GetInt();
    CVar->Set(Enabled, ECVF_SetByCode); return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteRasterBatchTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebRasterBatch"));
    static int Saved = -1;
    if (!CVar || Enabled < -1 || Enabled > 1) return 0;
    if (Enabled < 0)
    {
        if (Saved < 0) return 0;
        CVar->Set(Saved, ECVF_SetByCode); Saved = -1; return 1;
    }
    if (Saved < 0) Saved = CVar->GetInt();
    CVar->Set(Enabled, ECVF_SetByCode); return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteMaterialPassBatchTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebMaterialPassBatch"));
    static int Saved = -1;
    if (!CVar || Enabled < -1 || Enabled > 32) return 0;
    if (Enabled < 0)
    {
        if (Saved < 0) return 0;
        CVar->Set(Saved, ECVF_SetByCode); Saved = -1; return 1;
    }
    if (Saved < 0) Saved = CVar->GetInt();
    CVar->Set(Enabled, ECVF_SetByCode); return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNanitePrimitiveVisibilityTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* CVar = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebPrimitiveVisibility"));
    static int Saved = -1;
    if (!CVar || Enabled < -1 || Enabled > 1) return 0;
    if (Enabled < 0)
    {
        if (Saved < 0) return 0;
        CVar->Set(Saved, ECVF_SetByCode); Saved = -1; return 1;
    }
    if (Saved < 0) Saved = CVar->GetInt();
    CVar->Set(Enabled, ECVF_SetByCode); return 1;
}

namespace WebPrimitiveRecovery
{
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
UStaticMeshComponent* Target = nullptr;
UStaticMeshComponent* Sentinel = nullptr;
UStaticMeshComponent* Occluder = nullptr;
FDelegateHandle Observer;
FPrimitiveComponentId TargetId, OccluderId;
int Mode = 0, Frames = 0;
const FVector Origin(100000, 0, 100000);
void Observe(FRDGBuilder&, const Nanite::FWebSceneCullView& Cull)
{
    if (!Mode || Frames >= 16 || Cull.View->bIsSceneCapture) return;
    const bool Found = Cull.Entries.ContainsByPredicate([](const auto& E) { return E.ComponentId == TargetId; });
    const auto* TargetInfo = Cull.View->Family->Scene->GetPrimitiveSceneInfo(TargetId);
    const auto* OccluderInfo = Cull.View->Family->Scene->GetPrimitiveSceneInfo(OccluderId);
    const auto* OccluderProxy = OccluderInfo ? OccluderInfo->Proxy : nullptr;
    const bool Shown = OccluderProxy && OccluderProxy->IsShown(Cull.View);
    const FVector Position = OccluderProxy ? OccluderProxy->GetLocalToWorld().GetOrigin() : FVector::ZeroVector;
    const FVector Eye = Cull.View->ViewMatrices.GetViewOrigin();
    const bool Blocking = Shown && Position.Equals(Origin + FVector(300, 0, 0), .01) && Eye.X < Origin.X + 500;

    MAIN_THREAD_ASYNC_EM_ASM({
        globalThis.__webNanitePrimitiveRecovery ??= {modes: {}};
        const rows = globalThis.__webNanitePrimitiveRecovery.modes[$0] ??= [];
        rows.push({frame: $1, index: $2, candidate: !!$3, cameraCut: !!$4, targetPresent: !!$5, occluderShown: !!$6, occluderBlocking: !!$7, occluderY: $8, eyeX: $9});
    }, Mode, Cull.View->Family->FrameNumber, Frames++, Found, Cull.View->bCameraCut, TargetInfo && TargetInfo->Proxy, Shown, Blocking, Position.Y, Eye.X);
}
}

// Use the actual cooked scene mesh/material and an ordinary cooked cube. A
// second visible Nanite mesh keeps full-view depth/GBuffer readback available
// while the target is completely occluded. No proxy is manually registered.
extern "C" EMSCRIPTEN_KEEPALIVE int WebNanitePrimitiveRecoveryTest(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    using namespace WebPrimitiveRecovery;
    if (Mode < -1 || Mode > 8 || !GEngine) return 0;
    if (Mode == 0) return Target != nullptr;
    if (Mode == -1)
    {
        if (!Target) return 0;
        ENQUEUE_RENDER_COMMAND(RemovePrimitiveRecoveryObserver)([](FRHICommandListImmediate&) {
            Nanite::GetWebSceneCullDelegate().Remove(Observer); WebPrimitiveRecovery::Mode = 0;
        });
        for (auto* C : {Target, Sentinel, Occluder}) { C->UnregisterComponent(); C->RemoveFromRoot(); C->DestroyComponent(); }
        Target = Sentinel = Occluder = nullptr;
        if (Controller.IsValid() && SavedTarget.IsValid()) Controller->SetViewTarget(SavedTarget.Get());
        Camera->Destroy(); Camera.Reset(); return 1;
    }
    if (Mode == 1)
    {
        if (Target) return 0;
        UWorld* World = nullptr;
        for (const auto& C : GEngine->GetWorldContexts()) if (C.WorldType == EWorldType::Game) World = C.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        UStaticMeshComponent* Source = nullptr;
        for (TActorIterator<AActor> It(World); It && !Source; ++It)
        {
            TInlineComponentArray<UStaticMeshComponent*> Components(*It);
            for (auto* C : Components)
                if (C->GetStaticMesh() && C->GetStaticMesh()->GetName() == TEXT("SM_TestSphere")) { Source = C; break; }
        }
        auto* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
        if (!Source || !Cube || (Cube->GetRenderData()->NaniteResourcesPtr && Cube->GetRenderData()->NaniteResourcesPtr->NumClusters)) return 0;
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); if (!Camera.IsValid()) return 0;
        Camera->SetActorLocationAndRotation(Origin, FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        const auto Create = [&](UStaticMesh* Mesh, FVector Offset, FVector Scale) {
            auto* C = NewObject<UStaticMeshComponent>(); C->AddToRoot();
            C->SetCollisionEnabled(ECollisionEnabled::NoCollision); C->SetMobility(EComponentMobility::Movable);
            C->SetStaticMesh(Mesh); C->SetMaterial(0, Source->GetMaterial(0)); C->SetCastShadow(false);
            C->SetWorldLocation(Origin + Offset); C->SetWorldScale3D(Scale); C->RegisterComponentWithWorld(World); return C;
        };
        Target = Create(Source->GetStaticMesh(), FVector(500, 0, 0), FVector(1));
        Sentinel = Create(Source->GetStaticMesh(), FVector(500, 350, 0), FVector(1));
        // The existing Web visibility history conservatively retains movable
        // targets. Exercise static scene meshes with a movable occluder.
        Target->SetMobility(EComponentMobility::Static); Sentinel->SetMobility(EComponentMobility::Static);
        Occluder = Create(Cube, FVector(300, 0, 0), FVector(.5, 2.4, 2.4));
        ENQUEUE_RENDER_COMMAND(AddPrimitiveRecoveryObserver)([](FRHICommandListImmediate&) {
            Observer = Nanite::GetWebSceneCullDelegate().AddStatic(&Observe);
        });
    }
    if (!Target || !Camera.IsValid()) return 0;
    if (Mode == 2) Occluder->SetVisibility(false);
    if (Mode == 3) Occluder->SetVisibility(true);
    if (Mode == 4) Occluder->SetWorldLocation(Origin + FVector(300, -500, 0));
    if (Mode == 5) Occluder->SetWorldLocation(Origin + FVector(300, 0, 0));
    if (Mode == 6)
    {
        Camera->SetActorLocationAndRotation(Origin + FVector(1000, 0, 0), FRotator(0, 180, 0));
        Controller->PlayerCameraManager->SetGameCameraCutThisFrame();
    }
    if (Mode == 7)
    {
        Target->UnregisterComponent(); Target->RegisterComponentWithWorld(Camera->GetWorld());
    }
    if (Mode == 8)
    {
        Camera->SetActorLocationAndRotation(Origin, FRotator::ZeroRotator);
        Controller->PlayerCameraManager->SetGameCameraCutThisFrame(); Occluder->SetVisibility(false);
    }
    const FPrimitiveComponentId Id = Target->GetPrimitiveSceneId(), BlockerId = Occluder->GetPrimitiveSceneId();
    ENQUEUE_RENDER_COMMAND(ArmPrimitiveRecovery)([Mode, Id, BlockerId](FRHICommandListImmediate&) {
        WebPrimitiveRecovery::Mode = Mode; TargetId = Id; OccluderId = BlockerId; Frames = 0;
    });
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteAutomaticSceneTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int Last = 0;
    if (RequestedStep < -1 || RequestedStep > 99 || !GEngine || !Nanite::IsWebSceneRequested()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollAutomaticNanite)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    auto* Enabled = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite")); check(Enabled);
    if (RequestedStep == -1)
    {
        Enabled->Set(SavedNanite, ECVF_SetByCode);
        ENQUEUE_RENDER_COMMAND(RemoveAutomaticNanite)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Copies.IsEmpty());
            Nanite::GetWebSceneCullDelegate().Remove(CullObserver);
            Nanite::GetWebNativeMaterialGraphDelegate().Remove(GraphObserver);
            Nanite::GetWebNativeMaterialGBufferDelegate().Remove(GBufferObserver);
            Nanite::GetWebOcclusionDelegate().Remove(OcclusionObserver);
        }); return 1;
    }
    if (RequestedStep != Last + 1) return 0;
    if (RequestedStep == 1)
    {
        SavedNanite = Enabled->GetInt();
        ENQUEUE_RENDER_COMMAND(ObserveAutomaticNanite)([](FRHICommandListImmediate&) {
            CullObserver = Nanite::GetWebSceneCullDelegate().AddStatic(&ObserveCull);
            GraphObserver = Nanite::GetWebNativeMaterialGraphDelegate().AddStatic(&ObserveGraph);
            GBufferObserver = Nanite::GetWebNativeMaterialGBufferDelegate().AddStatic(&ObserveGBuffer);
            OcclusionObserver = Nanite::GetWebOcclusionDelegate().AddStatic(&ObserveOcclusion);
        });
    }
    // Native r.Nanite owns proxy recreation; neither this probe nor the page
    // registers resources, changes materials, or edits fallback triangles.
    if (RequestedStep == 2 || RequestedStep == 3) Enabled->Set(RequestedStep == 3 ? 1 : 0, ECVF_SetByCode);
    UWorld* World = nullptr;
    for (const auto& Context : GEngine->GetWorldContexts()) if (Context.WorldType == EWorldType::Game) World = Context.World();
    if (!World) return 0;
    TArray<FPrimitiveComponentId> IDs; TArray<TSharedPtr<FJsonValue>> Meshes;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        TInlineComponentArray<UStaticMeshComponent*> Components(*It);
        for (const auto* Component : Components)
        {
            const UStaticMesh* Mesh = Component->GetStaticMesh(); const auto* Data = Mesh ? Mesh->GetRenderData() : nullptr;
            if (!Data || !Data->NaniteResourcesPtr || !Data->NaniteResourcesPtr->NumClusters || Data->LODResources.IsEmpty()) continue;
            IDs.Add(Component->GetPrimitiveSceneId());
            auto Item = MakeShared<FJsonObject>(); Item->SetStringField(TEXT("mesh"), Mesh->GetPathName());
            Item->SetNumberField(TEXT("fallbackTriangles"), Data->LODResources[0].GetNumTriangles());
            Item->SetNumberField(TEXT("clusters"), Data->NaniteResourcesPtr->NumClusters);
            Item->SetNumberField(TEXT("rootPages"), Data->NaniteResourcesPtr->NumRootPages);
            Meshes.Add(MakeShared<FJsonValueObject>(Item));
        }
    }
    ENQUEUE_RENDER_COMMAND(RequestAutomaticNanite)([RequestedStep, IDs = MoveTemp(IDs), Meshes = MoveTemp(Meshes)](FRHICommandListImmediate&) mutable {
        check(!Requested && !Report && Copies.IsEmpty()); Candidates = MoveTemp(IDs); Assets = MoveTemp(Meshes);
        Step = RequestedStep; Settled = 0; Requested = true; HierarchyCaptured = false;
    }); Last = RequestedStep; return 1;
}
