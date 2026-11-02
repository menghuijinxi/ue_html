// Standalone D3D12 counterpart of benchmark-pso-apis.cjs. No UE dependency.
#include <algorithm>
#include <chrono>
#include <d3d12.h>
#include <dxcapi.h>
#include <dxgi1_6.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <numeric>
#include <sstream>
#include <string>
#include <vector>
#include <windows.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
namespace fs = std::filesystem;
double ms(Clock::time_point t) {
  return std::chrono::duration<double, std::milli>(Clock::now() - t).count();
}
void check(HRESULT h) {
  if (FAILED(h)) {
    std::ostringstream o;
    o << "HRESULT 0x" << std::hex << unsigned(h);
    throw std::runtime_error(o.str());
  }
}
std::vector<char> read(const fs::path &p) {
  std::ifstream f(p, std::ios::binary);
  return {std::istreambuf_iterator<char>(f), {}};
}
void write(const fs::path &p, const void *b, size_t n) {
  std::ofstream f(p, std::ios::binary);
  f.write((const char *)b, n);
  if (!f)
    throw std::runtime_error("write failed");
}
constexpr unsigned N = 64, ITER = 64, DRAWS = 1000, FRAMES = 80;
unsigned hash(unsigned v) {
  for (unsigned i = 0; i < ITER; i++)
    v = v * 1664525u + 1013904223u;
  return v;
}
std::string shader(unsigned seed, bool compute) {
  std::ostringstream s;
  s << "uint calc(uint v){[loop] for(uint "
       "i=0;i<64;i++)v=v*1664525u+1013904223u;return v;}\n";
  if (compute)
    s << "RWStructuredBuffer<uint> output:register(u0);[numthreads(64,1,1)] "
         "void main(uint3 id:SV_DispatchThreadID){output[id.x]=calc(id.x+"
      << seed << "u);}";
  else
    s << "float4 main(float4 p:SV_Position):SV_Target{uint "
         "v=calc(uint(p.x)+uint(p.y)*16u+"
      << seed
      << "u);return float4(v&255u,(v>>8)&255u,(v>>16)&255u,255u)/255.0;}";
  return s.str();
}
const char *vs =
    "float4 main(uint id:SV_VertexID):SV_Position{float2 "
    "p[3]={float2(-1,-1),float2(3,-1),float2(-1,3)};return float4(p[id],0,1);}";
