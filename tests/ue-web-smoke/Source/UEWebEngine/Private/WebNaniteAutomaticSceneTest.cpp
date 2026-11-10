#include "CoreMinimal.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "HAL/IConsoleManager.h"
#include "PipelineStateCache.h"
#include "PrimitiveSceneInfo.h"
#include "Rendering/NaniteResources.h"
#include "Rendering/NaniteWebMaterial.h"
#include "Rendering/NaniteWebGBuffer.h"
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
FDelegateHandle CullObserver, GraphObserver, GBufferObserver;
TArray<FPrimitiveComponentId> Candidates;
TArray<TSharedPtr<FJsonValue>> Assets;
TSharedPtr<FJsonObject> Report;
int Step = 0, Settled = 0, SavedNanite = 1;
bool Requested = false, MaterialComplete = false;
uint32 MaterialFrame = MAX_uint32, MaterialDraws = 0;
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
    Report->SetNumberField(TEXT("rejected"), Cull.Rejected);
    Report->SetArrayField(TEXT("assets"), Assets);
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
    Report->SetBoolField(TEXT("instanceFrustum"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebInstanceFrustum"))->GetInt() != 0);
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

void ObserveCull(FRDGBuilder&, const Nanite::FWebSceneCullView& Cull)
{
    if (!Requested || Report || Cull.View->bIsSceneCapture) return;
    if (Cull.View->Family->FrameNumber % 120 == 0)
        MAIN_THREAD_ASYNC_EM_ASM({ globalThis.__webNaniteAutomaticProgress = ({registered: $0, entries: $1,
            rejected: $2, settled: $3, pendingPipelines: $4, materialFrame: $5, materialDraws: $6, materialComplete: !!$7}); },
            Cull.Registered, Cull.Entries.Num(), Cull.Rejected, Settled, PipelineStateCache::NumActivePrecacheRequests(),
            MaterialFrame, MaterialDraws, MaterialComplete);
    if (PipelineStateCache::NumActivePrecacheRequests()) { Settled = 0; return; }
    if (++Settled < 60) return;
    if (Cull.Entries.IsEmpty()) Describe(Cull);
}

void ObserveGraph(FRDGBuilder&, const Nanite::FWebSceneRasterView& Saved, uint32 Draws, bool Complete)
{
    if (!Saved.Cull || Saved.Cull->View->bIsSceneCapture) return;
    MaterialFrame = Saved.Cull->View->Family->FrameNumber; MaterialDraws = Draws; MaterialComplete = Complete;
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
    for (int32 I = 0; I < Saved.Cull->Entries.Num(); ++I) AddCopyBufferPass(Graph, States, I * 16, Saved.Cull->Entries[I].Result.State, 0, 16);
    Copy(Graph, States, TEXT("cullStates"));
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
        Step = RequestedStep; Settled = 0; Requested = true;
    }); Last = RequestedStep; return 1;
}
