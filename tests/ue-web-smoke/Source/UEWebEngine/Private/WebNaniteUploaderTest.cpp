#include "CoreMinimal.h"
#include "Misc/FileHelper.h"
#include "Serialization/MemoryReader.h"
#include "Rendering/NaniteResources.h"
#include "Nanite/NaniteFixupChunk.h"
#include "UObject/Package.h"
#include "RenderingThread.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "Nanite/NaniteStreamingPageUploader.h"
#include <emscripten.h>

// Explicit browser diagnostic. The ordinary renderer and asset activation
// policy are unchanged; uploads use the actual Engine module implementation.
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteUploaderTest(int Step)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (Step < 0 || Step > 4 || !GDynamicRHI || !GRHISupportsWaveOperations || GRHIMinimumWaveSize < 32) return 0;
    TArray<uint8> Disk;
    uint32 PageBytes = 0, Clusters = 0;
    if (Step)
    {
        TArray<uint8> Cooked;
        if (!FFileHelper::LoadFileToArray(Cooked, TEXT("/Engine/Programs/UEWebEngine/Content/NaniteUploader/resources.cooked.bin"))) return 0;
        Nanite::FResources Resources;
        FMemoryReader Reader(Cooked, true);
        Reader.SetFilterEditorOnly(true);
        Resources.Serialize(Reader, GetTransientPackage(), true);
        if (Reader.IsError() || Reader.Tell() != Cooked.Num() || Resources.NumRootPages != 1 ||
            Resources.HasStreamingData() || Resources.PageStreamingStates.Num() != 1) return 0;
        const auto& State = Resources.PageStreamingStates[0];
        if (uint64(State.BulkOffset) + State.BulkSize > uint64(Resources.RootData.Num()) ||
            State.BulkSize < sizeof(Nanite::FFixupChunk::FHeader) || State.DependenciesNum) return 0;
        const auto* Data = Resources.RootData.GetData() + State.BulkOffset;
        const auto* Fixup = reinterpret_cast<const Nanite::FFixupChunk*>(Data);
        const uint32 FixupSize = Fixup->GetSize();
        if (Fixup->Header.Magic != NANITE_FIXUP_MAGIC || FixupSize > State.BulkSize ||
            State.PageSize != State.BulkSize - FixupSize || !Fixup->Header.NumClusters) return 0;
        PageBytes = NANITE_ROOT_PAGE_GPU_SIZE;
        Clusters = Fixup->Header.NumClusters;
        Disk.Append(Data + FixupSize, State.PageSize);
    }
    ENQUEUE_RENDER_COMMAND(WebNaniteUploader)([Step, Disk = MoveTemp(Disk), PageBytes, Clusters](FRHICommandListImmediate& Cmd) {
        static Nanite::FStreamingPageUploader Uploader;
        static TUniquePtr<FRHIGPUBufferReadback> Readback;
        static uint32 Prefix, Count, Size, ActiveCase;
        if (Step)
        {
            check(!Readback);
            ActiveCase = Step - 1;
            Prefix = ActiveCase ? 256 : 0;
            Count = ActiveCase >= 2 ? 2 : 1;
            Size = PageBytes;
            TArray<uint8> Initial;
            Initial.Init(0xa5, Prefix + Count * Size + 256);
            FMemory::Memzero(Initial.GetData() + Prefix, Count * Size);
            FRDGBuilder Graph(Cmd, RDG_EVENT_NAME("WebNaniteUploader"));
            auto* Target = Graph.CreateBuffer(FRDGBufferDesc::CreateByteAddressDesc(Initial.Num()), TEXT("WebNaniteUploaderTarget"));
            Graph.QueueBufferUpload(Target, MakeArrayView(Initial));
            Uploader.Init(Graph, Count, Count * Disk.Num(), 0);
            if (ActiveCase == 2)
                FMemory::Memcpy(Uploader.Add_GetRef(Disk.Num(), Clusters, Prefix + Size, {1, 1}, {0}), Disk.GetData(), Disk.Num());
            FMemory::Memcpy(Uploader.Add_GetRef(Disk.Num(), Clusters, Prefix, {1, 0}, {}), Disk.GetData(), Disk.Num());
            Uploader.ResourceUploadTo(Graph, Target);
            if (ActiveCase == 3)
            {
                Uploader.Init(Graph, 1, Disk.Num(), 0);
                FMemory::Memcpy(Uploader.Add_GetRef(Disk.Num(), Clusters, Prefix + Size, {2, 0}, {}), Disk.GetData(), Disk.Num());
                Uploader.ResourceUploadTo(Graph, Target);
            }
            Readback = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebNaniteUploaderReadback"));
            AddEnqueueCopyPass(Graph, Readback.Get(), Target, Initial.Num());
            Graph.Execute();
            MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteUploaderTest = ({pending:true, index:$0, min:$1, max:$2});},
                ActiveCase, GRHIMinimumWaveSize, GRHIMaximumWaveSize);
        }
        else if (Readback && Readback->IsReady())
        {
            const auto* Bytes = static_cast<const uint8*>(Readback->Lock(Prefix + Count * Size + 256));
            bool Guards = Bytes != nullptr;
            if (Bytes)
            {
                for (uint32 Index = 0; Index < Prefix; ++Index) Guards &= Bytes[Index] == 0xa5;
                for (uint32 Index = 0; Index < 256; ++Index) Guards &= Bytes[Prefix + Count * Size + Index] == 0xa5;
                // Synchronous copy while the mapped readback remains valid.
                MAIN_THREAD_EM_ASM({
                    globalThis.__webNaniteUploaderTest = ({pending:false, index:$0, guards:!!$1, size:$2, count:$3,
                        bytes:Array.from(HEAPU8.subarray(Number($4), Number($4) + $2 * $3))});
                }, ActiveCase, Guards, Size, Count, Bytes + Prefix);
                Readback->Unlock();
            }
            else MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteUploaderTest = ({pending:false, error:'Readback lock failed'});});
            Readback.Reset();
            FRDGBuilder Empty(Cmd, RDG_EVENT_NAME("WebNaniteUploaderEmpty"));
            Uploader.Init(Empty, 1, 16, 0);
            Uploader.ResourceUploadTo(Empty, nullptr);
            Empty.Execute();
            Uploader.Release();
        }
    });
    return 1;
}
