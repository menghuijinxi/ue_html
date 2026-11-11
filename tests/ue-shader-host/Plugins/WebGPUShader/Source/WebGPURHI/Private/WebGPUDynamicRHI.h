#pragma once

#include "WebGPUUnsupportedRHI.h"
#include "WebGPUOwner.h"
#include "RHICoreStats.h"
#include "Misc/ScopeLock.h"
#include "Dom/JsonObject.h"
#include "../../WebGPUShaderFormat/Public/WebGPUShaderRuntimeMetadata.h"
#include <webgpu/webgpu.h>
#if defined(PLATFORM_WEB) && PLATFORM_WEB
#include "WebGPUCommandStream.h"
#include "WebGPUPackedDescriptors.h"
#endif
#include <atomic>

class FRHITextureReference;

struct FWebGPUBindingRoute
{
    enum class EKind { Uniform, Direct, Table, GlobalSampler };
    EKind Kind;
    uint32 Slot = 0, Index = 0;
    EUniformBufferBaseType MemberType = UBMT_INVALID;
    ERHIResourceType ResourceType = RRT_None;
    TRefCountPtr<FRHIResource> GlobalResource;
};

using FWebGPUStorageContract = UE::WebGPUShader::FStorageContract;

struct FWebGPUShaderBinding : UE::WebGPUShader::FRuntimeBinding
{
    const FJsonObject* Metadata = nullptr; // Only legacy/explicit validation loads own a DOM.
    bool StorageContractChecked = false;
    int32 SamplerBiasSlot = INDEX_NONE;
    // Prepared descriptors are reusable only while their source and access
    // state are unchanged. The bind-group cache below owns GPU handle refs.
    TRefCountPtr<FRHIResource> PreparedResource;
    WGPUBindGroupEntry PreparedEntry = WGPU_BIND_GROUP_ENTRY_INIT;
    uint64 PreparedSerial = 0, PreparedVersion = 0;
    FWebGPUBindingRoute Route{FWebGPUBindingRoute::EKind::Direct};
    bool RouteInitialized = false;
    FRHITextureReference* SourceTextureReference = nullptr;
};

struct FWebGPUBindGroupCacheEntry
{
    WGPUBindGroupLayout Layout = nullptr;
    uint32 LastUsedFrame = 0;
    WGPUBindGroup Handle = nullptr;
    TArray<WGPUBindGroupEntry> Entries;
    ~FWebGPUBindGroupCacheEntry()
    {
        if (Handle) WebGPUOnOwner([&] { wgpuBindGroupRelease(Handle); });
        for (const auto& Entry : Entries)
        {
            if (Entry.buffer) WebGPUOnOwner([&] { wgpuBufferRelease(Entry.buffer); });
            if (Entry.textureView) WebGPUOnOwner([&] { wgpuTextureViewRelease(Entry.textureView); });
            if (Entry.sampler) WebGPUOnOwner([&] { wgpuSamplerRelease(Entry.sampler); });
        }
        if (Layout) WebGPUOnOwner([&] { wgpuBindGroupLayoutRelease(Layout); });
    }
};

struct FWebGPUResolvedGroup
{
    WGPUBindGroup Handle = nullptr;
    // Cached groups are borrowed until EndFrame; an uncached new handle is
    // transferred to graphics state or released after encoding compute state.
    bool OwnedHandle = false;
    TArray<uint32, TInlineAllocator<12>> DynamicOffsets;
};
using FWebGPUResolvedGroups = TArray<FWebGPUResolvedGroup, TInlineAllocator<4>>;

struct FWebGPUGroupSnapshot
{
    // Borrowed from the bounded bind-group cache, valid only in Frame. Shader
    // resource versions must match before dereferencing any borrowed texture ref.
    FWebGPUBindGroupCacheEntry* Entry = nullptr;
    uint32 Frame = MAX_uint32;
    uint64 AccessSerial = 0;
    uint64 ShaderVersions[2] = {};
    uint64 ShaderResourceVersions[2] = {};
    TArray<uint32, TInlineAllocator<12>> DynamicOffsets;
    TArray<TPair<FRHITextureReference*, FRHITexture*>, TInlineAllocator<4>> TextureReferences;
};

// Immutable pipeline layout work. Descriptor order stays identical to the
// reference path; only dynamic offsets use WebGPU's binding-number order.
struct FWebGPUBindingPlan
{
    struct FSlot { int32 Entry = 0, Dynamic = INDEX_NONE; };
    TArray<FSlot> Slots[2];
    TArray<int32, TInlineAllocator<4>> EntryCounts, DynamicCounts;
    bool Initialized = false;
};

struct FWebGPUShaderData
{
    FRHIShader* Owner = nullptr;
    uint32 BindingFrame = MAX_uint32;
    WGPUShaderModule Module = nullptr;
    uint32 VertexInputMask = MAX_uint32;
    FString Entry;
    FString StorageFormatSource;
    TSharedPtr<FJsonObject> Metadata;
    UE::WebGPUShader::FRuntimeMetadata RuntimeMetadata;
    TMap<uint32, TRefCountPtr<FRHIResource>> Resources;
    TArray<uint8> Globals;
    FShaderResourceTable ResourceTable;
    const FShaderResourceTable& GetResourceTable() const
    {
        // Standalone rejection probes have no FRHIShader owner.
        return Owner ? Owner->GetShaderResourceTable() : ResourceTable;
    }
    TArray<TRefCountPtr<FRHIUniformBuffer>> BoundUniformBuffers;
    TArray<uint64> BoundUniformVersions;
    TMap<uint32, TRefCountPtr<FRHIResource>> TableResources;
    uint32 DirtyUniformBuffers = 0;
    uint64 UniformBindingVersion = 1, ResolvedUniformBindingVersion = 0;
    uint64 UniformUpdateSerial = 0, StaticUniformSerial = 0;
    TArray<FWebGPUShaderBinding> Bindings;
    TArray<uint64, TInlineAllocator<4>> GroupVersions;
    TArray<uint64, TInlineAllocator<4>> GroupGlobalsVersions;
    TMap<uint32, uint32> ResourceGroupMasks;
    uint32 GlobalsGroupMask = 0;
    void InvalidateGroups(uint32 Mask, bool GlobalsOnly = false)
    {
        if (GlobalsOnly) GroupGlobalsVersions.SetNumZeroed(GroupVersions.Num());
        for (int32 Group = 0; Group < GroupVersions.Num(); ++Group)
            if (Mask & (1u << Group))
            {
                ++GroupVersions[Group];
                if (GlobalsOnly) ++GroupGlobalsVersions[Group];
            }
    }
    bool HasVertexFetchFormats = false;
    mutable TMap<const FJsonObject*, FWebGPUBindingRoute> BindingRoutes;
    mutable TArray<const FRHIUniformBufferLayout*> UniformSlotLayouts;
    WGPUBuffer GlobalsBuffer = nullptr;
    uint64 GlobalsBufferOffset = 0;
    uint64 GlobalsVersion = 1;
    int32 SamplerBiasGroup = INDEX_NONE;
    WGPUBuffer SamplerBiasBuffer = nullptr;
    float SamplerBiasValues[4] = {};
    uint64 SamplerBiasVersion = 1;
    EShaderFrequency Frequency = SF_NumFrequencies;
    ~FWebGPUShaderData()
    {
        if (GlobalsBuffer)
            WebGPUOnOwner([&] { wgpuBufferRelease(GlobalsBuffer); });
        if (SamplerBiasBuffer)
            WebGPUOnOwner([&] { wgpuBufferRelease(SamplerBiasBuffer); });
        if (Module)
            WebGPUOnOwner([&] { wgpuShaderModuleRelease(Module); });
    }
};

