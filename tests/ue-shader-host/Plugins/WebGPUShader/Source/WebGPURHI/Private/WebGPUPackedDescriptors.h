#pragma once
#ifdef __EMSCRIPTEN__
#include <array>
#include <cstdint>
extern "C" double ueWGPUCreatePackedBindGroup(double device,double layout,double entries,uint32_t count);
namespace UEWebGPUPacked {
inline bool Enabled=true;
constexpr uint64_t MaxExact=9007199254740991ULL;
// Leave the pinned C API in charge of extensions, labels, unsupported sizes and
// malformed descriptors. The common path packs exact Numbers in Wasm, removing
// repeated BigInt heap reads and view-refresh checks in generated JS glue.
inline WGPUBindGroup createBindGroup(WGPUDevice device,const WGPUBindGroupDescriptor* desc){
#if defined(UE_WEB_ENGINE_WORKER) && UE_WEB_ENGINE_WORKER
 // Resource creation outside the owner keeps WebGPUOwner.h's original proxy.
 // The compact JS decoder, like every other GPU call, needs the owner's table.
 if(!emscripten_is_main_runtime_thread())return wgpuDeviceCreateBindGroup(device,desc);
#endif
 if(!Enabled||!device||!desc||!desc->layout||desc->nextInChain||desc->label.data||desc->entryCount>128||
    (desc->entryCount&&!desc->entries))return wgpuDeviceCreateBindGroup(device,desc);
 std::array<double,128*5> packed;
 for(size_t i=0;i<desc->entryCount;i++){
  const auto& entry=desc->entries[i];
  if(entry.nextInChain||int(!!entry.buffer)+int(!!entry.textureView)+int(!!entry.sampler)!=1||
     entry.offset>MaxExact||(entry.size>MaxExact&&entry.size!=WGPU_WHOLE_SIZE))return wgpuDeviceCreateBindGroup(device,desc);
  auto* words=packed.data()+i*5;words[0]=entry.binding;words[1]=entry.buffer?0:entry.textureView?1:2;
  words[2]=double(reinterpret_cast<uintptr_t>(entry.buffer?static_cast<void*>(entry.buffer):entry.textureView?static_cast<void*>(entry.textureView):static_cast<void*>(entry.sampler)));
  words[3]=double(entry.offset);words[4]=entry.size==WGPU_WHOLE_SIZE?-1.:double(entry.size);
 }
 return reinterpret_cast<WGPUBindGroup>(uintptr_t(ueWGPUCreatePackedBindGroup(double(reinterpret_cast<uintptr_t>(device)),
  double(reinterpret_cast<uintptr_t>(desc->layout)),double(reinterpret_cast<uintptr_t>(packed.data())),uint32_t(desc->entryCount))));
}
}
#ifdef wgpuDeviceCreateBindGroup
#undef wgpuDeviceCreateBindGroup
#endif
#define wgpuDeviceCreateBindGroup UEWebGPUPacked::createBindGroup
#endif
