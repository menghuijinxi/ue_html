// One C API workload compiled both as native Dawn/D3D12 and standalone wasm64.
#include "draw-api-common.h"
#include <webgpu/webgpu.h>
#ifdef DRAW_FAST_CALLS
#include "../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUFastCalls.h"
#endif
#ifdef DRAW_COMMAND_STREAM
#include "../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUCommandStream.h"
#endif
#ifdef DRAW_PACKED_GROUPS
#include "../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUPackedDescriptors.h"
#endif
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
 WGPUTexture target;WGPUTextureView view;WGPUQuerySet queries,occlusion;WGPUBuffer resolve,readback,pixels,occlusionResolve,occlusionReadback;
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
  qd.type=WGPUQueryType_Occlusion;occlusion=wgpuDeviceCreateQuerySet(device,&qd);occlusionResolve=buffer(256,WGPUBufferUsage_QueryResolve|WGPUBufferUsage_CopySrc);occlusionReadback=buffer(256,WGPUBufferUsage_MapRead|WGPUBufferUsage_CopyDst);
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
#ifdef DRAW_COMMAND_STREAM
 void verifyIndirectTemplates(){
  UEWebGPUStream::IndirectTemplates=true;
  auto& cache=UEWebGPUStream::indirectCache();
  auto vd=vertexData();auto ix=indexData();
  auto vertex=buffer(vd.size()*4,WGPUBufferUsage_Vertex,vd.data());
  auto index=buffer(ix.size()*2,WGPUBufferUsage_Index,ix.data());
  uint32_t args[]={3,1,0,0,0, 0,1,0,0,0};
  auto indirect=buffer(sizeof(args),WGPUBufferUsage_Indirect,args);
  std::vector<uint32_t> wideIndices(ix.begin(),ix.end());
  for(unsigned frame=0;frame<4;frame++){
   // Frame 1 reads changed indirect data through the same cached geometry.
   // Its second draw becomes empty; frame 2 replaces the underlying VB and IB.
   args[0]=frame==1?0:3;wgpuQueueWriteBuffer(queue,indirect,20,args,20);
   begin(0,false);
   UEWebGPUStream::VertexBinding bindings[8]{};bindings[0]={vertex,vd.size()*4,0};
   for(unsigned pixel=0;pixel<5;pixel++){
    wgpuRenderPassEncoderSetScissorRect(pass,pixel,0,1,1);
    wgpuRenderPassEncoderSetBindGroup(pass,0,groups[pixel],0,nullptr);
    bindings[0].offset=(pixel==2?1:pixel)*256;
    require(UEWebGPUStream::drawIndexedIndirectTemplate(pass,1,bindings,index,ix.size()*(frame==3?4:2),
     frame==3?WGPUIndexFormat_Uint32:WGPUIndexFormat_Uint16,pixel==2?0:1,pixel==0,indirect,pixel==4?20:0),
     "template path rejected valid geometry");
   }
   // executeBundles clears encoder bindings. Reestablish state before reusing.
   WGPUTextureFormat format=WGPUTextureFormat_RGBA8Unorm;
   auto bd=WGPU_RENDER_BUNDLE_ENCODER_DESCRIPTOR_INIT;bd.colorFormatCount=1;bd.colorFormats=&format;
   auto be=wgpuDeviceCreateRenderBundleEncoder(device,&bd);auto bundle=wgpuRenderBundleEncoderFinish(be,nullptr);
   wgpuRenderBundleEncoderRelease(be);wgpuRenderPassEncoderExecuteBundles(pass,1,&bundle);wgpuRenderBundleRelease(bundle);
   wgpuRenderPassEncoderSetScissorRect(pass,5,0,1,1);wgpuRenderPassEncoderSetPipeline(pass,pipelines[0]);
   wgpuRenderPassEncoderSetBindGroup(pass,0,groups[5],0,nullptr);
   require(UEWebGPUStream::drawIndexedIndirectTemplate(pass,1,bindings,index,ix.size()*(frame==3?4:2),
    frame==3?WGPUIndexFormat_Uint32:WGPUIndexFormat_Uint16,1,true,indirect,0),"template state reset rejected");
   end();submit();wait();
   auto e=wgpuDeviceCreateCommandEncoder(device,nullptr);
   WGPUTexelCopyTextureInfo src=WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;src.texture=target;
   WGPUTexelCopyBufferInfo dst=WGPU_TEXEL_COPY_BUFFER_INFO_INIT;dst.buffer=pixels;dst.layout.bytesPerRow=256;dst.layout.rowsPerImage=64;
   WGPUExtent3D size{64,64,1};wgpuCommandEncoderCopyTextureToBuffer(e,&src,&dst,&size);
   auto command=wgpuCommandEncoderFinish(e,nullptr);wgpuQueueSubmit(queue,1,&command);
   wgpuCommandBufferRelease(command);wgpuCommandEncoderRelease(e);
   auto p=(const uint8_t*)map(pixels,64*256);
   for(unsigned pixel=0;pixel<6;pixel++)for(unsigned channel=0;channel<4;channel++){
    const unsigned expected[]={(pixel*3+17)%256,(pixel*5+31)%256,(pixel*7+47)%256,255};
    require(std::abs(int(p[pixel*4+channel])-int(frame==1&&pixel==4?0:expected[channel]))<=1,
     "cached indirect geometry, current arguments, vertex offsets or reset mismatch");
   }
   require(p[24]==0&&p[27]==0,"template drew outside scissor");wgpuBufferUnmap(pixels);
   cache.endFrame();
   if(frame==1){
    wgpuBufferRelease(vertex);wgpuBufferRelease(index);
    vertex=buffer(vd.size()*4,WGPUBufferUsage_Vertex,vd.data());index=buffer(ix.size()*2,WGPUBufferUsage_Index,ix.data());
   }
   if(frame==2){wgpuBufferRelease(index);index=buffer(wideIndices.size()*4,WGPUBufferUsage_Index,wideIndices.data());}
  }
  require(cache.hits>=21&&cache.created==3,"geometry templates did not reuse or invalidate");
  wgpuBufferRelease(vertex);wgpuBufferRelease(index);wgpuBufferRelease(indirect);
  for(unsigned k=0;k<3;k++)cache.endFrame();
  require(cache.entries==0,"unused template leases were not retired");
  UEWebGPUStream::IndirectTemplates=false;checkErrors();
 }
 void verifyStream(){
  // Exercise deferred lifetime, immediate dynamic-offset copying, object-table
  // overflow, indirect draws, and ordered viewport/scissor boundaries on GPU.
  WGPUBindGroupLayoutEntry entry=WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;entry.binding=0;entry.visibility=WGPUShaderStage_Fragment;entry.buffer.type=WGPUBufferBindingType_Uniform;entry.buffer.hasDynamicOffset=true;entry.buffer.minBindingSize=16;
  WGPUBindGroupLayoutDescriptor ld=WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;ld.entryCount=1;ld.entries=&entry;auto layout=wgpuDeviceCreateBindGroupLayout(device,&ld);
  WGPUPipelineLayoutDescriptor pd=WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;pd.bindGroupLayoutCount=1;pd.bindGroupLayouts=&layout;auto pl=wgpuDeviceCreatePipelineLayout(device,&pd);
  WGPUShaderSourceWGSL source=WGPU_SHADER_SOURCE_WGSL_INIT;source.code=text(wgsl);WGPUShaderModuleDescriptor sd=WGPU_SHADER_MODULE_DESCRIPTOR_INIT;sd.nextInChain=&source.chain;auto module=wgpuDeviceCreateShaderModule(device,&sd);
  WGPUVertexAttribute attr=WGPU_VERTEX_ATTRIBUTE_INIT;attr.format=WGPUVertexFormat_Float32x2;attr.shaderLocation=0;
  WGPUVertexBufferLayout vb=WGPU_VERTEX_BUFFER_LAYOUT_INIT;vb.arrayStride=8;vb.attributeCount=1;vb.attributes=&attr;
  WGPUColorTargetState color=WGPU_COLOR_TARGET_STATE_INIT;color.format=WGPUTextureFormat_RGBA8Unorm;
  WGPUFragmentState frag=WGPU_FRAGMENT_STATE_INIT;frag.module=module;frag.entryPoint=text("fs0");frag.targetCount=1;frag.targets=&color;
  WGPURenderPipelineDescriptor d=WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;d.layout=pl;d.vertex.module=module;d.vertex.entryPoint=text("vs");d.vertex.bufferCount=1;d.vertex.buffers=&vb;d.fragment=&frag;
  auto pipeline=wgpuDeviceCreateRenderPipeline(device,&d);
  auto vd=vertexData();auto ix=indexData();auto vertex=buffer(vd.size()*4,WGPUBufferUsage_Vertex,vd.data());auto index=buffer(ix.size()*2,WGPUBufferUsage_Index,ix.data());
  uint32_t args[]={3,1,0,0,0};auto indirect=buffer(sizeof(args),WGPUBufferUsage_Indirect,args);
  encoder=wgpuDeviceCreateCommandEncoder(device,nullptr);WGPURenderPassColorAttachment ca=WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;ca.view=view;ca.loadOp=WGPULoadOp_Clear;ca.storeOp=WGPUStoreOp_Store;
  WGPURenderPassDescriptor passDesc=WGPU_RENDER_PASS_DESCRIPTOR_INIT;passDesc.colorAttachmentCount=1;passDesc.colorAttachments=&ca;passDesc.occlusionQuerySet=occlusion;pass=wgpuCommandEncoderBeginRenderPass(encoder,&passDesc);timed=false;
  wgpuRenderPassEncoderSetViewport(pass,0,0,64,64,0,1);wgpuRenderPassEncoderSetScissorRect(pass,0,0,1,1);
  wgpuRenderPassEncoderSetPipeline(pass,pipeline);wgpuRenderPipelineRelease(pipeline);
  wgpuRenderPassEncoderSetVertexBuffer(pass,0,vertex,0,WGPU_WHOLE_SIZE);wgpuBufferRelease(vertex);
  wgpuRenderPassEncoderSetIndexBuffer(pass,index,WGPUIndexFormat_Uint16,0,WGPU_WHOLE_SIZE);wgpuBufferRelease(index);
  for(unsigned k=0;k<401;k++){
   WGPUBindGroupEntry be=WGPU_BIND_GROUP_ENTRY_INIT;be.binding=0;be.buffer=uniforms;be.size=16;
   WGPUBindGroupDescriptor bd=WGPU_BIND_GROUP_DESCRIPTOR_INIT;bd.layout=layout;bd.entryCount=1;bd.entries=&be;auto group=wgpuDeviceCreateBindGroup(device,&bd);
   uint32_t offset=0;wgpuRenderPassEncoderSetBindGroup(pass,0,group,1,&offset);offset=256;wgpuBindGroupRelease(group);
  }
  wgpuRenderPassEncoderSetStencilReference(pass,7);
  wgpuRenderPassEncoderBeginOcclusionQuery(pass,0);wgpuRenderPassEncoderDrawIndexed(pass,3,1,0,0,0);wgpuRenderPassEncoderEndOcclusionQuery(pass);
  wgpuRenderPassEncoderSetScissorRect(pass,1,0,1,1);
  WGPUBindGroupEntry be=WGPU_BIND_GROUP_ENTRY_INIT;be.binding=0;be.buffer=uniforms;be.size=16;
  WGPUBindGroupDescriptor bd=WGPU_BIND_GROUP_DESCRIPTOR_INIT;bd.layout=layout;bd.entryCount=1;bd.entries=&be;auto group=wgpuDeviceCreateBindGroup(device,&bd);
  uint32_t offset=256;wgpuRenderPassEncoderSetBindGroup(pass,0,group,1,&offset);offset=0;wgpuBindGroupRelease(group);
  wgpuRenderPassEncoderSetScissorRect(pass,1,0,0,1);
  wgpuRenderPassEncoderBeginOcclusionQuery(pass,1);wgpuRenderPassEncoderDrawIndexedIndirect(pass,indirect,0);wgpuRenderPassEncoderEndOcclusionQuery(pass);
  wgpuRenderPassEncoderSetScissorRect(pass,1,0,1,1);wgpuRenderPassEncoderDrawIndexedIndirect(pass,indirect,0);wgpuBufferRelease(indirect);
  // The engine also emits pipeline/VB/group/IB; cover that fused decode path.
  wgpuRenderPassEncoderSetScissorRect(pass,2,0,1,1);
  wgpuRenderPassEncoderSetPipeline(pass,pipelines[0]);wgpuRenderPassEncoderSetVertexBuffer(pass,0,vertices,0,24);
  wgpuRenderPassEncoderSetBindGroup(pass,0,groups[2],0,nullptr);wgpuRenderPassEncoderSetIndexBuffer(pass,indices,WGPUIndexFormat_Uint16,0,6);
  wgpuRenderPassEncoderDrawIndexed(pass,3,1,0,0,0);
  wgpuRenderPassEncoderSetScissorRect(pass,3,0,1,1);wgpuRenderPassEncoderSetBindGroup(pass,0,groups[3],0,nullptr);wgpuRenderPassEncoderDraw(pass,3,1,0,0);
  wgpuRenderPassEncoderSetScissorRect(pass,4,0,1,1);wgpuRenderPassEncoderSetBindGroup(pass,0,groups[4],0,nullptr);
  auto nonIndexed=buffer(sizeof(args),WGPUBufferUsage_Indirect,args);wgpuRenderPassEncoderDrawIndirect(pass,nonIndexed,0);wgpuBufferRelease(nonIndexed);
  end();submit();wait();
  auto queryEncoder=wgpuDeviceCreateCommandEncoder(device,nullptr);wgpuCommandEncoderResolveQuerySet(queryEncoder,occlusion,0,2,occlusionResolve,0);wgpuCommandEncoderCopyBufferToBuffer(queryEncoder,occlusionResolve,0,occlusionReadback,0,16);auto queryCommands=wgpuCommandEncoderFinish(queryEncoder,nullptr);wgpuQueueSubmit(queue,1,&queryCommands);wgpuCommandBufferRelease(queryCommands);wgpuCommandEncoderRelease(queryEncoder);
  auto queryValues=(const uint64_t*)map(occlusionReadback,16);require(queryValues[0]>0&&queryValues[1]==0,"stream occlusion query ordering mismatch");wgpuBufferUnmap(occlusionReadback);
  auto e=wgpuDeviceCreateCommandEncoder(device,nullptr);WGPUTexelCopyTextureInfo src=WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;src.texture=target;WGPUTexelCopyBufferInfo dst=WGPU_TEXEL_COPY_BUFFER_INFO_INIT;dst.buffer=pixels;dst.layout.bytesPerRow=256;dst.layout.rowsPerImage=64;WGPUExtent3D size{64,64,1};wgpuCommandEncoderCopyTextureToBuffer(e,&src,&dst,&size);auto c=wgpuCommandEncoderFinish(e,nullptr);wgpuQueueSubmit(queue,1,&c);wgpuCommandBufferRelease(c);wgpuCommandEncoderRelease(e);
  auto p=(const uint8_t*)map(pixels,64*256);verifyPixel(p,0,1);for(unsigned k=1;k<=4;k++){const unsigned expected[]={(k*3+17)%256,(k*5+31)%256,(k*7+47)%256,255};for(unsigned channel=0;channel<4;channel++)require(std::abs(int(p[k*4+channel])-int(expected[channel]))<=1,"stream dynamic offset, lifetime or decode mismatch");}require(p[20]==0&&p[23]==0,"stream scissor ordering mismatch");wgpuBufferUnmap(pixels);
  wgpuShaderModuleRelease(module);wgpuPipelineLayoutRelease(pl);wgpuBindGroupLayoutRelease(layout);checkErrors();
 }