void compile(const fs::path &dir) {
  ComPtr<IDxcCompiler3> c;
  check(DxcCreateInstance(CLSID_DxcCompiler, IID_PPV_ARGS(&c)));
  auto one = [&](std::string code, const wchar_t *target,
                 const fs::path &file) {
    DxcBuffer b{code.data(), code.size(), DXC_CP_UTF8};
    const wchar_t *args[] = {L"-E",  L"main", L"-T",  target,
                             L"-O3", L"-HV",  L"2021"};
    ComPtr<IDxcResult> r;
    check(c->Compile(&b, args, UINT32(std::size(args)), nullptr,
                     IID_PPV_ARGS(&r)));
    HRESULT h;
    check(r->GetStatus(&h));
    if (FAILED(h)) {
      ComPtr<IDxcBlobUtf8> e;
      r->GetOutput(DXC_OUT_ERRORS, IID_PPV_ARGS(&e), nullptr);
      throw std::runtime_error(e ? e->GetStringPointer()
                                 : "shader compilation failed");
    }
    ComPtr<IDxcBlob> o;
    check(r->GetOutput(DXC_OUT_OBJECT, IID_PPV_ARGS(&o), nullptr));
    write(file, o->GetBufferPointer(), o->GetBufferSize());
  };
  one(vs, L"vs_6_0", dir / "vs.dxil");
  for (unsigned i = 0; i < N; i++) {
    one(shader(700001 + i, false), L"ps_6_0",
        dir / ("ps" + std::to_string(i) + ".dxil"));
    one(shader(700001 + i, true), L"cs_6_0",
        dir / ("cs" + std::to_string(i) + ".dxil"));
  }
}
struct Summary {
  std::vector<double> values;
  void add(double n) { values.push_back(n); }
  void json(std::ostream &o) {
    auto a = values;
    std::sort(a.begin(), a.end());
    o << "{\"count\":" << a.size()
      << ",\"sumMs\":" << std::accumulate(a.begin(), a.end(), 0.)
      << ",\"medianMs\":" << a[a.size() / 2]
      << ",\"p95Ms\":" << a[size_t(a.size() * .95)] << ",\"maxMs\":" << a.back()
      << "}";
  }
};
struct GPU {
  ComPtr<ID3D12Device1> d;
  ComPtr<ID3D12CommandQueue> q;
  ComPtr<ID3D12CommandAllocator> a;
  ComPtr<ID3D12GraphicsCommandList> l;
  ComPtr<ID3D12Fence> f;
  ComPtr<ID3D12RootSignature> gr, cr;
  ComPtr<ID3D12Resource> rt, out, readback;
  ComPtr<ID3D12DescriptorHeap> heap;
  HANDLE event;
  UINT64 fence = 0;
  std::string adapter;
  GPU() {
    ComPtr<IDXGIFactory6> factory;
    check(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)));
    ComPtr<IDXGIAdapter1> ad;
    check(factory->EnumAdapterByGpuPreference(
        0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(&ad)));
    DXGI_ADAPTER_DESC1 desc;
    ad->GetDesc1(&desc);
    for (auto c : desc.Description) {
      if (!c)
        break;
      adapter += char(c);
    }
    check(
        D3D12CreateDevice(ad.Get(), D3D_FEATURE_LEVEL_12_0, IID_PPV_ARGS(&d)));
    D3D12_COMMAND_QUEUE_DESC qd{};
    check(d->CreateCommandQueue(&qd, IID_PPV_ARGS(&q)));
    check(d->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                                    IID_PPV_ARGS(&a)));
    check(d->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, a.Get(),
                               nullptr, IID_PPV_ARGS(&l)));
    check(l->Close());
    check(d->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&f)));
    event = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    auto root = [&](bool compute, ComPtr<ID3D12RootSignature> &r) {
      D3D12_ROOT_PARAMETER p{};
      p.ParameterType = D3D12_ROOT_PARAMETER_TYPE_UAV;
      p.ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
      D3D12_ROOT_SIGNATURE_DESC rd{};
      rd.NumParameters = compute ? 1 : 0;
      rd.pParameters = compute ? &p : nullptr;
      rd.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
      ComPtr<ID3DBlob> b, e;
      check(D3D12SerializeRootSignature(&rd, D3D_ROOT_SIGNATURE_VERSION_1, &b,
                                        &e));
      check(d->CreateRootSignature(0, b->GetBufferPointer(), b->GetBufferSize(),
                                   IID_PPV_ARGS(&r)));
    };
    root(false, gr);
    root(true, cr);
    D3D12_HEAP_PROPERTIES hp{};
    hp.Type = D3D12_HEAP_TYPE_DEFAULT;
    D3D12_RESOURCE_DESC rd{};
    rd.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    rd.Width = rd.Height = 16;
    rd.DepthOrArraySize = rd.MipLevels = 1;
    rd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    rd.SampleDesc.Count = 1;
    rd.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;
    check(d->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd,
                                     D3D12_RESOURCE_STATE_RENDER_TARGET,
                                     nullptr, IID_PPV_ARGS(&rt)));
    rd = {};
    rd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    rd.Width = 256;
    rd.Height = rd.DepthOrArraySize = rd.MipLevels = rd.SampleDesc.Count = 1;
    rd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    rd.Flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
    check(d->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd,
                                     D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                                     nullptr, IID_PPV_ARGS(&out)));
    hp.Type = D3D12_HEAP_TYPE_READBACK;
    rd.Width = 65536;
    rd.Flags = D3D12_RESOURCE_FLAG_NONE;
    check(d->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd,
                                     D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                     IID_PPV_ARGS(&readback)));
    D3D12_DESCRIPTOR_HEAP_DESC hd{};
    hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    hd.NumDescriptors = 1;
    check(d->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&heap)));
    d->CreateRenderTargetView(rt.Get(), nullptr,
                              heap->GetCPUDescriptorHandleForHeapStart());
  }
  ~GPU() { CloseHandle(event); }
  void begin() {
    check(a->Reset());
    check(l->Reset(a.Get(), nullptr));
  }
  double submit() {
    auto t = Clock::now();
    check(l->Close());
    ID3D12CommandList *lists[] = {l.Get()};
    q->ExecuteCommandLists(1, lists);
    check(q->Signal(f.Get(), ++fence));
    if (f->GetCompletedValue() < fence) {
      check(f->SetEventOnCompletion(fence, event));
      if (WaitForSingleObject(event, 30000) != WAIT_OBJECT_0)
        throw std::runtime_error("GPU fence timed out");
    }
    return ms(t);
  }
  void setup(bool compute) {
    if (compute) {
      l->SetComputeRootSignature(cr.Get());
      l->SetComputeRootUnorderedAccessView(0, out->GetGPUVirtualAddress());
    } else {
      l->SetGraphicsRootSignature(gr.Get());
      auto h = heap->GetCPUDescriptorHandleForHeapStart();
      l->OMSetRenderTargets(1, &h, FALSE, nullptr);
      D3D12_VIEWPORT v{0, 0, 16, 16, 0, 1};
      D3D12_RECT s{0, 0, 1, 1};
      l->RSSetViewports(1, &v);
      l->RSSetScissorRects(1, &s);
      l->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    }
  }
  void work(bool compute) {
    if (compute) {
      l->Dispatch(1, 1, 1);
      D3D12_RESOURCE_BARRIER b{};
      b.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
      b.UAV.pResource = out.Get();
      l->ResourceBarrier(1, &b);
    } else
      l->DrawInstanced(3, 1, 0, 0);
  }
  void verify() {
    begin();
    auto transition = [&](ID3D12Resource *r, D3D12_RESOURCE_STATES from) {
      D3D12_RESOURCE_BARRIER b{};
      b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
      b.Transition = {r, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES, from,
                      D3D12_RESOURCE_STATE_COPY_SOURCE};
      l->ResourceBarrier(1, &b);
    };
    transition(out.Get(), D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    transition(rt.Get(), D3D12_RESOURCE_STATE_RENDER_TARGET);
    l->CopyBufferRegion(readback.Get(), 0, out.Get(), 0, 256);
    D3D12_TEXTURE_COPY_LOCATION src{}, dst{};
    src.pResource = rt.Get();
    src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    dst.pResource = readback.Get();
    dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    dst.PlacedFootprint.Offset = 512;
    dst.PlacedFootprint.Footprint = {DXGI_FORMAT_R8G8B8A8_UNORM, 16, 16, 1,
                                     256};
    l->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    submit();
    void *p;
    check(readback->Map(0, nullptr, &p));
    for (unsigned i = 0; i < 64; i++)
      if (((unsigned *)p)[i] != hash(i + 700001 + (DRAWS - 1) % N))
        throw std::runtime_error("compute output mismatch");
    unsigned v = hash(700001 + (DRAWS - 1) % N);
    auto bytes = (unsigned char *)p + 512;
    for (unsigned i = 0; i < 3; i++)
      if (bytes[i] != ((v >> (i * 8)) & 255))
        throw std::runtime_error("render output mismatch");
    readback->Unmap(0, nullptr);
  }
};
int main(int argc, char **argv) {
  try {
    if (argc < 4)
      throw std::runtime_error("usage: pso-api-benchmark prepare|run DIR "
                               "REPORT [library|implicit|blob]");
    fs::path dir = argv[2];
    fs::create_directories(dir);
    if (std::string(argv[1]) == "prepare") {
      compile(dir);
      std::cout << "DXIL prepared outside measured startup\n";
      return 0;
    }
    bool library = argc > 4 && std::string(argv[4]) == "library";
    bool cachedBlob = argc > 4 && std::string(argv[4]) == "blob";
    unsigned blobsProvided = 0, blobsSucceeded = 0;
    GPU g;
    auto v = read(dir / "vs.dxil");
    std::vector<std::vector<char>> ps(N), cs(N);
    for (unsigned i = 0; i < N; i++) {
      ps[i] = read(dir / ("ps" + std::to_string(i) + ".dxil"));
      cs[i] = read(dir / ("cs" + std::to_string(i) + ".dxil"));
      if (ps[i].empty() || cs[i].empty())
        throw std::runtime_error("prepare DXIL first");
    }
    auto cacheReadAt = Clock::now();
    auto blob = library ? read(dir / "pipeline-library.bin") : std::vector<char>{};
    double cacheReadMs = ms(cacheReadAt);
    ComPtr<ID3D12PipelineLibrary> lib;
    auto t = Clock::now();
    if (library)
      check(g.d->CreatePipelineLibrary(blob.empty() ? nullptr : blob.data(),
                                       blob.size(), IID_PPV_ARGS(&lib)));
    double libraryInit = ms(t);
    unsigned hits = 0, misses = 0;
    Summary create;
    std::vector<ComPtr<ID3D12PipelineState>> gp(N), cp(N);
    t = Clock::now();
    for (unsigned i = 0; i < N; i++) {
      D3D12_GRAPHICS_PIPELINE_STATE_DESC p{};
      p.pRootSignature = g.gr.Get();
      p.VS = {v.data(), v.size()};
      p.PS = {ps[i].data(), ps[i].size()};
      p.BlendState.RenderTarget[0].RenderTargetWriteMask =
          D3D12_COLOR_WRITE_ENABLE_ALL;
      p.BlendState.RenderTarget[0].SrcBlend =
          p.BlendState.RenderTarget[0].SrcBlendAlpha = D3D12_BLEND_ONE;
      p.BlendState.RenderTarget[0].DestBlend =
          p.BlendState.RenderTarget[0].DestBlendAlpha = D3D12_BLEND_ZERO;
      p.BlendState.RenderTarget[0].BlendOp =
          p.BlendState.RenderTarget[0].BlendOpAlpha = D3D12_BLEND_OP_ADD;
      p.SampleMask = UINT_MAX;
      p.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
      p.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
      p.RasterizerState.DepthClipEnable = TRUE;
      p.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ZERO;
      p.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_ALWAYS;
      p.DepthStencilState.FrontFace.StencilFunc =
          p.DepthStencilState.BackFace.StencilFunc =
              D3D12_COMPARISON_FUNC_ALWAYS;
      p.DepthStencilState.FrontFace.StencilFailOp =
          p.DepthStencilState.BackFace.StencilFailOp =
              p.DepthStencilState.FrontFace.StencilDepthFailOp =
                  p.DepthStencilState.BackFace.StencilDepthFailOp =
                      p.DepthStencilState.FrontFace.StencilPassOp =
                          p.DepthStencilState.BackFace.StencilPassOp =
                              D3D12_STENCIL_OP_KEEP;
      p.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
      p.NumRenderTargets = 1;
      p.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
      p.SampleDesc.Count = 1;
      auto name = L"g" + std::to_wstring(i);
      auto at = Clock::now();
      auto graphicsBlobFile = dir / ("g" + std::to_string(i) + ".pso");
      auto graphicsBlob = cachedBlob ? read(graphicsBlobFile) : std::vector<char>{};
      if (!graphicsBlob.empty()) {
        p.CachedPSO = {graphicsBlob.data(), graphicsBlob.size()};
        ++blobsProvided;
      }
      HRESULT hr = lib ? lib->LoadGraphicsPipeline(name.c_str(), &p,
                                                   IID_PPV_ARGS(&gp[i]))
                       : E_INVALIDARG;
      if (SUCCEEDED(hr))
        hits++;
      else {
        if (lib && hr != E_INVALIDARG)
          check(hr);
        misses++;
        check(g.d->CreateGraphicsPipelineState(&p, IID_PPV_ARGS(&gp[i])));
        if (!graphicsBlob.empty()) ++blobsSucceeded;
        if (cachedBlob && graphicsBlob.empty()) {
          ComPtr<ID3DBlob> saved;
          check(gp[i]->GetCachedBlob(&saved));
          write(graphicsBlobFile, saved->GetBufferPointer(), saved->GetBufferSize());
        }
        if (lib)
          check(lib->StorePipeline(name.c_str(), gp[i].Get()));
      }
      create.add(ms(at));
      D3D12_COMPUTE_PIPELINE_STATE_DESC c{};
      c.pRootSignature = g.cr.Get();
      c.CS = {cs[i].data(), cs[i].size()};
      name = L"c" + std::to_wstring(i);
      at = Clock::now();
      auto computeBlobFile = dir / ("c" + std::to_string(i) + ".pso");
      auto computeBlob = cachedBlob ? read(computeBlobFile) : std::vector<char>{};
      if (!computeBlob.empty()) {
        c.CachedPSO = {computeBlob.data(), computeBlob.size()};
        ++blobsProvided;
      }
      hr =
          lib ? lib->LoadComputePipeline(name.c_str(), &c, IID_PPV_ARGS(&cp[i]))
              : E_INVALIDARG;
      if (SUCCEEDED(hr))
        hits++;
      else {
        if (lib && hr != E_INVALIDARG)
          check(hr);
        misses++;
        check(g.d->CreateComputePipelineState(&c, IID_PPV_ARGS(&cp[i])));
        if (!computeBlob.empty()) ++blobsSucceeded;
        if (cachedBlob && computeBlob.empty()) {
          ComPtr<ID3DBlob> saved;
          check(cp[i]->GetCachedBlob(&saved));
          write(computeBlobFile, saved->GetBufferPointer(), saved->GetBufferSize());
        }
        if (lib)
          check(lib->StorePipeline(name.c_str(), cp[i].Get()));
      }
      create.add(ms(at));
    }
    double createWall = ms(t);
    if (lib) {
      std::vector<char> b(lib->GetSerializedSize());
      check(lib->Serialize(b.data(), b.size()));
      write(dir / "pipeline-library.bin", b.data(), b.size());
    }
    // Warm actual execution of every pipeline before measuring normal use.
    g.begin();
    g.setup(false);
    for (auto &p : gp) {
      g.l->SetPipelineState(p.Get());
      g.work(false);
    }
    g.setup(true);
    for (auto &p : cp) {
      g.l->SetPipelineState(p.Get());
      g.work(true);
    }
    g.submit();
    std::ofstream report(argv[3]);
    report.precision(9);
    report << "{\"backend\":\"D3D12\",\"adapter\":\"" << g.adapter
           << "\",\"pipelines\":" << 2 * N
           << ",\"library\":" << (library ? "true" : "false")
           << ",\"libraryInputBytes\":" << blob.size()
           << ",\"libraryInitMs\":" << libraryInit
           << ",\"libraryReadMs\":" << cacheReadMs
           << ",\"cachedBlobMode\":" << (cachedBlob ? "true" : "false")
           << ",\"cachedBlobsProvided\":" << blobsProvided
           << ",\"cachedBlobsSucceeded\":" << blobsSucceeded
           << ",\"libraryHits\":" << hits << ",\"created\":" << misses
           << ",\"creationWallMs\":" << createWall << ",\"creationCalls\":";
    create.json(report);
    report << ",\"runtime\":[";
    bool comma = false;
    for (bool compute : {false, true})
      for (unsigned mode = 0; mode < 3; mode++) {
        Summary binds, encode, completion;
        auto &pipelines = compute ? cp : gp;
        for (unsigned frame = 0; frame < FRAMES + 10; frame++) {
          g.begin();
          g.setup(compute);
          auto start = Clock::now();
          g.l->SetPipelineState(pipelines[0].Get());
          for (unsigned j = 0; j < DRAWS; j++) {
            if (mode)
              g.l->SetPipelineState(pipelines[mode == 2 ? j % N : 0].Get());
            g.work(compute);
          }
          double encoded = ms(start);
          double finished = g.submit();
          g.begin();
          g.setup(compute);
          start = Clock::now();
          for (unsigned j = 0; j < 10000; j++)
            g.l->SetPipelineState(pipelines[mode == 2 ? j % N : 0].Get());
          double binding = ms(start);
          g.submit();
          if (frame >= 10) {
            encode.add(encoded);
            completion.add(finished);
            binds.add(binding);
          }
        }
        if (comma)
          report << ",";
        comma = true;
        report << "{\"kind\":\"" << (compute ? "compute" : "graphics")
               << "\",\"mode\":" << mode << ",\"operationsPerFrame\":" << DRAWS
               << ",\"bindOnlyOperations\":10000,\"bindOnly\":";
        binds.json(report);
        report << ",\"encode\":";
        encode.json(report);
        report << ",\"closeSubmitFence\":";
        completion.json(report);
        report << "}";
      }
    // Verification uses the final switching mode and matches WGSL integer
    // arithmetic.
    g.begin();
    g.setup(false);
    for (unsigned j = 0; j < DRAWS; j++) {
      g.l->SetPipelineState(gp[j % N].Get());
      g.work(false);
    }
    g.setup(true);
    for (unsigned j = 0; j < DRAWS; j++) {
      g.l->SetPipelineState(cp[j % N].Get());
      g.work(true);
    }
    g.submit();
    g.verify();
    report << "],\"outputVerified\":true,\"pass\":true}\n";
    std::cout << "D3D12 done; library hits " << hits << " / " << 2 * N
              << "; creation " << createWall << " ms\n";
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
  return 0;
}
