#include "CoreMinimal.h"
#include <emscripten.h>
#include "HAL/IConsoleManager.h"

extern "C" EMSCRIPTEN_KEEPALIVE int WebBindingCacheTest(int Enabled)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* Variable = IConsoleManager::Get().FindConsoleVariable(TEXT("r.WebGPU.ValidateBindingCache"));
    if (!Variable) return 0;
    Variable->Set(Enabled ? 1 : 0, ECVF_SetByCode);
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebBindingGroupTest(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    // Mode 0/1 controls only this backend optimization; mode 2 requests logs.
    const TCHAR* Name = Mode == 2 ? TEXT("r.Web.ShadowSubmissionProbe") : TEXT("r.WebGPU.BindingGroupCache");
    auto* Variable = IConsoleManager::Get().FindConsoleVariable(Name);
    if (!Variable || Mode < 0 || Mode > 2) return 0;
    Variable->Set(Mode == 2 ? 240 : Mode, ECVF_SetByCode);
    if (Mode == 2)
        if (auto* Local = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Web.ShadowCacheProbe")))
            Local->Set(240, ECVF_SetByCode);
    return 1;
}

#if UE_TRACE_ENABLED
#include "ProfilingDebugging/TraceAuxiliary.h"
#include "ProfilingDebugging/MiscTrace.h"
#include "Misc/ScopeLock.h"
#include <atomic>

namespace {
FCriticalSection CaptureCS;
TArray<uint8> CaptureBytes;
std::atomic<bool> CaptureClosed{true}, CaptureOverflow{false};
bool CaptureStarted = false;
bool WriteCapture(UPTRINT, const void* Data, uint32 Size)
{
    FScopeLock Lock(&CaptureCS);
    constexpr uint32 MaximumBytes = 256 * 1024 * 1024;
    if (uint64(CaptureBytes.Num()) + Size > MaximumBytes)
    {
        CaptureOverflow.store(true);
        return false;
    }
    CaptureBytes.Append(static_cast<const uint8*>(Data), Size);
    return true;
}
void CloseCapture(UPTRINT) { CaptureClosed.store(true, std::memory_order_release); }
}
extern "C" EMSCRIPTEN_KEEPALIVE void WebTraceRegisterOwner()
{
    // UE's RHI queue is pumped on the runtime owner, without an FRunnableThread
    // startup hook. Register its name there, while trace control stays on GT.
    UE::Trace::ThreadRegister(TEXT("RHIThread"), FPlatformTLS::GetCurrentThreadId(), 0);
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebTraceStart()
{
    if (CaptureStarted || !CaptureClosed.load(std::memory_order_acquire)) return 0;
    MAIN_THREAD_EM_ASM({ Module._WebTraceRegisterOwner(); });
    { FScopeLock Lock(&CaptureCS); CaptureBytes.Reset(); }
    CaptureOverflow.store(false);
    CaptureClosed.store(false);
    FTraceAuxiliary::FOptions Options;
    Options.bExcludeTail = true;
    CaptureStarted = FTraceAuxiliary::Relay(1, WriteCapture, CloseCapture,
        TEXT("cpu,frame,bookmark,task,rhicommands"), &Options);
    if (!CaptureStarted) CaptureClosed.store(true);
    TRACE_BOOKMARK(TEXT("WebCaptureStart"));
    return CaptureStarted ? 1 : 0;
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebTraceStop()
{
    if (!CaptureStarted) return 0;
    TRACE_BOOKMARK(TEXT("WebCaptureStop"));
    const bool Stopped = FTraceAuxiliary::Stop();
    CaptureStarted = false;
    return Stopped ? 1 : 0;
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebTraceExport()
{
    if (CaptureStarted || !CaptureClosed.load(std::memory_order_acquire)) return 0;
    if (CaptureOverflow.load()) return -1;
    FScopeLock Lock(&CaptureCS);
    if (!CaptureBytes.Num()) return -2;
    MAIN_THREAD_EM_ASM({
        const pointer = Number($0);
        const size = $1;
        const bytes = HEAPU8.slice(pointer, pointer + size);
        postMessage({type: 'trace', bytes}, [bytes.buffer]);
    }, CaptureBytes.GetData(), CaptureBytes.Num());
    return CaptureBytes.Num();
}
#endif