#endif
#ifdef DRAW_PACKED_GROUPS
 void verifyPackedGroups(){
  WGPUBindGroupLayoutEntry le[3];for(unsigned i=0;i<3;i++){le[i]=WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;le[i].binding=i;le[i].visibility=WGPUShaderStage_Fragment;}
  le[0].buffer.type=WGPUBufferBindingType_Uniform;le[0].buffer.minBindingSize=16;
  le[1].texture.sampleType=WGPUTextureSampleType_Float;le[1].texture.viewDimension=WGPUTextureViewDimension_2D;
  le[2].sampler.type=WGPUSamplerBindingType_Filtering;
  WGPUBindGroupLayoutDescriptor ld=WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;ld.entryCount=3;ld.entries=le;auto layout=wgpuDeviceCreateBindGroupLayout(device,&ld);
  WGPUPipelineLayoutDescriptor pd=WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;pd.bindGroupLayoutCount=1;pd.bindGroupLayouts=&layout;auto pl=wgpuDeviceCreatePipelineLayout(device,&pd);
  std::string code="@group(0) @binding(1) var tx:texture_2d<f32>; @group(0) @binding(2) var sm:sampler;\n"+std::string(wgsl);
  const std::string original="return color.value;";code.replace(code.find(original),original.size(),"return color.value * textureSampleLevel(tx,sm,vec2f(0.5),0.0);");
  WGPUShaderSourceWGSL source=WGPU_SHADER_SOURCE_WGSL_INIT;source.code=text(code.c_str());WGPUShaderModuleDescriptor sd=WGPU_SHADER_MODULE_DESCRIPTOR_INIT;sd.nextInChain=&source.chain;auto shader=wgpuDeviceCreateShaderModule(device,&sd);
  WGPUVertexAttribute attr=WGPU_VERTEX_ATTRIBUTE_INIT;attr.format=WGPUVertexFormat_Float32x2;attr.shaderLocation=0;WGPUVertexBufferLayout vb=WGPU_VERTEX_BUFFER_LAYOUT_INIT;vb.arrayStride=8;vb.attributeCount=1;vb.attributes=&attr;
  WGPUColorTargetState color=WGPU_COLOR_TARGET_STATE_INIT;color.format=WGPUTextureFormat_RGBA8Unorm;
  WGPUFragmentState frag=WGPU_FRAGMENT_STATE_INIT;frag.module=shader;frag.entryPoint=text("fs0");frag.targetCount=1;frag.targets=&color;
  WGPURenderPipelineDescriptor pipelineDesc=WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;pipelineDesc.layout=pl;pipelineDesc.vertex.module=shader;pipelineDesc.vertex.entryPoint=text("vs");pipelineDesc.vertex.bufferCount=1;pipelineDesc.vertex.buffers=&vb;pipelineDesc.fragment=&frag;auto pipeline=wgpuDeviceCreateRenderPipeline(device,&pipelineDesc);
  WGPUTextureDescriptor td=WGPU_TEXTURE_DESCRIPTOR_INIT;td.size={1,1,1};td.format=WGPUTextureFormat_RGBA8Unorm;td.usage=WGPUTextureUsage_TextureBinding|WGPUTextureUsage_CopyDst;auto texture=wgpuDeviceCreateTexture(device,&td);auto textureView=wgpuTextureCreateView(texture,nullptr);
  WGPUTexelCopyTextureInfo destination=WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;destination.texture=texture;WGPUTexelCopyBufferLayout dataLayout=WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;dataLayout.bytesPerRow=4;dataLayout.rowsPerImage=1;WGPUExtent3D extent{1,1,1};const uint8_t texel[]={255,128,64,255};wgpuQueueWriteTexture(queue,&destination,texel,4,&dataLayout,&extent);
  WGPUSamplerDescriptor samplerDesc=WGPU_SAMPLER_DESCRIPTOR_INIT;auto sampler=wgpuDeviceCreateSampler(device,&samplerDesc);const float constants[]={20.f/255,36.f/255,54.f/255,1};auto uniform=buffer(16,WGPUBufferUsage_Uniform,constants);
  WGPUBindGroupEntry entries[3];for(unsigned i=0;i<3;i++){entries[i]=WGPU_BIND_GROUP_ENTRY_INIT;entries[i].binding=i;}entries[0].buffer=uniform;entries[0].size=WGPU_WHOLE_SIZE;entries[1].textureView=textureView;entries[2].sampler=sampler;
  WGPUBindGroupDescriptor desc=WGPU_BIND_GROUP_DESCRIPTOR_INIT;desc.layout=layout;desc.entryCount=3;desc.entries=entries;auto packed=wgpuDeviceCreateBindGroup(device,&desc);desc.label=text("label-preserved-fallback");auto labeled=wgpuDeviceCreateBindGroup(device,&desc);
  begin(0,false);wgpuRenderPassEncoderSetPipeline(pass,pipeline);wgpuRenderPassEncoderSetBindGroup(pass,0,packed,0,nullptr);wgpuRenderPassEncoderDrawIndexed(pass,3,1,0,0,0);wgpuRenderPassEncoderSetScissorRect(pass,1,0,1,1);wgpuRenderPassEncoderSetBindGroup(pass,0,labeled,0,nullptr);wgpuRenderPassEncoderDrawIndexed(pass,3,1,0,0,0);end();submit();wait();
  auto e=wgpuDeviceCreateCommandEncoder(device,nullptr);WGPUTexelCopyTextureInfo src=WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;src.texture=target;WGPUTexelCopyBufferInfo dst=WGPU_TEXEL_COPY_BUFFER_INFO_INIT;dst.buffer=pixels;dst.layout.bytesPerRow=256;dst.layout.rowsPerImage=64;WGPUExtent3D size{64,64,1};wgpuCommandEncoderCopyTextureToBuffer(e,&src,&dst,&size);auto c=wgpuCommandEncoderFinish(e,nullptr);wgpuQueueSubmit(queue,1,&c);wgpuCommandBufferRelease(c);wgpuCommandEncoderRelease(e);
  auto bytes=(const uint8_t*)map(pixels,64*256);const int expected[]={20,18,14,255};for(unsigned pixel=0;pixel<2;pixel++)for(unsigned channel=0;channel<4;channel++)require(std::abs(int(bytes[pixel*4+channel])-expected[channel])<=1,"packed buffer/texture/sampler or label fallback mismatch");wgpuBufferUnmap(pixels);
  wgpuBindGroupRelease(packed);wgpuBindGroupRelease(labeled);wgpuBufferRelease(uniform);wgpuSamplerRelease(sampler);wgpuTextureViewRelease(textureView);wgpuTextureRelease(texture);wgpuRenderPipelineRelease(pipeline);wgpuShaderModuleRelease(shader);wgpuPipelineLayoutRelease(pl);wgpuBindGroupLayoutRelease(layout);checkErrors();
 }
 std::string benchmarkGroups(){
  std::ostringstream out;out<<"[";bool first=true;
  for(unsigned n:{0u,1u,8u,16u,32u}){
   std::vector<WGPUBindGroupLayoutEntry> layoutEntries(n);std::vector<WGPUBindGroupEntry> entries(n);
   for(unsigned i=0;i<n;i++){auto& le=layoutEntries[i];le=WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;le.binding=i;le.visibility=WGPUShaderStage_None;le.buffer.type=WGPUBufferBindingType_Uniform;le.buffer.minBindingSize=16;
    entries[i]=WGPU_BIND_GROUP_ENTRY_INIT;entries[i].binding=i;entries[i].buffer=uniforms;entries[i].offset=(i%64)*256;entries[i].size=16;}
   WGPUBindGroupLayoutDescriptor ld=WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;ld.entryCount=n;ld.entries=layoutEntries.data();auto layout=wgpuDeviceCreateBindGroupLayout(device,&ld);
   WGPUBindGroupDescriptor bd=WGPU_BIND_GROUP_DESCRIPTOR_INIT;bd.layout=layout;bd.entryCount=n;bd.entries=entries.data();std::vector<double> values;
   for(unsigned batch=0;batch<46;batch++){std::array<WGPUBindGroup,80> groups;auto start=Clock::now();for(auto& group:groups)group=wgpuDeviceCreateBindGroup(device,&bd);double ms=elapsed(start);for(auto group:groups)wgpuBindGroupRelease(group);if(batch>=10)values.push_back(ms);wait();}
   if(!first)out<<',';first=false;out<<"{\"entries\":"<<n<<",\"groupsPerSample\":80,\"creation\":";stats(out,values);out<<"}";wgpuBindGroupLayoutRelease(layout);
  }out<<"]";checkErrors();return out.str();
 }