template <typename Base> class TWebGPUShader final : public Base
{
  public:
    FWebGPUShaderData Data;
    void InitResourceTable()
    {
        this->ShaderResourceTable = MoveTemp(Data.ResourceTable);
        auto& Table = this->ShaderResourceTable;
        // UE's enumerator indexes every resource map at each dirty UB slot.
        // The Web packet omits maps with no resources of that type.
        const auto InitEmptyMap = [&](TArray<uint32>& Map) {
            if (Map.IsEmpty()) Map.SetNumZeroed(Table.ResourceTableLayoutHashes.Num());
        };
        InitEmptyMap(Table.TextureMap);
        InitEmptyMap(Table.ShaderResourceViewMap);
        InitEmptyMap(Table.SamplerMap);
        InitEmptyMap(Table.UnorderedAccessViewMap);
#if PLATFORM_SUPPORTS_BINDLESS_RENDERING
        InitEmptyMap(Table.ResourceCollectionMap);
#endif
    }
};
using FWebGPUVertexShader = TWebGPUShader<FRHIVertexShader>;
using FWebGPUPixelShader = TWebGPUShader<FRHIPixelShader>;
using FWebGPUComputeShader = TWebGPUShader<FRHIComputeShader>;

struct FWebGPUResourceState
{
    ERHIAccess Access;
    const FRHITransition *Pending = nullptr;
    explicit FWebGPUResourceState(ERHIAccess In) : Access(In)
    {
    }
};
struct FWebGPUTransitionData
{
    enum class EStage
    {
        Created,
        Begun,
        Ended
    };
    EStage Stage = EStage::Created;
    TArray<FRHITransitionInfo> Infos;
    TArray<TRefCountPtr<FRHIResource>> References;
};
struct FWebGPUTransitionPrivateData
{
    TSharedPtr<FWebGPUTransitionData> Data;
};

template <typename Base, typename InitializerType> class TWebGPUState final : public Base
{
  public:
    InitializerType Initializer;
    explicit TWebGPUState(const InitializerType &In) : Initializer(In)
    {
    }
    bool GetInitializer(InitializerType &Out) override
    {
        Out = Initializer;
        return true;
    }
};

class FWebGPUBuffer final : public FRHIBuffer
{
  public:
    WGPUBuffer Handle;
    TArray<uint8> InitialBytes;
    bool Locked = false;
    FWebGPUResourceState State;
    FWebGPUBuffer(const FRHIBufferCreateDesc &Desc, WGPUBuffer InHandle)
        : FRHIBuffer(Desc), Handle(InHandle), State(Desc.InitialState)
    {
    }
    ~FWebGPUBuffer() override
    {
        check(!Locked);
        if (Handle) WebGPUOnOwner([&] { wgpuBufferRelease(Handle); });
    }
};

struct FWebGPUBufferLock
{
    TRefCountPtr<FWebGPUBuffer> Buffer;
    TArray<uint8> Bytes;
    uint32 Offset = 0;
    EResourceLockMode Mode = RLM_WriteOnly;
};

struct FWebGPUReadbackState
{
    WGPUBuffer Handle = nullptr;
    uint32 Size = 0, RowPitch = 0, Height = 0;
    TArray<uint8> Bytes;
    std::atomic<bool> Ready{false};
    TFunction<void(const TArray<uint8>&)> OnReady;
    ~FWebGPUReadbackState() { if (Handle) WebGPUOnOwner([&] { wgpuBufferRelease(Handle); }); }
};
using FWebGPUReadbackRef = TSharedPtr<FWebGPUReadbackState, ESPMode::ThreadSafe>;

class FWebGPUTexture final : public FRHITexture
{
  public:
    WGPUTexture Handle;
    WGPUTextureView View = nullptr;
    WGPUTextureView DepthSampleView = nullptr;
    struct FAtomicMip
    {
        WGPUBuffer Buffer = nullptr;
        uint64 Bytes = 0;
        uint32 RowPitch = 0;
        // The mirror was bound for atomics after the last buffer-to-texture copy.
        TArray<uint8> DirtySlices;
        // The texture may have been written without the mirror after the last
        // texture-to-buffer copy. A new texture and its mirror both start zeroed.
        TArray<uint8> StaleSlices;
    };
    TArray<FAtomicMip> AtomicMips;
    FWebGPUResourceState State;
    FWebGPUResourceState StencilState;
    TArray<FWebGPUResourceState> SubresourceStates;
    TArray<uint8> InitialBytes;
    TMap<uint32, TArray<uint8>> MipLocks;
    TMap<uint32, WGPUTextureView> AttachmentViews;
    mutable FCriticalSection ReadbackCS;
    FWebGPUReadbackRef Readback, LockedReadback;
    bool SurfaceFrameActive = true;
    uint32 LayerCount() const { return uint32(GetDesc().ArraySize) * (GetDesc().IsTextureCube() ? 6u : 1u); }
    FWebGPUTexture(const FRHITextureCreateDesc &Desc, WGPUTexture InHandle,
        WGPUTextureFormat SampleFormat = WGPUTextureFormat_Undefined)
        : FRHITexture(Desc), Handle(InHandle),
          State(Desc.InitialState), StencilState(Desc.InitialState)
    {
        UE::RHICore::UpdateGlobalTextureStats(Desc, Desc.CalcMemorySizeEstimate(), false, true);
        SubresourceStates.Init(FWebGPUResourceState(Desc.InitialState),
            Desc.NumMips * LayerCount() - 1);
        if (!Handle) return; // CPUReadback uses a mapped buffer, not a GPU texture.
        WGPUTextureViewDescriptor Sample = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        Sample.format = SampleFormat;
        if (SampleFormat != WGPUTextureFormat_Undefined)
            Sample.usage = wgpuTextureGetUsage(Handle) &
                (WGPUTextureUsage_TextureBinding | WGPUTextureUsage_RenderAttachment);
        if (Desc.IsTextureCube())
        {
            Sample.dimension = Desc.Dimension == ETextureDimension::TextureCubeArray
                ? WGPUTextureViewDimension_CubeArray : WGPUTextureViewDimension_Cube;
            Sample.arrayLayerCount = LayerCount();
            Sample.usage = WGPUTextureUsage_TextureBinding;
            View = wgpuTextureCreateView(Handle, &Sample);
        }
        else if (Desc.Dimension == ETextureDimension::Texture2DArray)
        {
            Sample.dimension = WGPUTextureViewDimension_2DArray;
            Sample.arrayLayerCount = Desc.ArraySize;
            Sample.usage = WGPUTextureUsage_TextureBinding;
            View = wgpuTextureCreateView(Handle, &Sample);
        }
        else
            View = wgpuTextureCreateView(Handle, &Sample);
        if (Desc.Format == PF_DepthStencil && EnumHasAnyFlags(Desc.Flags, ETextureCreateFlags::ShaderResource))
        {
            Sample = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            Sample.format = WGPUTextureFormat_Depth24Plus;
            Sample.dimension = WGPUTextureViewDimension_2D;
            Sample.aspect = WGPUTextureAspect_DepthOnly;
            Sample.usage = WGPUTextureUsage_TextureBinding;
            DepthSampleView = wgpuTextureCreateView(Handle, &Sample);
        }
    }
    WGPUTextureView AttachmentView(uint32 Mip, uint32 Face)
    {
        check(Mip < GetNumMips() && Face < LayerCount());
        const uint32 Key = Mip * LayerCount() + Face;
        if (const auto* Existing = AttachmentViews.Find(Key))
            return *Existing;
        WGPUTextureViewDescriptor Desc = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        Desc.dimension = WGPUTextureViewDimension_2D;
        Desc.baseMipLevel = Mip;
        Desc.mipLevelCount = 1;
        Desc.baseArrayLayer = Face;
        Desc.arrayLayerCount = 1;
        Desc.usage = WGPUTextureUsage_RenderAttachment;
        auto Result = wgpuTextureCreateView(Handle, &Desc);
        AttachmentViews.Add(Key, Result);
        return Result;
    }
    ~FWebGPUTexture() override
    {
        check(MipLocks.IsEmpty());
        if (!AtomicMips.IsEmpty())
            WebGPUOnOwner([&] { for (const auto& Mip : AtomicMips) wgpuBufferRelease(Mip.Buffer); });
        if (DepthSampleView)
            WebGPUOnOwner([&] { wgpuTextureViewRelease(DepthSampleView); });
        for (const auto& Entry : AttachmentViews)
            WebGPUOnOwner([&] { wgpuTextureViewRelease(Entry.Value); });
        if (View) WebGPUOnOwner([&] { wgpuTextureViewRelease(View); });
        if (Handle) WebGPUOnOwner([&] { wgpuTextureRelease(Handle); });
        UE::RHICore::UpdateGlobalTextureStats(GetDesc(), GetDesc().CalcMemorySizeEstimate(), false, false);
    }
};

