#include <cstdio>
#include <pthread.h>
#include <emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>

static void OwnerLog(void*)
{
    emscripten_console_log("owner-enter");
#if DIRECT_LOG
    const char* Message = "owner-log";
    EM_ASM({
        const Text = UTF8ToString(Number($0));
        if (typeof out === 'function') out(Text);
        else console.log(Text);
    }, Message);
#else
    std::printf("owner-log\n");
#endif
}

static void* BackgroundLog(void*)
{
    emscripten_console_log("background-enter");
    // A pthread holds this lock while libc forwards its write syscall to the owner.
    flockfile(stdout);
    const bool Completed = emscripten_proxy_sync(emscripten_proxy_get_system_queue(),
        emscripten_main_runtime_thread_id(), OwnerLog, nullptr);
    funlockfile(stdout);
    MAIN_THREAD_ASYNC_EM_ASM({ postMessage({complete: !!$0}); }, Completed);
    return nullptr;
}

int main()
{
    pthread_t Thread;
    if (pthread_create(&Thread, nullptr, BackgroundLog, nullptr)) return 1;
    pthread_detach(Thread);
    emscripten_exit_with_live_runtime();
}
