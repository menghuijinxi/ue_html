#include "CoreMinimal.h"
#include "Components.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Materials/Material.h"
#include "MaterialDomain.h"
#include "StaticMeshResources.h"
#include "Misc/FileHelper.h"
#include "Serialization/MemoryReader.h"
#include "Rendering/NaniteResources.h"
#include "Rendering/NaniteStreamingManager.h"
#include "UObject/Package.h"
#include "RenderingThread.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "RenderUtils.h"
#include <emscripten.h>

namespace
{
UStaticMesh* SceneMesh;
UStaticMeshComponent* SceneComponents[2];

UStaticMesh* CreateResidentSceneMesh()
{
    TArray<uint8> Cooked, Triangles;
    const FString Directory = TEXT("/Engine/Programs/UEWebEngine/Content/NaniteUploader/");
    if (!FFileHelper::LoadFileToArray(Cooked, *(Directory + TEXT("resources.cooked.bin"))) ||
        !FFileHelper::LoadFileToArray(Triangles, *(Directory + TEXT("source-triangles.bin"))) ||
        Triangles.Num() != 960 * 9 * sizeof(float)) return nullptr;
    auto Data = MakeUnique<FStaticMeshRenderData>();
    Data->NaniteResourcesPtr = MakePimpl<Nanite::FResources>();
    FMemoryReader Reader(Cooked, true); Reader.SetFilterEditorOnly(true);
    Data->NaniteResourcesPtr->Serialize(Reader, GetTransientPackage(), true);
    if (Reader.IsError() || Reader.Tell() != Cooked.Num()) return nullptr;
    // Build a normal fallback from the fixture's original triangle soup. This
    // permits real component scene proxies while the Nanite raster is unfinished.
    Data->AllocateLODResources(1);
    Data->bHasNaniteFallbackMesh = true;
    Data->NumInlinedLODs = 1;
    Data->ScreenSize[0] = 1.0f;
    auto& LOD = Data->LODResources[0];
    LOD.bBuffersInlined = true;
    TArray<FStaticMeshBuildVertex> Vertices;
    TArray<uint32> Indices;
    FBox Bounds(ForceInit);
    for (int32 I = 0; I < Triangles.Num() / int32(sizeof(FVector3f)); ++I)
    {
        auto& Vertex = Vertices.AddDefaulted_GetRef();
        FMemory::Memcpy(&Vertex.Position, Triangles.GetData() + I * sizeof(FVector3f), sizeof(FVector3f));
        Vertex.TangentX = FVector3f(1, 0, 0); Vertex.TangentY = FVector3f(0, 1, 0); Vertex.TangentZ = FVector3f(0, 0, 1);
        Vertex.UVs[0] = FVector2f::ZeroVector; Vertex.Color = FColor::White;
        Indices.Add(I); Bounds += FVector(Vertex.Position);
    }
    LOD.VertexBuffers.PositionVertexBuffer.Init(Vertices, true);
    FStaticMeshVertexBufferFlags Flags; Flags.bNeedsCPUAccess = true;
    LOD.VertexBuffers.StaticMeshVertexBuffer.Init(Vertices, 1, Flags);
    LOD.VertexBuffers.ColorVertexBuffer.InitFromSingleColor(FColor::White, Vertices.Num());
    // Match the CPU retention policy of the runtime-created vertex buffers so
    // the fallback can also survive the release/reinitialize lifecycle test.
    LOD.IndexBuffer.SetIndices(Indices, EIndexBufferStride::Force32Bit);
    verify(LOD.IndexBuffer.TrySetAllowCPUAccess(true));
    auto& Section = LOD.Sections.AddDefaulted_GetRef();
    Section.NumTriangles = 960; Section.MinVertexIndex = 0; Section.MaxVertexIndex = Vertices.Num() - 1;
    Section.bEnableCollision = false;
    Data->Bounds = FBoxSphereBounds(Bounds);
    auto* Mesh = NewObject<UStaticMesh>(GetTransientPackage(), NAME_None, RF_Transient);
    Mesh->AddToRoot(); Mesh->NeverStream = true; Mesh->bAllowCPUAccess = true;
    Mesh->GetStaticMaterials().Add(FStaticMaterial(UMaterial::GetDefaultMaterial(MD_Surface)));
    // Runtime construction has no editor UV-density build. The fallback uses
    // constant UVs and the default material, so its streaming density is zero.
    Mesh->GetStaticMaterials()[0].UVChannelData.bInitialized = true;
    Mesh->SetRenderData(MoveTemp(Data)); Mesh->CalculateExtendedBounds();
    Mesh->InitResources();
    return Mesh;
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteSceneTest(int Step)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (Step < 0 || Step > 6 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    static int LastStep = 0;
    if (Step == 6)
    {
        if (LastStep != 5) return 0;
        for (auto*& Component : SceneComponents)
        {
            Component->RemoveFromRoot(); Component->DestroyComponent(); Component = nullptr;
        }
        SceneMesh->RemoveFromRoot(); SceneMesh = nullptr; LastStep = 6;
        return 1;
    }
    if (!Step && (!SceneMesh || LastStep == 6)) return 0;
    if (Step)
    {
        if (Step != LastStep + 1) return 0;
        UWorld* World = nullptr;
        for (const auto& Context : GEngine->GetWorldContexts()) if (Context.WorldType == EWorldType::Game) World = Context.World();
        if (!World) return 0;
        if (Step == 1)
        {
            SceneMesh = CreateResidentSceneMesh(); if (!SceneMesh) return 0;
            for (int I = 0; I < 2; ++I)
            {
                auto* Component = NewObject<UStaticMeshComponent>(GetTransientPackage(), NAME_None, RF_Transient);
                Component->AddToRoot(); Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
                Component->SetMobility(EComponentMobility::Movable);
                Component->SetStaticMesh(SceneMesh);
                Component->SetWorldLocation(FVector(I * 150, 0, 200));
                Component->RegisterComponentWithWorld(World);
                SceneComponents[I] = Component;
            }
            // Duplicate asset initialization is a no-op for the resident manager.
            SceneMesh->GetRenderData()->NaniteResourcesPtr->InitResources(SceneMesh);
        }
        if (Step == 2) SceneComponents[0]->UnregisterComponent();
        if (Step == 3 || Step == 5)
        {
            for (auto* Component : SceneComponents) Component->UnregisterComponent();
            SceneMesh->ReleaseResources();
        }
        if (Step == 4)
        {
            SceneMesh->InitResources();
            SceneMesh->ReleaseResources();
            SceneMesh->InitResources();
            for (auto* Component : SceneComponents) Component->RegisterComponentWithWorld(World);
        }
        LastStep = Step;
    }
    int Registered = 0, Proxies = 0;
    for (auto* Component : SceneComponents) if (Component)
    {
        Registered += Component->IsRegistered(); Proxies += Component->SceneProxy != nullptr;
        check(Component->GetNaniteResources() == SceneMesh->GetRenderData()->NaniteResourcesPtr.Get());
    }
    auto* Resource = SceneMesh ? SceneMesh->GetRenderData()->NaniteResourcesPtr.Get() : nullptr;
    ENQUEUE_RENDER_COMMAND(WebNaniteScene)([Step, Registered, Proxies, Resource](FRHICommandListImmediate& Cmd) {
        static uint32 ActiveStep = 0, ID, Page, Offset, Levels, Clusters, RegisteredCount, ProxyCount;
        static bool Requested = false;
        static TUniquePtr<FRHIGPUBufferReadback> PageReadback, HierarchyReadback;
        static uint32 PageBytes, HierarchyBytes;
        auto& Manager = Nanite::GStreamingManager;
        if (Step)
        {
            check(!PageReadback);
            ActiveStep = Step; Requested = true;
            MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteSceneTest = {pending:true};});
            return;
        }
        const bool Active = ActiveStep != 3 && ActiveStep != 5;
        if (Requested)
        {
            MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteSceneTest = ({pending:true,step:$0,registered:$1,proxies:$2,id:$3,levels:$4,safe:!!$5});},
                ActiveStep, Registered, Proxies, Resource->RuntimeResourceID, Manager.GetMaxHierarchyLevels(), Manager.IsSafeForRendering());
        }
        if (Requested && Proxies == Registered && Manager.IsSafeForRendering() &&
            (Resource->RuntimeResourceID != INDEX_NONE) == Active && Manager.GetMaxHierarchyLevels() == (Active ? 1u : 0u))
        {
            Requested = false; RegisteredCount = Registered; ProxyCount = Proxies;
            ID = Resource->RuntimeResourceID; Page = Resource->RootPageIndex; Offset = Resource->HierarchyOffset;
            Levels = Manager.GetMaxHierarchyLevels(); Clusters = Active ? Resource->NumResidentClusters : 0;
            check(Manager.HasResourceEntries() == Active && !DoesPlatformSupportNanite(GMaxRHIShaderPlatform));
            check(!Resource->RootData.IsEmpty() && !Resource->HierarchyNodes.IsEmpty());
            if (!Active)
            {
                MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteSceneTest = ({pending:false,step:$0,registered:$1,proxies:$2,levels:0,active:false});},
                    ActiveStep, RegisteredCount, ProxyCount);
                return;
            }
            // The renderer must have installed resources on a prior frame. The
            // diagnostic only reads buffers; it never drives manager updates.
            FRDGBuilder Graph(Cmd, RDG_EVENT_NAME("WebNaniteSceneReadback"));
            auto* Pages = Manager.GetClusterPageDataSRV(Graph)->Desc.Buffer;
            auto* Hierarchy = Manager.GetHierarchySRV(Graph)->Desc.Buffer;
            PageBytes = Pages->Desc.GetSize(); HierarchyBytes = Hierarchy->Desc.GetSize();
            PageReadback = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebNaniteScenePages"));
            HierarchyReadback = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebNaniteSceneHierarchy"));
            AddEnqueueCopyPass(Graph, PageReadback.Get(), Pages, PageBytes);
            AddEnqueueCopyPass(Graph, HierarchyReadback.Get(), Hierarchy, HierarchyBytes);
            Graph.Execute();
        }
        else if (PageReadback && PageReadback->IsReady() && HierarchyReadback->IsReady())
        {
            const auto* Pages = static_cast<const uint8*>(PageReadback->Lock(PageBytes));
            const auto* Hierarchy = static_cast<const uint8*>(HierarchyReadback->Lock(HierarchyBytes));
            check(Pages && Hierarchy);
            MAIN_THREAD_EM_ASM({globalThis.__webNaniteSceneTest = ({pending:false,step:$0,registered:$1,proxies:$2,id:$3,page:$4,
                offset:$5 * 4,levels:$6,clusters:$7,active:true,
                pages:Array.from(HEAPU8.subarray(Number($8), Number($8) + $9)),
                hierarchy:Array.from(HEAPU8.subarray(Number($10), Number($10) + $11))});},
                ActiveStep, RegisteredCount, ProxyCount, ID, Page, Offset, Levels, Clusters, Pages, PageBytes, Hierarchy, HierarchyBytes);
            PageReadback->Unlock(); HierarchyReadback->Unlock();
            PageReadback.Reset(); HierarchyReadback.Reset();
        }
    });
    return 1;
}