class FWebGPUTextureUAV final : public FRHIUnorderedAccessView
{
  public:
    WGPUTextureView Handle;
    FWebGPUTextureUAV(FRHITexture* Texture, const FRHIViewDesc& Desc, WGPUTextureView InHandle)
        : FRHIUnorderedAccessView(Texture, Desc), Handle(InHandle) {}
    ~FWebGPUTextureUAV() override { WebGPUOnOwner([&] { wgpuTextureViewRelease(Handle); }); }
};

class FWebGPUViewport final : public FRHIViewport
{
  public:
    WGPUSurface Surface = nullptr;
    TRefCountPtr<FWebGPUTexture> BackBuffer;
    WGPUSurfaceConfiguration Configuration = WGPU_SURFACE_CONFIGURATION_INIT;
    void *Window = nullptr;
    uint32 OwnerThread = 0;
    uint32 BrowserSurfaceEpoch = 0;
    EPixelFormat Format = PF_Unknown;
    explicit FWebGPUViewport(void *InWindow) : Window(InWindow)
    {
    }
    ~FWebGPUViewport() override;
    void InvalidateFrame();
    void *GetNativeSwapChain() const override
    {
        return Surface;
    }
    void *GetNativeWindow(void ** = nullptr) const override
    {
        return Window;
    }
};

class FWebGPUTextureSRV final : public FRHIShaderResourceView
{
  public:
    WGPUTextureView Handle;
    FWebGPUTextureSRV(FRHITexture *Texture, const FRHIViewDesc &Desc, WGPUTextureView InHandle)
        : FRHIShaderResourceView(Texture, Desc), Handle(InHandle)
    {
    }
    ~FWebGPUTextureSRV() override
    {
        WebGPUOnOwner([&] { wgpuTextureViewRelease(Handle); });
    }
};

class FWebGPUBufferSRV final : public FRHIShaderResourceView
{
  public:
    explicit FWebGPUBufferSRV(FRHIBuffer *Buffer, const FRHIViewDesc &Desc) : FRHIShaderResourceView(Buffer, Desc)
    {
    }
};

class FWebGPUSampler final : public FRHISamplerState
{
  public:
    FSamplerStateInitializerRHI Initializer;
    WGPUSampler Handle = nullptr;
    explicit FWebGPUSampler(const FSamplerStateInitializerRHI &In) : Initializer(In)
    {
    }
    ~FWebGPUSampler() override
    {
        if (Handle)
            WebGPUOnOwner([&] { wgpuSamplerRelease(Handle); });
    }
};

class FWebGPUUniform final : public FRHIUniformBuffer
{
  public:
    struct FConstantSnapshot { WGPUBuffer Buffer = nullptr; uint64 Offset = 0; uint32 Frame = MAX_uint32; };
    TArray<uint8> Bytes;
    TMap<uint32, FConstantSnapshot> ConstantBuffers;
    bool SingleFrame = false;
    uint64 ContentsVersion = 1;
    explicit FWebGPUUniform(const FRHIUniformBufferLayout *Layout) : FRHIUniformBuffer(Layout)
    {
    }
    void ReleaseConstants()
    {
        for (const auto& Buffer : ConstantBuffers)
            WebGPUOnOwner([&] { wgpuBufferRelease(Buffer.Value.Buffer); });
        ConstantBuffers.Empty();
    }
    ~FWebGPUUniform() override { ReleaseConstants(); }
    void SetContents(TArray<uint8> InBytes, TArray<TRefCountPtr<FRHIResource>> InResources)
    {
        if (Bytes != InBytes || ResourceTable != InResources) ++ContentsVersion;
        // Encoded draws retain the previous immutable GPU snapshot when constants change.
        if (Bytes != InBytes)
            ReleaseConstants();
        Bytes = MoveTemp(InBytes);
        ResourceTable = MoveTemp(InResources);
    }
};

class FWebGPUVertexDeclaration final : public FRHIVertexDeclaration
{
  public:
    FVertexDeclarationElementList Elements;
    uint32 PrecacheHash = 0;
    explicit FWebGPUVertexDeclaration(const FVertexDeclarationElementList &InElements) : Elements(InElements)
    {
        // Unlike DX12, WebGPU includes arrayStride in the pipeline descriptor.
        // Hash fields explicitly so padding cannot change precache identity.
        for (const FVertexElement& Element : Elements)
        {
            for (uint32 Value : {uint32(Element.StreamIndex), uint32(Element.Offset), uint32(Element.Type),
                                uint32(Element.AttributeIndex), uint32(Element.Stride), uint32(Element.bUseInstanceIndex)})
                PrecacheHash = HashCombineFast(PrecacheHash, Value);
        }
    }
    bool GetInitializer(FVertexDeclarationElementList& Out) override { Out = Elements; return true; }
    uint32 GetPrecachePSOHash() const override { return PrecacheHash; }
};

