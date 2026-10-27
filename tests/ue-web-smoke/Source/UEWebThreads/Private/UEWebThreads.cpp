#include "CoreMinimal.h"
#include "Async/TaskGraphInterfaces.h"
#include "HAL/Event.h"
#include "HAL/PlatformTLS.h"
#include "HAL/Runnable.h"
#include "HAL/RunnableThread.h"
#include "Misc/CommandLine.h"
#include "Misc/ScopeLock.h"
#include "Tasks/Task.h"
#include <emscripten/heap.h>
#include <emscripten/threading.h>
#include <atomic>
#include <cstdio>

TCHAR GInternalProjectName[64] = TEXT("UEWebThreads");

namespace
{
constexpr int32 Iterations = 4000;
thread_local uint32 LocalValue = 0;

class FThreadProbe final : public FRunnable
{
public:
    FThreadProbe(uint32 InValue, uint32 InSlot, FCriticalSection& InLock, int32& InCounter)
        : Value(InValue), Slot(InSlot), Lock(InLock), Counter(InCounter)
    {
        Ready = FPlatformProcess::CreateSynchEvent(true);
        Gate = FPlatformProcess::CreateSynchEvent(true);
    }

    ~FThreadProbe()
    {
        delete Ready;
        delete Gate;
    }

    uint32 Run() override
    {
        ThreadId = FPlatformTLS::GetCurrentThreadId();
        LocalValue = Value;
        FPlatformTLS::SetTlsValue(Slot, reinterpret_cast<void*>(UPTRINT(Value)));
        TArray<uint8> Bytes;
        Bytes.Init(uint8(Value), 8 * 1024 * 1024);
        Ready->Trigger();
        if (!Gate->Wait(10000))
        {
            return 1;
        }
        for (int32 Index = 0; Index < Iterations && !Cancelled.load(); ++Index)
        {
            void* Allocation = FMemory::Malloc(257 + Index % 1024, 64);
            FMemory::Memset(Allocation, uint8(Value), 257);
            Allocation = FMemory::Realloc(Allocation, 4097, 64);
            AllocationOK &= reinterpret_cast<UPTRINT>(Allocation) % 64 == 0 &&
                static_cast<uint8*>(Allocation)[256] == uint8(Value);
            FMemory::Free(Allocation);
            FScopeLock Guard(&Lock);
            ++Counter;
        }
        Isolated = LocalValue == Value &&
            FPlatformTLS::GetTlsValue(Slot) == reinterpret_cast<void*>(UPTRINT(Value));
        AllocationOK &= Bytes[0] == uint8(Value) && Bytes.Last() == uint8(Value);
        return 0;
    }

    void Stop() override
    {
        Cancelled.store(true);
        Gate->Trigger();
    }

    void Exit() override
    {
        Exited = true;
    }

    FEvent* Ready;
    FEvent* Gate;
    uint32 ThreadId = 0;
    bool Isolated = false;
    bool AllocationOK = true;
    bool Exited = false;

private:
    uint32 Value;
    uint32 Slot;
    FCriticalSection& Lock;
    int32& Counter;
    std::atomic<bool> Cancelled{false};
};
}