#endif
};
int main(int argc,char**argv){
#ifndef __EMSCRIPTEN__
 try{
#endif
 GPU g;
#ifdef DRAW_PACKED_GROUPS
 UEWebGPUPacked::Enabled=EM_ASM_INT({return !Module.arguments?.includes('--legacy-groups');});
 g.verifyPackedGroups();
#endif
#ifdef DRAW_COMMAND_STREAM
 UEWebGPUStream::StateCommands=EM_ASM_INT({return !Module.arguments?.includes('--legacy-states');});
 g.verifyStream();
 g.verifyIndirectTemplates();
 if(EM_ASM_INT({return Module.arguments?.includes('--preflight-only');})){
  const auto& cache=UEWebGPUStream::indirectCache();
  EM_ASM({postMessage({result:{pass:true,indirectTemplates:true,hits:$0,created:$1,retained:$2,
   indexFormats:[16,32],currentIndirectArguments:true,bufferReplacement:true,bundleStateReset:true}});},
   cache.hits,cache.created,cache.entries);emscripten_exit_with_live_runtime();return 0;
 }
#endif
 auto r=benchmark(g);
#ifdef DRAW_PACKED_GROUPS
 auto groupResult=g.benchmarkGroups();r.pop_back();r+=",\"bindGroupCreation\":"+groupResult+"}";
#endif
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
