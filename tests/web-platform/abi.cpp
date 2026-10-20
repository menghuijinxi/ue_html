#include <atomic>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif
#if !defined(__EMSCRIPTEN__) || defined(__EMSCRIPTEN_PTHREADS__)
#include <thread>
#endif

struct LayoutProbe {
    uint8_t tag;
    void* pointer;
    uint64_t counter;
    uint32_t value;
};

std::string report;
int main() {
    std::atomic<uint32_t> counter{0};
    bool threads = false;
#if !defined(__EMSCRIPTEN__) || defined(__EMSCRIPTEN_PTHREADS__)
    std::thread worker([&] { for (uint32_t i = 0; i < 10000; ++i) ++counter; });
    for (uint32_t i = 0; i < 10000; ++i) ++counter;
    worker.join();
    threads = true;
#endif
    bool pass = !threads || counter == 20000;
    std::ostringstream json;
    json << "{\"kind\":\"abi\",\"pass\":" << (pass ? "true" : "false")
         << ",\"pointerBytes\":" << sizeof(void*) << ",\"sizeTBytes\":" << sizeof(size_t)
         << ",\"layoutSize\":" << sizeof(LayoutProbe) << ",\"layoutAlign\":" << alignof(LayoutProbe)
         << ",\"pointerOffset\":" << offsetof(LayoutProbe, pointer)
         << ",\"counterOffset\":" << offsetof(LayoutProbe, counter)
         << ",\"valueOffset\":" << offsetof(LayoutProbe, value)
         << ",\"threads\":" << (threads ? "true" : "false")
         << ",\"atomicCounter\":" << counter << '}';
    report = json.str();
    std::cout << "P0_RESULT " << report << std::endl;
#ifdef __EMSCRIPTEN__
    MAIN_THREAD_ASYNC_EM_ASM({
        globalThis.__p0Report = JSON.parse(UTF8ToString($0));
        globalThis.dispatchEvent(new CustomEvent('p0-result', {detail: globalThis.__p0Report}));
    }, report.c_str());
    emscripten_exit_with_live_runtime();
#endif
    return pass ? 0 : 1;
}
