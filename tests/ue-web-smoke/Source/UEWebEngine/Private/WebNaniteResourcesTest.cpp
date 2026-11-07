#include "CoreMinimal.h"
#include "Misc/FileHelper.h"
#include "Serialization/MemoryReader.h"
#include "Serialization/JsonSerializer.h"
#include "Rendering/NaniteResources.h"
#include "Rendering/NaniteStreamingManager.h"
#include "Nanite/NaniteFixupChunk.h"
#include "UObject/Package.h"
#include "RenderingThread.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include <emscripten.h>

namespace
{
TArray<TSharedPtr<FJsonValue>> JsonBytes(const uint8* Data, uint32 Size)
{
    TArray<TSharedPtr<FJsonValue>> Result;
    for (uint32 I = 0; I < Size; ++I) Result.Add(MakeShared<FJsonValueNumber>(Data[I]));
    return Result;
}

TArray<TSharedPtr<FJsonValue>> JsonPages(const TSet<Nanite::FPageInfo>& Pages)
{
    TArray<TSharedPtr<FJsonValue>> Result;
    for (const auto& Page : Pages)
    {
        auto Item = MakeShared<FJsonObject>();
        Item->SetNumberField(TEXT("page"), Page.GPUPageIndex);
        Item->SetNumberField(TEXT("id"), Page.RuntimeResourceID);
        Item->SetNumberField(TEXT("clusters"), Page.NumClusters);
        Result.Add(MakeShared<FJsonValueObject>(Item));
    }
    return Result;
}
}