class FWebGPUGraphicsPipeline final : public FRHIGraphicsPipelineState
{
  public:
    WGPURenderPipeline Handle = nullptr;
    uint32 VertexStreamMask = 0;
    TArray<WGPUBindGroupLayout> GroupLayouts;
    TSet<uint64> DynamicBindings;
    uint32 PreviousGroupsFrame = MAX_uint32;
    TArray<FWebGPUBindGroupCacheEntry*> PreviousGroups;
    TArray<FWebGPUGroupSnapshot, TInlineAllocator<4>> PreparedGroups;
    // Cached PSOs can outlive the material/task that supplied these raw pointers.
    FWebGPUBindingPlan BindingPlan;
    FVertexDeclarationRHIRef VertexDeclaration;
    FVertexShaderRHIRef VertexShader;
    FPixelShaderRHIRef PixelShader;
    FBlendStateRHIRef BlendState;
    FRasterizerStateRHIRef RasterizerState;
    FDepthStencilStateRHIRef DepthStencilState;
    FGraphicsPipelineStateInitializer Initializer;
    bool PrecacheUsed = false;
    explicit FWebGPUGraphicsPipeline(const FGraphicsPipelineStateInitializer &In)
        : VertexDeclaration(In.BoundShaderState.VertexDeclarationRHI),
          VertexShader(In.BoundShaderState.GetVertexShader()), PixelShader(In.BoundShaderState.GetPixelShader()),
          BlendState(In.BlendState), RasterizerState(In.RasterizerState), DepthStencilState(In.DepthStencilState),
          Initializer(In)
    {
    }
    ~FWebGPUGraphicsPipeline() override
    {
        for (auto Layout : GroupLayouts) if (Layout) WebGPUOnOwner([&] { wgpuBindGroupLayoutRelease(Layout); });
        if (Handle)
            WebGPUOnOwner([&] { wgpuRenderPipelineRelease(Handle); });
    }
    FRHIGraphicsShader *GetShader(EShaderFrequency Frequency) const override
    {
        return Frequency == SF_Vertex
                   ? static_cast<FRHIGraphicsShader *>(Initializer.BoundShaderState.GetVertexShader())
               : Frequency == SF_Pixel
                   ? static_cast<FRHIGraphicsShader *>(Initializer.BoundShaderState.GetPixelShader())
                   : nullptr;
    }
};

class FWebGPUComputePipeline final : public FRHIComputePipelineState
{
  public:
    WGPUComputePipeline Handle;
    TArray<WGPUBindGroupLayout> GroupLayouts;
    TSet<uint64> DynamicBindings;
    TMap<uint64, uint32> StorageFormats;
    TMap<FString, TRefCountPtr<FWebGPUComputePipeline>> FormatVariants;
    FWebGPUBindingPlan BindingPlan;
    uint32 PreviousGroupsFrame = MAX_uint32;
    TArray<FWebGPUBindGroupCacheEntry*> PreviousGroups;
    TArray<FWebGPUGroupSnapshot, TInlineAllocator<4>> PreparedGroups;
    FWebGPUComputePipeline(FRHIComputeShader *Shader, WGPUComputePipeline In)
        : FRHIComputePipelineState(Shader), Handle(In)
    {
    }
    ~FWebGPUComputePipeline() override
    {
        for (auto Layout : GroupLayouts) if (Layout) WebGPUOnOwner([&] { wgpuBindGroupLayoutRelease(Layout); });
        if (Handle) WebGPUOnOwner([&] { wgpuComputePipelineRelease(Handle); });
    }
};

struct FWebGPUOcclusionResultSlot
{
    TRefCountPtr<FRHIRenderQuery> Query;
    uint64 Generation;
};

struct FWebGPUOcclusionBatch
{
    WGPUQuerySet Queries = nullptr;
    WGPUBuffer Resolve = nullptr;
    FWebGPUReadbackRef Readback;
    TArray<FWebGPUOcclusionResultSlot> Results;
    uint32 Count = 0, Capacity = 0;
    ~FWebGPUOcclusionBatch()
    {
        if (Queries) WebGPUOnOwner([&] { wgpuQuerySetRelease(Queries); });
        if (Resolve) WebGPUOnOwner([&] { wgpuBufferRelease(Resolve); });
    }
};
using FWebGPUOcclusionRef = TSharedPtr<FWebGPUOcclusionBatch, ESPMode::ThreadSafe>;

class FWebGPURenderQuery final : public FRHIRenderQuery
{
  public:
    FWebGPUOcclusionRef Batch;
    uint32 Index = 0;
    // A 32-bit word also supports sleeping Render workers until the owner
    // publishes a result. The owner itself must always remain nonblocking.
    std::atomic<uint32> ResultReady{0};
    std::atomic<uint64> ResultValue{0};
    uint64 Generation = 0; // RHI owns reuse and completion publication.
};

struct FWebGPUFenceState
{
    std::atomic<bool> Complete{false};
    TArray<FWebGPUReadbackRef> Readbacks;
};
using FWebGPUFenceRef = TSharedPtr<FWebGPUFenceState, ESPMode::ThreadSafe>;

class FWebGPUFence final : public FRHIGPUFence
{
  public:
    FWebGPUFenceRef State = MakeShared<FWebGPUFenceState, ESPMode::ThreadSafe>();
    explicit FWebGPUFence(FName Name) : FRHIGPUFence(Name) {}
    void Clear() override { State = MakeShared<FWebGPUFenceState, ESPMode::ThreadSafe>(); }
    bool Poll() const override
    {
        return State->Complete.load() && State->Readbacks.ContainsByPredicate(
            [](const auto& Readback) { return !Readback->Ready.load(); }) == false;
    }
    void Wait(FRHICommandListImmediate&, FRHIGPUMask) const override
    {
        checkf(Poll(), TEXT("WebGPU readback must be polled across frames; blocking waits are unsupported"));
    }
};

class FWebGPUStagingBuffer final : public FRHIStagingBuffer
{
    mutable FCriticalSection StateCS;
    FWebGPUReadbackRef State, LockedState;
  public:
    void SetState(FWebGPUReadbackRef InState)
    {
        FScopeLock Lock(&StateCS);
        check(!bIsLocked);
        State = MoveTemp(InState);
    }
    void* Lock(uint32 Offset, uint32 Size) override
    {
        FScopeLock Guard(&StateCS);
        if (!State || !State->Ready.load(std::memory_order_acquire))
            return nullptr;
        check(!bIsLocked && uint64(Offset) + Size <= uint64(State->Bytes.Num()));
        // Publish immutable CPU bytes through Ready and retain them through Unlock.
        // No WebGPU object access, owner proxy or RHI execution lock is needed.
        LockedState = State;
        bIsLocked = true;
        return LockedState->Bytes.GetData() + Offset;
    }
    void Unlock() override
    {
        FScopeLock Guard(&StateCS);
        check(bIsLocked);
        bIsLocked = false;
        LockedState.Reset();
    }
    uint64 GetGPUSizeBytes() const override
    {
        FScopeLock Guard(&StateCS);
        return State ? State->Size : 0;
    }
};

