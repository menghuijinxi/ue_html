#define main OriginalDrawMain
#include "draw-api-d3d12.cpp"
#undef main
#include "rhi-isolation-common.h"
struct IsolationGPU:GPU {
 void verify(unsigned mode,unsigned n){verifyParallelPixel(mode,n);}
 void emitPacketsState(const std::vector<Isolation::Packet>&packets,bool cached){unsigned resource=~0u,pipeline=~0u;for(const auto&p:packets){if(!cached||pipeline!=p.pipeline){list->SetPipelineState(pipelines[p.pipeline].Get());pipeline=p.pipeline;}if(!cached||resource!=p.resource){list->SetGraphicsRootDescriptorTable(0,cbv[p.resource]);list->IASetVertexBuffers(0,1,&vb[p.resource]);list->IASetIndexBuffer(&ib[p.resource]);resource=p.resource;}list->DrawIndexedInstanced(3,1,0,0,0);}}
 void emitPackets(const std::vector<Isolation::Packet>&packets){for(const auto&p:packets){bind(list,p.resource,p.pipeline);list->DrawIndexedInstanced(3,1,0,0,0);}}
 std::string creation(){std::ostringstream out;out<<'[';bool first=true;for(unsigned n:{1u,8u,24u}){
  D3D12_DESCRIPTOR_HEAP_DESC desc{};desc.Type=D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;desc.NumDescriptors=80*n;desc.Flags=D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;ComPtr<ID3D12DescriptorHeap> heap;check(device->CreateDescriptorHeap(&desc,IID_PPV_ARGS(&heap)));auto stride=device->GetDescriptorHandleIncrementSize(desc.Type);std::vector<double> times;
  desc.NumDescriptors=n;desc.Flags=D3D12_DESCRIPTOR_HEAP_FLAG_NONE;ComPtr<ID3D12DescriptorHeap> source;check(device->CreateDescriptorHeap(&desc,IID_PPV_ARGS(&source)));auto original=source->GetCPUDescriptorHandleForHeapStart();for(unsigned i=0;i<n;i++){D3D12_CONSTANT_BUFFER_VIEW_DESC cb{uniforms->GetGPUVirtualAddress()+i*256,256};device->CreateConstantBufferView(&cb,original);original.ptr+=stride;}
  for(unsigned frame=0;frame<46;frame++){auto dest=heap->GetCPUDescriptorHandleForHeapStart(),src=source->GetCPUDescriptorHandleForHeapStart();auto t=Clock::now();for(unsigned group=0;group<80;group++){device->CopyDescriptorsSimple(n,dest,src,desc.Type);dest.ptr+=n*stride;}if(frame>=10)times.push_back(elapsed(t));}
  if(!first)out<<',';first=false;out<<"{\"entries\":"<<n<<",\"groups\":80,\"copyIntoPreallocatedHeap\":";stats(out,times);out<<'}';
 }out<<']';return out.str();}
 std::string parallelRecording(){
  std::array<ComPtr<ID3D12CommandAllocator>,4> allocators;std::array<ComPtr<ID3D12GraphicsCommandList>,4> commands;
  for(unsigned i=0;i<4;i++){check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,IID_PPV_ARGS(&allocators[i])));check(device->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_DIRECT,allocators[i].Get(),nullptr,IID_PPV_ARGS(&commands[i])));check(commands[i]->Close());}
  auto record=[&](unsigned i){check(allocators[i]->Reset());auto*c=commands[i].Get();check(c->Reset(allocators[i].Get(),nullptr));auto h=rtvHeap->GetCPUDescriptorHandleForHeapStart();c->OMSetRenderTargets(1,&h,FALSE,nullptr);D3D12_VIEWPORT v{0,0,64,64,0,1};D3D12_RECT scissor{0,0,1,1};c->RSSetViewports(1,&v);c->RSSetScissorRects(1,&scissor);auto heap=cbvHeap.Get();c->SetDescriptorHeaps(1,&heap);c->SetGraphicsRootSignature(root.Get());c->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);for(unsigned j=Isolation::Draws*i/4;j<Isolation::Draws*(i+1)/4;j++){bind(c,j%64,j&1);c->DrawIndexedInstanced(3,1,0,0,0);}check(c->Close());};
  std::ostringstream out;out<<'[';bool first=true;for(unsigned n:{1u,2u,4u}){Isolation::Pool pool(n);std::vector<double> times,wall;
   for(unsigned frame=0;frame<72;frame++){auto start=Clock::now();begin(0,false);end();submit();auto t=Clock::now();pool.run([&](unsigned worker){for(unsigned i=worker;i<4;i+=n)record(i);});double ms=elapsed(t);ID3D12CommandList*lists[4];for(unsigned i=0;i<4;i++)lists[i]=commands[i].Get();queue->ExecuteCommandLists(4,lists);wait();if(frame>=12){times.push_back(ms);wall.push_back(elapsed(start));}}
   // Read the just-recorded workload. verify() re-emits the same sequence;
   // the separate direct readback below checks the parallel lists themselves.
   verifyParallelPixel();if(!first)out<<',';first=false;out<<"{\"workers\":"<<n<<",\"commandLists\":4,\"draws\":"<<Isolation::Draws<<",\"record\":";stats(out,times);out<<",\"wall\":";stats(out,wall);out<<",\"pixelVerified\":true}";
  }out<<']';return out.str();
 }
 void verifyParallelPixel(unsigned mode=1,unsigned n=Isolation::Draws){
  // Do not call begin(): it would clear the image we need to inspect.
  check(alloc[0]->Reset());check(lists[0]->Reset(alloc[0].Get(),nullptr));list=lists[0].Get();timed=false;
  D3D12_RESOURCE_BARRIER b{};b.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;b.Transition={target.Get(),D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,D3D12_RESOURCE_STATE_RENDER_TARGET,D3D12_RESOURCE_STATE_COPY_SOURCE};list->ResourceBarrier(1,&b);D3D12_TEXTURE_COPY_LOCATION src{};src.pResource=target.Get();src.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;D3D12_TEXTURE_COPY_LOCATION dst{};dst.pResource=pixels.Get();dst.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;dst.PlacedFootprint.Footprint={DXGI_FORMAT_R8G8B8A8_UNORM,64,64,1,256};list->CopyTextureRegion(&dst,0,0,0,&src,nullptr);std::swap(b.Transition.StateBefore,b.Transition.StateAfter);list->ResourceBarrier(1,&b);end();submit();wait();void*p;D3D12_RANGE range{0,64*256};check(pixels->Map(0,&range,&p));verifyPixel((uint8_t*)p,mode,n);require(((uint8_t*)p)[4]==0&&((uint8_t*)p)[7]==0,"parallel outside-scissor pixel");pixels->Unmap(0,nullptr);
 }
};
int main(int argc,char**argv){try{require(argc==2,"output path");IsolationGPU gpu;const auto cpu=Isolation::cpuTests(),render=Isolation::gpuTests(gpu),state=Isolation::stateTests(gpu),parallel=gpu.parallelRecording(),creation=gpu.creation();std::ofstream(argv[1])<<"{\"pass\":true,\"backend\":\"native-d3d12\",\"cpu\":"<<cpu<<",\"render\":"<<render<<",\"stateTracking\":"<<state<<",\"parallelRecording\":"<<parallel<<",\"descriptorCreation\":"<<creation<<'}';return 0;}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
