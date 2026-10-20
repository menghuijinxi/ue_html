#include <cstdint>
#include <cstdio>
#include <vector>
#include <emscripten.h>

#if !PLATFORM_WEB
#error Web toolchain must define PLATFORM_WEB.
#endif

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t WebToolchainChecksum(uint32_t count)
{
    std::vector<uint32_t> values(count);
    uint32_t sum = 0;
    for (uint32_t index = 0; index < count; ++index)
    {
        values[index] = index * 3 + 7;
        sum += values[index];
    }
    return sum;
}

int main()
{
    static_assert(sizeof(void *) == 8);
    const uint32_t checksum = WebToolchainChecksum(100);
    std::printf("P3_WEB_UBT_RESULT {\"pointerBytes\":%zu,\"checksum\":%u,\"pass\":%s}\n",
                sizeof(void *), checksum, checksum == 15550 ? "true" : "false");
    return checksum == 15550 ? 0 : 1;
}