class FWebGPUCommandList final : public IRHIPlatformCommandList
{
  public:
    WGPUCommandBuffer Handle;
    uint32 Serial;
    TArray<FWebGPUReadbackRef> Readbacks;
    TArray<FWebGPUFenceRef> Fences;
    FWebGPUCommandList(WGPUCommandBuffer In, uint32 InSerial) : Handle(In), Serial(InSerial)
    {
    }
    ~FWebGPUCommandList()
    {
        WebGPUOnOwner([&] { wgpuCommandBufferRelease(Handle); });
    }
};

class FWebGPUDynamicRHI final : public FWebGPUUnsupportedRHI
{
  public:
    WGPUInstance Instance = nullptr;
    WGPUAdapter Adapter = nullptr;
    WGPUDevice Device = nullptr;
    WGPUQueue Queue = nullptr;
    WGPULimits Limits = WGPU_LIMITS_INIT;
    TOptional<FPixelFormatInfo> PreviousDepthFormat, PreviousStencilFormat, PreviousShadowFormat, PreviousPackedHDRFormat,
        PreviousFloatRGBFormat, PreviousR16UIntFormat;
    WGPUCommandEncoder Encoder = nullptr;
    WGPURenderPassEncoder Pass = nullptr;
    WGPUComputePassEncoder ComputePass = nullptr;
    uint32 ComputePassGroups = 0, ComputePassesOpened = 0, ComputePassesReused = 0;
    uint32 RenderPassesOpened = 0;
    TArray<FWebGPUReadbackRef> StagingReadbackPool;
    uint32 StagingReadbackPoolBytes = 0, StagingReadbacksCreated = 0, StagingReadbacksReused = 0;
    TRefCountPtr<FWebGPUGraphicsPipeline> GraphicsPipeline;
    TRefCountPtr<FWebGPUComputePipeline> ComputePipeline;
    TArray<TRefCountPtr<FWebGPUTexture>> Attachments;
    TArray<FIntPoint> AttachmentSubresources;
    TRefCountPtr<FWebGPUTexture> RasterExtentAttachment;
    TArray<FString> Errors;
    FString AdapterName;
    uint32 Draws = 0, Dispatches = 0, Finalized = 0, Submitted = 0, BoundGroups = 0;
    uint32 IndirectDraws = 0;
    uint32 UniformUploads = 0;
    uint32 BindGroupCacheHits = 0, BindGroupCacheEntries = 0;
    uint32 BindGroupFastHits = 0;
    TArray<TArray<WGPUBindGroupEntry>> BindingScratchGroups;
    TArray<TArray<TPair<uint32, uint32>>> BindingScratchDynamicOffsets;
    uint64 BindingStateSerial = 1;
    // Immutable after RHI construction. Startup switches isolate each experiment.
    bool NativeShaderMetadata = false;
    uint32 NativeMetadataLoads = 0, DOMMetadataLoads = 0;
    uint64 NativeMetadataBytes = 0;
    double MetadataReadSeconds = 0;
    bool SkipNoopRHITick = false, NativeStorageContracts = false, RevalidateStorageDescriptors = false;
    std::atomic<uint32> NoopRHITicksSkipped{0};
    uint32 StorageDescriptorRevalidations = 0, NativeStorageContractUses = 0, StorageContractRejectionChecks = 0;
    uint32 BindingEntriesPrepared = 0, BindingEntriesReused = 0, BindingEntriesValidated = 0;
    uint32 BindingPlanEntries = 0, BindingPlansBuilt = 0, BindingPlanValidations = 0;
    uint32 GroupPreparationHits = 0, GroupPreparationValidated = 0;
    uint32 GroupAccessRevalidated = 0, GroupAccessBindingsChecked = 0;
    uint32 GroupDynamicGlobalsReused = 0;
    uint32 GroupPreparationFrameMisses = 0, GroupPreparationAccessMisses = 0,
        GroupPreparationVersionMisses = 0, GroupPreparationTextureMisses = 0;
    TMap<uint32, TArray<TUniquePtr<FWebGPUBindGroupCacheEntry>>> BindGroupCache;
    // Explicit layouts are interned for the device lifetime, like native root signatures.
    // Keys contain semantic fields, never C struct padding or shader/pipeline identity.
    struct FGroupLayout { TArray<uint64> Key; WGPUBindGroupLayout Handle; };
    struct FPipelineLayout { TArray<WGPUBindGroupLayout> Groups; WGPUPipelineLayout Handle; };
    TMap<uint32, TArray<FGroupLayout>> GroupLayoutCache;
    TArray<FPipelineLayout> PipelineLayoutCache;
    struct FDrawBundle
    {
        TArray<uint64> Key;
        WGPURenderBundle Handle = nullptr;
        uint32 LastUsedFrame = 0;
        uint32 StableFrames = 1;
        TRefCountPtr<FWebGPUGraphicsPipeline> Pipeline;
        TArray<TRefCountPtr<FWebGPUBuffer>> Buffers;
        TArray<WGPUBindGroup> Groups;
        ~FDrawBundle()
        {
            if (Handle) WebGPUOnOwner([&] { wgpuRenderBundleRelease(Handle); });
            for (auto Group : Groups) WebGPUOnOwner([&] { wgpuBindGroupRelease(Group); });
        }
    };
    TMap<uint32, TArray<TUniquePtr<FDrawBundle>>> DrawBundleCache;
    TArray<uint64> DrawBundleKey, PassBundleKey;
    TArray<WGPUTextureFormat> PassBundleColors;
    WGPUTextureFormat PassBundleDepth = WGPUTextureFormat_Undefined;
    bool PassStencilReadOnly = false, UseRenderBundles = false;
    uint32 PassStencilReference = MAX_uint32;
    struct FPendingBundle { WGPURenderBundle Handle; bool Owned; };
    TArray<FPendingBundle> PendingDrawBundles;
    uint32 DrawBundleEntries = 0, DrawBundleReadyEntries = 0, DrawBundleHits = 0, DrawBundlesCreated = 0;
    void FlushDrawBundles();
    void DrawIndexedBundle(FWebGPUBuffer* Index, int32 Base, uint32 FirstInstance,
        uint32 StartIndex, uint32 Primitives, uint32 Instances);
    WGPUBuffer FrameUniformBuffer = nullptr;
    uint64 FrameUniformOffset = 0;
    TArray<uint8> FrameUniformUploadBytes;
    uint64 FrameUniformDirtyBegin = 0, FrameUniformDirtyEnd = 0;
    uint32 UniformWriteCalls = 0;
    TArray<WGPUBuffer> FrameUniformPages;
    uint32 FrameUniformPage = 0;
    // Upload slices are unique until RHIEndFrame has submitted every encoder.
    WGPUBuffer StagingUploadBuffer = nullptr;
    uint64 StagingUploadOffset = 0;
    uint32 StagingUploadPage = 0;
    TArray<WGPUBuffer> StagingUploadPages;
    uint32 StagingUploadCalls = 0, StagingUploadPooled = 0, StagingUploadPageCreates = 0;
    uint32 StagingUploadFallbacks = 0;
    TArray<uint8> StagingUploadBytes;
    uint64 StagingDirtyBegin = 0, StagingDirtyEnd = 0;
    uint32 StagingWriteBatches = 0;
    TArray<TRefCountPtr<FRHIShader>> FrameShaders;
    uint32 OwnerThread = 0;
    uint32 ResourceTableBindings = 0;
    uint64 UniformUpdateSerial = 1, StaticUniformSerial = 1;
    uint32 ResourceTableCommits = 0, ResourceTableBuffers = 0, BindingRouteResolutions = 0;
    TMap<uint32, WGPUBuffer> VertexFetchFormatBuffers;
    uint32 ManualVertexFetchDraws = 0;
    TSharedRef<std::atomic<uint32>, ESPMode::ThreadSafe> TextureReadbacksReady = MakeShared<std::atomic<uint32>, ESPMode::ThreadSafe>(0);
    std::atomic<uint32> TextureReadbacksPending{0};
    std::atomic<uint32> TextureReadbackMaps{0}, TextureReadbackNotReady{0};
    double GraphicsPipelineCreateMs = 0, ComputePipelineCreateMs = 0;
    uint32 PrecachedGraphicsPipelines = 0;
    uint32 TransitionsCreated = 0, TransitionsBegun = 0, TransitionsEnded = 0, TransitionsReleased = 0;
    uint32 AccessChecks = 0;
    uint32 GraphicsPipelinesCreated = 0, ComputePipelinesCreated = 0, VertexDeclarationsCreated = 0, EndFrames = 0;
    uint32 ViewportsCreated = 0, ViewportsResized = 0, FramesAcquired = 0, FramesPresented = 0, FramesSkipped = 0;
    uint32 PostInitCalls = 0;
    uint32 BufferLocksCreated = 0, BufferLocksReleased = 0, BufferUploads = 0, BufferReadLocks = 0;
    uint64 BufferUploadBytes = 0;
    TMap<FRHIBuffer *, FWebGPUBufferLock> BufferLocks;
    TMap<FString, FSamplerStateRHIRef> GlobalSamplers;
    uint32 BreadcrumbsBegun = 0, BreadcrumbsEnded = 0, BreadcrumbMarkersEmitted = 0;
    TArray<FRHIBreadcrumbNode *> BreadcrumbStack;
    TMap<const FRHITransition *, TSharedPtr<FWebGPUTransitionData>> Transitions;
    bool ContextOpen = false;
    bool PassDepthReadOnly = false;
    bool GlobalProbeMode = false;
    bool StartupProbeMode = false;
    bool EmitDebugMarkers = true;
    FWebGPUOcclusionRef OcclusionBatch;
    TRefCountPtr<FWebGPURenderQuery> ActiveOcclusionQuery;
    std::atomic<uint32> OcclusionResultsReady{0}, OcclusionResultsPending{0}, OcclusionResultsZero{0};

