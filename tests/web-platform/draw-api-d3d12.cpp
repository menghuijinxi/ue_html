#include "draw-api-common.h"
#include <windows.h>
#include <d3d12.h>
#include <d3d12sdklayers.h>
#include <d3dcompiler.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
void check(HRESULT h){if(FAILED(h)){std::ostringstream s;s<<"HRESULT 0x"<<std::hex<<unsigned(h);throw std::runtime_error(s.str());}}
struct GPU {
 ComPtr<ID3D12Device> device;ComPtr<ID3D12CommandQueue> queue;ComPtr<ID3D12CommandAllocator> alloc[3],bundleAlloc;
 ComPtr<ID3D12GraphicsCommandList> lists[3],bundle;ID3D12GraphicsCommandList* list;
 ComPtr<ID3D12RootSignature> root;ComPtr<ID3D12PipelineState> pipelines[2];
 ComPtr<ID3D12DescriptorHeap> rtvHeap,cbvHeap;ComPtr<ID3D12Resource> target,vertices,indices,uniforms,readback,pixels;
 ComPtr<ID3D12QueryHeap> queries;ComPtr<ID3D12Fence> fence;HANDLE event;UINT64 value=0,frequency=0;
 ComPtr<ID3D12InfoQueue> info;
 D3D12_VERTEX_BUFFER_VIEW vb[64];D3D12_INDEX_BUFFER_VIEW ib[64];D3D12_GPU_DESCRIPTOR_HANDLE cbv[64];
 bool timed=false;unsigned slot=0;std::string adapterName;
 const char* name(){return "native-d3d12";}
 ComPtr<ID3D12Resource> buffer(uint64_t bytes,D3D12_HEAP_TYPE heap,const void* data=nullptr){D3D12_HEAP_PROPERTIES hp{};hp.Type=heap;D3D12_RESOURCE_DESC d{};d.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER;d.Width=bytes;d.Height=d.DepthOrArraySize=d.MipLevels=1;d.SampleDesc.Count=1;d.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR;ComPtr<ID3D12Resource> r;check(device->CreateCommittedResource(&hp,D3D12_HEAP_FLAG_NONE,&d,heap==D3D12_HEAP_TYPE_READBACK?D3D12_RESOURCE_STATE_COPY_DEST:(heap==D3D12_HEAP_TYPE_DEFAULT?D3D12_RESOURCE_STATE_COMMON:D3D12_RESOURCE_STATE_GENERIC_READ),nullptr,IID_PPV_ARGS(&r)));if(data){void*p;check(r->Map(0,nullptr,&p));memcpy(p,data,size_t(bytes));r->Unmap(0,nullptr);}return r;}
 ComPtr<ID3D12Resource> resident(uint64_t bytes,const void* data){
  auto upload=buffer(bytes,D3D12_HEAP_TYPE_UPLOAD,data), result=buffer(bytes,D3D12_HEAP_TYPE_DEFAULT);
  ComPtr<ID3D12CommandAllocator> a;ComPtr<ID3D12GraphicsCommandList> c;
  check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,IID_PPV_ARGS(&a)));
  check(device->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_DIRECT,a.Get(),nullptr,IID_PPV_ARGS(&c)));
  D3D12_RESOURCE_BARRIER b{};b.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
  b.Transition={result.Get(),D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,D3D12_RESOURCE_STATE_COMMON,D3D12_RESOURCE_STATE_COPY_DEST};
  c->ResourceBarrier(1,&b);c->CopyBufferRegion(result.Get(),0,upload.Get(),0,bytes);
  b.Transition.StateBefore=D3D12_RESOURCE_STATE_COPY_DEST;b.Transition.StateAfter=D3D12_RESOURCE_STATE_GENERIC_READ;c->ResourceBarrier(1,&b);check(c->Close());
  ID3D12CommandList* p=c.Get();queue->ExecuteCommandLists(1,&p);wait();return result;
 }
 GPU(){
  if(GetEnvironmentVariableA("DRAW_API_DEBUG",nullptr,0)){ComPtr<ID3D12Debug> debug;check(D3D12GetDebugInterface(IID_PPV_ARGS(&debug)));debug->EnableDebugLayer();}
  ComPtr<IDXGIFactory6> f;check(CreateDXGIFactory2(0,IID_PPV_ARGS(&f)));ComPtr<IDXGIAdapter1>a;check(f->EnumAdapterByGpuPreference(0,DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,IID_PPV_ARGS(&a)));DXGI_ADAPTER_DESC1 ad;check(a->GetDesc1(&ad));for(auto c:ad.Description){if(!c)break;adapterName+=char(c);}require(!(ad.Flags&DXGI_ADAPTER_FLAG_SOFTWARE),"software adapter");check(D3D12CreateDevice(a.Get(),D3D_FEATURE_LEVEL_12_0,IID_PPV_ARGS(&device)));
  if(GetEnvironmentVariableA("DRAW_API_DEBUG",nullptr,0))check(device.As(&info));
  D3D12_COMMAND_QUEUE_DESC qd{};check(device->CreateCommandQueue(&qd,IID_PPV_ARGS(&queue)));check(queue->GetTimestampFrequency(&frequency));check(device->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence)));event=CreateEvent(nullptr,FALSE,FALSE,nullptr);
  D3D12_DESCRIPTOR_RANGE range{};range.RangeType=D3D12_DESCRIPTOR_RANGE_TYPE_CBV;range.NumDescriptors=1;range.BaseShaderRegister=0;
  D3D12_ROOT_PARAMETER p{};p.ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;p.ShaderVisibility=D3D12_SHADER_VISIBILITY_PIXEL;p.DescriptorTable.NumDescriptorRanges=1;p.DescriptorTable.pDescriptorRanges=&range;
  D3D12_ROOT_SIGNATURE_DESC rd{};rd.NumParameters=1;rd.pParameters=&p;rd.Flags=D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
  ComPtr<ID3DBlob> r,e;check(D3D12SerializeRootSignature(&rd,D3D_ROOT_SIGNATURE_VERSION_1,&r,&e));check(device->CreateRootSignature(0,r->GetBufferPointer(),r->GetBufferSize(),IID_PPV_ARGS(&root)));
  auto compile=[&](const char* entry,const char* profile){ComPtr<ID3DBlob>b,err;auto h=D3DCompile(hlsl,strlen(hlsl),nullptr,nullptr,nullptr,entry,profile,D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&b,&err);if(FAILED(h)&&err)std::cerr<<(const char*)err->GetBufferPointer();check(h);return b;};auto vs=compile("vs","vs_5_1");
  D3D12_INPUT_ELEMENT_DESC input{"POSITION",0,DXGI_FORMAT_R32G32_FLOAT,0,0,D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA,0};
  for(unsigned k=0;k<2;k++){auto ps=compile(k?"fs1":"fs0","ps_5_1");D3D12_GRAPHICS_PIPELINE_STATE_DESC d{};d.pRootSignature=root.Get();d.VS={vs->GetBufferPointer(),vs->GetBufferSize()};d.PS={ps->GetBufferPointer(),ps->GetBufferSize()};d.BlendState.RenderTarget[0].RenderTargetWriteMask=D3D12_COLOR_WRITE_ENABLE_ALL;d.SampleMask=UINT_MAX;d.RasterizerState.FillMode=D3D12_FILL_MODE_SOLID;d.RasterizerState.CullMode=D3D12_CULL_MODE_NONE;d.RasterizerState.DepthClipEnable=TRUE;d.InputLayout={&input,1};d.PrimitiveTopologyType=D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;d.NumRenderTargets=1;d.RTVFormats[0]=DXGI_FORMAT_R8G8B8A8_UNORM;d.SampleDesc.Count=1;check(device->CreateGraphicsPipelineState(&d,IID_PPV_ARGS(&pipelines[k])));}
  auto vd=vertexData();auto ix=indexData();auto colors=colorData();vertices=resident(vd.size()*4,vd.data());indices=resident(ix.size()*2,ix.data());uniforms=resident(colors.size()*4,colors.data());
  D3D12_DESCRIPTOR_HEAP_DESC hd{};hd.Type=D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;hd.NumDescriptors=64;hd.Flags=D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;check(device->CreateDescriptorHeap(&hd,IID_PPV_ARGS(&cbvHeap)));auto cpu=cbvHeap->GetCPUDescriptorHandleForHeapStart();auto gpu=cbvHeap->GetGPUDescriptorHandleForHeapStart();auto stride=device->GetDescriptorHandleIncrementSize(hd.Type);
  for(unsigned k=0;k<64;k++){D3D12_CONSTANT_BUFFER_VIEW_DESC cd{uniforms->GetGPUVirtualAddress()+256*k,256};device->CreateConstantBufferView(&cd,cpu);cbv[k]=gpu;cpu.ptr+=stride;gpu.ptr+=stride;vb[k]={vertices->GetGPUVirtualAddress()+256*k,24,8};ib[k]={indices->GetGPUVirtualAddress()+256*k,6,DXGI_FORMAT_R16_UINT};}
  D3D12_HEAP_PROPERTIES hp{};hp.Type=D3D12_HEAP_TYPE_DEFAULT;D3D12_RESOURCE_DESC td{};td.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;td.Width=td.Height=64;td.DepthOrArraySize=td.MipLevels=1;td.Format=DXGI_FORMAT_R8G8B8A8_UNORM;td.SampleDesc.Count=1;td.Flags=D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;D3D12_CLEAR_VALUE cv{};cv.Format=td.Format;check(device->CreateCommittedResource(&hp,D3D12_HEAP_FLAG_NONE,&td,D3D12_RESOURCE_STATE_RENDER_TARGET,&cv,IID_PPV_ARGS(&target)));
  hd={};hd.Type=D3D12_DESCRIPTOR_HEAP_TYPE_RTV;hd.NumDescriptors=1;check(device->CreateDescriptorHeap(&hd,IID_PPV_ARGS(&rtvHeap)));device->CreateRenderTargetView(target.Get(),nullptr,rtvHeap->GetCPUDescriptorHandleForHeapStart());
  D3D12_QUERY_HEAP_DESC qh{};qh.Count=2;qh.Type=D3D12_QUERY_HEAP_TYPE_TIMESTAMP;check(device->CreateQueryHeap(&qh,IID_PPV_ARGS(&queries)));readback=buffer(256,D3D12_HEAP_TYPE_READBACK);pixels=buffer(64*256,D3D12_HEAP_TYPE_READBACK);
  for(unsigned k=0;k<3;k++){check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,IID_PPV_ARGS(&alloc[k])));check(device->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_DIRECT,alloc[k].Get(),nullptr,IID_PPV_ARGS(&lists[k])));check(lists[k]->Close());}
 }
 void bind(ID3D12GraphicsCommandList*l,unsigned k,unsigned pipeline){l->SetPipelineState(pipelines[pipeline].Get());l->SetGraphicsRootDescriptorTable(0,cbv[k]);l->IASetVertexBuffers(0,1,&vb[k]);l->IASetIndexBuffer(&ib[k]);}
 double prepare(unsigned mode,unsigned n){bundle.Reset();bundleAlloc.Reset();if(mode!=2)return 0;auto t=Clock::now();check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_BUNDLE,IID_PPV_ARGS(&bundleAlloc)));check(device->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_BUNDLE,bundleAlloc.Get(),pipelines[0].Get(),IID_PPV_ARGS(&bundle)));auto heap=cbvHeap.Get();bundle->SetDescriptorHeaps(1,&heap);bundle->SetGraphicsRootSignature(root.Get());bundle->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);bind(bundle.Get(),0,0);for(unsigned j=0;j<n;j++){bind(bundle.Get(),j%64,j&1);bundle->DrawIndexedInstanced(3,1,0,0,0);}check(bundle->Close());return elapsed(t);}
 double begin(unsigned s,bool timing){slot=s;timed=timing;check(alloc[s]->Reset());check(lists[s]->Reset(alloc[s].Get(),nullptr));list=lists[s].Get();if(timed)list->EndQuery(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,0);auto h=rtvHeap->GetCPUDescriptorHandleForHeapStart();float clear[4]={};list->ClearRenderTargetView(h,clear,0,nullptr);list->OMSetRenderTargets(1,&h,FALSE,nullptr);D3D12_VIEWPORT v{0,0,64,64,0,1};D3D12_RECT scissor{0,0,1,1};list->RSSetViewports(1,&v);list->RSSetScissorRects(1,&scissor);auto heap=cbvHeap.Get();list->SetDescriptorHeaps(1,&heap);list->SetGraphicsRootSignature(root.Get());list->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);bind(list,0,0);return 0;}
 void emit(unsigned mode,unsigned n){if(mode==2){list->ExecuteBundle(bundle.Get());return;}if(mode==3){list->DrawIndexedInstanced(3,n,0,0,0);return;}if(mode==0){for(unsigned j=0;j<n;j++)list->DrawIndexedInstanced(3,1,0,0,0);return;}for(unsigned j=0;j<n;j++){bind(list,j%64,j&1);list->DrawIndexedInstanced(3,1,0,0,0);}}
 void end(){if(timed){list->EndQuery(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,1);list->ResolveQueryData(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,0,2,readback.Get(),0);}check(list->Close());}
 void submit(){ID3D12CommandList*p=list;queue->ExecuteCommandLists(1,&p);}
 void wait(){check(queue->Signal(fence.Get(),++value));if(fence->GetCompletedValue()<value){check(fence->SetEventOnCompletion(value,event));require(WaitForSingleObject(event,120000)==WAIT_OBJECT_0,"GPU fence timeout");}checkErrors();}
 double gpuMilliseconds(){void*p;D3D12_RANGE range{0,16};check(readback->Map(0,&range,&p));auto q=(uint64_t*)p;double v=double(q[1]-q[0])*1000/frequency;readback->Unmap(0,nullptr);return v;}
 void verify(unsigned mode,unsigned n){begin(0,false);D3D12_RESOURCE_BARRIER b{};b.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;b.Transition={target.Get(),D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,D3D12_RESOURCE_STATE_RENDER_TARGET,D3D12_RESOURCE_STATE_COPY_SOURCE};
  // begin() cleared the target: execute the case again before checking it.
  emit(mode,n);list->ResourceBarrier(1,&b);D3D12_TEXTURE_COPY_LOCATION src{};src.pResource=target.Get();src.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;D3D12_TEXTURE_COPY_LOCATION dst{};dst.pResource=pixels.Get();dst.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;dst.PlacedFootprint.Footprint={DXGI_FORMAT_R8G8B8A8_UNORM,64,64,1,256};list->CopyTextureRegion(&dst,0,0,0,&src,nullptr);std::swap(b.Transition.StateBefore,b.Transition.StateAfter);list->ResourceBarrier(1,&b);end();submit();wait();void*p;D3D12_RANGE range{0,64*256};check(pixels->Map(0,&range,&p));verifyPixel((uint8_t*)p,mode,n);require(((uint8_t*)p)[4]==0&&((uint8_t*)p)[7]==0,"outside-scissor pixel modified");pixels->Unmap(0,nullptr);}
 void checkErrors(){check(device->GetDeviceRemovedReason());if(info){bool bad=false;auto count=info->GetNumStoredMessagesAllowedByRetrievalFilter();for(UINT64 i=0;i<count;i++){SIZE_T bytes=0;check(info->GetMessage(i,nullptr,&bytes));std::vector<uint8_t> data(bytes);auto m=(D3D12_MESSAGE*)data.data();check(info->GetMessage(i,m,&bytes));if(m->Severity<=D3D12_MESSAGE_SEVERITY_WARNING)std::cerr<<m->pDescription<<'\n';if(m->Severity<=D3D12_MESSAGE_SEVERITY_ERROR)bad=true;}info->ClearStoredMessages();require(!bad,"D3D12 validation error");}}
 ~GPU(){CloseHandle(event);}
};
int main(int argc,char**argv){try{require(argc==2,"pass output JSON path");GPU g;std::ofstream(argv[1])<<benchmark(g);return 0;}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
