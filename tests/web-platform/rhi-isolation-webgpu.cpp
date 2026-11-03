#define main OriginalDrawMain
#include "draw-api-webgpu.cpp"
#undef main
#include "rhi-isolation-common.h"
struct IsolationGPU:GPU {
 void emitPacketsState(const std::vector<Isolation::Packet>&packets,bool cached){unsigned resource=~0u,pipeline=~0u;for(const auto&p:packets){if(!cached||pipeline!=p.pipeline){wgpuRenderPassEncoderSetPipeline(pass,pipelines[p.pipeline]);pipeline=p.pipeline;}if(!cached||resource!=p.resource){wgpuRenderPassEncoderSetBindGroup(pass,0,groups[p.resource],0,nullptr);wgpuRenderPassEncoderSetVertexBuffer(pass,0,vertices,p.resource*256,24);wgpuRenderPassEncoderSetIndexBuffer(pass,indices,WGPUIndexFormat_Uint16,p.resource*256,6);resource=p.resource;}wgpuRenderPassEncoderDrawIndexed(pass,3,1,0,0,0);}}
 void emitPackets(const std::vector<Isolation::Packet>&packets){for(const auto&p:packets){wgpuRenderPassEncoderSetPipeline(pass,pipelines[p.pipeline]);wgpuRenderPassEncoderSetBindGroup(pass,0,groups[p.resource],0,nullptr);wgpuRenderPassEncoderSetVertexBuffer(pass,0,vertices,p.resource*256,24);wgpuRenderPassEncoderSetIndexBuffer(pass,indices,WGPUIndexFormat_Uint16,p.resource*256,6);wgpuRenderPassEncoderDrawIndexed(pass,3,1,0,0,0);}}
 std::string creation(){std::ostringstream out;out<<'[';bool first=true;for(unsigned n:{1u,8u,24u}){
  std::vector<WGPUBindGroupLayoutEntry> le(n);std::vector<WGPUBindGroupEntry> entries(n);
  for(unsigned i=0;i<n;i++){le[i]=WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;le[i].binding=i;le[i].visibility=WGPUShaderStage_None;le[i].buffer.type=WGPUBufferBindingType_Uniform;le[i].buffer.minBindingSize=16;entries[i]=WGPU_BIND_GROUP_ENTRY_INIT;entries[i].binding=i;entries[i].buffer=uniforms;entries[i].offset=i*256;entries[i].size=16;}
  WGPUBindGroupLayoutDescriptor ld=WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;ld.entryCount=n;ld.entries=le.data();auto layout=wgpuDeviceCreateBindGroupLayout(device,&ld);WGPUBindGroupDescriptor desc=WGPU_BIND_GROUP_DESCRIPTOR_INIT;desc.layout=layout;desc.entryCount=n;desc.entries=entries.data();std::vector<double> times,release,drain;
  for(unsigned frame=0;frame<46;frame++){std::array<WGPUBindGroup,80> batch;auto t=Clock::now();for(auto&group:batch)group=wgpuDeviceCreateBindGroup(device,&desc);double a=elapsed(t);t=Clock::now();for(auto group:batch)wgpuBindGroupRelease(group);double b=elapsed(t);t=Clock::now();wait();double c=elapsed(t);if(frame>=10){times.push_back(a);release.push_back(b);drain.push_back(c);}}
  if(!first)out<<',';first=false;out<<"{\"entries\":"<<n<<",\"groups\":80,\"create\":";stats(out,times);out<<",\"release\":";stats(out,release);out<<",\"queueDrain\":";stats(out,drain);out<<'}';wgpuBindGroupLayoutRelease(layout);
 }out<<']';return out.str();}
};
int main(int argc,char**argv){
#ifndef __EMSCRIPTEN__
 try{
#endif
 IsolationGPU gpu;
#ifdef DRAW_PACKED_GROUPS
 UEWebGPUPacked::Enabled=true;gpu.verifyPackedGroups();
#endif
#ifdef DRAW_COMMAND_STREAM
 gpu.verifyStream();
#endif
 const auto cpu=Isolation::cpuTests(),render=Isolation::gpuTests(gpu),state=Isolation::stateTests(gpu),creation=gpu.creation();
 std::string result="{\"pass\":true,\"backend\":"+quote(gpu.name())+",\"cpu\":"+cpu+",\"render\":"+render+",\"stateTracking\":"+state+",\"descriptorCreation\":"+creation+"}";
#ifdef __EMSCRIPTEN__
 EM_ASM({postMessage({result:JSON.parse(UTF8ToString($0))});},result.c_str());emscripten_exit_with_live_runtime();
#else
 require(argc==2,"output path");std::ofstream(argv[1])<<result;
#endif
 return 0;
#ifndef __EMSCRIPTEN__
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
#endif
}