    explicit FWebGPUDynamicRHI(bool InStartupProbe = false);
    void ConfigureStartup();
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    void BeginBrowserDevice(void (*Completion)(bool));
    void (*BrowserCompletion)(bool) = nullptr;
#endif
    void Init() override;
    void PostInit() override;
    void Shutdown() override;
    void ReleaseBindings();
    void RHIEndFrame(const FRHIEndFrameArgs &) override;
    void RHITick(float DeltaTime) override;
    void RHIBlockUntilGPUIdle() override;
    ~FWebGPUDynamicRHI() override;
    void RequireOwner() const;
    bool Wait(TFunctionRef<bool()> Complete);
    WGPUBuffer CreateBuffer(uint64 Size, WGPUBufferUsage Usage, const void *Data = nullptr);
    void FlushStagingUploads();
    WGPUBuffer UploadStagingBytes(const void* Data, uint64 Size, uint64& Offset);
    void EndComputePass();
    WGPUSampler ResolveSampler(FWebGPUSampler *Sampler, bool ShaderBias = false);
    bool LoadShader(const FRHICreateShaderDesc &Desc, EShaderFrequency Frequency, FWebGPUShaderData &Data,
                    FString &Error);
    bool ValidateUAV(FRHIBuffer *Buffer, const FRHIViewDesc &Desc, FString &Error) const;
    bool ValidateStructuredView(const FRHIBuffer *Buffer, const FRHIViewDesc::FBuffer &View,
                                EBufferUsageFlags RequiredUsage, FString &Error) const;
    bool ValidateTextureSRV(FRHIViewableResource *Resource, const FRHIViewDesc &Desc, FString &Error) const;
    bool ValidateTextureInitialization(const FRHITextureCreateDesc &Desc, FString &Error) const;
    bool ValidateTextureBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                FString &Error) const;
    bool ValidateTextureBinding(FRHIResource *Resource, const FWebGPUShaderBinding &Binding, ERHIAccess Access,
                                FString &Error, FWebGPUTexture *&Texture, WGPUTextureView &View) const;
    bool ValidateBufferSRV(FRHIViewableResource *Resource, const FRHIViewDesc &Desc, FString &Error) const;
    bool ValidateStorageSRVBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                   FString &Error) const;
    bool ValidateStorageSRVBinding(FRHIResource *Resource, const FWebGPUStorageContract &Binding, ERHIAccess Access,
                                                  FString &Error) const;
    bool ValidateStorageUAVBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                   FString &Error) const;
    bool ValidateStorageUAVBinding(FRHIResource *Resource, const FWebGPUStorageContract &Binding, ERHIAccess Access,
                                                  FString &Error) const;
    bool ValidateTextureAtomicBinding(FRHIResource* Resource, const FWebGPUStorageContract& Binding,
        ERHIAccess Access, FString& Error) const;
    void SyncTextureAtomicBuffer(FWebGPUTexture* Texture, uint32 Mip, uint32 Slice,
        ERHIAccess PreviousAccess, ERHIAccess NextAccess);
    void CopyTextureAtomicSlice(FWebGPUTexture* Texture, uint32 Mip, uint32 Slice, bool ToTexture);
    void RefreshTextureAtomicBuffer(FWebGPUTexture* Texture, uint32 Mip);
    uint64 RHIGetMinimumAlignmentForBufferBackedSRV(EPixelFormat Format) override;
    bool ResolveSampledTexture(FRHIResource *Resource, FWebGPUTexture *&Texture, WGPUTextureView &View,
                               ERHIAccess Access, FString &Error) const;
    bool ValidateSampledTexture(FRHITexture *Texture, FString &Error,
                                ERHIAccess Access = ERHIAccess::SRVGraphicsPixel, uint32 Plane = 0) const;
    bool IsRenderAttachment(FWebGPUTexture* Texture, uint32 Mip, uint32 Slice) const;
    FWebGPUResourceState &ResourceState(FRHIViewableResource *Resource, uint32 Plane = 0,
                                       uint32 Mip = 0, uint32 Slice = 0) const;
    bool ValidateAccess(FRHIViewableResource *Resource, ERHIAccess Access, FString &Error,
                        bool InternalCopy = false, uint32 Plane = 0,
                        uint32 Mip = MAX_uint32, uint32 Slice = MAX_uint32) const;
    void RequireAccess(FRHIViewableResource *Resource, ERHIAccess Access, bool InternalCopy = false,
                       uint32 Plane = 0, uint32 Mip = MAX_uint32, uint32 Slice = MAX_uint32);
    bool ValidateTransitionCreate(const FRHITransitionCreateInfo &Info, FString &Error) const;
    bool ValidateTransitionBatch(TArrayView<const FRHITransition *> Batch, bool Begin, FString &Error) const;
    bool ValidateTransitionRelease(const FRHITransition *Transition, FString &Error) const;
    bool ValidateSubmissionOrder(TConstArrayView<IRHIPlatformCommandList *> Lists, FString &Error) const;
    bool ValidateBufferLock(FRHIBuffer *Buffer, uint32 Offset, uint32 Size, EResourceLockMode Mode,
                            FString &Error) const;
    bool ValidateBufferUnlock(FRHIBuffer *Buffer, FString &Error) const;
    void *LockBuffer_BottomOfPipe(FRHICommandListBase &, FRHIBuffer *, uint32, uint32, EResourceLockMode) override;
    void UnlockBuffer_BottomOfPipe(FRHICommandListBase &, FRHIBuffer *) override;
    bool ValidatePipelineDepth(const FGraphicsPipelineStateInitializer &Initializer, FString &Error) const;
    bool ValidateUniform(const FWebGPUShaderData &Shader, uint32 Slot, FRHIUniformBuffer *Uniform,
                         FString &Error) const;
    bool ValidateStaticUniform(FUniformBufferStaticSlot Slot, FRHIUniformBuffer *Uniform, FString &Error) const;
    bool ResolveUniform(const FWebGPUShaderData &Shader, uint32 Slot, FRHIUniformBuffer *&Uniform,
                        FString &Error) const;
    bool ResolveNativeBinding(const FWebGPUShaderData &Shader, FWebGPUShaderBinding &Binding, FRHIResource *&Resource,
                              bool &FromTable, FString &Error) const;
    bool ResolveBinding(const FWebGPUShaderData &Shader, const FJsonObject &Binding, FRHIResource *&Resource,
                        bool &FromTable, FString &Error) const;
    FWebGPUShaderData &ShaderData(FRHIShader *Shader);
    void TrackShaderBindings(FWebGPUShaderData& Shader);
    void CommitShaderResources(FWebGPUShaderData& Shader);
    FRHIResource* ResolveDrawBinding(FWebGPUShaderData& Shader, FWebGPUShaderBinding& Binding);
    void ReleaseFrameBindings();
    FWebGPUUniform::FConstantSnapshot UploadFrameConstants(const void* Data, uint64 Bytes);
    void FlushFrameConstants();
    WGPUPipelineLayout CreatePipelineLayout(TConstArrayView<const FWebGPUShaderData*> Shaders,
        TSet<uint64>& DynamicBindings, TArray<WGPUBindGroupLayout>& Layouts,
        const TMap<uint64, uint32>* StorageFormats = nullptr);
    TRefCountPtr<FWebGPUComputePipeline> ResolveComputePipeline(FWebGPUComputePipeline& Pipeline);
    void Bind(FWebGPUShaderData &Shader, const FRHIShaderParameterResource &Parameter);
    void Parameters(FWebGPUShaderData &Shader, TConstArrayView<uint8>, TConstArrayView<FRHIShaderParameter>,
                    TConstArrayView<FRHIShaderParameterResource>, TConstArrayView<FRHIShaderParameterResource>);
    FWebGPUResolvedGroups CreateGroups(WGPURenderPipeline Render, WGPUComputePipeline Compute,
                                       TConstArrayView<FWebGPUShaderData *> Shaders);
    TArray<uint8> ReadBuffer(FRHIBuffer *Source, uint64 Bytes);
    TArray<uint8> MapBuffer(WGPUBuffer Buffer, uint64 Bytes);
    void SubmitCurrent();
    bool ValidateViewport(void *Window, uint32 Width, uint32 Height, bool Fullscreen, EPixelFormat Format,
                          FString &Error) const;
    FViewportRHIRef RHICreateViewport(void *, uint32, uint32, bool, EPixelFormat) override;
    void RHIResizeViewport(FRHIViewport *, uint32, uint32, bool, EPixelFormat) override;
    FTextureRHIRef RHIGetViewportBackBuffer(FRHIViewport *) override;
    void PresentBrowserViewport(FWebGPUViewport&, const FRHIPresentArgs&);
    void RHIEndDrawingViewport(FRHICommandListImmediate &, FRHIViewport *, const FRHIPresentArgs &) override;
