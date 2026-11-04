// Diagnostic-only libc boundary counters. Linked only with -AllocationProbe.
// No locks/allocations in the probe; per-thread cache lines avoid a shared
// counter bottleneck. Timings include probe clock overhead, not UE proxy wait.
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <pthread.h>
#include <emscripten.h>

namespace {
enum {Malloc,Calloc,Realloc,Free,Aligned,Usable,Operations};
struct alignas(128) Record {std::atomic<uint64_t> thread{0},calls[Operations]{},bytes[Operations]{},ns[Operations]{};};
Record Records[128];std::atomic<bool> Enabled{false};thread_local Record* Local=nullptr;thread_local bool Nested=false;
Record* enter(){
 if(!Enabled.load(std::memory_order_relaxed)||Nested)return nullptr;
 Nested=true;
 if(!Local){const uint64_t id=reinterpret_cast<uintptr_t>(pthread_self());for(auto& r:Records){uint64_t empty=0;if(r.thread.compare_exchange_strong(empty,id,std::memory_order_relaxed)||empty==id){Local=&r;break;}}}
 if(!Local)Nested=false;return Local;
}
void leave(Record*r,unsigned op,size_t bytes,double begin){if(!r)return;
 r->calls[op].fetch_add(1,std::memory_order_relaxed);r->bytes[op].fetch_add(bytes,std::memory_order_relaxed);
 r->ns[op].fetch_add(uint64_t((emscripten_get_now()-begin)*1000000),std::memory_order_relaxed);Nested=false;
}
}
extern "C" {
void* __real_malloc(size_t);void* __real_calloc(size_t,size_t);void* __real_realloc(void*,size_t);void __real_free(void*);
int __real_posix_memalign(void**,size_t,size_t);size_t __real_malloc_usable_size(void*);
void* __wrap_malloc(size_t n){auto*r=enter();double t=r?emscripten_get_now():0;auto*p=__real_malloc(n);leave(r,Malloc,n,t);return p;}
void* __wrap_calloc(size_t a,size_t b){auto*r=enter();double t=r?emscripten_get_now():0;auto*p=__real_calloc(a,b);leave(r,Calloc,a*b,t);return p;}
void* __wrap_realloc(void*p,size_t n){auto*r=enter();double t=r?emscripten_get_now():0;auto*q=__real_realloc(p,n);leave(r,Realloc,n,t);return q;}
void __wrap_free(void*p){auto*r=enter();double t=r?emscripten_get_now():0;__real_free(p);leave(r,Free,0,t);}
int __wrap_posix_memalign(void**p,size_t a,size_t n){auto*r=enter();double t=r?emscripten_get_now():0;int result=__real_posix_memalign(p,a,n);leave(r,Aligned,n,t);return result;}
size_t __wrap_malloc_usable_size(void*p){auto*r=enter();double t=r?emscripten_get_now():0;auto n=__real_malloc_usable_size(p);leave(r,Usable,0,t);return n;}
EMSCRIPTEN_KEEPALIVE void WebAllocationProbeEnable(int active){Enabled.store(active!=0,std::memory_order_relaxed);}
EMSCRIPTEN_KEEPALIVE const char* WebAllocationProbeSnapshot(){
 static char text[131072];size_t at=0;at+=std::snprintf(text+at,sizeof(text)-at,"{\"threads\":[");bool first=true;
 for(auto&r:Records){auto id=r.thread.load(std::memory_order_relaxed);if(!id)continue;
  at+=std::snprintf(text+at,sizeof(text)-at,"%s{\"pthread\":\"%llu\",\"operations\":[",first?"":",",(unsigned long long)id);first=false;
  for(unsigned op=0;op<Operations;op++)at+=std::snprintf(text+at,sizeof(text)-at,"%s{\"calls\":%llu,\"requestedBytes\":%llu,\"inclusiveNs\":%llu}",op?",":"",(unsigned long long)r.calls[op].load(),(unsigned long long)r.bytes[op].load(),(unsigned long long)r.ns[op].load());
  at+=std::snprintf(text+at,sizeof(text)-at,"]}");
 }std::snprintf(text+at,sizeof(text)-at,"]}");return text;
}
}
