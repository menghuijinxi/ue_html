#pragma once

#include "WebGPUUnsupportedRHI.h"
#include "Dom/JsonObject.h"
#include <webgpu/webgpu.h>
#include <atomic>

struct FWebGPUShaderData
{
    WGPUShaderModule Module = nullptr;
    FString Entry;
    TSharedPtr<FJsonObject> Metadata;
    TMap<uint32, TRefCountPtr<FRHIResource>> Resources;
    TArray<uint8> Globals;
    FShaderResourceTable ResourceTable;
    ~FWebGPUShaderData()
    {
        if (Module)
            wgpuShaderModuleRelease(Module);
    }
};

template <typename Base> class TWebGPUShader final : public Base
{
  public:
    FWebGPUShaderData Data;
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
        wgpuBufferRelease(Handle);
    }
};

struct FWebGPUBufferLock
{
    TRefCountPtr<FWebGPUBuffer> Buffer;
    TArray<uint8> Bytes;
    uint32 Offset = 0;
    EResourceLockMode Mode = RLM_WriteOnly;
};

class FWebGPUTexture final : public FRHITexture
{
  public:
    WGPUTexture Handle;
    WGPUTextureView View;
    WGPUTextureView DepthSampleView = nullptr;
    FWebGPUResourceState State;
    FWebGPUResourceState StencilState;
    TArray<FWebGPUResourceState> SubresourceStates;
    TArray<uint8> InitialBytes;
    TArray<uint8> LockedBytes;
    uint32 LockedMip = MAX_uint32;
    uint32 LockedFace = 0;
    TMap<uint32, WGPUTextureView> AttachmentViews;
    bool SurfaceFrameActive = true;
    FWebGPUTexture(const FRHITextureCreateDesc &Desc, WGPUTexture InHandle)
        : FRHITexture(Desc), Handle(InHandle),
          State(Desc.InitialState), StencilState(Desc.InitialState)
    {
        SubresourceStates.Init(FWebGPUResourceState(Desc.InitialState),
            Desc.NumMips * (Desc.IsTextureCube() ? 6 : 1) - 1);
        WGPUTextureViewDescriptor Sample = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        if (Desc.Dimension == ETextureDimension::TextureCube)
        {
            Sample.dimension = WGPUTextureViewDimension_Cube;
            Sample.arrayLayerCount = 6;
            Sample.usage = WGPUTextureUsage_TextureBinding;
            View = wgpuTextureCreateView(Handle, &Sample);
        }
        else
            View = wgpuTextureCreateView(Handle, nullptr);
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
        check(Mip < GetNumMips() && Face < (GetDesc().IsTextureCube() ? 6u : 1u));
        const uint32 Key = Mip * 6 + Face;
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
        check(LockedMip == MAX_uint32);
        if (DepthSampleView)
            wgpuTextureViewRelease(DepthSampleView);
        for (const auto& Entry : AttachmentViews)
            wgpuTextureViewRelease(Entry.Value);
        wgpuTextureViewRelease(View);
        wgpuTextureRelease(Handle);
    }
};

class FWebGPUTextureUAV final : public FRHIUnorderedAccessView
{
  public:
    WGPUTextureView Handle;
    FWebGPUTextureUAV(FRHITexture* Texture, const FRHIViewDesc& Desc, WGPUTextureView InHandle)
        : FRHIUnorderedAccessView(Texture, Desc), Handle(InHandle) {}
    ~FWebGPUTextureUAV() override { wgpuTextureViewRelease(Handle); }
};

class FWebGPUViewport final : public FRHIViewport
{
  public:
    WGPUSurface Surface = nullptr;
    TRefCountPtr<FWebGPUTexture> BackBuffer;
    WGPUSurfaceConfiguration Configuration = WGPU_SURFACE_CONFIGURATION_INIT;
    void *Window = nullptr;
    uint32 OwnerThread = 0;
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
        wgpuTextureViewRelease(Handle);
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
            wgpuSamplerRelease(Handle);
    }
};

