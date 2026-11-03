#pragma once
#ifdef __EMSCRIPTEN__
#include <array>
#include <cstdint>
#include <memory>
#include <vector>

extern "C" void ueWGPUReplay(double pass,double commands,uint32_t count,double objects,uint32_t objectCount,double offsets);

namespace UEWebGPUStream {
// Rebuilt for every render pass. Only transports calls across the WASM/JS
// boundary; all WebGPU calls, order, validation and GPU work are preserved.
// A chunk retains each referenced C API object until synchronous JS replay.
inline bool Enabled=true; // Set once at startup on the WebGPU owner.
inline bool StateCommands=true;
constexpr uint64_t MaxExact=9007199254740991ULL;
enum class Kind { Pipeline, Group, Buffer };
struct Lease {uintptr_t pointer;Kind kind;};
struct Stream {
 WGPURenderPassEncoder pass=nullptr;
 std::array<double,32768> commands;
 uint32_t commandCount=0;
 std::vector<double> objects;
 std::vector<uint32_t> offsets;
 std::vector<Lease> leases;
 std::array<uint32_t,1024> slots{};
 uint32_t history=0;
 Stream(){objects.reserve(384);leases.reserve(384);offsets.reserve(4096);}
 void flush(){
  if(!pass)return;
  if(commandCount)ueWGPUReplay(double(reinterpret_cast<uintptr_t>(pass)),
   double(reinterpret_cast<uintptr_t>(commands.data())),commandCount,
   double(reinterpret_cast<uintptr_t>(objects.data())),uint32_t(objects.size()),double(reinterpret_cast<uintptr_t>(offsets.data())));
  commandCount=0;objects.clear();offsets.clear();slots.fill(0);history=0;
  for(const auto& lease:leases)switch(lease.kind){
   case Kind::Pipeline:wgpuRenderPipelineRelease(reinterpret_cast<WGPURenderPipeline>(lease.pointer));break;
   case Kind::Group:wgpuBindGroupRelease(reinterpret_cast<WGPUBindGroup>(lease.pointer));break;
   case Kind::Buffer:wgpuBufferRelease(reinterpret_cast<WGPUBuffer>(lease.pointer));break;
  }
  leases.clear();wgpuRenderPassEncoderRelease(pass);pass=nullptr;
 }
 __attribute__((always_inline)) void reserveFor(WGPURenderPassEncoder next,size_t words=8,size_t dynamicCount=0){
  if(pass&&(pass!=next||commandCount+words>32768||leases.size()+2>384||offsets.size()+dynamicCount>4096))flush();
  if(!pass){pass=next;wgpuRenderPassEncoderAddRef(pass);}
 }
 template<class T> uint32_t object(T* p,Kind kind){
  if(!p)return 0;
  uintptr_t key=reinterpret_cast<uintptr_t>(p);uint32_t bucket=uint32_t((key>>4)^(key>>17))&1023;
  while(slots[bucket]){uint32_t slot=slots[bucket];if(leases[slot-1].pointer==key)return slot;bucket=(bucket+1)&1023;}
  switch(kind){
   case Kind::Pipeline:wgpuRenderPipelineAddRef(reinterpret_cast<WGPURenderPipeline>(p));break;
   case Kind::Group:wgpuBindGroupAddRef(reinterpret_cast<WGPUBindGroup>(p));break;
   case Kind::Buffer:wgpuBufferAddRef(reinterpret_cast<WGPUBuffer>(p));break;
  }
  leases.push_back({key,kind});objects.push_back(double(key));return slots[bucket]=uint32_t(leases.size());
 }
 template<class... A>__attribute__((always_inline)) void write(uint32_t op,A...args){double* at=commands.data()+commandCount;*at++=double(op);((*at++=double(args)),...);commandCount+=1+sizeof...(args);history=(history<<4)|op;}
};
inline Stream& stream(){static thread_local std::unique_ptr<Stream> value(new Stream);return *value;}
inline void flush(){stream().flush();}
inline void setPipeline(WGPURenderPassEncoder p,WGPURenderPipeline v){if(!p||!Enabled){wgpuRenderPassEncoderSetPipeline(p,v);return;}auto& s=stream();s.reserveFor(p);auto id=s.object(v,Kind::Pipeline);s.write(1,id);}
inline void setBindGroup(WGPURenderPassEncoder p,uint32_t index,WGPUBindGroup g,size_t count,const uint32_t* offsets){
 if(!p||!Enabled||count>1024){flush();wgpuRenderPassEncoderSetBindGroup(p,index,g,count,offsets);return;}
 auto& s=stream();s.reserveFor(p,5,count);auto id=s.object(g,Kind::Group);auto at=s.offsets.size();
 if(count)s.offsets.insert(s.offsets.end(),offsets,offsets+count);
 s.write(2,index,id,count,at);
}
inline void setVertexBuffer(WGPURenderPassEncoder p,uint32_t slot,WGPUBuffer b,uint64_t offset,uint64_t size){
 if(!p||!Enabled||offset>MaxExact||(size>MaxExact&&size!=WGPU_WHOLE_SIZE)){flush();wgpuRenderPassEncoderSetVertexBuffer(p,slot,b,offset,size);return;}
 auto& s=stream();s.reserveFor(p);auto id=s.object(b,Kind::Buffer);s.write(3,slot,id,offset,size==WGPU_WHOLE_SIZE?-1.:double(size));
}
inline void setIndexBuffer(WGPURenderPassEncoder p,WGPUBuffer b,WGPUIndexFormat format,uint64_t offset,uint64_t size){
 if(!p||!Enabled||offset>MaxExact||(size>MaxExact&&size!=WGPU_WHOLE_SIZE)){flush();wgpuRenderPassEncoderSetIndexBuffer(p,b,format,offset,size);return;}
 auto& s=stream();s.reserveFor(p);auto id=s.object(b,Kind::Buffer);s.write(4,id,uint32_t(format),offset,size==WGPU_WHOLE_SIZE?-1.:double(size));
}
inline void drawIndexed(WGPURenderPassEncoder p,uint32_t indices,uint32_t instances,uint32_t first,int32_t base,uint32_t instance){
 if(!p||!Enabled||indices>INT32_MAX||instances>INT32_MAX){flush();wgpuRenderPassEncoderDrawIndexed(p,indices,instances,first,base,instance);return;}
 auto& s=stream();s.reserveFor(p);
 // Fuse decoding of common state sequences without dropping or reordering any
 // WebGPU calls. Both sequences have 17 words before the indexed draw.
 if((s.history&65535)==0x1234)s.commands[s.commandCount-17]=9;
 else if((s.history&65535)==0x1324)s.commands[s.commandCount-17]=10;
 s.write(5,indices,instances,first,base,instance);
}
inline void draw(WGPURenderPassEncoder p,uint32_t vertices,uint32_t instances,uint32_t first,uint32_t instance){
 if(!p||!Enabled||vertices>INT32_MAX||instances>INT32_MAX){flush();wgpuRenderPassEncoderDraw(p,vertices,instances,first,instance);return;}
 auto& s=stream();s.reserveFor(p);s.write(6,vertices,instances,first,instance);
}
inline void drawIndirect(WGPURenderPassEncoder p,WGPUBuffer b,uint64_t offset){
 if(!p||!Enabled||offset>MaxExact){flush();wgpuRenderPassEncoderDrawIndirect(p,b,offset);return;}
 auto& s=stream();s.reserveFor(p);auto id=s.object(b,Kind::Buffer);s.write(7,id,offset);
}
inline void drawIndexedIndirect(WGPURenderPassEncoder p,WGPUBuffer b,uint64_t offset){
 if(!p||!Enabled||offset>MaxExact){flush();wgpuRenderPassEncoderDrawIndexedIndirect(p,b,offset);return;}
 auto& s=stream();s.reserveFor(p);auto id=s.object(b,Kind::Buffer);s.write(8,id,offset);
}
inline void RenderPassEncoderSetScissorRect(WGPURenderPassEncoder p,uint32_t x,uint32_t y,uint32_t w,uint32_t h){
 if(!p||!Enabled||!StateCommands){flush();wgpuRenderPassEncoderSetScissorRect(p,x,y,w,h);return;}
 auto& s=stream();s.reserveFor(p,5);s.write(11,x,y,w,h);
}
inline void RenderPassEncoderSetViewport(WGPURenderPassEncoder p,float x,float y,float w,float h,float nearDepth,float farDepth){
 if(!p||!Enabled||!StateCommands){flush();wgpuRenderPassEncoderSetViewport(p,x,y,w,h,nearDepth,farDepth);return;}
 auto& s=stream();s.reserveFor(p,7);s.write(12,x,y,w,h,nearDepth,farDepth);
}
inline void RenderPassEncoderSetStencilReference(WGPURenderPassEncoder p,uint32_t reference){
 if(!p||!Enabled||!StateCommands){flush();wgpuRenderPassEncoderSetStencilReference(p,reference);return;}
 auto& s=stream();s.reserveFor(p,2);s.write(13,reference);
}
inline void RenderPassEncoderBeginOcclusionQuery(WGPURenderPassEncoder p,uint32_t index){
 if(!p||!Enabled||!StateCommands){flush();wgpuRenderPassEncoderBeginOcclusionQuery(p,index);return;}
 auto& s=stream();s.reserveFor(p,2);s.write(14,index);
}
inline void RenderPassEncoderEndOcclusionQuery(WGPURenderPassEncoder p){
 if(!p||!Enabled||!StateCommands){flush();wgpuRenderPassEncoderEndOcclusionQuery(p);return;}
 auto& s=stream();s.reserveFor(p,1);s.write(15);
}
// These operations delimit ordering and encoder state. Replay pending calls
// before forwarding the boundary through the unchanged Emdawn C API.
#define UE_WGPU_BOUNDARY(name) template<class... A>inline auto name(A...args){flush();return wgpu##name(args...);}
UE_WGPU_BOUNDARY(RenderPassEncoderEnd)
UE_WGPU_BOUNDARY(RenderPassEncoderRelease)
UE_WGPU_BOUNDARY(RenderPassEncoderSetBlendConstant)
UE_WGPU_BOUNDARY(RenderPassEncoderExecuteBundles)
UE_WGPU_BOUNDARY(RenderPassEncoderInsertDebugMarker)
UE_WGPU_BOUNDARY(RenderPassEncoderPushDebugGroup)
UE_WGPU_BOUNDARY(RenderPassEncoderPopDebugGroup)
UE_WGPU_BOUNDARY(CommandEncoderFinish)
UE_WGPU_BOUNDARY(QueueSubmit)
UE_WGPU_BOUNDARY(BufferDestroy)
UE_WGPU_BOUNDARY(TextureDestroy)
#undef UE_WGPU_BOUNDARY
}
#define wgpuRenderPassEncoderSetPipeline UEWebGPUStream::setPipeline
#define wgpuRenderPassEncoderSetBindGroup UEWebGPUStream::setBindGroup
#define wgpuRenderPassEncoderSetVertexBuffer UEWebGPUStream::setVertexBuffer
#define wgpuRenderPassEncoderSetIndexBuffer UEWebGPUStream::setIndexBuffer
#define wgpuRenderPassEncoderDrawIndexed UEWebGPUStream::drawIndexed
#define wgpuRenderPassEncoderDraw UEWebGPUStream::draw
#define wgpuRenderPassEncoderDrawIndirect UEWebGPUStream::drawIndirect
#define wgpuRenderPassEncoderDrawIndexedIndirect UEWebGPUStream::drawIndexedIndirect
#define wgpuRenderPassEncoderEnd UEWebGPUStream::RenderPassEncoderEnd
#define wgpuRenderPassEncoderRelease UEWebGPUStream::RenderPassEncoderRelease
#define wgpuRenderPassEncoderSetScissorRect UEWebGPUStream::RenderPassEncoderSetScissorRect
#define wgpuRenderPassEncoderSetViewport UEWebGPUStream::RenderPassEncoderSetViewport
#define wgpuRenderPassEncoderSetStencilReference UEWebGPUStream::RenderPassEncoderSetStencilReference
#define wgpuRenderPassEncoderSetBlendConstant UEWebGPUStream::RenderPassEncoderSetBlendConstant
#define wgpuRenderPassEncoderBeginOcclusionQuery UEWebGPUStream::RenderPassEncoderBeginOcclusionQuery
#define wgpuRenderPassEncoderEndOcclusionQuery UEWebGPUStream::RenderPassEncoderEndOcclusionQuery
#define wgpuRenderPassEncoderExecuteBundles UEWebGPUStream::RenderPassEncoderExecuteBundles
#define wgpuRenderPassEncoderInsertDebugMarker UEWebGPUStream::RenderPassEncoderInsertDebugMarker
#define wgpuRenderPassEncoderPushDebugGroup UEWebGPUStream::RenderPassEncoderPushDebugGroup
#define wgpuRenderPassEncoderPopDebugGroup UEWebGPUStream::RenderPassEncoderPopDebugGroup
#define wgpuCommandEncoderFinish UEWebGPUStream::CommandEncoderFinish
#define wgpuQueueSubmit UEWebGPUStream::QueueSubmit
#define wgpuBufferDestroy UEWebGPUStream::BufferDestroy
#define wgpuTextureDestroy UEWebGPUStream::TextureDestroy
#endif
