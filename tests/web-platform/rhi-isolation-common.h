#pragma once
#include "draw-api-common.h"
#include <array>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>
#include <unordered_map>

// Dependency-free model of the adapter's prepared-group/version check,
// field-by-field key matching, route traversal and draw-state packet creation.
// Not the UE functions themselves: UE containers, JSON metadata, reference
// counting, barriers and resource lifetime are intentionally not reproduced.
namespace Isolation {
constexpr unsigned Draws=3200,Entries=24;
struct Entry {uint32_t binding;uint64_t buffer,offset,size,texture,sampler;};
inline bool equal(const Entry&a,const Entry&b){return a.binding==b.binding&&a.buffer==b.buffer&&a.offset==b.offset&&a.size==b.size&&a.texture==b.texture&&a.sampler==b.sampler;}
inline uint32_t combine(uint32_t a,uint32_t b){return a^(b+0x9e3779b9u+(a<<6)+(a>>2));}
inline uint32_t hash(const Entry&e){uint32_t h=e.binding;for(auto v:{e.buffer,e.offset,e.size,e.texture,e.sampler}){h=combine(h,uint32_t(v));h=combine(h,uint32_t(v>>32));}return h;}
struct Packet {uint32_t resource,pipeline,key;};
struct Pool {
 std::mutex mutex;std::condition_variable wake,done;bool stopping=false;unsigned epoch=0,remaining=0;
 std::function<void(unsigned)> work;std::vector<std::thread> threads;
 explicit Pool(unsigned n){for(unsigned i=0;i<n;i++)threads.emplace_back([this,i]{unsigned seen=0;for(;;){std::unique_lock lock(mutex);wake.wait(lock,[&]{return stopping||epoch!=seen;});if(stopping)return;seen=epoch;auto f=work;lock.unlock();f(i);lock.lock();if(!--remaining)done.notify_one();}});}
 void start(std::function<void(unsigned)> f){{std::lock_guard lock(mutex);require(!remaining,"pool task overlap");work=std::move(f);remaining=unsigned(threads.size());++epoch;}wake.notify_all();}
 void join(){std::unique_lock lock(mutex);done.wait(lock,[&]{return !remaining;});}
 void run(std::function<void(unsigned)>f){start(std::move(f));join();}
 ~Pool(){{std::lock_guard lock(mutex);stopping=true;}wake.notify_all();for(auto&t:threads)t.join();}
};
struct Preparation {
 std::array<std::array<Entry,Entries>,64> table{};
 std::array<uint32_t,64> expected{};
 std::mutex resourceLock;
 std::unordered_map<unsigned,uint64_t> resources;
 std::array<std::atomic<uint64_t>,64> versions{};
 Preparation(){for(unsigned k=0;k<64;k++){uint32_t h=0;for(unsigned e=0;e<Entries;e++){
  const unsigned slot=k*Entries+e;resources[slot]=uint64_t(slot+1)*16;
  table[k][e]={e,resources[slot],uint64_t(k)*256,256,0,0};h=combine(h,hash(table[k][e]));
 }expected[k]=h;versions[k].store(1);}}
 void build(Packet*out,unsigned begin,unsigned end,unsigned mode){
  for(unsigned j=begin;j<end;j++){
   const unsigned k=j%64;uint32_t key=0;
   if(mode==0)key=expected[k]; // Already prepared draw bindings: no traversal.
   else if(mode==1){require(versions[k].load(std::memory_order_relaxed)==1,"version mismatch");key=expected[k];}
   else {
    std::array<Entry,Entries> scratch{};std::vector<Entry> allocated;
    Entry* entries=scratch.data();if(mode==3){allocated.resize(Entries);entries=allocated.data();}
    for(unsigned e=0;e<Entries;e++){
     uint64_t resource;
     if(mode==4){std::lock_guard lock(resourceLock);resource=resources.at(k*Entries+e);}
     else if(mode==5)resource=resources.at(k*Entries+e);
     else resource=table[k][e].buffer;
     entries[e]={e,resource,uint64_t(k)*256,256,0,0};
     // Match the backend's per-field equality and hash work on misses.
     require(equal(entries[e],table[k][e]),"binding key mismatch");key=combine(key,hash(entries[e]));
    }
   }
   out[j]={k,j&1,key};
  }
 }
 void buildParallel(Pool&pool,std::vector<Packet>&out,unsigned mode){const unsigned n=unsigned(pool.threads.size());pool.run([&](unsigned i){build(out.data(),Draws*i/n,Draws*(i+1)/n,mode);});}
 uint32_t verify(const std::vector<Packet>&v){require(v.size()==Draws,"packet count");uint32_t checksum=0;for(unsigned j=0;j<Draws;j++){require(v[j].resource==j%64&&v[j].pipeline==(j&1)&&v[j].key==expected[j%64],"packet mismatch");checksum=combine(checksum,v[j].key);}return checksum;}
};
inline std::string cpuTests(){
 const char* modes[]={"pre-resolved","prepared-version-hit","rebuild-stack","rebuild-allocation","shared-resource-lock","immutable-resource-map"};
 Preparation preparation;std::ostringstream out;out<<'[';bool first=true;
 for(unsigned n:{1u,2u,4u}){Pool pool(n);std::vector<Packet> packets(Draws);
  // A dispatch-only control keeps worker wake-up cost visible.
  std::vector<double> dispatch;for(unsigned f=0;f<70;f++){auto t=Clock::now();pool.run([](unsigned){});if(f>=10)dispatch.push_back(elapsed(t));}
  for(unsigned mode=0;mode<6;mode++){
   std::vector<double> times;uint32_t checksum=0;
   for(unsigned f=0;f<70;f++){auto t=Clock::now();preparation.buildParallel(pool,packets,mode);double ms=elapsed(t);checksum=preparation.verify(packets);if(f>=10)times.push_back(ms);}
   if(!first)out<<',';first=false;out<<"{\"workers\":"<<n<<",\"mode\":"<<quote(modes[mode])<<",\"draws\":"<<Draws<<",\"entries\":"<<Entries<<",\"checksum\":"<<checksum<<",\"wall\":";stats(out,times);out<<",\"dispatchControl\":";stats(out,dispatch);out<<'}';
  }
 }out<<']';return out.str();
}
template<class GPU>std::string gpuTests(GPU&gpu){
 Preparation prep;Pool producer(1);std::vector<Packet> slots[2]={std::vector<Packet>(Draws),std::vector<Packet>(Draws)};
 std::ostringstream out;out<<'[';
 // Work is identical across serial/pipelined preparation. GPU API calls
 // always remain on this device's owner thread, including native controls.
 for(unsigned variant=0;variant<4;variant++){
  const unsigned mode=variant==0?0:variant==1?1:2;const bool pipeline=variant==3;
  std::vector<double> prepare,encode,finish,wait;double wall=0;uint32_t checksum=0;
  for(unsigned phase=0;phase<2;phase++){
   unsigned frames=phase?60:12;auto begin=Clock::now();
   if(pipeline)producer.start([&](unsigned){prep.build(slots[0].data(),0,Draws,mode);});
   for(unsigned frame=0;frame<frames;frame++){
    auto& packets=slots[frame%2];auto t=Clock::now();
    if(pipeline){producer.join();if(frame+1<frames)producer.start([&,next=(frame+1)%2](unsigned){prep.build(slots[next].data(),0,Draws,mode);});}
    else prep.build(packets.data(),0,Draws,mode);
    double p=elapsed(t);t=Clock::now();gpu.begin(frame%3,false);gpu.emitPackets(packets);double e=elapsed(t);t=Clock::now();gpu.end();gpu.submit();double q=elapsed(t);t=Clock::now();if(frame%3==2)gpu.wait();double w=elapsed(t);
    if(phase){prepare.push_back(p);encode.push_back(e);finish.push_back(q);wait.push_back(w);}
   }
   gpu.wait();if(phase)wall=elapsed(begin);
  }
  checksum=prep.verify(slots[0]);gpu.verify(1,Draws);gpu.checkErrors();
  if(variant)out<<',';out<<"{\"mode\":"<<quote(variant==0?"pre-resolved":variant==1?"prepared-version-hit":variant==2?"serial-rebuild":"producer-owner-pipeline")<<",\"draws\":"<<Draws<<",\"checksum\":"<<checksum<<",\"frames\":60,\"inFlight\":3,\"wallMsPerFrame\":"<<wall/60<<",\"prepareOrWait\":";stats(out,prepare);out<<",\"encode\":";stats(out,encode);out<<",\"finishSubmit\":";stats(out,finish);out<<",\"gpuQueueWait\":";stats(out,wait);out<<",\"pixelVerified\":true}";
 }out<<']';return out.str();
}
template<class GPU>std::string stateTests(GPU&gpu){
 Preparation prep;std::vector<Packet> packets(Draws,Packet{0,0,prep.expected[0]});std::ostringstream out;out<<'[';
 for(unsigned cached=0;cached<2;cached++){
  std::vector<double> encoding;auto wall=Clock::now();double ms=0;
  for(unsigned frame=0;frame<72;frame++){
   if(frame==12)wall=Clock::now();gpu.begin(frame%3,false);auto t=Clock::now();gpu.emitPacketsState(packets,cached!=0);double sample=elapsed(t);gpu.end();gpu.submit();if(frame%3==2)gpu.wait();if(frame>=12)encoding.push_back(sample);
  }gpu.wait();ms=elapsed(wall);gpu.verify(0,Draws);gpu.checkErrors();
  if(cached)out<<',';out<<"{\"cached\":"<<(cached?"true":"false")<<",\"draws\":"<<Draws<<",\"bindingCalls\":"<<(cached?4:Draws*4)<<",\"wallMsPerFrame\":"<<ms/60<<",\"encoding\":";stats(out,encoding);out<<",\"pixelVerified\":true}";
 }out<<']';return out.str();
}
}
