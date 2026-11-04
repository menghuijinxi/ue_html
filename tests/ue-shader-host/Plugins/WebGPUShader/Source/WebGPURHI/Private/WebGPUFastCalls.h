#pragma once
// Keep the standard WGPU API and validation, but pass hot wasm64 arguments as
// numeric f64 values. Conversions happen as Wasm instructions, without BigInt.
#ifdef __EMSCRIPTEN__
#include <cstdint>
extern "C" {
void ueWGPUSetPipeline(double,double);
void ueWGPUSetBindGroup(double,uint32_t,double,double,double);
void ueWGPUSetVertexBuffer(double,uint32_t,double,double,double);
void ueWGPUSetIndexBuffer(double,double,uint32_t,double,double);
void ueWGPUDrawIndexed(double,uint32_t,uint32_t,uint32_t,int32_t,uint32_t);
void ueWGPUDraw(double,uint32_t,uint32_t,uint32_t,uint32_t);
}
namespace UEWebGPUFast {
constexpr uint64_t MaxExact=9007199254740991ULL;
template<class T> inline double pointer(T* p){return double(reinterpret_cast<uintptr_t>(p));}
inline void setPipeline(WGPURenderPassEncoder p,WGPURenderPipeline v){ueWGPUSetPipeline(pointer(p),pointer(v));}
inline void setBindGroup(WGPURenderPassEncoder p,uint32_t index,WGPUBindGroup group,size_t count,const uint32_t* offsets){
 if(count>MaxExact){wgpuRenderPassEncoderSetBindGroup(p,index,group,count,offsets);return;}
 ueWGPUSetBindGroup(pointer(p),index,pointer(group),double(count),pointer(offsets));
}
inline void setVertexBuffer(WGPURenderPassEncoder p,uint32_t slot,WGPUBuffer buffer,uint64_t offset,uint64_t size){
 if(offset>MaxExact||(size>MaxExact&&size!=WGPU_WHOLE_SIZE)){wgpuRenderPassEncoderSetVertexBuffer(p,slot,buffer,offset,size);return;}
 ueWGPUSetVertexBuffer(pointer(p),slot,pointer(buffer),double(offset),size==WGPU_WHOLE_SIZE?-1.:double(size));
}
inline void setIndexBuffer(WGPURenderPassEncoder p,WGPUBuffer buffer,WGPUIndexFormat format,uint64_t offset,uint64_t size){
 if(offset>MaxExact||(size>MaxExact&&size!=WGPU_WHOLE_SIZE)){wgpuRenderPassEncoderSetIndexBuffer(p,buffer,format,offset,size);return;}
 ueWGPUSetIndexBuffer(pointer(p),pointer(buffer),uint32_t(format),double(offset),size==WGPU_WHOLE_SIZE?-1.:double(size));
}
inline void drawIndexed(WGPURenderPassEncoder p,uint32_t indices,uint32_t instances,uint32_t first,int32_t base,uint32_t instance){
 ueWGPUDrawIndexed(pointer(p),indices,instances,first,base,instance);
}
inline void draw(WGPURenderPassEncoder p,uint32_t vertices,uint32_t instances,uint32_t first,uint32_t instance){
 ueWGPUDraw(pointer(p),vertices,instances,first,instance);
}
}
#define wgpuRenderPassEncoderSetPipeline UEWebGPUFast::setPipeline
#define wgpuRenderPassEncoderSetBindGroup UEWebGPUFast::setBindGroup
#define wgpuRenderPassEncoderSetVertexBuffer UEWebGPUFast::setVertexBuffer
#define wgpuRenderPassEncoderSetIndexBuffer UEWebGPUFast::setIndexBuffer
#define wgpuRenderPassEncoderDrawIndexed UEWebGPUFast::drawIndexed
#define wgpuRenderPassEncoderDraw UEWebGPUFast::draw
#endif