#if WITH_RHI_BREADCRUMBS
    void RHIBeginBreadcrumbGPU(FRHIBreadcrumbNode *) override;
    void RHIEndBreadcrumbGPU(FRHIBreadcrumbNode *) override;
#endif

    FVertexShaderRHIRef RHICreateVertexShader(const FRHICreateShaderDesc &) override;
    FPixelShaderRHIRef RHICreatePixelShader(const FRHICreateShaderDesc &) override;
    FComputeShaderRHIRef RHICreateComputeShader(const FRHICreateShaderDesc &) override;
    FSamplerStateRHIRef RHICreateSamplerState(const FSamplerStateInitializerRHI &) override;
    FRasterizerStateRHIRef RHICreateRasterizerState(const FRasterizerStateInitializerRHI &) override;
    FDepthStencilStateRHIRef RHICreateDepthStencilState(const FDepthStencilStateInitializerRHI &) override;
    FBlendStateRHIRef RHICreateBlendState(const FBlendStateInitializerRHI &) override;
    FVertexDeclarationRHIRef RHICreateVertexDeclaration(const FVertexDeclarationElementList &) override;
    FGraphicsPipelineStateRHIRef RHICreateGraphicsPipelineState(const FGraphicsPipelineStateInitializer &) override;
    FComputePipelineStateRHIRef RHICreateComputePipelineState(const FComputePipelineStateInitializer &) override;
    FUniformBufferRHIRef RHICreateUniformBuffer(const void *, const FRHIUniformBufferLayout *, EUniformBufferUsage,
                                                EUniformBufferValidation) override;
    void RHIUpdateUniformBuffer(FRHICommandListBase &, FRHIUniformBuffer *, const void *) override;
    FRHIBufferInitializer RHICreateBufferInitializer(FRHICommandListBase &, const FRHIBufferCreateDesc &) override;
    FRHICalcTextureSizeResult RHICalcTexturePlatformSize(const FRHITextureDesc &, uint32) override;
    uint32 RHIComputeMemorySize(FRHITexture *) override;
    void RHIGetTextureMemoryStats(FTextureMemoryStats &) override;
    FRHILockTextureResult RHILockTexture(FRHICommandListImmediate &, const FRHILockTextureArgs &) override;
    void RHIUnlockTexture(FRHICommandListImmediate &, const FRHILockTextureArgs &) override;
    FRHITextureInitializer RHICreateTextureInitializer(FRHICommandListBase &, const FRHITextureCreateDesc &) override;
    void RHIUpdateTexture2D(FRHICommandListBase &, FRHITexture *, uint32, const FUpdateTextureRegion2D &, uint32,
                            const uint8 *) override;
    FUnorderedAccessViewRHIRef RHICreateUnorderedAccessView(FRHICommandListBase &, FRHIViewableResource *,
                                                            const FRHIViewDesc &) override;
    FShaderResourceViewRHIRef RHICreateShaderResourceView(FRHICommandListBase &, FRHIViewableResource *,
                                                          const FRHIViewDesc &) override;
    void RHISetShaderParameters(FRHIGraphicsShader *, TConstArrayView<uint8>, TConstArrayView<FRHIShaderParameter>,
                                TConstArrayView<FRHIShaderParameterResource>,
                                TConstArrayView<FRHIShaderParameterResource>) override;
    void RHISetShaderParameters(FRHIComputeShader *, TConstArrayView<uint8>, TConstArrayView<FRHIShaderParameter>,
                                TConstArrayView<FRHIShaderParameterResource>,
                                TConstArrayView<FRHIShaderParameterResource>) override;
    void RHISetStaticUniformBuffers(const FUniformBufferStaticBindings &) override;
    void RHISetStaticUniformBuffer(FUniformBufferStaticSlot, FRHIUniformBuffer *) override;
    void RHISetGraphicsPipelineState(FRHIGraphicsPipelineState *, uint32, bool) override;
