#include "rhi-isolation-common.h"
#include <malloc.h>

// Exercise alignment, usable size, realloc preservation and cross-thread free.
// UE FMallocAnsi uses posix_memalign / malloc_usable_size / free on Web.
static void contract(){
 for(size_t align=8;align<=4096;align*=2)for(size_t size:{size_t(1),size_t(17),size_t(256),size_t(4097),size_t(1048576)}){
  void* p=nullptr;require(posix_memalign(&p,align,size)==0&&p,"aligned allocation failed");
  require(uintptr_t(p)%align==0&&malloc_usable_size(p)>=size,"alignment or usable size");
  std::memset(p,0x5a,size);void* q=nullptr;require(posix_memalign(&q,align,size*2)==0&&q,"aligned reallocation failed");
  std::memcpy(q,p,size);std::free(p);for(size_t i=0;i<size;i++)require(static_cast<unsigned char*>(q)[i]==0x5a,"copy preservation");std::free(q);
 }
 for(size_t size:{size_t(1),size_t(17),size_t(256),size_t(4097)}){
  auto* p=static_cast<unsigned char*>(std::malloc(size));require(p,"malloc failed");std::memset(p,0xa5,size);
  auto* q=static_cast<unsigned char*>(std::realloc(p,size*3));require(q,"realloc failed");
  for(size_t i=0;i<size;i++)require(q[i]==0xa5,"realloc preservation");std::free(q);
 }
 Isolation::Pool pool(4);std::array<void*,4096> blocks{};
 for(unsigned round=0;round<8;round++){
  pool.run([&](unsigned w){for(unsigned i=w;i<blocks.size();i+=4){require(posix_memalign(&blocks[i],64,257)==0,"thread allocate");std::memset(blocks[i],int(i&255),257);}});
  pool.run([&](unsigned w){for(unsigned i=(w+1)%4;i<blocks.size();i+=4){const auto* p=static_cast<unsigned char*>(blocks[i]);require(p[0]==(i&255)&&p[256]==(i&255)&&malloc_usable_size(blocks[i])>=257,"cross-thread preservation");std::free(blocks[i]);}});
 }
}
int main(){contract();const auto cpu=Isolation::cpuTests();const auto result="{\"pass\":true,\"contractPassed\":true,\"cpu\":"+cpu+"}";
 EM_ASM({postMessage({result:JSON.parse(UTF8ToString($0))});},result.c_str());emscripten_exit_with_live_runtime();return 0;}
