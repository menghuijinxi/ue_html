#include "HAL/PlatformAtomics.h"
#include "HAL/PlatformMath.h"
#include "HAL/PlatformMemory.h"
#include "HAL/PlatformMutex.h"
#include "HAL/PlatformString.h"
#include "HAL/PlatformTLS.h"
#include <cstdio>
#include <cstring>
#include <emscripten.h>
#include <zlib.h>

static_assert(sizeof(FInt128) == 16 && alignof(FInt128) == 16);
static_assert(!PLATFORM_HAS_128BIT_ATOMICS);
static_assert(!PLATFORM_HAS_FPlatformVirtualMemoryBlock);
static_assert(FPlatformMemory::KernelAddressBit == 63);

extern "C" EMSCRIPTEN_KEEPALIVE uint64 WebCoreAtomicRoundTrip(uint64 Value)
{
    volatile int64 Storage = static_cast<int64>(Value);
    FPlatformAtomics::InterlockedAdd(&Storage, int64(17));
    return static_cast<uint64>(FPlatformAtomics::AtomicRead(&Storage));
}

int main()
{
    bool Pass = true;
    int Groups = 0;
    auto Check = [&](bool Result, const char* Name)
    {
        ++Groups;
        if (!Result)
        {
            std::printf("P3_CORE_SERVICE_FAILED %s\n", Name);
            Pass = false;
        }
    };

    char Formatted[64];
    std::snprintf(Formatted, sizeof(Formatted), "%" SIZE_T_FMT "/%" UPTRINT_FMT,
        SIZE_T(0x100000010ULL), UPTRINT(0x100000010ULL));
    Check(FPlatformString::Stricmp(TEXT("WebCore"), TEXT("wEBcORE")) == 0 &&
        FPlatformString::Stricmp(TEXT("WebCore"), "webcore") == 0 &&
        FPlatformString::Stricmp(u8"WebCore", u8"wEBcORE") == 0 &&
        FPlatformString::Strnicmp(TEXT("SceneA"), TEXT("sCENEb"), 5) == 0 &&
        FPlatformString::Stricmp(TEXT("\u4e2dWeb"), TEXT("\u4e2dwEB")) == 0 &&
        FPlatformString::Strlen(TEXT("\u4e2d\u6587\U0001f680")) == 4 &&
        std::strcmp(Formatted, "4294967312/4294967312") == 0, "strings");

    volatile int32 Atomic = 7;
    const int32 BeforeAdd = FPlatformAtomics::InterlockedAdd(&Atomic, 5);
    const int32 BeforeExchange = FPlatformAtomics::InterlockedCompareExchange(&Atomic, 42, 12);
    const int32 RejectedExchange = FPlatformAtomics::InterlockedCompareExchange(&Atomic, 99, 12);
    FInt128 AlignedValues[2]{};
    Check(BeforeAdd == 7 && BeforeExchange == 12 && RejectedExchange == 42 &&
        FPlatformAtomics::AtomicRead(&Atomic) == 42 &&
        reinterpret_cast<UPTRINT>(&AlignedValues[0]) % 16 == 0 &&
        reinterpret_cast<UPTRINT>(&AlignedValues[1]) % 16 == 0 &&
        WebCoreAtomicRoundTrip(0x100000010ULL) == 0x100000021ULL, "atomics");

    uint8 Memory[] = {1, 2, 3, 4, 5, 6, 7, 8};
    const uint8 Expected[] = {1, 2, 1, 2, 0, 0, 5, 6};
    FPlatformMemory::Memmove(Memory + 2, Memory, 6);
    FPlatformMemory::Memzero(Memory + 4, 2);
    Check(std::memcmp(Memory, Expected, sizeof(Memory)) == 0 &&
        (reinterpret_cast<UPTRINT>(Memory) >> FPlatformMemory::KernelAddressBit) == 0, "memory");

    uint64 OverflowResult = 0;
    Check(FPlatformMath::CountLeadingZeros64(0) == 64 &&
        FPlatformMath::CountBits64(0x100000011ULL) == 3 &&
        FPlatformMath::RoundUpToPowerOfTwo64(0x100000001ULL) == 0x200000000ULL &&
        !FPlatformMath::AddAndCheckForOverflow(~uint64(0), uint64(1), OverflowResult), "math");

    const uint32 SlotA = FPlatformTLS::AllocTlsSlot();
    const uint32 SlotB = FPlatformTLS::AllocTlsSlot();
    bool TlsPass = FPlatformTLS::IsValidTlsSlot(SlotA) && FPlatformTLS::IsValidTlsSlot(SlotB) && SlotA != SlotB;
    if (TlsPass)
    {
        FPlatformTLS::SetTlsValue(SlotA, Memory);
        FPlatformTLS::SetTlsValue(SlotB, Formatted);
        TlsPass = FPlatformTLS::GetTlsValue(SlotA) == Memory && FPlatformTLS::GetTlsValue(SlotB) == Formatted &&
            FPlatformTLS::GetCurrentThreadId() != 0 &&
            FPlatformTLS::GetCurrentThreadId() == FPlatformTLS::GetCurrentThreadId();
        FPlatformTLS::SetTlsValue(SlotA, nullptr);
        TlsPass &= FPlatformTLS::GetTlsValue(SlotA) == nullptr && FPlatformTLS::GetTlsValue(SlotB) == Formatted;
    }
    if (FPlatformTLS::IsValidTlsSlot(SlotA)) FPlatformTLS::FreeTlsSlot(SlotA);
    if (FPlatformTLS::IsValidTlsSlot(SlotB)) FPlatformTLS::FreeTlsSlot(SlotB);
    Check(TlsPass, "tls");

    {
        UE::FPlatformRecursiveMutex Mutex;
        Mutex.Lock();
        const bool RecursivelyLocked = Mutex.TryLock();
        if (RecursivelyLocked) Mutex.Unlock();
        Mutex.Unlock();
        Check(RecursivelyLocked, "recursive-mutex");
    }

    const char Payload[] = "UE Web zlib \xe4\xb8\xad\xe6\x96\x87";
    uint8 Compressed[128], Restored[sizeof(Payload)];
    uLongf CompressedSize = sizeof(Compressed), RestoredSize = sizeof(Restored);
    const int CompressResult = compress2(Compressed, &CompressedSize,
        reinterpret_cast<const Bytef*>(Payload), sizeof(Payload), Z_BEST_SPEED);
    const int RestoreResult = uncompress(Restored, &RestoredSize, Compressed, CompressedSize);
    bool ZlibPass = CompressResult == Z_OK && RestoreResult == Z_OK &&
        RestoredSize == sizeof(Payload) && std::memcmp(Payload, Restored, sizeof(Payload)) == 0;
    if (ZlibPass)
    {
        Compressed[CompressedSize - 1] ^= 1;
        RestoredSize = sizeof(Restored);
        ZlibPass = uncompress(Restored, &RestoredSize, Compressed, CompressedSize) != Z_OK;
    }
    Check(ZlibPass, "zlib");

    std::printf("P3_WEB_CORE_SERVICES_RESULT {\"pointerBytes\":%zu,\"int128Alignment\":%zu,\"groups\":%d,\"pass\":%s,\"zlibVersion\":\"%s\"}\n",
        sizeof(void*), alignof(FInt128), Groups, Pass ? "true" : "false", zlibVersion());
    return Pass ? 0 : 1;
}