int main()
{
    FCommandLine::Set(TEXT("-oversubscriptionratio=1 -TaskGraphUseDynamicThreadCreation=0"));
    GGameThreadId = FPlatformTLS::GetCurrentThreadId();
    GIsGameThreadIdInitialized = true;
    bool Pass = true;
    int32 Groups = 0;
    auto Check = [&](bool Result, const char* Name)
    {
        ++Groups;
        std::printf("UE_WEB_THREAD_CHECK {\"name\":\"%s\",\"pass\":%s}\n", Name, Result ? "true" : "false");
        Pass &= Result;
    };

    Check(FPlatformProcess::SupportsMultithreading() && !emscripten_is_main_browser_thread() &&
        FPlatformMisc::NumberOfCores() >= 2 && FPlatformMisc::NumberOfCores() <= 4, "worker-entry-and-bounded-cores");
    {
        TUniquePtr<FEvent> Manual(FPlatformProcess::CreateSynchEvent(true));
        TUniquePtr<FEvent> Automatic(FPlatformProcess::CreateSynchEvent(false));
        const double Start = FPlatformTime::Seconds();
        bool EventsOK = !Manual->Wait(20);
        const double Elapsed = FPlatformTime::Seconds() - Start;
        Manual->Trigger();
        EventsOK &= Manual->Wait(0) && Manual->Wait(0);
        Manual->Reset();
        EventsOK &= !Manual->Wait(0);
        Automatic->Trigger();
        EventsOK &= Automatic->Wait(0) && !Automatic->Wait(0);
        Check(EventsOK && Elapsed >= 0.010 && Elapsed < 2.0, "event-timeout-manual-auto-reset");
    }

    uint32 RunnableIds[2]{};
    const SIZE_T HeapBefore = emscripten_get_heap_size();
    SIZE_T HeapAfter = HeapBefore;
    {
        const uint32 Slot = FPlatformTLS::AllocTlsSlot();
        LocalValue = 99;
        FPlatformTLS::SetTlsValue(Slot, reinterpret_cast<void*>(UPTRINT(99)));
        FCriticalSection Lock;
        int32 Counter = 0;
        FThreadProbe First(17, Slot, Lock, Counter), Second(31, Slot, Lock, Counter);
        TUniquePtr<FRunnableThread> ThreadA(FRunnableThread::Create(&First, TEXT("WebProbeA")));
        TUniquePtr<FRunnableThread> ThreadB(FRunnableThread::Create(&Second, TEXT("WebProbeB")));
        Check(ThreadA && ThreadB && First.Ready->Wait(10000) && Second.Ready->Wait(10000), "runnable-create-and-wake");
        const SIZE_T GrowFrom = emscripten_get_heap_size();
        const bool Grew = emscripten_resize_heap(GrowFrom + 64 * 1024 * 1024);
        HeapAfter = emscripten_get_heap_size();
        First.Gate->Trigger();
        Second.Gate->Trigger();
        ThreadA->WaitForCompletion();
        ThreadB->WaitForCompletion();
        RunnableIds[0] = First.ThreadId;
        RunnableIds[1] = Second.ThreadId;
        Check(First.Exited && Second.Exited && Counter == Iterations * 2 &&
            First.ThreadId != Second.ThreadId && First.ThreadId != GGameThreadId &&
            Second.ThreadId != GGameThreadId, "parallel-lock-and-join");
        Check(First.Isolated && Second.Isolated && LocalValue == 99 &&
            FPlatformTLS::GetTlsValue(Slot) == reinterpret_cast<void*>(UPTRINT(99)), "tls-isolation");
        Check(Grew && HeapAfter > GrowFrom && First.AllocationOK && Second.AllocationOK,
            "concurrent-allocator-and-shared-memory-growth");

        FThreadProbe Cancelled(42, Slot, Lock, Counter);
        TUniquePtr<FRunnableThread> CancelThread(FRunnableThread::Create(&Cancelled, TEXT("WebProbeCancel")));
        const bool Ready = CancelThread && Cancelled.Ready->Wait(10000);
        Check(Ready && CancelThread->Kill(true) && Cancelled.Exited && Counter == Iterations * 2,
            "cooperative-stop-and-join");
        FPlatformTLS::FreeTlsSlot(Slot);
    }

    uint32 TaskIds[2]{};
    uint64 Sum = 0;
    for (int32 Cycle = 0; Cycle < 2; ++Cycle)
    {
        FTaskGraphInterface::Startup(FPlatformMisc::NumberOfWorkerThreadsToSpawn());
        FTaskGraphInterface::Get().AttachToThread(ENamedThreads::GameThread);
        {
            TUniquePtr<FEvent> Gate(FPlatformProcess::CreateSynchEvent(true));
            TUniquePtr<FEvent> ReadyA(FPlatformProcess::CreateSynchEvent(true));
            TUniquePtr<FEvent> ReadyB(FPlatformProcess::CreateSynchEvent(true));
            std::atomic<int32> Active{0};
            std::atomic<int32> Peak{0};
            auto Body = [&](int32 Index, FEvent& Ready)
            {
                TaskIds[Index] = FPlatformTLS::GetCurrentThreadId();
                const int32 Current = Active.fetch_add(1) + 1;
                int32 Previous = Peak.load();
                while (Previous < Current && !Peak.compare_exchange_weak(Previous, Current)) {}
                Ready.Trigger();
                const bool Woke = Gate->Wait(10000);
                Active.fetch_sub(1);
                return Woke;
            };
            auto A = UE::Tasks::Launch(TEXT("WebParallelA"), [&] { return Body(0, *ReadyA); });
            auto B = UE::Tasks::Launch(TEXT("WebParallelB"), [&] { return Body(1, *ReadyB); });
            const bool Started = ReadyA->Wait(10000) && ReadyB->Wait(10000);
            Gate->Trigger();
            A.Wait();
            B.Wait();
            Check(Started && A.GetResult() && B.GetResult() && Peak.load() == 2 &&
                TaskIds[0] != TaskIds[1] && TaskIds[0] != GGameThreadId && TaskIds[1] != GGameThreadId,
                Cycle == 0 ? "ue-tasks-parallel-workers" : "ue-tasks-restart-parallel-workers");

            std::atomic<uint64> Accumulator{0};
            TArray<UE::Tasks::FTask> Jobs;
            for (uint32 Index = 1; Index <= 256; ++Index)
            {
                Jobs.Add(UE::Tasks::Launch(TEXT("WebTaskBatch"), [&, Index]
                {
                    TArray<uint32> Values;
                    Values.Init(Index, 1024);
                    Accumulator.fetch_add(Values[0] + Values.Last(), std::memory_order_relaxed);
                }));
            }
            for (const auto& Job : Jobs) Job.Wait();
            Sum = Accumulator.load();
            Check(Sum == 65792, "ue-tasks-batch-allocations");

            std::atomic<int32> Dependency{0};
            auto Prerequisite = UE::Tasks::Launch(TEXT("WebPrerequisite"), [&] { Dependency.store(7); });
            auto Dependent = UE::Tasks::Launch(TEXT("WebDependent"), [&]
            {
                return Dependency.load() == 7;
            }, UE::Tasks::Prerequisites(Prerequisite));
            Check(Dependent.Wait() && Dependent.GetResult(), "ue-tasks-dependencies");

            std::atomic<uint32> GraphThread{0};
            TUniquePtr<FEvent> GraphReady(FPlatformProcess::CreateSynchEvent(true));
            FGraphEventRef GraphTask = FFunctionGraphTask::CreateAndDispatchWhenReady([&]
            {
                GraphThread.store(FPlatformTLS::GetCurrentThreadId());
                GraphReady->Trigger();
            }, TStatId(), nullptr, ENamedThreads::AnyBackgroundThreadNormalTask);
            const bool GraphStarted = GraphReady->Wait(10000);
            FTaskGraphInterface::Get().WaitUntilTaskCompletes(GraphTask);
            Check(GraphStarted && GraphThread.load() != 0 && GraphThread.load() != GGameThreadId, "taskgraph-dispatch");
        }
        FTaskGraphInterface::Shutdown();
        Check(!FTaskGraphInterface::IsRunning(), "taskgraph-shutdown");
    }

    // Keep the engine Worker blocked long enough for the browser probe to observe UI heartbeats.
    FPlatformProcess::SleepNoStats(0.3f);
    std::printf("UE_WEB_THREAD_RESULT {\"pass\":%s,\"groups\":%d,\"pointerBytes\":%zu,"
        "\"browserMainThread\":%s,\"cores\":%d,\"gameThreadId\":%u,\"runnableIds\":[%u,%u],"
        "\"taskIds\":[%u,%u],\"heapBefore\":%zu,\"heapAfter\":%zu,\"sum\":%llu}\n",
        Pass ? "true" : "false", Groups, sizeof(void*),
        emscripten_is_main_browser_thread() ? "true" : "false", FPlatformMisc::NumberOfCores(),
        GGameThreadId, RunnableIds[0], RunnableIds[1], TaskIds[0], TaskIds[1],
        HeapBefore, HeapAfter, static_cast<unsigned long long>(Sum));
    FPlatformProcess::TearDownThreadedRuntime();
    return Pass ? 0 : 1;
}
