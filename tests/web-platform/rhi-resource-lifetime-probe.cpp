// Compile the extracted production refcount methods with controlled atomic
// scheduling. Objects stay allocated so a delete claim is observable safely.
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
using uint32 = uint32_t;
using int32 = int32_t;
#define TEXT(x) x
#define check(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
#define checkf(x, ...) check(x)
#define checkSlow(x) check(x)

struct Gate
{
    enum Mode { AfterZero, AfterLoad } Mode;
    std::mutex Mutex;
    std::condition_variable Condition;
    bool Reached = false, Resume = false;
    void Pause()
    {
        std::unique_lock Lock(Mutex);
        if (Reached) return;
        Reached = true; Condition.notify_all();
        Condition.wait(Lock, [&] { return Resume; });
    }
    void Wait() { std::unique_lock Lock(Mutex); Condition.wait(Lock, [&] { return Reached; }); }
    void Continue() { std::lock_guard Lock(Mutex); Resume = true; Condition.notify_all(); }
};
thread_local Gate* ActiveGate = nullptr;
void Hook(bool Load, uint32 Value)
{
    if (ActiveGate && ((Load && ActiveGate->Mode == Gate::AfterLoad) ||
        (!Load && ActiveGate->Mode == Gate::AfterZero && (Value & 0x3fffffffu) == 0))) ActiveGate->Pause();
}
struct ObservedAtomic
{
    std::atomic_uint Value;
    ObservedAtomic(uint32 Initial) : Value(Initial) {}
    uint32 load(std::memory_order Order) const { const auto V = Value.load(Order); Hook(true, V); return V; }
    uint32 fetch_add(uint32 V, std::memory_order O) { return Value.fetch_add(V, O); }
    uint32 fetch_sub(uint32 V, std::memory_order O) { const auto Old = Value.fetch_sub(V, O); Hook(false, Old - V); return Old; }
    uint32 fetch_or(uint32 V, std::memory_order O) { return Value.fetch_or(V, O); }
    uint32 fetch_xor(uint32 V, std::memory_order O) { return Value.fetch_xor(V, O); }
    bool compare_exchange_weak(uint32& Expected, uint32 Desired, std::memory_order Success, std::memory_order Failure)
    {
        const bool Result = Value.compare_exchange_weak(Expected, Desired, Success, Failure);
        if (Result) Hook(false, Desired);
        return Result;
    }
};
std::atomic_uint Enqueued{0};
struct Queue { std::atomic_uint Count{0}; void ProduceItem(void*) { ++Count; ++Enqueued; } } PendingDeletes, PendingDeletesWithLifetimeExtension;
#if !DO_CHECK
#undef check
#undef checkf
#undef checkSlow
#define check(x) do {} while (0)
#define checkf(x, ...) do {} while (0)
#define checkSlow(x) do {} while (0)
#endif
#include "rhi-resource-lifetime.generated.h"
#if !DO_CHECK
// The no-check variant disables production assertions, but the test oracle
// must still verify the resulting state and fail on any regression.
#undef check
#undef checkf
#undef checkSlow
#define check(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
#define checkf(x, ...) check(x)
#define checkSlow(x) check(x)
#endif

void PrepareRevived(FRHIResource& R)
{
    Enqueued = 0; PendingDeletes.Count = 0; PendingDeletesWithLifetimeExtension.Count = 0;
    check(R.AddRef() == 1); check(R.Release() == 0);
    check(Enqueued == 1); check(R.AddRef() == 1);
}
int main()
{
    // A queued resource is revived, then released by an RDG worker. Stop the
    // worker immediately after it publishes zero and let the RHI claim deletion.
    bool ReleaseTouchedDeleted = false;
    {
        FRHIResource R; PrepareRevived(R); Gate G{Gate::AfterZero};
        std::thread Worker([&] {
            ActiveGate = &G;
            try { check(R.Release() == 0); }
            catch (const std::runtime_error& Error) { check(std::string(Error.what()) == "(OldPacked & DeletingBit) == 0"); ReleaseTouchedDeleted = true; }
        });
        G.Wait(); check(R.AtomicFlags.Deleting()); G.Continue(); Worker.join();
        check(Enqueued == 1);
    }
    // Deletion first observes a live revived reference. A last release occurs
    // before it can clear the mark. It must retry, not lose the only queue entry.
    bool LostDelete = false;
    {
        FRHIResource R; PrepareRevived(R); Gate G{Gate::AfterLoad}; bool Deleted = false;
        std::thread Worker([&] { ActiveGate = &G; Deleted = R.AtomicFlags.Deleting(); });
        G.Wait(); check(R.Release() == 0); G.Continue(); Worker.join();
        LostDelete = !Deleted && Enqueued == 1;
    }
    // Revive after the deletion consumer reads zero, before its state change.
    // The consumer must not claim a now-live resource from a stale load.
    bool DeletedLive = false;
    {
        FRHIResource R; Enqueued = 0; R.AddRef(); R.Release(); Gate G{Gate::AfterLoad};
        std::thread Worker([&] { ActiveGate = &G; DeletedLive = R.AtomicFlags.Deleting(); });
        G.Wait(); check(R.AddRef() == 1); G.Continue(); Worker.join();
        if (!DeletedLive) { check(R.Release() == 0); check(Enqueued == 2); check(R.AtomicFlags.Deleting()); }
    }
    check(ReleaseTouchedDeleted == !EXPECT_FIXED);
    check(LostDelete == !EXPECT_FIXED);
    check(DeletedLive == !EXPECT_FIXED);
    // A reference retained through queue consumption must get a new queue entry
    // on its eventual last release. Both lifetime-extension policies are used.
    for (bool Extend : {false, true})
    {
        FRHIResource R; R.bAllowExtendLifetime = Extend; PrepareRevived(R);
        check(!R.AtomicFlags.Deleting()); check(R.GetRefCount() == 1);
        check(R.Release() == 0); check(Enqueued == 2); check(R.AtomicFlags.Deleting());
        check(PendingDeletes.Count == (Extend ? 0u : 2u));
        check(PendingDeletesWithLifetimeExtension.Count == (Extend ? 2u : 0u));
    }
    // Contended ordinary references stay live while an anchor is held; only its
    // final release may enqueue. Exercise actual Wasm pthread atomics repeatedly.
    constexpr int Threads = 8, Iterations = 20000;
    {
        FRHIResource R; Enqueued = 0; R.AddRef(); std::vector<std::thread> Workers;
        for (int I = 0; I < Threads; ++I) Workers.emplace_back([&] {
            for (int J = 0; J < Iterations; ++J) { R.AddRef(); R.Release(); }
        });
        for (auto& Worker : Workers) Worker.join();
        check(R.GetRefCount() == 1); check(Enqueued == 0);
        check(R.Release() == 0); check(Enqueued == 1); check(R.AtomicFlags.Deleting());
    }
    std::printf("{\"pass\":true,\"fixed\":%s,\"releaseTouchedDeleted\":%s,\"lostDelete\":%s,\"deletedLive\":%s,\"threads\":%d,\"referencePairs\":%d}\n",
        EXPECT_FIXED ? "true" : "false", ReleaseTouchedDeleted ? "true" : "false", LostDelete ? "true" : "false", DeletedLive ? "true" : "false", Threads, Threads * Iterations);
}