// Exercises the real Engine manager in a private, two-root-page pool while the
// ordinary scene continues rendering. No renderer-wide Nanite capability flag.
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteResourcesTest(int Step)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (Step < 0 || Step > 4 || !GDynamicRHI) return 0;
    TUniquePtr<Nanite::FResources> Incoming;
    if (Step)
    {
        TArray<uint8> Cooked;
        if (!FFileHelper::LoadFileToArray(Cooked, TEXT("/Engine/Programs/UEWebEngine/Content/NaniteUploader/resources.cooked.bin"))) return 0;
        Incoming = MakeUnique<Nanite::FResources>();
        FMemoryReader Reader(Cooked, true);
        Reader.SetFilterEditorOnly(true);
        Incoming->Serialize(Reader, GetTransientPackage(), true);
        if (Reader.IsError() || Reader.Tell() != Cooked.Num() || Incoming->NumRootPages != 1 ||
            Incoming->HasStreamingData() || Incoming->PageStreamingStates.Num() != 1 ||
            Incoming->HierarchyNodes.IsEmpty()) return 0;
        Incoming->PersistentHash = 0x12340000 + Step;
    }
    ENQUEUE_RENDER_COMMAND(WebNaniteResources)([Step, Incoming = MoveTemp(Incoming)](FRHICommandListImmediate& Cmd) mutable {
        static Nanite::FStreamingManager Manager;
        static TUniquePtr<Nanite::FResources> Resources[2];
        static TUniquePtr<FRHIGPUBufferReadback> PagesReadback, HierarchyReadback;
        static TSharedPtr<FJsonObject> Report;
        static uint32 PagesSize, HierarchySize, LastStep = 0;
        if (Step)
        {
            check(!PagesReadback && Step == LastStep + 1);
            LastStep = Step;
            Report = MakeShared<FJsonObject>();
            Report->SetNumberField(TEXT("step"), Step);
            if (Step == 1)
            {
                verify(!Manager.ConfigureWebResidentResources(0));
                verify(!Manager.ConfigureWebResidentResources(MAX_uint32));
                verify(Manager.ConfigureWebResidentResources(2));
                Manager.InitResource(Cmd);
                verify(!Manager.ConfigureWebResidentResources(3));
                // A resource with non-root pages must be rejected before allocation.
                Incoming->PageStreamingStates.AddDefaulted();
                verify(!Manager.AddWebResidentResource(Incoming.Get()));
                check(Incoming->RuntimeResourceID == INDEX_NONE && Incoming->HierarchyOffset == INDEX_NONE);
                Incoming->PageStreamingStates.Pop();
                Report->SetBoolField(TEXT("rejectedStreaming"), true);
            }
            if (Step == 3)
            {
                verify(!Manager.AddWebResidentResource(Incoming.Get()));
                check(Incoming->RuntimeResourceID == INDEX_NONE && Incoming->HierarchyOffset == INDEX_NONE);
                Report->SetBoolField(TEXT("rejectedBudget"), true);
                Report->SetNumberField(TEXT("removedId"), Resources[0]->RuntimeResourceID);
                Manager.Remove(Resources[0].Get());
                check(Resources[0]->RuntimeResourceID == INDEX_NONE && Resources[0]->RootPageIndex == INDEX_NONE);
                Resources[0].Reset();
            }
            if (Step == 4)
            {
                for (auto& Resource : Resources) { Manager.Remove(Resource.Get()); Resource.Reset(); }
                // Cancellation before installation must not leave a resource or page notification.
                verify(Manager.AddWebResidentResource(Incoming.Get()));
                Manager.Remove(Incoming.Get());
                check(Incoming->RuntimeResourceID == INDEX_NONE && !Manager.HasResourceEntries());
                Report->SetBoolField(TEXT("cancelledPending"), true);
            }
            else
            {
                const int32 Slot = Step == 2 ? 1 : 0;
                auto& Resource = Resources[Slot];
                Resource = MoveTemp(Incoming);
                // Capture the original Cook hierarchy and its relocation table for
                // independent byte comparison in the browser verifier.
                Report->SetArrayField(TEXT("originalHierarchy"), JsonBytes(
                    reinterpret_cast<const uint8*>(Resource->HierarchyNodes.GetData()),
                    Resource->HierarchyNodes.Num() * sizeof(Nanite::FPackedHierarchyNode)));
                TArray<TSharedPtr<FJsonValue>> Fixups;
                const auto* Fixup = reinterpret_cast<const Nanite::FFixupChunk*>(
                    Resource->RootData.GetData() + Resource->PageStreamingStates[0].BulkOffset);
                check(Fixup->Header.Magic == NANITE_FIXUP_MAGIC);
                for (uint32 I = 0; I < Fixup->Header.NumPartFixups; ++I)
                {
                    const auto& Part = Fixup->GetPartFixup(I);
                    for (uint32 J = 0; J < Part.NumHierarchyLocations; ++J)
                    {
                        const auto& Location = Fixup->GetHierarchyLocation(Part.FirstHierarchyLocation + J);
                        const auto* Address = &Resource->HierarchyNodes[Location.GetNodeIndex()].Misc1[Location.GetChildIndex()].ChildStartReference;
                        auto Item = MakeShared<FJsonObject>();
                        Item->SetNumberField(TEXT("offset"), reinterpret_cast<const uint8*>(Address) - reinterpret_cast<const uint8*>(Resource->HierarchyNodes.GetData()));
                        Item->SetNumberField(TEXT("page"), Part.PageIndex);
                        Item->SetNumberField(TEXT("cluster"), Part.StartClusterIndex);
                        Fixups.Add(MakeShared<FJsonValueObject>(Item));
                    }
                }
                Report->SetArrayField(TEXT("fixups"), Fixups);
                Report->SetNumberField(TEXT("clusterBits"), NANITE_MAX_CLUSTERS_PER_PAGE_BITS);
                Report->SetNumberField(TEXT("expectedLevels"), Resource->PageStreamingStates[0].MaxHierarchyDepth + 1);
                verify(Manager.AddWebResidentResource(Resource.Get()));
                verify(!Manager.AddWebResidentResource(Resource.Get()));
                check(!Manager.IsSafeForRendering());
            }
            FRDGBuilder Graph(Cmd, RDG_EVENT_NAME("WebNaniteResources"));
            Manager.BeginAsyncUpdate(Graph);
            check(Manager.IsAsyncUpdateInProgress());
            Manager.EndAsyncUpdate(Graph);
            check(Manager.IsSafeForRendering() && !Manager.IsAsyncUpdateInProgress());
            check(Manager.GetMaxStreamingPages() == 0 && Manager.GetMaxRootPages() == 2);
            check(!Manager.GetStreamingRequestsBuffer(Graph) && Manager.GetStreamingRequestsBufferVersion() == 0);
            Report->SetNumberField(TEXT("levels"), Manager.GetMaxHierarchyLevels());
            Report->SetBoolField(TEXT("hasResources"), Manager.HasResourceEntries());
            TArray<TSharedPtr<FJsonValue>> Active;
            for (const auto& Resource : Resources) if (Resource)
            {
                auto Item = MakeShared<FJsonObject>();
                Item->SetNumberField(TEXT("id"), Resource->RuntimeResourceID);
                Item->SetNumberField(TEXT("page"), Resource->RootPageIndex);
                Item->SetNumberField(TEXT("hierarchyOffset"), Resource->HierarchyOffset * 4);
                Item->SetNumberField(TEXT("hierarchyBytes"), Resource->NumHierarchyDwords * 4);
                Item->SetNumberField(TEXT("clusters"), Resource->NumResidentClusters);
                check(Resource->RootData.IsEmpty() && Resource->HierarchyNodes.IsEmpty());
                Active.Add(MakeShared<FJsonValueObject>(Item));
            }
            Report->SetArrayField(TEXT("active"), Active);
            TSet<Nanite::FPageInfo> Installed, Uninstalled;
            Manager.GetAndClearModifiedPages(Installed, Uninstalled);
            Report->SetArrayField(TEXT("installed"), JsonPages(Installed));
            Report->SetArrayField(TEXT("uninstalled"), JsonPages(Uninstalled));
            auto Modified = Manager.GetAndClearModifiedResources();
            Report->SetNumberField(TEXT("modifiedCount"), Modified.Num());
            for (const auto& Resource : Resources) if (Resource && Modified.Contains(Resource->RuntimeResourceID))
                check(Modified[Resource->RuntimeResourceID] == Resource->NumResidentClusters);
            auto* Pages = Manager.GetClusterPageDataSRV(Graph)->Desc.Buffer;
            auto* Hierarchy = Manager.GetHierarchySRV(Graph)->Desc.Buffer;
            PagesSize = Pages->Desc.GetSize(); HierarchySize = Hierarchy->Desc.GetSize();
            PagesReadback = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebNaniteResidentPages"));
            HierarchyReadback = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebNaniteResidentHierarchy"));
            AddEnqueueCopyPass(Graph, PagesReadback.Get(), Pages, PagesSize);
            AddEnqueueCopyPass(Graph, HierarchyReadback.Get(), Hierarchy, HierarchySize);
            Graph.Execute();
            MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteResourcesTest = {pending:true};});
        }
        else if (PagesReadback && PagesReadback->IsReady() && HierarchyReadback->IsReady())
        {
            const auto* Pages = static_cast<const uint8*>(PagesReadback->Lock(PagesSize));
            const auto* Hierarchy = static_cast<const uint8*>(HierarchyReadback->Lock(HierarchySize));
            check(Pages && Hierarchy);
            FString Json;
            FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json));
            FTCHARToUTF8 Utf8(*Json);
            MAIN_THREAD_EM_ASM({
                globalThis.__webNaniteResourcesTest = Object.assign(JSON.parse(UTF8ToString($0)), {pending:false,
                    pages:Array.from(HEAPU8.subarray(Number($1), Number($1) + $2)),
                    hierarchy:Array.from(HEAPU8.subarray(Number($3), Number($3) + $4))});
            }, Utf8.Get(), Pages, PagesSize, Hierarchy, HierarchySize);
            PagesReadback->Unlock(); HierarchyReadback->Unlock();
            PagesReadback.Reset(); HierarchyReadback.Reset(); Report.Reset();
            if (LastStep == 4) Manager.ReleaseResource();
        }
    });
    return 1;
}
