#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
using Microsoft::WRL::ComPtr;
using Clock=std::chrono::steady_clock;
static void Check(HRESULT hr) {if(FAILED(hr))throw std::runtime_error("HRESULT "+std::to_string(unsigned(hr)));}
struct NativePSO {
    D3D12_GRAPHICS_PIPELINE_STATE_DESC desc{};
    std::vector<D3D12_INPUT_ELEMENT_DESC> inputs;
    NativePSO() {
        desc.RasterizerState.FillMode=D3D12_FILL_MODE_SOLID;desc.RasterizerState.DepthClipEnable=TRUE;
        desc.PrimitiveTopologyType=D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
        for(auto& r:desc.BlendState.RenderTarget) {
            r.SrcBlend=r.SrcBlendAlpha=D3D12_BLEND_ONE;r.DestBlend=r.DestBlendAlpha=D3D12_BLEND_ZERO;
            r.BlendOp=r.BlendOpAlpha=D3D12_BLEND_OP_ADD;r.LogicOp=D3D12_LOGIC_OP_NOOP;
        }
        desc.DepthStencilState.DepthFunc=D3D12_COMPARISON_FUNC_ALWAYS;
        for(auto* f:{&desc.DepthStencilState.FrontFace,&desc.DepthStencilState.BackFace}) {
            f->StencilFunc=D3D12_COMPARISON_FUNC_ALWAYS;
            f->StencilFailOp=f->StencilDepthFailOp=f->StencilPassOp=D3D12_STENCIL_OP_KEEP;
        }
    }
};
#include "same-shader-native-descriptors.h"
int wmain(int argc,wchar_t** argv) try {
    if(argc!=4)return 2; // DXIL directory, output JSON, rounds
    ComPtr<IDXGIFactory6> factory;Check(CreateDXGIFactory2(0,IID_PPV_ARGS(&factory)));
    ComPtr<IDXGIAdapter1> adapter;Check(factory->EnumAdapterByGpuPreference(0,DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,IID_PPV_ARGS(&adapter)));
    DXGI_ADAPTER_DESC1 info{};Check(adapter->GetDesc1(&info));
    if(info.Flags&DXGI_ADAPTER_FLAG_SOFTWARE)return 3;
    ComPtr<ID3D12Device> device;Check(D3D12CreateDevice(adapter.Get(),D3D_FEATURE_LEVEL_12_0,IID_PPV_ARGS(&device)));
    // A compatible diagnostic root signature. It is intentionally reported as a baseline,
    // not an exact reconstruction of Dawn's dynamic/root bindings or UE's native layout.
    std::vector<D3D12_DESCRIPTOR_RANGE> resources,samplers;
    for(UINT space=0;space<=8;space++)for(auto type:{D3D12_DESCRIPTOR_RANGE_TYPE_CBV,D3D12_DESCRIPTOR_RANGE_TYPE_SRV,D3D12_DESCRIPTOR_RANGE_TYPE_UAV,D3D12_DESCRIPTOR_RANGE_TYPE_SAMPLER}) {
        D3D12_DESCRIPTOR_RANGE r{type,64,0,space,D3D12_DESCRIPTOR_RANGE_OFFSET_APPEND};
        (type==D3D12_DESCRIPTOR_RANGE_TYPE_SAMPLER?samplers:resources).push_back(r);
    }
    D3D12_ROOT_PARAMETER parameters[2]{};
    for(UINT i=0;i<2;i++){
        auto& p=parameters[i];auto& ranges=i?samplers:resources;
        p.ParameterType=D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;p.ShaderVisibility=D3D12_SHADER_VISIBILITY_ALL;
        p.DescriptorTable={UINT(ranges.size()),ranges.data()};
    }
    D3D12_ROOT_SIGNATURE_DESC signature{2,parameters,0,nullptr,D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT};
    ComPtr<ID3DBlob> blob,error;Check(D3D12SerializeRootSignature(&signature,D3D_ROOT_SIGNATURE_VERSION_1,&blob,&error));
    ComPtr<ID3D12RootSignature> root;Check(device->CreateRootSignature(0,blob->GetBufferPointer(),blob->GetBufferSize(),IID_PPV_ARGS(&root)));
    auto descriptors=Descriptors();std::vector<std::vector<char>> shaders;
    for(size_t i=0;i<descriptors.size()*2;i++){
        std::ifstream input(std::filesystem::path(argv[1])/(std::to_string(i)+".dxil"),std::ios::binary);
        shaders.push_back({std::istreambuf_iterator<char>(input),{}});if(shaders.back().empty())return 4;
    }
    for(size_t i=0;i<descriptors.size();i++){
        auto& n=descriptors[i];n.desc.pRootSignature=root.Get();n.desc.InputLayout={n.inputs.data(),UINT(n.inputs.size())};
        n.desc.VS={shaders[2*i].data(),shaders[2*i].size()};n.desc.PS={shaders[2*i+1].data(),shaders[2*i+1].size()};
    }
    std::ofstream output(argv[2]);output<<"{\"vendorId\":"<<info.VendorId<<",\"deviceId\":"<<info.DeviceId<<",\"rounds\":[";
    for(int round=0;round<_wtoi(argv[3]);round++){
        std::vector<ComPtr<ID3D12PipelineState>> kept(descriptors.size());std::vector<double> times;
        for(size_t i=0;i<descriptors.size();i++){
            const auto start=Clock::now();Check(device->CreateGraphicsPipelineState(&descriptors[i].desc,IID_PPV_ARGS(&kept[i])));
            times.push_back(std::chrono::duration<double,std::milli>(Clock::now()-start).count());
        }
        if(round)output<<',';output<<'[';
        for(size_t i=0;i<times.size();i++){if(i)output<<',';output<<times[i];}output<<']';
    }
    output<<"],\"success\":true}\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 5;}