class FWebGPUUniform final : public FRHIUniformBuffer
{
  public:
    TArray<uint8> Bytes;
    explicit FWebGPUUniform(const FRHIUniformBufferLayout *Layout) : FRHIUniformBuffer(Layout)
    {
    }
    void SetContents(TArray<uint8> InBytes, TArray<TRefCountPtr<FRHIResource>> InResources)
    {
        Bytes = MoveTemp(InBytes);
        ResourceTable = MoveTemp(InResources);
    }
};

class FWebGPUVertexDeclaration final : public FRHIVertexDeclaration
{
  public:
    FVertexDeclarationElementList Elements;
    explicit FWebGPUVertexDeclaration(const FVertexDeclarationElementList &InElements) : Elements(InElements)
    {
    }
};

class FWebGPUGraphicsPipeline final : public FRHIGraphicsPipelineState
{
  public:
    WGPURenderPipeline Handle = nullptr;
    FGraphicsPipelineStateInitializer Initializer;
    explicit FWebGPUGraphicsPipeline(const FGraphicsPipelineStateInitializer &In) : Initializer(In)
    {
    }
    ~FWebGPUGraphicsPipeline() override
    {
        if (Handle)
            wgpuRenderPipelineRelease(Handle);
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
    FWebGPUComputePipeline(FRHIComputeShader *Shader, WGPUComputePipeline In)
        : FRHIComputePipelineState(Shader), Handle(In)
    {
    }
    ~FWebGPUComputePipeline() override
    {
        wgpuComputePipelineRelease(Handle);
    }
};

struct FWebGPUReadbackState
{
    WGPUBuffer Handle = nullptr;
    uint32 Size = 0;
    TArray<uint8> Bytes;
    std::atomic<bool> Ready{false};
    ~FWebGPUReadbackState() { if (Handle) wgpuBufferRelease(Handle); }
};
using FWebGPUReadbackRef = TSharedPtr<FWebGPUReadbackState, ESPMode::ThreadSafe>;

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
  public:
    FWebGPUReadbackRef State;
    void* Lock(uint32 Offset, uint32 Size) override
    {
        if (!State || !State->Ready.load())
            return nullptr;
        check(!bIsLocked && uint64(Offset) + Size <= uint64(State->Bytes.Num()));
        bIsLocked = true;
        return State->Bytes.GetData() + Offset;
    }
    void Unlock() override { check(bIsLocked); bIsLocked = false; }
    uint64 GetGPUSizeBytes() const override { return State ? State->Size : 0; }
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
        wgpuCommandBufferRelease(Handle);
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
    TOptional<FPixelFormatInfo> PreviousDepthFormat, PreviousStencilFormat, PreviousShadowFormat;
    WGPUCommandEncoder Encoder = nullptr;
    WGPURenderPassEncoder Pass = nullptr;
    TRefCountPtr<FWebGPUGraphicsPipeline> GraphicsPipeline;
    TRefCountPtr<FWebGPUComputePipeline> ComputePipeline;
    TArray<TRefCountPtr<FWebGPUTexture>> Attachments;
    TArray<FIntPoint> AttachmentSubresources;
    TArray<FString> Errors;
    FString AdapterName;
    uint32 Draws = 0, Dispatches = 0, Finalized = 0, Submitted = 0, BoundGroups = 0;
    uint32 OwnerThread = 0;
    uint32 ResourceTableBindings = 0;
    uint32 TransitionsCreated = 0, TransitionsBegun = 0, TransitionsEnded = 0, TransitionsReleased = 0;
    uint32 AccessChecks = 0;
    uint32 GraphicsPipelinesCreated = 0, ComputePipelinesCreated = 0, VertexDeclarationsCreated = 0, EndFrames = 0;
    uint32 ViewportsCreated = 0, ViewportsResized = 0, FramesAcquired = 0, FramesPresented = 0, FramesSkipped = 0;
    uint32 PostInitCalls = 0;
    uint32 BufferLocksCreated = 0, BufferLocksReleased = 0, BufferUploads = 0, BufferReadLocks = 0;
    uint64 BufferUploadBytes = 0;
    TMap<FRHIBuffer *, FWebGPUBufferLock> BufferLocks;
    uint32 BreadcrumbsBegun = 0, BreadcrumbsEnded = 0, BreadcrumbMarkersEmitted = 0;
    TArray<FRHIBreadcrumbNode *> BreadcrumbStack;
    TMap<const FRHITransition *, TSharedPtr<FWebGPUTransitionData>> Transitions;
    bool ContextOpen = false;
    bool PassDepthReadOnly = false;
    bool GlobalProbeMode = false;
    bool StartupProbeMode = false;

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
    WGPUSampler ResolveSampler(FWebGPUSampler *Sampler);
    bool LoadShader(const FRHICreateShaderDesc &Desc, EShaderFrequency Frequency, FWebGPUShaderData &Data,
                    FString &Error);
    bool ValidateUAV(FRHIBuffer *Buffer, const FRHIViewDesc &Desc, FString &Error) const;
    bool ValidateStructuredView(const FRHIBuffer *Buffer, const FRHIViewDesc::FBuffer &View,
                                EBufferUsageFlags RequiredUsage, FString &Error) const;
    bool ValidateTextureSRV(FRHIViewableResource *Resource, const FRHIViewDesc &Desc, FString &Error) const;
    bool ValidateTextureInitialization(const FRHITextureCreateDesc &Desc, FString &Error) const;
    bool ValidateTextureBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                FString &Error) const;
    bool ValidateBufferSRV(FRHIViewableResource *Resource, const FRHIViewDesc &Desc, FString &Error) const;
    bool ValidateStorageSRVBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                   FString &Error) const;
    bool ValidateStorageUAVBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                   FString &Error) const;
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
    bool ResolveBinding(const FWebGPUShaderData &Shader, const FJsonObject &Binding, FRHIResource *&Resource,
                        bool &FromTable, FString &Error) const;
    FWebGPUShaderData &ShaderData(FRHIShader *Shader);
    void Bind(FWebGPUShaderData &Shader, const FRHIShaderParameterResource &Parameter);
    void Parameters(FWebGPUShaderData &Shader, TConstArrayView<uint8>, TConstArrayView<FRHIShaderParameter>,
                    TConstArrayView<FRHIShaderParameterResource>, TConstArrayView<FRHIShaderParameterResource>);
    TArray<WGPUBindGroup> CreateGroups(WGPURenderPipeline Render, WGPUComputePipeline Compute,
                                       TConstArrayView<FWebGPUShaderData *> Shaders);
    TArray<uint8> ReadBuffer(FRHIBuffer *Source, uint64 Bytes);
    TArray<uint8> MapBuffer(WGPUBuffer Buffer, uint64 Bytes);
    void SubmitCurrent();
    bool ValidateViewport(void *Window, uint32 Width, uint32 Height, bool Fullscreen, EPixelFormat Format,
                          FString &Error) const;
    FViewportRHIRef RHICreateViewport(void *, uint32, uint32, bool, EPixelFormat) override;
    void RHIResizeViewport(FRHIViewport *, uint32, uint32, bool, EPixelFormat) override;
    FTextureRHIRef RHIGetViewportBackBuffer(FRHIViewport *) override;
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
    void RHISetStreamSource(uint32, FRHIBuffer *, uint32) override;
    void RHISetViewport(float, float, float, float, float, float) override;
    void RHISetScissorRect(bool, uint32, uint32, uint32, uint32) override;
    void RHIDrawPrimitive(uint32, uint32, uint32) override;
    void RHIDrawIndexedPrimitive(FRHIBuffer *, int32, uint32, uint32, uint32, uint32, uint32) override;
    void RHIDispatchComputeShader(uint32, uint32, uint32) override;
    void RHIClearUAVUint(FRHIUnorderedAccessView*, const FUintVector4&) override;
    void RHICopyTexture(FRHITexture *, FRHITexture *, const FRHICopyTextureInfo &) override;
    void RHICopyBufferRegion(FRHIBuffer *, uint64, FRHIBuffer *, uint64, uint64) override;
    void RHIReadSurfaceData(FRHITexture *, FIntRect, TArray<FColor> &, FReadSurfaceDataFlags) override;
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
    void SetDrawBindings();
    TArray<TRefCountPtr<FRHIUniformBuffer>> StaticUniformBuffers;
    TArray<FWebGPUReadbackRef> PendingReadbacks;
    TArray<FWebGPUFenceRef> PendingFences;
};
