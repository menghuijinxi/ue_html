#include "CoreTypes.h"
#include <cstddef>
#include <cstdio>
#include <emscripten.h>

struct FWebLayoutProbe
{
    uint8 Tag;
    uint64 Value;
    void* Pointer;
    TCHAR Text[3];
};

static_assert(sizeof(void*) == 8 && sizeof(SIZE_T) == 8 && sizeof(UPTRINT) == 8);
static_assert(sizeof(TCHAR) == 2 && sizeof(WIDECHAR) == 2 && sizeof(wchar_t) == 4);
static_assert(sizeof(FWebLayoutProbe) == 32 && alignof(FWebLayoutProbe) == 8);
static_assert(offsetof(FWebLayoutProbe, Value) == 8 && offsetof(FWebLayoutProbe, Pointer) == 16);
static_assert(offsetof(FWebLayoutProbe, Text) == 24);

extern "C" EMSCRIPTEN_KEEPALIVE UPTRINT WebCorePointerRoundTrip(UPTRINT value)
{
    return value + 17;
}

int main()
{
    const uint64 value = 0x100000010ULL;
    const bool pass = WebCorePointerRoundTrip(value) == 0x100000021ULL;
    std::printf("P3_WEB_CORE_TYPES_RESULT {\"pointerBytes\":%zu,\"sizeTBytes\":%zu,\"tcharBytes\":%zu,"
        "\"layoutBytes\":%zu,\"pass\":%s}\n",
        sizeof(void*), sizeof(SIZE_T), sizeof(TCHAR), sizeof(FWebLayoutProbe), pass ? "true" : "false");
    return pass ? 0 : 1;
}
