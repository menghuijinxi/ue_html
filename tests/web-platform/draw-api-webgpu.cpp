// One C API workload compiled both as native Dawn/D3D12 and standalone wasm64.
#include "draw-api-common.h"
#include <webgpu/webgpu.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_ASYNC_JS(void, waitCallback, (bool* done), {
 if (!HEAPU8[Number(done)]) await new Promise((resolve, reject) => {
  Module.drawTimer=setTimeout(() => reject(new Error('callback timeout')),120000);
  Module.drawWake=resolve;
 });
});
#else
#include <thread>
#endif
WGPUStringView text(const char* s){return {s,strlen(s)};}
std::string text(WGPUStringView s){return s.data?std::string(s.data,s.length==WGPU_STRLEN?strlen(s.data):s.length):"";}
void complete(void* done){*(bool*)done=true;
#ifdef __EMSCRIPTEN__
 EM_ASM({if(Module.drawWake){const wake=Module.drawWake;Module.drawWake=null;clearTimeout(Module.drawTimer);wake();}});
#endif
}
struct GPU {
 WGPUInstance instance;WGPUAdapter adapter=nullptr;WGPUDevice device=nullptr;WGPUQueue queue;
 WGPURenderPipeline pipelines[2];WGPUBindGroup groups[64];WGPUBuffer vertices,indices,uniforms;
 WGPUTexture target;WGPUTextureView view;WGPUQuerySet queries;WGPUBuffer resolve,readback,pixels;
 WGPUCommandEncoder encoder;WGPURenderPassEncoder pass;WGPUCommandBuffer commands=nullptr;WGPURenderBundle bundle=nullptr;
 bool timed=false;std::string adapterName;std::vector<std::string> errors;
#ifdef __EMSCRIPTEN__
 static constexpr WGPUCallbackMode cb=WGPUCallbackMode_AllowSpontaneous;
#else
 static constexpr WGPUCallbackMode cb=WGPUCallbackMode_AllowProcessEvents;
#endif
 const char* name(){
#ifdef __EMSCRIPTEN__
 return "browser-wasm64-webgpu";
#else
 return "native-dawn-d3d12";
#endif
 }
 void until(bool& done){
#ifdef __EMSCRIPTEN__
 waitCallback(&done);
#else
 auto t=Clock::now();while(!done){require(elapsed(t)<120000,"callback timeout");
 wgpuInstanceProcessEvents(instance);std::this_thread::yield();
 }
#endif
 }
 WGPUBuffer buffer(uint64_t bytes,WGPUBufferUsage usage,const void* data=nullptr){WGPUBufferDescriptor d=WGPU_BUFFER_DESCRIPTOR_INIT;d.size=bytes;d.usage=usage|(data?WGPUBufferUsage_CopyDst:0);auto b=wgpuDeviceCreateBuffer(device,&d);if(data)wgpuQueueWriteBuffer(queue,b,0,data,size_t(bytes));return b;}
 GPU(){
  WGPUInstanceDescriptor id=WGPU_INSTANCE_DESCRIPTOR_INIT;instance=wgpuCreateInstance(&id);bool done=false;
  WGPURequestAdapterOptions ao=WGPU_REQUEST_ADAPTER_OPTIONS_INIT;ao.powerPreference=WGPUPowerPreference_HighPerformance;
#ifndef __EMSCRIPTEN__
  ao.backendType=WGPUBackendType_D3D12;
#endif
  WGPURequestAdapterCallbackInfo ac=WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;ac.mode=cb;ac.userdata1=this;ac.userdata2=&done;ac.callback=[](WGPURequestAdapterStatus status,WGPUAdapter a,WGPUStringView msg,void* u,void* d){auto&g=*(GPU*)u;g.adapter=a;if(status!=WGPURequestAdapterStatus_Success)g.errors.push_back(text(msg));complete(d);};
  wgpuInstanceRequestAdapter(instance,&ao,ac);until(done);checkErrors();require(adapter,"no adapter");
  WGPUAdapterInfo ai=WGPU_ADAPTER_INFO_INIT;wgpuAdapterGetInfo(adapter,&ai);adapterName=text(ai.description)+" "+text(ai.device);wgpuAdapterInfoFreeMembers(ai);
  require(wgpuAdapterHasFeature(adapter,WGPUFeatureName_TimestampQuery),"timestamp-query unavailable");
  WGPUFeatureName feature=WGPUFeatureName_TimestampQuery;WGPUDeviceDescriptor dd=WGPU_DEVICE_DESCRIPTOR_INIT;dd.requiredFeatureCount=1;dd.requiredFeatures=&feature;
  dd.uncapturedErrorCallbackInfo.userdata1=this;dd.uncapturedErrorCallbackInfo.callback=[](WGPUDevice const*,WGPUErrorType,WGPUStringView m,void*u,void*){((GPU*)u)->errors.push_back(text(m));};
  WGPURequestDeviceCallbackInfo dc=WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;dc.mode=cb;dc.userdata1=this;dc.userdata2=&done;dc.callback=[](WGPURequestDeviceStatus status,WGPUDevice d,WGPUStringView msg,void*u,void*b){auto&g=*(GPU*)u;g.device=d;if(status!=WGPURequestDeviceStatus_Success)g.errors.push_back(text(msg));complete(b);};done=false;wgpuAdapterRequestDevice(adapter,&dd,dc);until(done);checkErrors();queue=wgpuDeviceGetQueue(device);
  auto vd=vertexData();auto ix=indexData();auto colors=colorData();vertices=buffer(vd.size()*4,WGPUBufferUsage_Vertex,vd.data());indices=buffer(ix.size()*2,WGPUBufferUsage_Index,ix.data());uniforms=buffer(colors.size()*4,WGPUBufferUsage_Uniform,colors.data());
  WGPUTextureDescriptor td=WGPU_TEXTURE_DESCRIPTOR_INIT;td.size={64,64,1};td.format=WGPUTextureFormat_RGBA8Unorm;td.usage=WGPUTextureUsage_RenderAttachment|WGPUTextureUsage_CopySrc;target=wgpuDeviceCreateTexture(device,&td);view=wgpuTextureCreateView(target,nullptr);
  WGPUBindGroupLayoutEntry e=WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;e.binding=0;e.visibility=WGPUShaderStage_Fragment;e.buffer.type=WGPUBufferBindingType_Uniform;e.buffer.minBindingSize=16;
  WGPUBindGroupLayoutDescriptor ld=WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;ld.entryCount=1;ld.entries=&e;auto layout=wgpuDeviceCreateBindGroupLayout(device,&ld);
  WGPUPipelineLayoutDescriptor pd=WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;pd.bindGroupLayoutCount=1;pd.bindGroupLayouts=&layout;auto pl=wgpuDeviceCreatePipelineLayout(device,&pd);
  for(unsigned k=0;k<64;k++){WGPUBindGroupEntry be=WGPU_BIND_GROUP_ENTRY_INIT;be.binding=0;be.buffer=uniforms;be.offset=k*256;be.size=16;WGPUBindGroupDescriptor bd=WGPU_BIND_GROUP_DESCRIPTOR_INIT;bd.layout=layout;bd.entryCount=1;bd.entries=&be;groups[k]=wgpuDeviceCreateBindGroup(device,&bd);}
  WGPUShaderSourceWGSL source=WGPU_SHADER_SOURCE_WGSL_INIT;source.code=text(wgsl);WGPUShaderModuleDescriptor sd=WGPU_SHADER_MODULE_DESCRIPTOR_INIT;sd.nextInChain=&source.chain;auto module=wgpuDeviceCreateShaderModule(device,&sd);
  WGPUVertexAttribute attr=WGPU_VERTEX_ATTRIBUTE_INIT;attr.format=WGPUVertexFormat_Float32x2;attr.shaderLocation=0;
  WGPUVertexBufferLayout vb=WGPU_VERTEX_BUFFER_LAYOUT_INIT;vb.arrayStride=8;vb.attributeCount=1;vb.attributes=&attr;
  WGPUColorTargetState color=WGPU_COLOR_TARGET_STATE_INIT;color.format=WGPUTextureFormat_RGBA8Unorm;
  for(unsigned k=0;k<2;k++){WGPUFragmentState frag=WGPU_FRAGMENT_STATE_INIT;frag.module=module;frag.entryPoint=text(k?"fs1":"fs0");frag.targetCount=1;frag.targets=&color;WGPURenderPipelineDescriptor d=WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;d.layout=pl;d.vertex.module=module;d.vertex.entryPoint=text("vs");d.vertex.bufferCount=1;d.vertex.buffers=&vb;d.fragment=&frag;d.primitive.cullMode=WGPUCullMode_None;pipelines[k]=wgpuDeviceCreateRenderPipeline(device,&d);}
  WGPUQuerySetDescriptor qd=WGPU_QUERY_SET_DESCRIPTOR_INIT;qd.type=WGPUQueryType_Timestamp;qd.count=2;queries=wgpuDeviceCreateQuerySet(device,&qd);resolve=buffer(256,WGPUBufferUsage_QueryResolve|WGPUBufferUsage_CopySrc);readback=buffer(256,WGPUBufferUsage_MapRead|WGPUBufferUsage_CopyDst);pixels=buffer(64*256,WGPUBufferUsage_MapRead|WGPUBufferUsage_CopyDst);
  wgpuShaderModuleRelease(module);wgpuPipelineLayoutRelease(pl);wgpuBindGroupLayoutRelease(layout);checkErrors();wait();
 }
 double prepare(unsigned mode,unsigned n){if(bundle){wgpuRenderBundleRelease(bundle);bundle=nullptr;}if(mode!=2)return 0;auto t=Clock::now();WGPUTextureFormat format=WGPUTextureFormat_RGBA8Unorm;WGPURenderBundleEncoderDescriptor d=WGPU_RENDER_BUNDLE_ENCODER_DESCRIPTOR_INIT;d.colorFormatCount=1;d.colorFormats=&format;auto b=wgpuDeviceCreateRenderBundleEncoder(device,&d);wgpuRenderBundleEncoderSetPipeline(b,pipelines[0]);wgpuRenderBundleEncoderSetBindGroup(b,0,groups[0],0,nullptr);wgpuRenderBundleEncoderSetVertexBuffer(b,0,vertices,0,24);wgpuRenderBundleEncoderSetIndexBuffer(b,indices,WGPUIndexFormat_Uint16,0,6);for(unsigned j=0;j<n;j++){unsigned k=j%64;wgpuRenderBundleEncoderSetPipeline(b,pipelines[j&1]);wgpuRenderBundleEncoderSetBindGroup(b,0,groups[k],0,nullptr);wgpuRenderBundleEncoderSetVertexBuffer(b,0,vertices,k*256,24);wgpuRenderBundleEncoderSetIndexBuffer(b,indices,WGPUIndexFormat_Uint16,k*256,6);wgpuRenderBundleEncoderDrawIndexed(b,3,1,0,0,0);}bundle=wgpuRenderBundleEncoderFinish(b,nullptr);wgpuRenderBundleEncoderRelease(b);return elapsed(t);}
 double begin(unsigned,bool timing){timed=timing;encoder=wgpuDeviceCreateCommandEncoder(device,nullptr);WGPURenderPassColorAttachment ca=WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;ca.view=view;ca.loadOp=WGPULoadOp_Clear;ca.storeOp=WGPUStoreOp_Store;ca.clearValue={0,0,0,0};WGPURenderPassDescriptor d=WGPU_RENDER_PASS_DESCRIPTOR_INIT;d.colorAttachmentCount=1;d.colorAttachments=&ca;WGPUPassTimestampWrites ts=WGPU_PASS_TIMESTAMP_WRITES_INIT;ts.querySet=queries;ts.beginningOfPassWriteIndex=0;ts.endOfPassWriteIndex=1;if(timed)d.timestampWrites=&ts;pass=wgpuCommandEncoderBeginRenderPass(encoder,&d);wgpuRenderPassEncoderSetViewport(pass,0,0,64,64,0,1);wgpuRenderPassEncoderSetScissorRect(pass,0,0,1,1);wgpuRenderPassEncoderSetPipeline(pass,pipelines[0]);wgpuRenderPassEncoderSetBindGroup(pass,0,groups[0],0,nullptr);wgpuRenderPassEncoderSetVertexBuffer(pass,0,vertices,0,24);wgpuRenderPassEncoderSetIndexBuffer(pass,indices,WGPUIndexFormat_Uint16,0,6);return 0;}
 void emit(unsigned mode,unsigned n){if(mode==2){wgpuRenderPassEncoderExecuteBundles(pass,1,&bundle);return;}if(mode==3){wgpuRenderPassEncoderDrawIndexed(pass,3,n,0,0,0);return;}if(mode==0){for(unsigned j=0;j<n;j++)wgpuRenderPassEncoderDrawIndexed(pass,3,1,0,0,0);return;}for(unsigned j=0;j<n;j++){unsigned k=j%64;wgpuRenderPassEncoderSetPipeline(pass,pipelines[j&1]);wgpuRenderPassEncoderSetBindGroup(pass,0,groups[k],0,nullptr);wgpuRenderPassEncoderSetVertexBuffer(pass,0,vertices,k*256,24);wgpuRenderPassEncoderSetIndexBuffer(pass,indices,WGPUIndexFormat_Uint16,k*256,6);wgpuRenderPassEncoderDrawIndexed(pass,3,1,0,0,0);}}
 void end(){wgpuRenderPassEncoderEnd(pass);wgpuRenderPassEncoderRelease(pass);if(timed){wgpuCommandEncoderResolveQuerySet(encoder,queries,0,2,resolve,0);wgpuCommandEncoderCopyBufferToBuffer(encoder,resolve,0,readback,0,16);}commands=wgpuCommandEncoderFinish(encoder,nullptr);wgpuCommandEncoderRelease(encoder);}
 void submit(){wgpuQueueSubmit(queue,1,&commands);wgpuCommandBufferRelease(commands);commands=nullptr;}
 void wait(){bool done=false;WGPUQueueWorkDoneCallbackInfo c=WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;c.mode=cb;c.userdata1=&done;c.userdata2=this;c.callback=[](WGPUQueueWorkDoneStatus s,WGPUStringView msg,void*u,void*v){if(s!=WGPUQueueWorkDoneStatus_Success)((GPU*)v)->errors.push_back(text(msg));complete(u);};wgpuQueueOnSubmittedWorkDone(queue,c);until(done);checkErrors();}
 const void* map(WGPUBuffer b,size_t size){bool done=false;WGPUBufferMapCallbackInfo c=WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;c.mode=cb;c.userdata1=&done;c.userdata2=this;c.callback=[](WGPUMapAsyncStatus s,WGPUStringView msg,void*u,void*v){if(s!=WGPUMapAsyncStatus_Success)((GPU*)v)->errors.push_back(text(msg));complete(u);};wgpuBufferMapAsync(b,WGPUMapMode_Read,0,size,c);until(done);checkErrors();return wgpuBufferGetConstMappedRange(b,0,size);}
 double gpuMilliseconds(){auto p=(const uint64_t*)map(readback,16);double v=double(p[1]-p[0])/1e6;wgpuBufferUnmap(readback);return v;}
 void verify(unsigned mode,unsigned n){auto e=wgpuDeviceCreateCommandEncoder(device,nullptr);WGPUTexelCopyTextureInfo src=WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;src.texture=target;WGPUTexelCopyBufferInfo dst=WGPU_TEXEL_COPY_BUFFER_INFO_INIT;dst.buffer=pixels;dst.layout.bytesPerRow=256;dst.layout.rowsPerImage=64;WGPUExtent3D size{64,64,1};wgpuCommandEncoderCopyTextureToBuffer(e,&src,&dst,&size);auto c=wgpuCommandEncoderFinish(e,nullptr);wgpuQueueSubmit(queue,1,&c);wgpuCommandBufferRelease(c);wgpuCommandEncoderRelease(e);auto p=(const uint8_t*)map(pixels,64*256);verifyPixel(p,mode,n);require(p[4]==0&&p[7]==0,"outside-scissor pixel modified");wgpuBufferUnmap(pixels);}
 void checkErrors(){if(!errors.empty())require(false,errors.front().c_str());}
};
int main(int argc,char**argv){
#ifndef __EMSCRIPTEN__
 try{
#endif
 GPU g;auto r=benchmark(g);
#ifdef __EMSCRIPTEN__
 EM_ASM({postMessage({result:JSON.parse(UTF8ToString($0))});},r.c_str());emscripten_exit_with_live_runtime();
#else
 require(argc==2,"pass output JSON path");std::ofstream(argv[1])<<r;
#endif
 return 0;
#ifndef __EMSCRIPTEN__
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
#endif
}