#if PLATFORM_USE_FALLBACK_PSO
    void RHISetGraphicsPipelineState(const FGraphicsPipelineStateInitializer &, uint32, bool) override;
#endif
    void RHISetComputePipelineState(FRHIComputePipelineState *) override;
    void RHIBeginRenderPass(const FRHIRenderPassInfo &, const TCHAR *) override;
    void RHIEndRenderPass() override;
    FRenderQueryRHIRef RHICreateRenderQuery(ERenderQueryType) override;
    bool RHIGetRenderQueryResult(FRHIRenderQuery*, uint64&, bool, uint32) override;
    void RHIBeginRenderQuery(FRHIRenderQuery*) override;
    void RHIEndRenderQuery(FRHIRenderQuery*) override;
    void RHISetStreamSource(uint32, FRHIBuffer *, uint32) override;
    void RHISetViewport(float, float, float, float, float, float) override;
    void RHISetScissorRect(bool, uint32, uint32, uint32, uint32) override;
    void RHIDrawPrimitive(uint32, uint32, uint32) override;
    void RHIDrawPrimitiveIndirect(FRHIBuffer*, uint32) override;
    void RHIDrawIndexedPrimitive(FRHIBuffer *, int32, uint32, uint32, uint32, uint32, uint32) override;
    void RHIDrawIndexedPrimitiveIndirect(FRHIBuffer*, FRHIBuffer*, uint32) override;
    void RHIDispatchComputeShader(uint32, uint32, uint32) override;
    void RHIDispatchIndirectComputeShader(FRHIBuffer*, uint32) override;
    bool ValidateIndirectArguments(FRHIBuffer*, uint32 Offset, uint32 Bytes, FString& Error) const;
    void RHIClearUAVUint(FRHIUnorderedAccessView*, const FUintVector4&) override;
    void RHIClearUAVFloat(FRHIUnorderedAccessView*, const FVector4f&) override;
    void RHICopyTexture(FRHITexture *, FRHITexture *, const FRHICopyTextureInfo &) override;
    void RHICopyBufferRegion(FRHIBuffer *, uint64, FRHIBuffer *, uint64, uint64) override;
    void RHIReadSurfaceData(FRHITexture *, FIntRect, TArray<FColor> &, FReadSurfaceDataFlags) override;
    void RHIMapStagingSurface(FRHITexture*, FRHIGPUFence*, void*&, int32&, int32&, uint32) override;
    void RHIUnmapStagingSurface(FRHITexture*, uint32) override;
    void RHIMapStagingSurface_RenderThread(FRHICommandListImmediate&, FRHITexture*, uint32, FRHIGPUFence*, void*&, int32&, int32&) override;
    void RHIUnmapStagingSurface_RenderThread(FRHICommandListImmediate&, FRHITexture*, uint32) override;
    IRHICommandContext *RHIGetDefaultContext() override;
    IRHIComputeContext *RHIGetCommandContext(ERHIPipeline) override;
    FRHIFinalizeContextsResult RHIFinalizeContexts(FRHIFinalizeContextsArgs &&) override;
    void RHISubmitCommandLists(FRHISubmitCommandListsArgs &&) override;
    FGPUFenceRHIRef RHICreateGPUFence(const FName& Name) override;
    FStagingBufferRHIRef RHICreateStagingBuffer() override;
    void RHICopyToStagingBuffer(FRHIBuffer*, FRHIStagingBuffer*, uint32 Offset, uint32 Size) override;
    void RHIWriteGPUFence(FRHIGPUFence*) override;
    void* RHILockStagingBuffer(FRHIStagingBuffer*, FRHIGPUFence*, uint32 Offset, uint32 Size) override;
    void RHIUnlockStagingBuffer(FRHIStagingBuffer*) override;
    void* LockStagingBuffer_RenderThread(FRHICommandListImmediate&, FRHIStagingBuffer*, FRHIGPUFence*, uint32, uint32) override;
    void UnlockStagingBuffer_RenderThread(FRHICommandListImmediate&, FRHIStagingBuffer*) override;
    void RHICreateTransition(FRHITransition *, const FRHITransitionCreateInfo &) override;
    void RHIReleaseTransition(FRHITransition *) override;
    void RHIBeginTransitions(TArrayView<const FRHITransition *>) override;
    void RHIEndTransitions(TArrayView<const FRHITransition *>) override;
    void *RHIGetNativeDevice() override
    {
        return Device;
    }
    uint32 StaticUniformBatches = 0, StaticUniformUpdates = 0;
    mutable uint32 StaticUniformResolutions = 0;

  private:
    TArray<TRefCountPtr<FWebGPUBuffer>> VertexBuffers;
    TArray<uint32> VertexOffsets;
    // Like the native RHI state caches, remember what this encoder already has.
    // UE's mesh-command cache updates logical state; only changes reach WebGPU.
    TArray<TRefCountPtr<FWebGPUBuffer>> BoundVertexBuffers;
    TArray<uint32> BoundVertexOffsets;
    TRefCountPtr<FWebGPUBuffer> BoundIndexBuffer;
    TArray<FWebGPUResolvedGroup> BoundGraphicsGroups;
    void ResetEncoderBindings();
    void SetIndexBinding(FWebGPUBuffer*);
    void SetDrawBindings(FWebGPUResolvedGroups* PreparedGroups = nullptr);
    WGPUComputePassEncoder BeginComputePass();
    void ClearStorageUAV(FRHIUnorderedAccessView*, const FUintVector4&, bool Float);
    TMap<FString, WGPUComputePipeline> ClearPipelines;
    TArray<TRefCountPtr<FRHIUniformBuffer>> StaticUniformBuffers;
    TArray<FRHIUniformBuffer*> StaticUniformPointers;
    TArray<FWebGPUReadbackRef> PendingReadbacks;
    TArray<FWebGPUFenceRef> PendingFences;
};
