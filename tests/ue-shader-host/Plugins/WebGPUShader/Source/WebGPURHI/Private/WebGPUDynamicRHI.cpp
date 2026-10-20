#include "WebGPUDynamicRHI.h"
#include "DataDrivenShaderPlatformInfo.h"
#include "GlobalRenderResources.h"
#include "RenderResource.h"
#include "Containers/ResourceArray.h"
#include "RHITextureUtils.h"

#include "HAL/PlatformProcess.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformTLS.h"
#include "Misc/FileHelper.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderParameterStruct.h"

namespace
{
struct FWebGPUCompletion
{
    bool Done = false;
    bool Success = false;
};
using FWebGPUCompletionRef = TSharedPtr<FWebGPUCompletion, ESPMode::ThreadSafe>;
void UniformSnapshot(const void *Contents, const FRHIUniformBufferLayout &Layout, TArray<uint8> &Bytes,
                     TArray<TRefCountPtr<FRHIResource>> &Resources)
{
    check(Contents && !EnumHasAnyFlags(Layout.Flags, ERHIUniformBufferFlags::UniformView));
    Bytes.Append(static_cast<const uint8 *>(Contents), Layout.ConstantBufferSize);
    for (const auto &Member : Layout.Resources)
        Resources.Add(GetShaderParameterResourceRHI(Contents, Member.MemberOffset, Member.MemberType));
}
WGPUStringView Text(const ANSICHAR *Value)
{
    return {Value, size_t(FCStringAnsi::Strlen(Value))};
}
FString String(WGPUStringView Value)
{
    return Value.data
               ? FString(FUTF8ToTCHAR(Value.data, Value.length == WGPU_STRLEN ? FCStringAnsi::Strlen(Value.data)
                                                                              : static_cast<int32>(Value.length)))
               : FString();
}
bool IsUnsignedTextureFormat(EPixelFormat Value)
{
    return Value == PF_R8G8B8A8_UINT || Value == PF_R32_UINT || Value == PF_R16_UINT;
}
bool IsSampled2DTextureFormat(EPixelFormat Value)
{
    return Value == PF_R8G8B8A8 || Value == PF_B8G8R8A8 || Value == PF_G8 || Value == PF_R8 ||
           Value == PF_R8G8 || Value == PF_FloatRGBA ||
           IsUnsignedTextureFormat(Value);
}
WGPUTextureFormat Format(EPixelFormat Value, bool SRGB = false)
{
    switch (Value)
    {
    case PF_R8G8B8A8:
        return SRGB ? WGPUTextureFormat_RGBA8UnormSrgb : WGPUTextureFormat_RGBA8Unorm;
    case PF_B8G8R8A8:
        return SRGB ? WGPUTextureFormat_BGRA8UnormSrgb : WGPUTextureFormat_BGRA8Unorm;
    case PF_G8:
    case PF_R8:
        return WGPUTextureFormat_R8Unorm;
    case PF_R8G8:
        return WGPUTextureFormat_RG8Unorm;
    case PF_FloatRGBA:
        return WGPUTextureFormat_RGBA16Float;
    case PF_R8G8B8A8_UINT:
        return WGPUTextureFormat_RGBA8Uint;
    case PF_R32_UINT:
        return WGPUTextureFormat_R32Uint;
    case PF_R16_UINT:
        return WGPUTextureFormat_R16Uint;
    case PF_DepthStencil:
        return WGPUTextureFormat_Depth24PlusStencil8;
    default:
        checkf(false, TEXT("WebGPURHI pixel format unsupported: %d"), Value);
        return WGPUTextureFormat_Undefined;
    }
}
WGPULoadOp Load(ERenderTargetActions Action)
{
    return GetLoadAction(Action) == ERenderTargetLoadAction::ELoad ? WGPULoadOp_Load : WGPULoadOp_Clear;
}
WGPUStoreOp Store(ERenderTargetActions Action)
{
    check(GetStoreAction(Action) != ERenderTargetStoreAction::EMultisampleResolve);
    return GetStoreAction(Action) == ERenderTargetStoreAction::EStore ? WGPUStoreOp_Store : WGPUStoreOp_Discard;
}
uint32 VertexCount(EPrimitiveType Type, uint32 Primitives)
{
    check(Type == PT_TriangleList || Type == PT_TriangleStrip);
    return Type == PT_TriangleList ? Primitives * 3 : Primitives + 2;
}
WGPUCompareFunction Compare(ECompareFunction In)
{
    switch (In)
    {
    case CF_Less:
        return WGPUCompareFunction_Less;
    case CF_LessEqual:
        return WGPUCompareFunction_LessEqual;
    case CF_Greater:
        return WGPUCompareFunction_Greater;
    case CF_GreaterEqual:
        return WGPUCompareFunction_GreaterEqual;
    case CF_Equal:
        return WGPUCompareFunction_Equal;
    case CF_NotEqual:
        return WGPUCompareFunction_NotEqual;
    case CF_Never:
        return WGPUCompareFunction_Never;
    case CF_Always:
        return WGPUCompareFunction_Always;
    default:
        checkNoEntry();
        return WGPUCompareFunction_Undefined;
    }
}
WGPUBlendFactor BlendFactor(EBlendFactor In)
{
    switch (In)
    {
    case BF_Zero:
        return WGPUBlendFactor_Zero;
    case BF_One:
        return WGPUBlendFactor_One;
    case BF_SourceColor:
        return WGPUBlendFactor_Src;
    case BF_InverseSourceColor:
        return WGPUBlendFactor_OneMinusSrc;
    case BF_SourceAlpha:
        return WGPUBlendFactor_SrcAlpha;
    case BF_InverseSourceAlpha:
        return WGPUBlendFactor_OneMinusSrcAlpha;
    case BF_DestAlpha:
        return WGPUBlendFactor_DstAlpha;
    case BF_InverseDestAlpha:
        return WGPUBlendFactor_OneMinusDstAlpha;
    case BF_DestColor:
        return WGPUBlendFactor_Dst;
    case BF_InverseDestColor:
        return WGPUBlendFactor_OneMinusDst;
    default:
        checkf(false, TEXT("WebGPU blend factor unsupported: %d"), In);
        return WGPUBlendFactor_Undefined;
    }
}
WGPUBlendOperation BlendOperation(EBlendOperation In)
{
    switch (In)
    {
    case BO_Add:
        return WGPUBlendOperation_Add;
    case BO_Subtract:
        return WGPUBlendOperation_Subtract;
    case BO_ReverseSubtract:
        return WGPUBlendOperation_ReverseSubtract;
    case BO_Min:
        return WGPUBlendOperation_Min;
    case BO_Max:
        return WGPUBlendOperation_Max;
    default:
        checkNoEntry();
        return WGPUBlendOperation_Undefined;
    }
}
struct FBufferInitializer : FRHIBufferInitializer
{
    FBufferInitializer(FRHICommandListBase &Cmd, FWebGPUBuffer *Buffer, FWebGPUDynamicRHI &RHI, bool Writable)
        : FRHIBufferInitializer(
              Cmd, Buffer, Writable ? Buffer->InitialBytes.GetData() : nullptr,
              Writable ? Buffer->InitialBytes.Num() : 0,
              [Buffer = TRefCountPtr<FWebGPUBuffer>(Buffer), &RHI](FRHICommandListBase &) mutable -> FBufferRHIRef {
                  if (!Buffer->InitialBytes.IsEmpty())
                      wgpuQueueWriteBuffer(RHI.Queue, Buffer->Handle, 0, Buffer->InitialBytes.GetData(),
                                           Buffer->InitialBytes.Num());
                  Buffer->InitialBytes.Reset();
                  return FBufferRHIRef(Buffer.GetReference());
              })
    {
    }
};
void WriteTextureMip(FWebGPUDynamicRHI &RHI, FWebGPUTexture *Texture, uint32 Mip, const uint8 *Bytes, uint64 Size)
{
    uint64 Stride;
    check(UE::RHITextureUtils::CalculateTextureMipSize(Texture->GetDesc(), Mip, Stride) == Size);
    const auto Extents = UE::RHITextureUtils::CalculateMipExtents(Texture->GetDesc(), Mip);
    WGPUTexelCopyTextureInfo Destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    Destination.texture = Texture->Handle;
    Destination.mipLevel = Mip;
    WGPUTexelCopyBufferLayout Layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
    Layout.bytesPerRow = Stride;
    Layout.rowsPerImage = Extents.Y;
    WGPUExtent3D Extent{Extents.X, Extents.Y, Extents.Z};
    wgpuQueueWriteTexture(RHI.Queue, &Destination, Bytes, Size, &Layout, &Extent);
    if (RHI.StartupProbeMode)
        UE_LOG(LogRHI, Display, TEXT("P3_TEXTURE_UPLOAD name=%s mip=%u extent=%ux%ux%u bytes=%llu"),
               *Texture->GetName().ToString(), Mip, Extent.width, Extent.height, Extent.depthOrArrayLayers, Size);
}
struct FTextureInitializer : FRHITextureInitializer
{
    FTextureInitializer(FRHICommandListBase &Cmd, FWebGPUTexture *Texture, FWebGPUDynamicRHI &RHI, bool Writable)
        : FRHITextureInitializer(
              Cmd, Texture, Writable ? Texture->InitialBytes.GetData() : nullptr,
              Writable ? Texture->InitialBytes.Num() : 0,
              [Texture = TRefCountPtr<FWebGPUTexture>(Texture), &RHI](FRHICommandListBase &) mutable -> FTextureRHIRef {
                  if (!Texture->InitialBytes.IsEmpty())
                  {
                      for (uint32 Mip = 0; Mip < Texture->GetNumMips(); ++Mip)
                      {
                          uint64 Stride, Size;
                          const uint64 Offset = UE::RHITextureUtils::CalculateSubresourceOffset(
                              Texture->GetDesc(), 0, 0, Mip, Stride, Size);
                          WriteTextureMip(RHI, Texture, Mip, Texture->InitialBytes.GetData() + Offset, Size);
                      }
                      Texture->InitialBytes.Reset();
                      if (RHI.StartupProbeMode)
                          UE_LOG(LogRHI, Display,
                                 TEXT("P2_STARTUP Texture uploaded name=%s dimension=%u format=%u depth=%u"),
                                 *Texture->GetName().ToString(), uint32(Texture->GetDesc().Dimension),
                                 uint32(Texture->GetFormat()), uint32(Texture->GetSizeXYZ().Z));
                  }
                  return FTextureRHIRef(Texture.GetReference());
              },
              [Texture, Writable](FSubresourceIndex Index) -> FRHITextureSubresourceInitializer {
    check(Writable && uint32(Index.MipIndex) < uint32(Texture->GetNumMips()) && Index.ArrayIndex == 0 && Index.FaceIndex == 0 &&
                        !Texture->InitialBytes.IsEmpty());
                  uint64 Stride, Size;
                  const uint64 Offset = UE::RHITextureUtils::CalculateSubresourceOffset(
                      Texture->GetDesc(), 0, 0, Index.MipIndex, Stride, Size);
                  return {Texture->InitialBytes.GetData() + Offset, Size, Stride};
              })
    {
    }
};
} // namespace

FWebGPUDynamicRHI::FWebGPUDynamicRHI(bool InStartupProbe) : StartupProbeMode(InStartupProbe)
{
    if (!StartupProbeMode)
        return;
    ConfigureStartup();
}

void FWebGPUDynamicRHI::ConfigureStartup()
{
    StartupProbeMode = true;
    GlobalProbeMode = true;
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    GMaxRHIFeatureLevel = ERHIFeatureLevel::ES3_1;
    GMaxRHIShaderPlatform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_ES31"));
#else
    GMaxRHIFeatureLevel = ERHIFeatureLevel::SM5;
    GMaxRHIShaderPlatform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
#endif
    check(GMaxRHIShaderPlatform != SP_NumPlatforms);
    for (uint32 Index = 0; Index < ERHIFeatureLevel::Num; ++Index)
        GShaderPlatformForFeatureLevel[Index] = SP_NumPlatforms;
    GShaderPlatformForFeatureLevel[GMaxRHIFeatureLevel] = GMaxRHIShaderPlatform;
    GRHISupportsRHIThread = false;
    GRHISupportsRHIOnTaskThread = false;
    GRHISupportsParallelRHIExecute = false;
    GRHISupportsMultithreadedResources = false;
    GRHISupportsMultithreadedShaderCreation = false;
    GRHISupportsAsyncPipelinePrecompile = false;
    GRHISupportsPSOPrecaching = false;
    GRHISupportsPipelineFileCache = false;
    GRHISupportsTextureStreaming = false;
    // Slate also presents empty render graphs, which need an explicit final transition.
    GRHIGlobals.NeedsExtraTransitions = true;
    GRHITransitionPrivateData_SizeInBytes = sizeof(FWebGPUTransitionPrivateData);
    GRHITransitionPrivateData_AlignInBytes = alignof(FWebGPUTransitionPrivateData);
    UE_LOG(LogRHI, Display, TEXT("P2_STARTUP factory selected WebGPU platform=%u format=%s featureLevel=%u"),
        uint32(GMaxRHIShaderPlatform), *FDataDrivenShaderPlatformInfo::GetShaderFormat(GMaxRHIShaderPlatform).ToString(),
        uint32(GMaxRHIFeatureLevel));
}

void FWebGPUDynamicRHI::RequireOwner() const
{
    checkf(OwnerThread == FPlatformTLS::GetCurrentThreadId(),
           TEXT("WebGPURHI currently requires a single owner thread"));
}
bool FWebGPUDynamicRHI::Wait(TFunctionRef<bool()> Complete)
{
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    checkf(Complete(), TEXT("Synchronous GPU completion is not supported on the browser main thread."));
    return Complete();
#else
    const double Deadline = FPlatformTime::Seconds() + 20;
    while (!Complete() && FPlatformTime::Seconds() < Deadline)
    {
        wgpuInstanceProcessEvents(Instance);
        FPlatformProcess::SleepNoStats(0.001f);
    }
    if (!Complete())
        Errors.Add(TEXT("WebGPU callback timeout"));
    return Complete();
#endif
}
#if defined(PLATFORM_WEB) && PLATFORM_WEB
void FWebGPUDynamicRHI::BeginBrowserDevice(void (*Completion)(bool))
{
    check(!Instance && Completion);
    OwnerThread = FPlatformTLS::GetCurrentThreadId();
    BrowserCompletion = Completion;
    WGPUInstanceDescriptor Descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
    Instance = wgpuCreateInstance(&Descriptor);
    check(Instance);
    WGPURequestAdapterOptions Options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    Options.powerPreference = WGPUPowerPreference_HighPerformance;
    WGPURequestAdapterCallbackInfo Callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    Callback.mode = WGPUCallbackMode_AllowSpontaneous;
    Callback.userdata1 = this;
    Callback.callback = [](WGPURequestAdapterStatus Status, WGPUAdapter Adapter, WGPUStringView Message,
                           void* Opaque, void*) {
        auto& RHI = *static_cast<FWebGPUDynamicRHI*>(Opaque);
        RHI.Adapter = Adapter;
        if (Status != WGPURequestAdapterStatus_Success || !Adapter)
        {
            RHI.Errors.Add(TEXT("Browser adapter: ") + String(Message));
            RHI.BrowserCompletion(false);
            return;
        }
        WGPUDeviceDescriptor DeviceDesc = WGPU_DEVICE_DESCRIPTOR_INIT;
        DeviceDesc.uncapturedErrorCallbackInfo.userdata1 = &RHI;
        DeviceDesc.uncapturedErrorCallbackInfo.callback = [](WGPUDevice const*, WGPUErrorType,
                                                            WGPUStringView Message, void* Self, void*) {
            auto& Owner = *static_cast<FWebGPUDynamicRHI*>(Self);
            Owner.Errors.Add(TEXT("GPU validation: ") + String(Message));
            UE_LOG(LogRHI, Error, TEXT("%s"), *Owner.Errors.Last());
        };
        WGPURequestDeviceCallbackInfo DeviceCallback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        DeviceCallback.mode = WGPUCallbackMode_AllowSpontaneous;
        DeviceCallback.userdata1 = &RHI;
        DeviceCallback.callback = [](WGPURequestDeviceStatus Status, WGPUDevice Device, WGPUStringView Message,
                                     void* Self, void*) {
            auto& Owner = *static_cast<FWebGPUDynamicRHI*>(Self);
            Owner.Device = Device;
            if (Status != WGPURequestDeviceStatus_Success || !Device)
                Owner.Errors.Add(TEXT("Browser device: ") + String(Message));
            Owner.BrowserCompletion(Device && Owner.Errors.IsEmpty());
        };
        wgpuAdapterRequestDevice(Adapter, &DeviceDesc, DeviceCallback);
    };
    wgpuInstanceRequestAdapter(Instance, &Options, Callback);
}
#endif
void FWebGPUDynamicRHI::Init()
{
    OwnerThread = FPlatformTLS::GetCurrentThreadId();
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    check(Instance && Adapter && Device && Errors.IsEmpty());
    AdapterName = TEXT("Browser WebGPU");
#else
    WGPUInstanceDescriptor InstanceDesc = WGPU_INSTANCE_DESCRIPTOR_INIT;
    Instance = wgpuCreateInstance(&InstanceDesc);
    check(Instance);
    bool AdapterDone = false;
    WGPURequestAdapterOptions Options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    Options.backendType = WGPUBackendType_D3D12;
    Options.powerPreference = WGPUPowerPreference_HighPerformance;
    WGPURequestAdapterCallbackInfo AdapterCallback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    AdapterCallback.mode = WGPUCallbackMode_AllowProcessEvents;
    AdapterCallback.userdata1 = this;
    AdapterCallback.userdata2 = &AdapterDone;
    AdapterCallback.callback = [](WGPURequestAdapterStatus Status, WGPUAdapter Value, WGPUStringView Message,
                                  void *Self, void *Done) {
        auto &RHI = *static_cast<FWebGPUDynamicRHI *>(Self);
        RHI.Adapter = Value;
        if (Status != WGPURequestAdapterStatus_Success)
            RHI.Errors.Add(TEXT("Adapter: ") + String(Message));
        *static_cast<bool *>(Done) = true;
    };
    wgpuInstanceRequestAdapter(Instance, &Options, AdapterCallback);
    check(Wait([&] { return AdapterDone; }) && Adapter);
    WGPUAdapterInfo Info = WGPU_ADAPTER_INFO_INIT;
    wgpuAdapterGetInfo(Adapter, &Info);
    AdapterName = String(Info.description) + TEXT(" ") + String(Info.device);
    wgpuAdapterInfoFreeMembers(Info);
    bool DeviceDone = false;
    WGPUDeviceDescriptor Desc = WGPU_DEVICE_DESCRIPTOR_INIT;
    Desc.uncapturedErrorCallbackInfo.userdata1 = this;
    Desc.uncapturedErrorCallbackInfo.callback = [](WGPUDevice const *, WGPUErrorType, WGPUStringView Message,
                                                   void *Self, void *) {
        static_cast<FWebGPUDynamicRHI *>(Self)->Errors.Add(TEXT("GPU validation: ") + String(Message));
    };
    WGPURequestDeviceCallbackInfo Callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    Callback.mode = WGPUCallbackMode_AllowProcessEvents;
    Callback.userdata1 = this;
    Callback.userdata2 = &DeviceDone;
    Callback.callback = [](WGPURequestDeviceStatus Status, WGPUDevice Value, WGPUStringView Message, void *Self,
                           void *Done) {
        auto &RHI = *static_cast<FWebGPUDynamicRHI *>(Self);
        RHI.Device = Value;
        if (Status != WGPURequestDeviceStatus_Success)
            RHI.Errors.Add(TEXT("Device: ") + String(Message));
        *static_cast<bool *>(Done) = true;
    };
    wgpuAdapterRequestDevice(Adapter, &Desc, Callback);
    check(Wait([&] { return DeviceDone; }) && Device);
#endif
    check(wgpuDeviceGetLimits(Device, &Limits) == WGPUStatus_Success);
    check(!PreviousDepthFormat.IsSet() && !PreviousStencilFormat.IsSet());
    PreviousDepthFormat = GPixelFormats[PF_DepthStencil];
    PreviousStencilFormat = GPixelFormats[PF_X24_G8];
    auto& DepthFormat = GPixelFormats[PF_DepthStencil];
    DepthFormat.Supported = true;
    DepthFormat.PlatformFormat = WGPUTextureFormat_Depth24PlusStencil8;
    DepthFormat.Capabilities = EPixelFormatCapabilities::Texture2D | EPixelFormatCapabilities::DepthStencil |
        EPixelFormatCapabilities::TextureLoad;
    auto& StencilFormat = GPixelFormats[PF_X24_G8];
    StencilFormat.Supported = true;
    StencilFormat.PlatformFormat = WGPUTextureFormat_Stencil8;
    StencilFormat.Capabilities = EPixelFormatCapabilities::Texture2D | EPixelFormatCapabilities::TextureLoad;
    Queue = wgpuDeviceGetQueue(Device);
    if (StartupProbeMode || GlobalProbeMode)
        GRHIMaxDispatchThreadGroupsPerDimension = FIntVector(Limits.maxComputeWorkgroupsPerDimension);
    if (StartupProbeMode)
    {
#if defined(PLATFORM_WEB) && PLATFORM_WEB
        IConsoleVariable* BackBufferFormat =
            IConsoleManager::Get().FindConsoleVariable(TEXT("r.DefaultBackBufferPixelFormat"));
        check(BackBufferFormat);
        BackBufferFormat->Set(0, ECVF_SetByCode);
        UE_LOG(LogRHI, Display, TEXT("P3_WEB windowed canvas backbuffer setting=%d"), BackBufferFormat->GetInt());
#endif
        GRHIAdapterName = AdapterName;
        GMaxTextureDimensions = Limits.maxTextureDimension2D;
        GMaxTextureMipCount = FMath::Min<uint32>(MAX_TEXTURE_MIP_COUNT,
                                               FMath::FloorLog2(Limits.maxTextureDimension2D) + 1);
        GUsingNullRHI = false;
        if (FParse::Param(FCommandLine::Get(), TEXT("WebMinimalStartup")))
        {
            // Installed RenderCore cannot be rebuilt here; unregister only audited optional defaults before InitRHI.
            check(!GIsRHIInitialized);
            const struct
            {
                const TCHAR *Name;
                FTexture *Resource;
            } OptionalDefaults[] = {{TEXT("GBlackArrayTexture"), GBlackArrayTexture},
                                    {TEXT("GWhiteTextureCube"), GWhiteTextureCube},
                                    {TEXT("GBlackTextureCube"), GBlackTextureCube},
                                    {TEXT("GBlackTextureDepthCube"), GBlackTextureDepthCube},
                                    {TEXT("GBlackCubeArrayTexture"), GBlackCubeArrayTexture},
                                    {TEXT("GBlackUintTexture"), GBlackUintTexture}};
            for (const auto &Entry : OptionalDefaults)
            {
                check(Entry.Resource && Entry.Resource->IsInitialized() && !Entry.Resource->TextureRHI &&
                      !Entry.Resource->SamplerStateRHI);
                Entry.Resource->ReleaseResource();
                check(!Entry.Resource->IsInitialized());
                UE_LOG(LogRHI, Display, TEXT("P2_STARTUP optional default unregistered name=%s"), Entry.Name);
            }
        }
        UE_LOG(LogRHI, Display, TEXT("P2_STARTUP device initialized; initializing pre-RHI resources"));
        FRenderResource::InitPreRHIResources();
        GIsRHIInitialized = true;
        UE_LOG(LogRHI, Display, TEXT("P2_STARTUP pre-RHI resources initialized"));
    }
}
void FWebGPUDynamicRHI::Shutdown()
{
    RequireOwner();
    check(!Pass && !Encoder && !ContextOpen && Transitions.IsEmpty() && BreadcrumbStack.IsEmpty() &&
          BufferLocks.IsEmpty());
    ReleaseBindings();
    if (Queue)
    {
        wgpuQueueRelease(Queue);
        Queue = nullptr;
    }
    if (Device)
    {
        wgpuDeviceRelease(Device);
        Device = nullptr;
    }
    if (Adapter)
    {
        wgpuAdapterRelease(Adapter);
        Adapter = nullptr;
    }
    if (Instance)
    {
        wgpuInstanceRelease(Instance);
        Instance = nullptr;
    }
    if (PreviousDepthFormat.IsSet())
    {
        GPixelFormats[PF_DepthStencil] = PreviousDepthFormat.GetValue();
        GPixelFormats[PF_X24_G8] = PreviousStencilFormat.GetValue();
        PreviousDepthFormat.Reset();
        PreviousStencilFormat.Reset();
    }
}
void FWebGPUDynamicRHI::PostInit()
{
    RequireOwner();
    check(Device && PixelFormatBlockBytes.Num() == PF_MAX && PixelFormatBlockBytes[PF_R8G8B8A8] == 4 &&
          PixelFormatBlockBytes[PF_B8G8R8A8] == 4);
    ++PostInitCalls;
}
void FWebGPUDynamicRHI::ReleaseBindings()
{
    RequireOwner();
    check(!Pass);
    GraphicsPipeline.SafeRelease();
    ComputePipeline.SafeRelease();
    VertexBuffers.Reset();
    VertexOffsets.Reset();
    Attachments.Reset();
    StaticUniformBuffers.Reset();
}
void FWebGPUDynamicRHI::RHIEndFrame(const FRHIEndFrameArgs &Args)
{
    RequireOwner();
    check(!ContextOpen && !Pass && !Args.bProfileNextFrame);
    ++EndFrames;
}
FWebGPUDynamicRHI::~FWebGPUDynamicRHI()
{
    if (Instance)
        Shutdown();
}
WGPUBuffer FWebGPUDynamicRHI::CreateBuffer(uint64 Size, WGPUBufferUsage Usage, const void *Data)
{
    RequireOwner();
    WGPUBufferDescriptor Desc = WGPU_BUFFER_DESCRIPTOR_INIT;
    Desc.size = Align(Size, uint64(4));
    Desc.usage = Usage | WGPUBufferUsage_CopyDst;
    WGPUBuffer Result = wgpuDeviceCreateBuffer(Device, &Desc);
    if (Data)
        wgpuQueueWriteBuffer(Queue, Result, 0, Data, Size);
    return Result;
}
bool FWebGPUDynamicRHI::LoadShader(const FRHICreateShaderDesc &Desc, EShaderFrequency Frequency,
                                   FWebGPUShaderData &Data, FString &Error)
{
    const auto Fail = [&](const TCHAR *Reason) {
        Error = Reason;
        return false;
    };
    if (Desc.Code.Num() < 28)
        return Fail(TEXT("Web shader header truncated"));
    uint32 Header[7];
    FMemory::Memcpy(Header, Desc.Code.GetData(), sizeof(Header));
    if (Header[0] != 0x53475057 || Header[1] != 1 || Header[2] != 28 ||
        Header[3] != uint32(Frequency))
        return Fail(TEXT("Web shader header/frequency invalid"));
    const uint64 PayloadSize = uint64(28) + Header[5] + Header[6];
    const uint64 TotalSize = uint64(Desc.Code.Num());
    if (PayloadSize > TotalSize)
        return Fail(TEXT("Web shader payload truncated"));
    // Cooked UE code includes optional attachments and their size footer; standalone packets omit them.
    if (PayloadSize != TotalSize)
    {
        if (TotalSize - PayloadSize < sizeof(int32))
            return Fail(TEXT("Web shader optional-data footer truncated"));
        int32 OptionalSize;
        FMemory::Memcpy(&OptionalSize, Desc.Code.GetData() + TotalSize - sizeof(int32), sizeof(int32));
        if (OptionalSize < int32(sizeof(int32)) || uint64(OptionalSize) != TotalSize - PayloadSize)
            return Fail(TEXT("Web shader optional-data size invalid"));
        uint64 Cursor = PayloadSize;
        const uint64 End = TotalSize - sizeof(int32);
        while (Cursor < End)
        {
            if (End - Cursor < sizeof(uint8) + sizeof(uint32))
                return Fail(TEXT("Web shader optional-data header truncated"));
            uint32 Size;
            FMemory::Memcpy(&Size, Desc.Code.GetData() + Cursor + sizeof(uint8), sizeof(uint32));
            Cursor += sizeof(uint8) + sizeof(uint32);
            if (Size > End - Cursor)
                return Fail(TEXT("Web shader optional-data value truncated"));
            Cursor += Size;
        }
    }
    const ANSICHAR *Utf8 = reinterpret_cast<const ANSICHAR *>(Desc.Code.GetData() + 28);
    const FString Json(FUTF8ToTCHAR(Utf8, Header[5]));
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Data.Metadata) || !Data.Metadata)
        return Fail(TEXT("Web shader metadata invalid"));
    const auto &Metadata = Data.Metadata;
    double PlatformValue, HashValue, Version, MetadataFrequency;
    FString PlatformName, FormatName;
    bool Verified = false;
    double Schema;
    if (!Metadata->TryGetNumberField(TEXT("schema"), Schema) || Schema != Header[1] ||
        !Metadata->TryGetNumberField(TEXT("shaderPlatformEnum"), PlatformValue) ||
        !Metadata->TryGetNumberField(TEXT("shaderPlatformPropertiesHash"), HashValue) ||
        !Metadata->TryGetNumberField(TEXT("formatVersion"), Version) ||
        !Metadata->TryGetNumberField(TEXT("frequency"), MetadataFrequency) ||
        !Metadata->TryGetStringField(TEXT("shaderPlatform"), PlatformName) ||
        !Metadata->TryGetStringField(TEXT("format"), FormatName) ||
        !Metadata->TryGetBoolField(TEXT("bindingContractVerified"), Verified) || !Verified || Version != Header[4] ||
        MetadataFrequency != uint32(Frequency))
        return Fail(TEXT("Web shader metadata/header mismatch"));
    if ((PlatformValue != 46 && PlatformValue != 47) || HashValue < 0 || HashValue > MAX_uint32 ||
        HashValue != FMath::FloorToDouble(HashValue))
        return Fail(TEXT("Web shader platform is not a registered Web platform"));
    const auto Platform = EShaderPlatform(uint32(PlatformValue));
    if (!FDataDrivenShaderPlatformInfo::IsValid(Platform) ||
        FDataDrivenShaderPlatformInfo::GetName(Platform) != FName(*PlatformName) ||
        FDataDrivenShaderPlatformInfo::GetShaderPlatformPropertiesHash(Platform) != uint32(HashValue) ||
        LegacyShaderPlatformToShaderFormat(Platform) != FName(*FormatName))
        return Fail(TEXT("Web shader DDPI platform/configuration mismatch"));
    if (!Metadata->TryGetStringField(TEXT("webEntry"), Data.Entry))
        return Fail(TEXT("Web shader entry missing"));
    const TSharedPtr<FJsonObject> *TableJson = nullptr;
    if (!Metadata->TryGetObjectField(TEXT("resourceTable"), TableJson))
        return Fail(TEXT("Web shader resource table missing"));
    Data.ResourceTable.ResourceTableBits = uint32((*TableJson)->GetNumberField(TEXT("bits")));
    const auto ReadNumbers = [&](const TCHAR *Name, TArray<uint32> &Out) {
        Out.Reset();
        const TArray<TSharedPtr<FJsonValue>> *Array = nullptr;
        if (!(*TableJson)->TryGetArrayField(Name, Array))
            return false;
        for (const auto &Value : *Array)
        {
            double Number;
            if (!Value->TryGetNumber(Number) || Number < 0 || Number > MAX_uint32 ||
                Number != FMath::FloorToDouble(Number))
                return false;
            Out.Add(uint32(Number));
        }
        return true;
    };
    if (!ReadNumbers(TEXT("textures"), Data.ResourceTable.TextureMap) ||
        !ReadNumbers(TEXT("samplers"), Data.ResourceTable.SamplerMap) ||
        !ReadNumbers(TEXT("srvs"), Data.ResourceTable.ShaderResourceViewMap) ||
        !ReadNumbers(TEXT("uavs"), Data.ResourceTable.UnorderedAccessViewMap) ||
        !ReadNumbers(TEXT("layoutHashes"), Data.ResourceTable.ResourceTableLayoutHashes))
        return Fail(TEXT("Web shader resource table malformed"));
    const FString Source(FUTF8ToTCHAR(Utf8 + Header[5], Header[6]));
    const FTCHARToUTF8 Code(*Source);
    WGPUShaderSourceWGSL WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
    WGSL.code = {Code.Get(), size_t(Code.Length())};
    WGPUShaderModuleDescriptor ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    ModuleDesc.nextInChain = &WGSL.chain;
    Data.Module = wgpuDeviceCreateShaderModule(Device, &ModuleDesc);
    for (const auto &Item : Metadata->GetArrayField(TEXT("spirvBindings")))
        if (Item->AsObject()->GetStringField(TEXT("name")) == TEXT("$Globals"))
            Data.Globals.SetNumZeroed(Item->AsObject()->GetIntegerField(TEXT("paddedSize")));
    return Data.Module != nullptr;
}
FWebGPUShaderData &FWebGPUDynamicRHI::ShaderData(FRHIShader *Shader)
{
    switch (Shader->GetFrequency())
    {
    case SF_Vertex:
        return static_cast<FWebGPUVertexShader *>(Shader)->Data;
    case SF_Pixel:
        return static_cast<FWebGPUPixelShader *>(Shader)->Data;
    case SF_Compute:
        return static_cast<FWebGPUComputeShader *>(Shader)->Data;
    default:
        checkNoEntry();
        return static_cast<FWebGPUVertexShader *>(Shader)->Data;
    }
}
#define WEBGPU_CREATE_SHADER(Stage)                                                                                    \
    F##Stage##ShaderRHIRef FWebGPUDynamicRHI::RHICreate##Stage##Shader(const FRHICreateShaderDesc &Desc)               \
    {                                                                                                                  \
        RequireOwner();                                                                                                \
        TRefCountPtr<FWebGPU##Stage##Shader> Shader = new FWebGPU##Stage##Shader();                                    \
        FString Error;                                                                                                 \
        checkf(LoadShader(Desc, SF_##Stage, Shader->Data, Error), TEXT("%s"), *Error);                                 \
        Shader->SetHash(FShaderHash(FXxHash64::HashBuffer(Desc.Code.GetData(), Desc.Code.Num())));                     \
        return F##Stage##ShaderRHIRef(Shader.GetReference());                                                          \
    }
WEBGPU_CREATE_SHADER(Vertex)
WEBGPU_CREATE_SHADER(Pixel)
WEBGPU_CREATE_SHADER(Compute)
#undef WEBGPU_CREATE_SHADER

FSamplerStateRHIRef FWebGPUDynamicRHI::RHICreateSamplerState(const FSamplerStateInitializerRHI &In)
{
    if (StartupProbeMode)
        UE_LOG(LogRHI, Display, TEXT("P2_STARTUP sampler descriptor retained filter=%u comparison=%u"),
               uint32(In.Filter), uint32(In.SamplerComparisonFunction));
    return new FWebGPUSampler(In);
}
WGPUSampler FWebGPUDynamicRHI::ResolveSampler(FWebGPUSampler *Sampler)
{
    RequireOwner();
    if (Sampler->Handle)
        return Sampler->Handle;
    const auto &In = Sampler->Initializer;
    checkf(In.Filter == SF_Point && In.MipBias == 0 && In.SamplerComparisonFunction == SCF_Never,
           TEXT("WebGPU sampler binding only supports point filtering without mip bias or comparison"));
    const auto Address = [](ESamplerAddressMode Mode) {
        check(Mode == AM_Wrap || Mode == AM_Clamp || Mode == AM_Mirror);
        return Mode == AM_Wrap     ? WGPUAddressMode_Repeat
               : Mode == AM_Mirror ? WGPUAddressMode_MirrorRepeat
                                   : WGPUAddressMode_ClampToEdge;
    };
    WGPUSamplerDescriptor Desc = WGPU_SAMPLER_DESCRIPTOR_INIT;
    Desc.addressModeU = Address(In.AddressU);
    Desc.addressModeV = Address(In.AddressV);
    Desc.addressModeW = Address(In.AddressW);
    Desc.lodMinClamp = In.MinMipLevel;
    Desc.lodMaxClamp = In.MaxMipLevel;
    Sampler->Handle = wgpuDeviceCreateSampler(Device, &Desc);
    check(Sampler->Handle);
    return Sampler->Handle;
}
FVertexDeclarationRHIRef FWebGPUDynamicRHI::RHICreateVertexDeclaration(const FVertexDeclarationElementList &Elements)
{
    RequireOwner();
    ++VertexDeclarationsCreated;
    return new FWebGPUVertexDeclaration(Elements);
}
FRHIBufferInitializer FWebGPUDynamicRHI::RHICreateBufferInitializer(FRHICommandListBase &Cmd,
                                                                    const FRHIBufferCreateDesc &Desc)
{
    WGPUBufferUsage Usage = WGPUBufferUsage_CopySrc;
    if (EnumHasAnyFlags(Desc.Usage, EBufferUsageFlags::VertexBuffer))
        Usage |= WGPUBufferUsage_Vertex;
    if (EnumHasAnyFlags(Desc.Usage, EBufferUsageFlags::IndexBuffer))
        Usage |= WGPUBufferUsage_Index;
    if (EnumHasAnyFlags(Desc.Usage, EBufferUsageFlags::UnorderedAccess | EBufferUsageFlags::ShaderResource))
        Usage |= WGPUBufferUsage_Storage;
    check(Desc.InitAction == ERHIBufferInitAction::Initializer || Desc.InitAction == ERHIBufferInitAction::Zeroed ||
          Desc.InitAction == ERHIBufferInitAction::ResourceArray || Desc.InitAction == ERHIBufferInitAction::Default);
    FWebGPUBuffer *Buffer = new FWebGPUBuffer(Desc, CreateBuffer(Desc.Size, Usage));
    if (Desc.InitAction != ERHIBufferInitAction::Default)
        Buffer->InitialBytes.SetNumZeroed(Align(Desc.Size, 4u));
    if (Desc.InitAction == ERHIBufferInitAction::ResourceArray)
    {
        check(Desc.InitialData && Desc.InitialData->GetResourceDataSize() == Desc.Size &&
              Desc.InitialData->GetResourceData());
        FMemory::Memcpy(Buffer->InitialBytes.GetData(), Desc.InitialData->GetResourceData(), Desc.Size);
        Desc.InitialData->Discard();
    }
    return FBufferInitializer(Cmd, Buffer, *this, Desc.InitAction == ERHIBufferInitAction::Initializer);
}
FRHICalcTextureSizeResult FWebGPUDynamicRHI::RHICalcTexturePlatformSize(const FRHITextureDesc &Desc,
                                                                        uint32 FirstMipIndex)
{
    check(Desc.NumMips && FirstMipIndex < Desc.NumMips);
    // WebGPU owns allocation and exposes no heap alignment or driver allocation-size query.
    return {Desc.CalcMemorySizeEstimate(FirstMipIndex), 1};
}
uint32 FWebGPUDynamicRHI::RHIComputeMemorySize(FRHITexture *Texture)
{
    if (!Texture)
        return 0;
    const uint64 Bytes = RHICalcTexturePlatformSize(Texture->GetDesc(), 0).Size;
    check(Bytes <= MAX_uint32);
    return uint32(Bytes);
}
FRHILockTextureResult FWebGPUDynamicRHI::RHILockTexture(FRHICommandListImmediate &,
                                                        const FRHILockTextureArgs &Args)
{
    RequireOwner();
    auto *Texture = static_cast<FWebGPUTexture *>(Args.Texture);
    check(Texture && Texture->GetDesc().Dimension == ETextureDimension::Texture2D &&
          IsSampled2DTextureFormat(Texture->GetFormat()) &&
          Args.LockMode == RLM_WriteOnly && !Args.ArrayIndex && !Args.FaceIndex && !Args.bLockWithinMiptail &&
          Args.MipIndex < Texture->GetNumMips() && Texture->LockedMip == MAX_uint32);
    RequireAccess(Texture, ERHIAccess::CopyDest, true);
    if (ContextOpen)
        SubmitCurrent();
    uint64 Stride;
    const uint64 Size = UE::RHITextureUtils::CalculateTextureMipSize(Texture->GetDesc(), Args.MipIndex, Stride);
    check(Size <= MAX_int32 && Stride <= MAX_uint32);
    Texture->LockedBytes.SetNumZeroed(Size);
    Texture->LockedMip = Args.MipIndex;
    return {Texture->LockedBytes.GetData(), Size, uint32(Stride)};
}
void FWebGPUDynamicRHI::RHIUnlockTexture(FRHICommandListImmediate &, const FRHILockTextureArgs &Args)
{
    RequireOwner();
    auto *Texture = static_cast<FWebGPUTexture *>(Args.Texture);
    check(Texture && Texture->LockedMip == Args.MipIndex && !Args.ArrayIndex && !Args.FaceIndex &&
          !Args.bLockWithinMiptail && !Texture->LockedBytes.IsEmpty());
    // Queue writes follow previously submitted draws and copy their CPU data before returning.
    Texture->LockedMip = MAX_uint32;
    RequireAccess(Texture, ERHIAccess::CopyDest, true);
    if (ContextOpen)
        SubmitCurrent();
    WriteTextureMip(*this, Texture, Args.MipIndex, Texture->LockedBytes.GetData(), Texture->LockedBytes.Num());
    Texture->LockedBytes.Reset();
}
bool FWebGPUDynamicRHI::ValidateTextureInitialization(const FRHITextureCreateDesc &In, FString &Error) const
{
    const bool Volume = In.Dimension == ETextureDimension::Texture3D;
    const bool Color = Volume ? In.Format == PF_R8G8B8A8 || In.Format == PF_B8G8R8A8 ||
                                    In.Format == PF_R8G8B8A8_UINT
                              : IsSampled2DTextureFormat(In.Format);
    const uint32 Limit = Volume ? Limits.maxTextureDimension3D : Limits.maxTextureDimension2D;
    if ((In.Dimension != ETextureDimension::Texture2D && !Volume) || In.ArraySize != 1 || !In.Depth ||
        (!Volume && In.Depth != 1) || !In.NumMips || (Volume && In.NumMips != 1) ||
        In.NumSamples != 1 || In.Extent.X <= 0 || In.Extent.Y <= 0 ||
        uint32(In.Extent.X) > Limit || uint32(In.Extent.Y) > Limit || (Volume && In.Depth > Limit) ||
        (!Color && (Volume || In.Format != PF_DepthStencil)) ||
        (Volume && (!EnumHasAnyFlags(In.Flags, ETextureCreateFlags::ShaderResource) ||
                    EnumHasAnyFlags(In.Flags, ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::UAV))) ||
        (Volume && EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB)) ||
        (In.Format != PF_R8G8B8A8 && In.Format != PF_B8G8R8A8 &&
         EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB)) ||
        (!Color && (In.NumMips != 1 ||
                    !EnumHasAnyFlags(In.Flags, ETextureCreateFlags::DepthStencilTargetable) ||
                    EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB | ETextureCreateFlags::UAV |
                        ETextureCreateFlags::RenderTargetable))) ||
        In.NumMips > FMath::FloorLog2(FMath::Max(In.Extent.X, In.Extent.Y)) + 1 ||
        (In.NumMips > 1 && EnumHasAnyFlags(In.Flags, ETextureCreateFlags::RenderTargetable)) ||
        (In.InitAction != ERHITextureInitAction::Default && In.InitAction != ERHITextureInitAction::Initializer &&
         In.InitAction != ERHITextureInitAction::BulkData) ||
        (In.InitAction != ERHITextureInitAction::Default && !Color))
    {
        Error =
            TEXT("Only 2D RGBA8/BGRA8 (linear or sRGB), linear R8/RG8/RGBA16F/R16_UINT/R32_UINT/RGBA8_UINT, sampled mip chains, single-mip depth, or existing linear sampled 3D textures are implemented");
        return false;
    }
    const uint64 Bytes = In.CalcMemorySizeEstimate();
    if (Bytes > MAX_int32 ||
        (In.InitAction == ERHITextureInitAction::BulkData &&
         (!In.BulkData || In.BulkData->GetResourceBulkDataSize() != Bytes || !In.BulkData->GetResourceBulkData())))
    {
        Error = TEXT("Texture initialization size or BulkData contents invalid");
        return false;
    }
    return true;
}
FRHITextureInitializer FWebGPUDynamicRHI::RHICreateTextureInitializer(FRHICommandListBase &Cmd,
                                                                      const FRHITextureCreateDesc &In)
{
    RequireOwner();
    if (StartupProbeMode)
        UE_LOG(LogRHI, Display,
               TEXT("P3_TEXTURE_CREATE name=%s dimension=%u format=%u extent=%dx%d depth=%u array=%u "
                    "mips=%u samples=%u init=%u flags=0x%llx"),
               In.DebugName, uint32(In.Dimension), uint32(In.Format), In.Extent.X, In.Extent.Y, In.Depth,
               In.ArraySize, uint32(In.NumMips), uint32(In.NumSamples), uint32(In.InitAction), uint64(In.Flags));
    FString Error;
    checkf(ValidateTextureInitialization(In, Error),
           TEXT("WebGPU texture creation unsupported: dimension=%u format=%u extent=%dx%d depth=%u array=%u "
                "mips=%u samples=%u init=%u flags=0x%llx: %s"),
           uint32(In.Dimension), uint32(In.Format), In.Extent.X, In.Extent.Y, In.Depth, In.ArraySize,
           uint32(In.NumMips), uint32(In.NumSamples), uint32(In.InitAction), uint64(In.Flags), *Error);
    const bool Volume = In.Dimension == ETextureDimension::Texture3D;
    const FTCHARToUTF8 Label(In.DebugName ? In.DebugName : TEXT("WebGPUTexture"));
    WGPUTextureDescriptor Desc = WGPU_TEXTURE_DESCRIPTOR_INIT;
    Desc.label = {Label.Get(), size_t(Label.Length())};
    Desc.dimension = Volume ? WGPUTextureDimension_3D : WGPUTextureDimension_2D;
    Desc.size = {uint32(In.Extent.X), uint32(In.Extent.Y), uint32(In.Depth)};
    Desc.format = Format(In.Format, EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB));
    Desc.mipLevelCount = In.NumMips;
    Desc.usage = Volume ? WGPUTextureUsage_None : WGPUTextureUsage_RenderAttachment;
    if (In.Format != PF_DepthStencil)
        Desc.usage |= WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst | WGPUTextureUsage_TextureBinding;
    else if (EnumHasAnyFlags(In.Flags, ETextureCreateFlags::ShaderResource))
        Desc.usage |= WGPUTextureUsage_TextureBinding;
    auto *Texture = new FWebGPUTexture(In, wgpuDeviceCreateTexture(Device, &Desc));
    const bool Writable = In.InitAction == ERHITextureInitAction::Initializer;
    if (Writable || In.InitAction == ERHITextureInitAction::BulkData)
    {
        Texture->InitialBytes.SetNumZeroed(In.CalcMemorySizeEstimate());
        if (In.InitAction == ERHITextureInitAction::BulkData)
        {
            FMemory::Memcpy(Texture->InitialBytes.GetData(), In.BulkData->GetResourceBulkData(),
                            Texture->InitialBytes.Num());
            In.BulkData->Discard();
        }
    }
    return FTextureInitializer(Cmd, Texture, *this, Writable);
}
FShaderResourceViewRHIRef FWebGPUDynamicRHI::RHICreateShaderResourceView(FRHICommandListBase &,
                                                                         FRHIViewableResource *Resource,
                                                                         const FRHIViewDesc &Desc)
{
    RequireOwner();
    FString Error;
    if (Desc.Common.ViewType == FRHIViewDesc::EViewType::BufferSRV)
    {
        if (StartupProbeMode && Resource)
            UE_LOG(LogRHI, Display,
                   TEXT("P2_STARTUP BufferSRV requested name=%s format=%u bufferType=%u stride=%u count=%u offset=%u"),
                   *Resource->GetName().ToString(), uint32(Desc.Buffer.SRV.Format), uint32(Desc.Buffer.SRV.BufferType),
                   Desc.Buffer.SRV.Stride, Desc.Buffer.SRV.NumElements, Desc.Buffer.SRV.OffsetInBytes);
        if (StartupProbeMode && FParse::Param(FCommandLine::Get(), TEXT("WebMinimalStartup")) && Resource &&
            (Resource == GNullColorVertexBuffer.VertexBufferRHI || Resource == GNullVertexBuffer.VertexBufferRHI))
        {
            // Installed-host adaptation of the Web-only default SRV guard; keep the actual vertex buffers.
            check(!RHISupportsManualVertexFetch(GMaxRHIShaderPlatform) &&
                  !FDataDrivenShaderPlatformInfo::GetSupportsVertexShaderSRVs(GMaxRHIShaderPlatform));
            const auto &View = Desc.Buffer.SRV;
            auto *Buffer = static_cast<FRHIBuffer *>(Resource);
            const bool Color = Resource == GNullColorVertexBuffer.VertexBufferRHI;
            check(View.BufferType == FRHIViewDesc::EBufferType::Typed && View.Format == PF_R8G8B8A8 &&
                  !View.Stride && !View.NumElements && !View.OffsetInBytes && !View.bAtomicCounter &&
                  !View.bAppendBuffer && Buffer->GetSize() == (Color ? 16u : 12u) &&
                  EnumHasAllFlags(Buffer->GetUsage(), BUF_VertexBuffer | BUF_ShaderResource));
#if defined(PLATFORM_WEB) && PLATFORM_WEB
            // Native startup probes read these buffers back; the browser retains them without blocking its event loop.
            UE_LOG(LogRHI, Display,
                   TEXT("P2_STARTUP default vertex SRV omitted name=%s bytes=%u value=%u gpuReadbackVerified=0"),
                   *Resource->GetName().ToString(), Buffer->GetSize(), Color ? 255u : 0u);
#else
            const auto Bytes = ReadBuffer(Buffer, Buffer->GetSize());
            check(Bytes.Num() == int32(Buffer->GetSize()) && Errors.IsEmpty());
            for (uint8 Byte : Bytes)
                check(Byte == (Color ? 255 : 0));
            UE_LOG(LogRHI, Display,
                   TEXT("P2_STARTUP default vertex SRV omitted name=%s bytes=%u value=%u gpuReadbackVerified=1"),
                   *Resource->GetName().ToString(), Buffer->GetSize(), Color ? 255u : 0u);
#endif
            return {};
        }
        checkf(ValidateBufferSRV(Resource, Desc, Error), TEXT("WebGPU BufferSRV unsupported: %s"), *Error);
        auto *Buffer = static_cast<FWebGPUBuffer *>(Resource);
        const auto Info = Desc.Buffer.SRV.GetViewInfo(Buffer);
        if (StartupProbeMode)
            UE_LOG(LogRHI, Display, TEXT("P2_STARTUP BufferSRV created name=%s format=%u stride=%u count=%u offset=%u"),
                   *Buffer->GetName().ToString(), uint32(Info.Format), Info.StrideInBytes, Info.NumElements,
                   Info.OffsetInBytes);
        return new FWebGPUBufferSRV(Buffer, Desc);
    }
    const bool Valid = ValidateTextureSRV(Resource, Desc, Error);
    checkf(Valid, TEXT("WebGPU SRV unsupported: resourceType=%u viewType=%u: %s"),
           Resource ? uint32(Resource->GetType()) : MAX_uint32, uint32(Desc.Common.ViewType), *Error);
    auto *Texture = static_cast<FWebGPUTexture *>(Resource);
    const auto Info = Desc.Texture.SRV.GetViewInfo(Texture);
    WGPUTextureViewDescriptor View = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    const bool DepthStencil = Texture->GetFormat() == PF_DepthStencil;
    const bool Stencil = DepthStencil && Info.Plane == ERHITexturePlane::Stencil;
    View.format = DepthStencil ? (Stencil ? WGPUTextureFormat_Stencil8 : WGPUTextureFormat_Depth24Plus)
                               : Format(Info.Format);
    View.dimension = Texture->GetDesc().Dimension == ETextureDimension::Texture3D ? WGPUTextureViewDimension_3D
                                                                                  : WGPUTextureViewDimension_2D;
    View.baseMipLevel = Info.MipRange.First;
    View.mipLevelCount = Info.MipRange.Num;
    View.baseArrayLayer = Info.ArrayRange.First;
    View.arrayLayerCount = Info.ArrayRange.Num;
    View.aspect = DepthStencil ? (Stencil ? WGPUTextureAspect_StencilOnly : WGPUTextureAspect_DepthOnly)
                               : WGPUTextureAspect_All;
    View.usage = WGPUTextureUsage_TextureBinding;
    auto Handle = wgpuTextureCreateView(Texture->Handle, &View);
    check(Handle);
    if (StartupProbeMode)
        UE_LOG(LogRHI, Display, TEXT("P2_STARTUP TextureSRV created name=%s format=%u"), *Texture->GetName().ToString(),
               uint32(Info.Format));
    return new FWebGPUTextureSRV(Texture, Desc, Handle);
}
void FWebGPUDynamicRHI::RHIUpdateTexture2D(FRHICommandListBase &Cmd, FRHITexture *Texture, uint32 Mip,
                                           const FUpdateTextureRegion2D &Region, uint32 Pitch, const uint8 *Bytes)
{
    RequireOwner();
    check(Texture->GetDesc().Dimension == ETextureDimension::Texture2D && Mip == 0 &&
          Texture->GetFormat() == PF_R8G8B8A8 && Region.Width && Region.Height &&
          Region.DestX + Region.Width <= Texture->GetSizeX() && Region.DestY + Region.Height <= Texture->GetSizeY() &&
          Pitch >= (Region.SrcX + Region.Width) * 4);
    const uint32 UploadPitch = Align(Region.Width * 4, 256u);
    TArray<uint8> Snapshot;
    Snapshot.SetNumZeroed(UploadPitch * Region.Height);
    for (uint32 Row = 0; Row < Region.Height; ++Row)
        FMemory::Memcpy(Snapshot.GetData() + Row * UploadPitch, Bytes + (Region.SrcY + Row) * Pitch + Region.SrcX * 4,
                        Region.Width * 4);
    auto Upload = [this, Texture = TRefCountPtr<FWebGPUTexture>(static_cast<FWebGPUTexture *>(Texture)), Region,
                   UploadPitch, Snapshot = MoveTemp(Snapshot)](FRHICommandListBase &) {
        check(Encoder && !Pass);
        RequireAccess(Texture, ERHIAccess::CopyDest, true);
        WGPUBuffer Staging = CreateBuffer(Snapshot.Num(), WGPUBufferUsage_CopySrc, Snapshot.GetData());
        WGPUTexelCopyBufferInfo Source = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        Source.buffer = Staging;
        Source.layout.bytesPerRow = UploadPitch;
        Source.layout.rowsPerImage = Region.Height;
        WGPUTexelCopyTextureInfo Destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        Destination.texture = Texture->Handle;
        Destination.origin = {Region.DestX, Region.DestY, 0};
        WGPUExtent3D Extent{Region.Width, Region.Height, 1};
        wgpuCommandEncoderCopyBufferToTexture(Encoder, &Source, &Destination, &Extent);
        wgpuBufferRelease(Staging);
    };
    if (Cmd.Bypass())
        Upload(Cmd);
    else
        Cmd.EnqueueLambda(MoveTemp(Upload));
}
FUniformBufferRHIRef FWebGPUDynamicRHI::RHICreateUniformBuffer(const void *Bytes, const FRHIUniformBufferLayout *Layout,
                                                               EUniformBufferUsage, EUniformBufferValidation)
{
    RequireOwner();
    check(Layout && !EnumHasAnyFlags(Layout->Flags, ERHIUniformBufferFlags::UniformView));
    auto *Result = new FWebGPUUniform(Layout);
    TArray<uint8> Constants;
    TArray<TRefCountPtr<FRHIResource>> Resources;
    if (Bytes)
        UniformSnapshot(Bytes, *Layout, Constants, Resources);
    else
        Resources.SetNum(Layout->Resources.Num());
    Result->SetContents(MoveTemp(Constants), MoveTemp(Resources));
    return Result;
}
void FWebGPUDynamicRHI::RHIUpdateUniformBuffer(FRHICommandListBase &Cmd, FRHIUniformBuffer *Uniform, const void *Bytes)
{
    RequireOwner();
    auto *Buffer = static_cast<FWebGPUUniform *>(Uniform);
    TArray<uint8> Snapshot;
    TArray<TRefCountPtr<FRHIResource>> Resources;
    UniformSnapshot(Bytes, Buffer->GetLayout(), Snapshot, Resources);
    if (Cmd.Bypass())
        Buffer->SetContents(MoveTemp(Snapshot), MoveTemp(Resources));
    else
    {
        Cmd.EnqueueLambda([Buffer = TRefCountPtr<FWebGPUUniform>(Buffer), Snapshot = MoveTemp(Snapshot),
                           Resources = MoveTemp(Resources)](FRHICommandListBase &) mutable {
            Buffer->SetContents(MoveTemp(Snapshot), MoveTemp(Resources));
        });
    }
}
FUnorderedAccessViewRHIRef FWebGPUDynamicRHI::RHICreateUnorderedAccessView(FRHICommandListBase &,
                                                                           FRHIViewableResource *Resource,
                                                                           const FRHIViewDesc &Desc)
{
    RequireOwner();
    FString Error;
    if (StartupProbeMode && Resource && Desc.Common.ViewType == FRHIViewDesc::EViewType::BufferUAV)
        UE_LOG(LogRHI, Display,
               TEXT("P2_STARTUP BufferUAV requested name=%s format=%u bufferType=%u stride=%u count=%u offset=%u"),
               *Resource->GetName().ToString(), uint32(Desc.Buffer.UAV.Format), uint32(Desc.Buffer.UAV.BufferType),
               Desc.Buffer.UAV.Stride, Desc.Buffer.UAV.NumElements, Desc.Buffer.UAV.OffsetInBytes);
    checkf(Resource && Resource->GetType() == RRT_Buffer &&
               Desc.Common.ViewType == FRHIViewDesc::EViewType::BufferUAV &&
               ValidateUAV(static_cast<FRHIBuffer *>(Resource), Desc, Error),
           TEXT("%s"), *Error);
    if (StartupProbeMode)
    {
        const auto Info = Desc.Buffer.UAV.GetViewInfo(static_cast<FRHIBuffer *>(Resource));
        UE_LOG(LogRHI, Display, TEXT("P2_STARTUP BufferUAV created name=%s format=%u stride=%u count=%u offset=%u"),
               *Resource->GetName().ToString(), uint32(Info.Format), Info.StrideInBytes, Info.NumElements,
               Info.OffsetInBytes);
    }
    return new FRHIUnorderedAccessView(Resource, Desc);
}
bool FWebGPUDynamicRHI::ValidateUAV(FRHIBuffer *Buffer, const FRHIViewDesc &Desc, FString &Error) const
{
    if (!Buffer || Desc.Common.ViewType != FRHIViewDesc::EViewType::BufferUAV)
    {
        Error = TEXT("Only buffer UAVs are implemented");
        return false;
    }
    const auto &View = Desc.Buffer.UAV;
    if (View.BufferType == FRHIViewDesc::EBufferType::Typed)
    {
        if ((View.Format != PF_R32_UINT && View.Format != PF_R32G32B32A32_UINT && View.Format != PF_A32B32G32R32F) ||
            View.Stride || View.bAtomicCounter || View.bAppendBuffer ||
            EnumHasAnyFlags(Buffer->GetUsage(), BUF_StructuredBuffer | BUF_AccelerationStructure) ||
            !EnumHasAnyFlags(Buffer->GetUsage(), BUF_UnorderedAccess))
        {
            Error = TEXT("Typed UAV requires a non-structured UnorderedAccess buffer and uint32/uint4/float4 format");
            return false;
        }
        const uint64 Size = Buffer->GetSize();
        const uint32 Stride = GPixelFormats[View.Format].BlockBytes;
        const uint64 Bytes = View.NumElements ? uint64(View.NumElements) * Stride : Size;
        if (!Size || Size % Stride || !Bytes || Bytes > Limits.maxStorageBufferBindingSize ||
            View.OffsetInBytes >= Size || View.OffsetInBytes % Limits.minStorageBufferOffsetAlignment ||
            (View.OffsetInBytes && !View.NumElements) || uint64(View.OffsetInBytes) + Bytes > Size)
        {
            Error = TEXT("Typed UAV range, storage binding size or alignment invalid");
            return false;
        }
        return true;
    }
    return ValidateStructuredView(Buffer, View, BUF_UnorderedAccess, Error);
}
bool FWebGPUDynamicRHI::ValidateStructuredView(const FRHIBuffer *Buffer, const FRHIViewDesc::FBuffer &View,
                                               EBufferUsageFlags RequiredUsage, FString &Error) const
{
    const uint32 Stride = View.Stride ? View.Stride : Buffer->GetStride();
    if (View.BufferType != FRHIViewDesc::EBufferType::Structured || View.Format != PF_Unknown || View.bAtomicCounter ||
        View.bAppendBuffer || !EnumHasAllFlags(Buffer->GetUsage(), BUF_StructuredBuffer | RequiredUsage) ||
        EnumHasAnyFlags(Buffer->GetUsage(), BUF_AccelerationStructure) || Stride < 4 || Stride % 4 ||
        Stride != Buffer->GetStride())
    {
        Error = TEXT("Structured view requires matching buffer stride, capability and no format/counter/append");
        return false;
    }
    const uint64 Size = Buffer->GetSize();
    const uint64 Bytes = View.NumElements ? uint64(View.NumElements) * Stride : Size;
    if (!Size || Size % Stride || !Bytes || Bytes > Limits.maxStorageBufferBindingSize || View.OffsetInBytes >= Size ||
        View.OffsetInBytes % Stride || View.OffsetInBytes % Limits.minStorageBufferOffsetAlignment ||
        (View.OffsetInBytes && !View.NumElements) || uint64(View.OffsetInBytes) + Bytes > Size)
    {
        Error = TEXT("Structured view range, storage binding size or alignment invalid");
        return false;
    }
    return true;
}
bool FWebGPUDynamicRHI::ValidateTextureSRV(FRHIViewableResource *Resource, const FRHIViewDesc &Desc,
                                           FString &Error) const
{
    if (!Resource || Resource->GetType() != RRT_Texture || Desc.Common.ViewType != FRHIViewDesc::EViewType::TextureSRV)
    {
        Error = TEXT("Only texture SRVs are implemented; buffer SRVs are unsupported");
        return false;
    }
    const auto *Texture = static_cast<FWebGPUTexture *>(Resource);
    const auto &Target = Texture->GetDesc();
    const auto &View = Desc.Texture.SRV;
    if (!Texture->SurfaceFrameActive || !EnumHasAnyFlags(Target.Flags, ETextureCreateFlags::ShaderResource))
    {
        Error = TEXT("Texture SRV requires a live texture with ShaderResource capability");
        return false;
    }
    const bool Volume = Target.Dimension == ETextureDimension::Texture3D;
    const bool DepthStencil = Target.Format == PF_DepthStencil;
    const bool DepthPlane = View.Plane == ERHITexturePlane::Primary || View.Plane == ERHITexturePlane::Depth ||
        View.Plane == ERHITexturePlane::Stencil;
    if ((Target.Dimension != ETextureDimension::Texture2D && !Volume) || Target.ArraySize != 1 ||
        (!Volume && Target.Depth != 1) || Target.NumMips != 1 || Target.NumSamples != 1 ||
        View.Dimension != (Volume ? FRHIViewDesc::EDimension::Texture3D : FRHIViewDesc::EDimension::Texture2D) ||
        (DepthStencil ? !DepthPlane : View.Plane != ERHITexturePlane::Primary))
    {
        Error = TEXT("Texture SRV requires matching 2D/3D dimension, primary plane, single mip and single array layer");
        return false;
    }
    const bool SupportedFormat = Volume ? Target.Format == PF_R8G8B8A8 || Target.Format == PF_B8G8R8A8 ||
                                             Target.Format == PF_R8G8B8A8_UINT
                                       : IsSampled2DTextureFormat(Target.Format) || DepthStencil;
    if (!SupportedFormat ||
        (View.Format != PF_Unknown && View.Format != Target.Format && !(DepthStencil && View.Format == PF_X24_G8)) ||
        (DepthStencil && ((View.Plane == ERHITexturePlane::Depth && View.Format == PF_X24_G8) ||
            (View.Plane == ERHITexturePlane::Stencil && View.Format == PF_DepthStencil))) ||
        EnumHasAnyFlags(Target.Flags, ETextureCreateFlags::SRGB))
    {
        Error = TEXT("Texture SRV requires a matching supported linear sampled format");
        return false;
    }
    if (View.MipRange.First || View.MipRange.Num > 1 || View.ArrayRange.First || View.ArrayRange.Num > 1)
    {
        Error = TEXT("Texture SRV mip/array range is outside the supported texture");
        return false;
    }
    return true;
}
bool FWebGPUDynamicRHI::ValidateTextureBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                               FString &Error) const
{
    FWebGPUTexture *Texture;
    WGPUTextureView View;
    if (!ResolveSampledTexture(Resource, Texture, View, Access, Error))
        return false;
    double Dimension;
    bool Arrayed, Multisampled;
    const uint32 Expected = Texture->GetDesc().Dimension == ETextureDimension::Texture3D ? 2 : 1;
    if (!Binding.TryGetNumberField(TEXT("textureDimension"), Dimension) || Dimension != Expected ||
        !Binding.TryGetBoolField(TEXT("textureArrayed"), Arrayed) || Arrayed ||
        !Binding.TryGetBoolField(TEXT("textureMultisampled"), Multisampled) || Multisampled)
    {
        Error = TEXT("Sampled texture and reflected shader dimensions do not match");
        return false;
    }
    FString SampleType;
    const bool Stencil = Resource->GetType() == RRT_ShaderResourceView &&
        static_cast<FRHIShaderResourceView*>(Resource)->GetDesc().Texture.SRV.GetViewInfo(Texture).Plane ==
            ERHITexturePlane::Stencil;
    const TCHAR *ExpectedSampleType = Stencil || IsUnsignedTextureFormat(Texture->GetFormat()) ? TEXT("uint") : TEXT("float");
    if (!Binding.TryGetStringField(TEXT("textureSampleType"), SampleType) || SampleType != ExpectedSampleType)
    {
        Error = TEXT("Sampled texture format and reflected shader scalar type do not match");
        return false;
    }
    return true;
}
uint64 FWebGPUDynamicRHI::RHIGetMinimumAlignmentForBufferBackedSRV(EPixelFormat InFormat)
{
    return InFormat == PF_R32_UINT || InFormat == PF_R32G32B32A32_UINT || InFormat == PF_A32B32G32R32F
               ? Limits.minStorageBufferOffsetAlignment
               : GPixelFormats[InFormat].BlockBytes;
}
bool FWebGPUDynamicRHI::ValidateBufferSRV(FRHIViewableResource *Resource, const FRHIViewDesc &Desc,
                                          FString &Error) const
{
    if (!Resource || Resource->GetType() != RRT_Buffer || Desc.Common.ViewType != FRHIViewDesc::EViewType::BufferSRV)
    {
        Error = TEXT("Buffer SRV requires a buffer resource and BufferSRV descriptor");
        return false;
    }
    const auto *Buffer = static_cast<FRHIBuffer *>(Resource);
    const auto &View = Desc.Buffer.SRV;
    if (View.BufferType == FRHIViewDesc::EBufferType::Structured)
        return ValidateStructuredView(Buffer, View, BUF_ShaderResource, Error);
    if (View.BufferType != FRHIViewDesc::EBufferType::Typed ||
        (View.Format != PF_R32_UINT && View.Format != PF_R32G32B32A32_UINT && View.Format != PF_A32B32G32R32F) ||
        View.Stride || View.bAtomicCounter || View.bAppendBuffer ||
        EnumHasAnyFlags(Buffer->GetUsage(), BUF_StructuredBuffer | BUF_AccelerationStructure) ||
        !EnumHasAnyFlags(Buffer->GetUsage(), BUF_ShaderResource))
    {
        Error = TEXT("Only non-structured ShaderResource buffers with Typed uint32/uint4/float4 SRVs are implemented");
        return false;
    }
    const uint64 Size = Buffer->GetSize();
    const uint32 Stride = GPixelFormats[View.Format].BlockBytes;
    const uint64 Bytes = View.NumElements ? uint64(View.NumElements) * Stride : Size;
    if (!Size || Size % Stride || !Bytes || Bytes > Limits.maxStorageBufferBindingSize || View.OffsetInBytes >= Size ||
        View.OffsetInBytes % Limits.minStorageBufferOffsetAlignment || (View.OffsetInBytes && !View.NumElements) ||
        uint64(View.OffsetInBytes) + Bytes > Size)
    {
        Error = TEXT("Buffer SRV range, storage binding size or alignment invalid");
        return false;
    }
    return true;
}
bool FWebGPUDynamicRHI::ValidateStorageSRVBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                                  FString &Error) const
{
    if (!Resource || Resource->GetType() != RRT_ShaderResourceView)
    {
        Error = TEXT("Read-only storage binding requires a buffer SRV");
        return false;
    }
    auto *View = static_cast<FRHIShaderResourceView *>(Resource);
    if (!ValidateBufferSRV(View->GetResource(), View->GetDesc(), Error))
        return false;
    bool ReadOnly = false;
    if (!Binding.TryGetBoolField(TEXT("readOnlyStorage"), ReadOnly) || !ReadOnly)
    {
        Error = TEXT("SRV requires a reflected read-only storage binding");
        return false;
    }
    double Element;
    const auto &Desc = View->GetDesc().Buffer.SRV;
    const bool Typed = Desc.BufferType == FRHIViewDesc::EBufferType::Typed;
    if (!Binding.TryGetNumberField(Typed ? TEXT("storageElementFormat") : TEXT("storageElementStride"), Element) ||
        Element != (Typed ? uint32(Desc.Format) : Desc.GetViewInfo(View->GetBuffer()).StrideInBytes))
    {
        Error = TEXT("Buffer SRV element format/stride does not match reflected storage layout");
        return false;
    }
    return ValidateAccess(View->GetBuffer(), Access, Error);
}
bool FWebGPUDynamicRHI::ValidateStorageUAVBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                                  FString &Error) const
{
    if (!Resource || Resource->GetType() != RRT_UnorderedAccessView)
    {
        Error = TEXT("Writable storage binding requires a buffer UAV");
        return false;
    }
    auto *View = static_cast<FRHIUnorderedAccessView *>(Resource);
    if (View->GetResource()->GetType() != RRT_Buffer ||
        !ValidateUAV(static_cast<FRHIBuffer *>(View->GetResource()), View->GetDesc(), Error))
        return false;
    bool ReadOnly = false;
    if (!Binding.TryGetBoolField(TEXT("readOnlyStorage"), ReadOnly) || ReadOnly)
    {
        Error = TEXT("UAV requires a reflected writable storage binding");
        return false;
    }
    if (View->GetDesc().Buffer.UAV.BufferType == FRHIViewDesc::EBufferType::Typed)
    {
        double FormatValue;
        if (!Binding.TryGetNumberField(TEXT("storageElementFormat"), FormatValue) ||
            FormatValue != uint32(View->GetDesc().Buffer.UAV.Format))
        {
            Error = TEXT("Typed UAV requires a reflected storage array matching its element format");
            return false;
        }
    }
    else
    {
        double Stride;
        const auto Info = View->GetDesc().Buffer.UAV.GetViewInfo(static_cast<FRHIBuffer *>(View->GetResource()));
        if (!Binding.TryGetNumberField(TEXT("storageElementStride"), Stride) || Stride != Info.StrideInBytes)
        {
            Error = TEXT("Structured UAV stride does not match reflected storage layout");
            return false;
        }
    }
    return ValidateAccess(static_cast<FRHIBuffer *>(View->GetResource()), Access, Error);
}
bool FWebGPUDynamicRHI::ResolveSampledTexture(FRHIResource *Resource, FWebGPUTexture *&Texture, WGPUTextureView &View,
                                              ERHIAccess Access, FString &Error) const
{
    Texture = nullptr;
    View = nullptr;
    if (Resource && Resource->GetType() == RRT_ShaderResourceView)
    {
        auto *SRV = static_cast<FRHIShaderResourceView *>(Resource);
        if (!ValidateTextureSRV(SRV->GetResource(), SRV->GetDesc(), Error))
            return false;
        Texture = static_cast<FWebGPUTexture *>(SRV->GetTexture());
        View = static_cast<FWebGPUTextureSRV *>(SRV)->Handle;
    }
    else if (Resource && Resource->GetType() == RRT_Texture)
    {
        Texture = static_cast<FWebGPUTexture *>(Resource);
        View = Texture->DepthSampleView ? Texture->DepthSampleView : Texture->View;
    }
    else
    {
        Error = TEXT("Sampled binding requires a texture or a texture SRV");
        return false;
    }
    return ValidateSampledTexture(Texture, Error, Access);
}
bool FWebGPUDynamicRHI::ValidateSampledTexture(FRHITexture *Texture, FString &Error, ERHIAccess Access) const
{
    if (Attachments.Contains(static_cast<FWebGPUTexture *>(Texture)))
    {
        Error = TEXT("Sampling an active render attachment is not supported");
        return false;
    }
    return ValidateAccess(Texture, Access, Error);
}
bool FWebGPUDynamicRHI::ValidateUniform(const FWebGPUShaderData &Shader, uint32 Slot, FRHIUniformBuffer *Uniform,
                                        FString &Error) const
{
    if (!Uniform)
    {
        Error = TEXT("Uniform buffer is not bound");
        return false;
    }
    const auto &Hashes = Shader.ResourceTable.ResourceTableLayoutHashes;
    if (!Hashes.IsValidIndex(Slot) || !Hashes[Slot] || Uniform->GetLayout().GetHash() != Hashes[Slot])
    {
        Error = TEXT("Uniform buffer layout hash mismatch");
        return false;
    }
    return true;
}
bool FWebGPUDynamicRHI::ValidateStaticUniform(FUniformBufferStaticSlot Slot, FRHIUniformBuffer *Uniform,
                                              FString &Error) const
{
    if (!IsUniformBufferStaticSlotValid(Slot) || Slot >= FUniformBufferStaticSlotRegistry::Get().GetSlotCount())
    {
        Error = TEXT("Static uniform slot is not registered");
        return false;
    }
    if (Uniform && (Uniform->GetLayout().StaticSlot != Slot ||
                    !EnumHasAnyFlags(Uniform->GetLayout().BindingFlags, EUniformBufferBindingFlags::Static)))
    {
        Error = TEXT("Uniform layout does not support the requested static slot");
        return false;
    }
    return true;
}
void FWebGPUDynamicRHI::RHISetStaticUniformBuffers(const FUniformBufferStaticBindings &Bindings)
{
    RequireOwner();
    checkf(!Bindings.GetShaderBindingLayout(), TEXT("WebGPU static uniforms require registered static slots"));
    TArray<TRefCountPtr<FRHIUniformBuffer>> Updated;
    Updated.SetNum(FUniformBufferStaticSlotRegistry::Get().GetSlotCount());
    for (int32 Index = 0; Index < Bindings.GetUniformBufferCount(); ++Index)
    {
        const auto Slot = Bindings.GetSlot(Index);
        auto *Uniform = Bindings.GetUniformBuffer(Index);
        FString Error;
        checkf(ValidateStaticUniform(Slot, Uniform, Error), TEXT("%s"), *Error);
        Updated[Slot] = Uniform;
    }
    StaticUniformBuffers = MoveTemp(Updated);
    ++StaticUniformBatches;
    if (StartupProbeMode && StaticUniformBatches <= 4)
        UE_LOG(LogRHI, Display, TEXT("P3_STATIC_UNIFORMS batch=%u count=%d slots=%d"), StaticUniformBatches,
               Bindings.GetUniformBufferCount(), StaticUniformBuffers.Num());
}
void FWebGPUDynamicRHI::RHISetStaticUniformBuffer(FUniformBufferStaticSlot Slot, FRHIUniformBuffer *Uniform)
{
    RequireOwner();
    FString Error;
    checkf(ValidateStaticUniform(Slot, Uniform, Error), TEXT("%s"), *Error);
    if (!StaticUniformBuffers.IsValidIndex(Slot))
        StaticUniformBuffers.SetNum(Slot + 1);
    StaticUniformBuffers[Slot] = Uniform;
    ++StaticUniformUpdates;
}
bool FWebGPUDynamicRHI::ResolveUniform(const FWebGPUShaderData &Shader, uint32 Slot, FRHIUniformBuffer *&Uniform,
                                       FString &Error) const
{
    Uniform = nullptr;
    const auto &Hashes = Shader.ResourceTable.ResourceTableLayoutHashes;
    if (!Hashes.IsValidIndex(Slot) || !Hashes[Slot])
    {
        Error = TEXT("Shader uniform layout hash is missing");
        return false;
    }
    const auto *Direct = Shader.Resources.Find((1u << 16) | Slot);
    auto *ShaderUniform = Direct && Direct->IsValid() ? static_cast<FRHIUniformBuffer *>(Direct->GetReference()) : nullptr;
    const auto *Metadata = FindUniformBufferStructByLayoutHash(Hashes[Slot]);
    if (Metadata && EnumHasAnyFlags(Metadata->GetLayout().BindingFlags, EUniformBufferBindingFlags::Static))
    {
        // Cook and runtime can register static slots in different orders; the layout hash is stable.
        const auto StaticSlot = Metadata->GetLayout().StaticSlot;
        if (StaticUniformBuffers.IsValidIndex(StaticSlot))
            Uniform = StaticUniformBuffers[StaticSlot];
        if (Uniform && ShaderUniform)
        {
            Error = TEXT("Uniform buffer is bound through both static and shader slots");
            return false;
        }
        if (Uniform)
            ++StaticUniformResolutions;
        else if (!EnumHasAnyFlags(Metadata->GetLayout().BindingFlags, EUniformBufferBindingFlags::Shader))
        {
            Error = TEXT("Required static uniform buffer is not bound");
            return false;
        }
    }
    if (!Uniform)
        Uniform = ShaderUniform;
    return ValidateUniform(Shader, Slot, Uniform, Error);
}
bool FWebGPUDynamicRHI::ResolveBinding(const FWebGPUShaderData &Shader, const FJsonObject &Binding,
                                       FRHIResource *&Resource, bool &FromTable, FString &Error) const
{
    Resource = nullptr;
    FromTable = false;
    const FString Name = Binding.GetStringField(TEXT("name"));
    const uint32 Descriptor = Binding.GetIntegerField(TEXT("descriptorType"));
    for (const auto &Item : Shader.Metadata->GetArrayField(TEXT("ueParameterMap")))
    {
        const auto Parameter = Item->AsObject();
        if (Parameter->GetStringField(TEXT("name")) != Name)
            continue;
        const uint32 Type = Parameter->GetIntegerField(TEXT("type"));
        if ((Descriptor == 6 && Type != 1) || (Descriptor == 2 && Type != 3) || (Descriptor == 0 && Type != 2) ||
            (Descriptor == 7 && Type != 3 && Type != 4))
        {
            Error = TEXT("Shader descriptor/parameter type mismatch: ") + Name;
            return false;
        }
        const uint32 Index = Parameter->GetIntegerField(Type == 1 ? TEXT("bufferIndex") : TEXT("baseIndex"));
        if (Type == 1)
        {
            FRHIUniformBuffer *Uniform = nullptr;
            if (!ResolveUniform(Shader, Index, Uniform, Error))
                return false;
            Resource = Uniform;
            return true;
        }
        // Vulkan classifies read-only storage as UAV; preserve its slot and use the reflected access for RHI binding.
        bool ReadOnlyStorage = false;
        const uint32 ResourceType =
            Descriptor == 7 && Binding.TryGetBoolField(TEXT("readOnlyStorage"), ReadOnlyStorage) && ReadOnlyStorage
                ? 3u
                : Type;
        const auto *Found = Shader.Resources.Find((ResourceType << 16) | Index);
        if (!Found || !Found->IsValid())
        {
            Error = TEXT("Direct shader resource is not bound: ") + Name;
            return false;
        }
        Resource = Found->GetReference();
        return true;
    }
    const TArray<uint32> *Stream = Descriptor == 2   ? &Shader.ResourceTable.TextureMap
                                   : Descriptor == 0 ? &Shader.ResourceTable.SamplerMap
                                                     : nullptr;
    if (!Stream)
    {
        Error = TEXT("Resource table descriptor is unsupported: ") + Name;
        return false;
    }
    for (const auto &Item : Shader.Metadata->GetArrayField(TEXT("ueParameterMap")))
    {
        const auto Parameter = Item->AsObject();
        if (Parameter->GetIntegerField(TEXT("type")) != 1)
            continue;
        const uint32 Slot = Parameter->GetIntegerField(TEXT("bufferIndex"));
        if (Slot >= 32 || !(Shader.ResourceTable.ResourceTableBits & (1u << Slot)))
            continue;
        if (!Stream->IsValidIndex(Slot))
        {
            Error = TEXT("Resource table slot offset missing");
            return false;
        }
        uint32 Cursor = (*Stream)[Slot];
        if (!Cursor)
            continue;
        if (Cursor <= Slot || !Stream->IsValidIndex(Cursor))
        {
            Error = TEXT("Resource table token offset invalid");
            return false;
        }
        while (Stream->IsValidIndex(Cursor) && FRHIResourceTableEntry::GetUniformBufferIndex((*Stream)[Cursor]) == Slot)
        {
            const uint32 Token = (*Stream)[Cursor++];
            if (FRHIResourceTableEntry::GetBindIndex(Token) != Binding.GetIntegerField(TEXT("binding")))
                continue;
            const uint32 ResourceIndex = FRHIResourceTableEntry::GetResourceIndex(Token);
            const auto Entry =
                Shader.Metadata->GetArrayField(TEXT("uniformResourceEntries")).FindByPredicate([&](const auto &Value) {
                    const auto Member = Value->AsObject();
                    return Member->GetStringField(TEXT("name")) == Name &&
                           Member->GetStringField(TEXT("uniformBuffer")) == Parameter->GetStringField(TEXT("name")) &&
                           Member->GetIntegerField(TEXT("resourceIndex")) == ResourceIndex &&
                           Member->GetIntegerField(TEXT("type")) == (Descriptor == 2 ? UBMT_TEXTURE : UBMT_SAMPLER);
                });
            if (!Entry)
            {
                Error = TEXT("Resource table token/name/type mismatch");
                return false;
            }
            FRHIUniformBuffer *Uniform = nullptr;
            if (!ResolveUniform(Shader, Slot, Uniform, Error))
                return false;
            const auto &Layout = Uniform->GetLayout();
            if (!Layout.Resources.IsValidIndex(ResourceIndex) ||
                Layout.Resources[ResourceIndex].MemberType != (Descriptor == 2 ? UBMT_TEXTURE : UBMT_SAMPLER) ||
                !Uniform->GetResourceTable().IsValidIndex(ResourceIndex))
            {
                Error = TEXT("Resource table member index/type mismatch");
                return false;
            }
            Resource = Uniform->GetResourceTable()[ResourceIndex].GetReference();
            if (!Resource || Resource->GetType() != (Descriptor == 2 ? RRT_Texture : RRT_SamplerState))
            {
                Error = TEXT("Resource table member is null or has wrong RHI type");
                return false;
            }
            FromTable = true;
            return true;
        }
    }
    Error = TEXT("Resource table binding is missing: ") + Name;
    return false;
}
FRasterizerStateRHIRef FWebGPUDynamicRHI::RHICreateRasterizerState(const FRasterizerStateInitializerRHI &In)
{
    // A state object only stores the descriptor; unsupported draws are rejected at PSO creation.
    if (StartupProbeMode)
        UE_LOG(LogRHI, Display, TEXT("P2_STARTUP rasterizer descriptor retained fill=%u cull=%u msaa=%u"),
               uint32(In.FillMode), uint32(In.CullMode), uint32(In.bAllowMSAA));
    return new TWebGPUState<FRHIRasterizerState, FRasterizerStateInitializerRHI>(In);
}
FDepthStencilStateRHIRef FWebGPUDynamicRHI::RHICreateDepthStencilState(const FDepthStencilStateInitializerRHI &In)
{
    return new TWebGPUState<FRHIDepthStencilState, FDepthStencilStateInitializerRHI>(In);
}
FBlendStateRHIRef FWebGPUDynamicRHI::RHICreateBlendState(const FBlendStateInitializerRHI &In)
{
    return new TWebGPUState<FRHIBlendState, FBlendStateInitializerRHI>(In);
}
void FWebGPUDynamicRHI::Bind(FWebGPUShaderData &Shader, const FRHIShaderParameterResource &Parameter)
{
    uint32 Type = 0;
    switch (Parameter.Type)
    {
    case FRHIShaderParameterResource::EType::UniformBuffer:
        Type = 1;
        break;
    case FRHIShaderParameterResource::EType::Sampler:
        Type = 2;
        break;
    case FRHIShaderParameterResource::EType::Texture:
    case FRHIShaderParameterResource::EType::ResourceView:
        Type = 3;
        break;
    case FRHIShaderParameterResource::EType::UnorderedAccessView:
        Type = 4;
        break;
    default:
        Unsupported(TEXT("Shader parameter resource type"));
        break;
    }
    Shader.Resources.Add((Type << 16) | Parameter.Index, Parameter.Resource);
}
void FWebGPUDynamicRHI::Parameters(FWebGPUShaderData &Shader, TConstArrayView<uint8> Bytes,
                                   TConstArrayView<FRHIShaderParameter> Values,
                                   TConstArrayView<FRHIShaderParameterResource> Resources,
                                   TConstArrayView<FRHIShaderParameterResource> Bindless)
{
    RequireOwner();
    check(Bindless.IsEmpty());
    for (const auto &Value : Values)
    {
        check(Value.BufferIndex == 0 && Value.BaseIndex + Value.ByteSize <= Shader.Globals.Num() &&
              Value.ByteOffset + Value.ByteSize <= Bytes.Num());
        FMemory::Memcpy(Shader.Globals.GetData() + Value.BaseIndex, Bytes.GetData() + Value.ByteOffset, Value.ByteSize);
    }
    for (const auto &Resource : Resources)
        Bind(Shader, Resource);
}
void FWebGPUDynamicRHI::RHISetShaderParameters(FRHIGraphicsShader *Shader, TConstArrayView<uint8> Bytes,
                                               TConstArrayView<FRHIShaderParameter> Values,
                                               TConstArrayView<FRHIShaderParameterResource> Resources,
                                               TConstArrayView<FRHIShaderParameterResource> Bindless)
{
    Parameters(ShaderData(Shader), Bytes, Values, Resources, Bindless);
}
void FWebGPUDynamicRHI::RHISetShaderParameters(FRHIComputeShader *Shader, TConstArrayView<uint8> Bytes,
                                               TConstArrayView<FRHIShaderParameter> Values,
                                               TConstArrayView<FRHIShaderParameterResource> Resources,
                                               TConstArrayView<FRHIShaderParameterResource> Bindless)
{
    Parameters(ShaderData(Shader), Bytes, Values, Resources, Bindless);
}
TArray<WGPUBindGroup> FWebGPUDynamicRHI::CreateGroups(WGPURenderPipeline Render, WGPUComputePipeline Compute,
                                                      TConstArrayView<FWebGPUShaderData *> Shaders)
{
    TMap<uint32, TArray<WGPUBindGroupEntry>> Groups;
    TArray<WGPUBuffer> TemporaryBuffers;
    uint32 Maximum = 0;
    bool HasBindings = false;
    for (FWebGPUShaderData *Shader : Shaders)
    {
        for (const auto &Item : Shader->Metadata->GetArrayField(TEXT("spirvBindings")))
        {
            const auto Binding = Item->AsObject();
            const FString Name = Binding->GetStringField(TEXT("name"));
            WGPUBindGroupEntry Entry = WGPU_BIND_GROUP_ENTRY_INIT;
            Entry.binding = Binding->GetIntegerField(TEXT("binding"));
            const uint32 Group = Binding->GetIntegerField(TEXT("group"));
            const int32 Descriptor = Binding->GetIntegerField(TEXT("descriptorType"));
            HasBindings = true;
            Maximum = FMath::Max(Maximum, Group);
            if (Name == TEXT("$Globals"))
            {
                Entry.buffer = CreateBuffer(Shader->Globals.Num(), WGPUBufferUsage_Uniform, Shader->Globals.GetData());
                Entry.size = Shader->Globals.Num();
                TemporaryBuffers.Add(Entry.buffer);
            }
            else
            {
                FRHIResource *Resource;
                bool FromTable;
                FString Error;
                checkf(ResolveBinding(*Shader, *Binding, Resource, FromTable, Error), TEXT("%s"), *Error);
                ResourceTableBindings += FromTable ? 1 : 0;
                if (Descriptor == 6)
                {
                    const auto *Uniform = static_cast<FWebGPUUniform *>(Resource);
                    Entry.size = Binding->GetIntegerField(TEXT("paddedSize"));
                    check(Entry.size <= uint64(Uniform->Bytes.Num()));
                    Entry.buffer = CreateBuffer(Entry.size, WGPUBufferUsage_Uniform, Uniform->Bytes.GetData());
                    TemporaryBuffers.Add(Entry.buffer);
                }
                else if (Descriptor == 2)
                {
                    FWebGPUTexture *Texture;
                    const ERHIAccess Access = Compute ? ERHIAccess::SRVCompute
                                              : Shader->Metadata->GetIntegerField(TEXT("frequency")) == SF_Vertex
                                                  ? ERHIAccess::SRVGraphicsNonPixel
                                                  : ERHIAccess::SRVGraphicsPixel;
                    checkf(ValidateTextureBinding(Resource, *Binding, Access, Error), TEXT("%s"), *Error);
                    checkf(ResolveSampledTexture(Resource, Texture, Entry.textureView, Access, Error), TEXT("%s"),
                           *Error);
                    RequireAccess(Texture, Access);
                }
                else if (Descriptor == 0)
                    Entry.sampler = ResolveSampler(static_cast<FWebGPUSampler *>(Resource));
                else if (Descriptor == 7)
                {
                    if (Resource->GetType() == RRT_ShaderResourceView)
                    {
                        const auto Access = Compute ? ERHIAccess::SRVCompute
                                            : Shader->Metadata->GetIntegerField(TEXT("frequency")) == SF_Vertex
                                                ? ERHIAccess::SRVGraphicsNonPixel
                                                : ERHIAccess::SRVGraphicsPixel;
                        checkf(ValidateStorageSRVBinding(Resource, *Binding, Access, Error), TEXT("%s"), *Error);
                        auto *View = static_cast<FRHIShaderResourceView *>(Resource);
                        const auto Description = View->GetDesc().Buffer.SRV.GetViewInfo(View->GetBuffer());
                        auto *Buffer = static_cast<FWebGPUBuffer *>(View->GetBuffer());
                        RequireAccess(Buffer, Access);
                        Entry.buffer = Buffer->Handle;
                        Entry.offset = Description.OffsetInBytes;
                        Entry.size = Description.SizeInBytes;
                    }
                    else
                    {
                        const auto Access = Compute ? ERHIAccess::UAVCompute : ERHIAccess::UAVGraphics;
                        checkf(ValidateStorageUAVBinding(Resource, *Binding, Access, Error), TEXT("%s"), *Error);
                        auto *View = static_cast<FRHIUnorderedAccessView *>(Resource);
                        auto *Buffer = static_cast<FWebGPUBuffer *>(View->GetResource());
                        RequireAccess(Buffer, Access);
                        const auto Description = View->GetDesc().Buffer.UAV.GetViewInfo(Buffer);
                        Entry.buffer = Buffer->Handle;
                        Entry.offset = Description.OffsetInBytes;
                        Entry.size = Description.SizeInBytes;
                    }
                }
                else
                    Unsupported(TEXT("Shader descriptor type"));
            }
            check(!Groups.FindOrAdd(Group).ContainsByPredicate(
                [&](const auto &Other) { return Other.binding == Entry.binding; }));
            Groups.FindOrAdd(Group).Add(Entry);
        }
    }
    TArray<WGPUBindGroup> Result;
    for (uint32 Group = 0; HasBindings && Group <= Maximum; ++Group)
    {
        WGPUBindGroupLayout Layout = Render ? wgpuRenderPipelineGetBindGroupLayout(Render, Group)
                                            : wgpuComputePipelineGetBindGroupLayout(Compute, Group);
        WGPUBindGroupDescriptor Desc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        Desc.layout = Layout;
        const auto *Entries = Groups.Find(Group);
        if (Entries)
        {
            Desc.entryCount = Entries->Num();
            Desc.entries = Entries->GetData();
        }
        Result.Add(wgpuDeviceCreateBindGroup(Device, &Desc));
        wgpuBindGroupLayoutRelease(Layout);
        ++BoundGroups;
    }
    for (auto Buffer : TemporaryBuffers)
        wgpuBufferRelease(Buffer);
    return Result;
}
FGraphicsPipelineStateRHIRef FWebGPUDynamicRHI::RHICreateGraphicsPipelineState(
    const FGraphicsPipelineStateInitializer &In)
{
    RequireOwner();
    ++GraphicsPipelinesCreated;
    check(In.NumSamples == 1 && !In.BoundShaderState.GetGeometryShader() &&
          (In.PrimitiveType == PT_TriangleList || In.PrimitiveType == PT_TriangleStrip));
    auto *Result = new FWebGPUGraphicsPipeline(In);
    auto &VS = static_cast<FWebGPUVertexShader *>(In.BoundShaderState.GetVertexShader())->Data;
    auto &PS = static_cast<FWebGPUPixelShader *>(In.BoundShaderState.GetPixelShader())->Data;
    WGPURenderPipelineDescriptor Desc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    Desc.vertex.module = VS.Module;
    const FTCHARToUTF8 VertexEntry(*VS.Entry), PixelEntry(*PS.Entry);
    Desc.vertex.entryPoint = Text(VertexEntry.Get());
    TArray<TArray<WGPUVertexAttribute>> Attributes;
    TArray<WGPUVertexBufferLayout> Layouts;
    if (In.BoundShaderState.VertexDeclarationRHI)
    {
        const auto *Declaration = static_cast<FWebGPUVertexDeclaration *>(In.BoundShaderState.VertexDeclarationRHI);
        for (const auto &Element : Declaration->Elements)
        {
            check(Element.StreamIndex < Limits.maxVertexBuffers);
            while (Layouts.Num() <= Element.StreamIndex)
            {
                Layouts.Add(WGPU_VERTEX_BUFFER_LAYOUT_INIT);
                Attributes.AddDefaulted();
            }
            WGPUVertexAttribute Attribute = WGPU_VERTEX_ATTRIBUTE_INIT;
            Attribute.offset = Element.Offset;
            Attribute.shaderLocation = Element.AttributeIndex;
            check(Element.Type == VET_Float2 || Element.Type == VET_Float3 || Element.Type == VET_Float4);
            Attribute.format = Element.Type == VET_Float2   ? WGPUVertexFormat_Float32x2
                               : Element.Type == VET_Float3 ? WGPUVertexFormat_Float32x3
                                                            : WGPUVertexFormat_Float32x4;
            Attributes[Element.StreamIndex].Add(Attribute);
            auto &Layout = Layouts[Element.StreamIndex];
            check(!Layout.arrayStride || Layout.arrayStride == Element.Stride);
            Layout.arrayStride = Element.Stride;
            Layout.stepMode = Element.bUseInstanceIndex ? WGPUVertexStepMode_Instance : WGPUVertexStepMode_Vertex;
        }
        for (int32 Index = 0; Index < Layouts.Num(); ++Index)
        {
            Layouts[Index].attributeCount = Attributes[Index].Num();
            Layouts[Index].attributes = Attributes[Index].GetData();
        }
        Desc.vertex.bufferCount = Layouts.Num();
        Desc.vertex.buffers = Layouts.GetData();
    }
    Desc.primitive.topology =
        In.PrimitiveType == PT_TriangleList ? WGPUPrimitiveTopology_TriangleList : WGPUPrimitiveTopology_TriangleStrip;
    Desc.primitive.cullMode = WGPUCullMode_None;
    check(In.BlendState && In.RasterizerState && In.DepthStencilState);
    FBlendStateInitializerRHI Blend;
    FDepthStencilStateInitializerRHI DepthState;
    FRasterizerStateInitializerRHI Rasterizer;
    check(In.BlendState->GetInitializer(Blend) && In.DepthStencilState->GetInitializer(DepthState) &&
          In.RasterizerState->GetInitializer(Rasterizer));
    // NumSamples is fixed to one above; UE's rasterizer MSAA permission does not enable multisampling.
    check(Rasterizer.FillMode == FM_Solid && Rasterizer.CullMode == CM_None && Rasterizer.DepthBias == 0 &&
          Rasterizer.SlopeScaleDepthBias == 0 &&
          Rasterizer.DepthClipMode == ERasterizerDepthClipMode::DepthClip && !Blend.bUseAlphaToCoverage &&
          !DepthState.bEnableFrontFaceStencil && !DepthState.bEnableBackFaceStencil &&
          In.RenderTargetsEnabled <= Limits.maxColorAttachments);
    TArray<WGPUColorTargetState> Targets;
    TArray<WGPUBlendState> Blends;
    Blends.SetNum(In.RenderTargetsEnabled);
    for (uint32 Index = 0; Index < In.RenderTargetsEnabled; ++Index)
    {
        auto Target = WGPU_COLOR_TARGET_STATE_INIT;
        Target.format = Format(EPixelFormat(In.RenderTargetFormats[Index]));
        const auto &State = Blend.RenderTargets[Blend.bUseIndependentRenderTargetBlendStates ? Index : 0];
        auto &NativeBlend = Blends[Index];
        NativeBlend.color = {BlendOperation(State.ColorBlendOp), BlendFactor(State.ColorSrcBlend),
                             BlendFactor(State.ColorDestBlend)};
        NativeBlend.alpha = {BlendOperation(State.AlphaBlendOp), BlendFactor(State.AlphaSrcBlend),
                             BlendFactor(State.AlphaDestBlend)};
        Target.blend = &NativeBlend;
        Target.writeMask = State.ColorWriteMask;
        Targets.Add(Target);
    }
    WGPUFragmentState Fragment = WGPU_FRAGMENT_STATE_INIT;
    Fragment.module = PS.Module;
    Fragment.entryPoint = Text(PixelEntry.Get());
    Fragment.targetCount = Targets.Num();
    Fragment.targets = Targets.GetData();
    Desc.fragment = &Fragment;
    WGPUDepthStencilState Depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    if (In.DepthStencilTargetFormat != PF_Unknown)
    {
        Depth.format = Format(In.DepthStencilTargetFormat);
        Depth.depthWriteEnabled = DepthState.bEnableDepthWrite ? WGPUOptionalBool_True : WGPUOptionalBool_False;
        Depth.depthCompare = Compare(DepthState.DepthTest);
        Desc.depthStencil = &Depth;
    }
    Result->Handle = wgpuDeviceCreateRenderPipeline(Device, &Desc);
    return Result;
}
FComputePipelineStateRHIRef FWebGPUDynamicRHI::RHICreateComputePipelineState(const FComputePipelineStateInitializer &In)
{
    RequireOwner();
    check(In.SpecializationConstants.IsEmpty());
    const auto &Shader = static_cast<FWebGPUComputeShader *>(In.ComputeShader)->Data;
    WGPUComputePipelineDescriptor Desc = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    Desc.compute.module = Shader.Module;
    const FTCHARToUTF8 Entry(*Shader.Entry);
    Desc.compute.entryPoint = Text(Entry.Get());
    ++ComputePipelinesCreated;
    return new FWebGPUComputePipeline(In.ComputeShader, wgpuDeviceCreateComputePipeline(Device, &Desc));
}
IRHICommandContext *FWebGPUDynamicRHI::RHIGetDefaultContext()
{
    RequireOwner();
    if (!ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    return this;
}
IRHIComputeContext *FWebGPUDynamicRHI::RHIGetCommandContext(ERHIPipeline Pipeline)
{
    RequireOwner();
    check(Pipeline == ERHIPipeline::Graphics && !ContextOpen && !Encoder);
    Encoder = wgpuDeviceCreateCommandEncoder(Device, nullptr);
    ContextOpen = true;
    return this;
}
FDynamicRHI::FRHIFinalizeContextsResult FWebGPUDynamicRHI::RHIFinalizeContexts(FRHIFinalizeContextsArgs &&Args)
{
    RequireOwner();
    if (!Args.Contexts[ERHIPipeline::Graphics])
    {
        check(!Args.Contexts[ERHIPipeline::AsyncCompute] && !Args.UploadContext);
        return {};
    }
    if (GlobalProbeMode && !ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    check(ContextOpen && Encoder && !Pass && Args.Contexts[ERHIPipeline::Graphics] == this &&
          !Args.Contexts[ERHIPipeline::AsyncCompute] && !Args.UploadContext);
    FRHIFinalizeContextsResult Result;
    Result.CommandLists[ERHIPipeline::Graphics] =
        new FWebGPUCommandList(wgpuCommandEncoderFinish(Encoder, nullptr), Finalized + 1);
    wgpuCommandEncoderRelease(Encoder);
    Encoder = nullptr;
    ContextOpen = false;
    ++Finalized;
    return Result;
}
void FWebGPUDynamicRHI::RHISubmitCommandLists(FRHISubmitCommandListsArgs &&Args)
{
    RequireOwner();
    FString Error;
    checkf(ValidateSubmissionOrder(Args.CommandLists, Error), TEXT("%s"), *Error);
    for (auto *Base : Args.CommandLists)
    {
        auto *List = static_cast<FWebGPUCommandList *>(Base);
        wgpuQueueSubmit(Queue, 1, &List->Handle);
        delete List;
        ++Submitted;
    }
}
void FWebGPUDynamicRHI::SubmitCurrent()
{
    FRHIFinalizeContextsArgs FinalizeArgs;
    FinalizeArgs.Contexts[ERHIPipeline::Graphics] = this;
    auto Result = RHIFinalizeContexts(MoveTemp(FinalizeArgs));
    FRHISubmitCommandListsArgs SubmitArgs;
    SubmitArgs.CommandLists.Add(Result.CommandLists[ERHIPipeline::Graphics]);
    RHISubmitCommandLists(MoveTemp(SubmitArgs));
}
void FWebGPUDynamicRHI::RHIBeginRenderPass(const FRHIRenderPassInfo &Info, const TCHAR *)
{
    RequireOwner();
    if (GlobalProbeMode && !ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    check(ContextOpen && Encoder && !Pass && !Info.MultiViewCount && !Info.NumOcclusionQueries);
    Attachments.Reset();
    PassDepthReadOnly = false;
    TArray<WGPURenderPassColorAttachment> Colors;
    for (const auto &Color : Info.ColorRenderTargets)
    {
        if (!Color.RenderTarget)
            break;
        auto *Texture = static_cast<FWebGPUTexture *>(Color.RenderTarget);
        RequireAccess(Texture, ERHIAccess::RTV);
        check(!Color.ResolveTarget && Color.MipIndex == 0 && Color.ArraySlice <= 0);
        Attachments.Add(Texture);
        WGPURenderPassColorAttachment Attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        Attachment.view = Texture->View;
        Attachment.loadOp = Load(Color.Action);
        Attachment.storeOp = Store(Color.Action);
        const auto Clear = Texture->GetClearColor();
        Attachment.clearValue = {Clear.R, Clear.G, Clear.B, Clear.A};
        Colors.Add(Attachment);
    }
    WGPURenderPassDepthStencilAttachment Depth = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    WGPURenderPassDescriptor Desc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    Desc.colorAttachmentCount = Colors.Num();
    Desc.colorAttachments = Colors.GetData();
    if (Info.DepthStencilRenderTarget.DepthStencilTarget)
    {
        auto *Texture = static_cast<FWebGPUTexture *>(Info.DepthStencilRenderTarget.DepthStencilTarget);
        RequireAccess(Texture, Info.DepthStencilRenderTarget.ExclusiveDepthStencil.IsDepthWrite()
                                   ? ERHIAccess::DSVWrite
                                   : ERHIAccess::DSVRead);
        Attachments.Add(Texture);
        Depth.view = Texture->View;
        Depth.depthLoadOp = Load(GetDepthActions(Info.DepthStencilRenderTarget.Action));
        Depth.depthStoreOp = Store(GetDepthActions(Info.DepthStencilRenderTarget.Action));
        PassDepthReadOnly = !Info.DepthStencilRenderTarget.ExclusiveDepthStencil.IsDepthWrite();
        if (PassDepthReadOnly)
        {
            check(Depth.depthLoadOp != WGPULoadOp_Clear);
            Depth.depthReadOnly = true;
            Depth.depthLoadOp = WGPULoadOp_Undefined;
            Depth.depthStoreOp = WGPUStoreOp_Undefined;
        }
        float ClearDepth;
        uint32 ClearStencil;
        Texture->GetDepthStencilClearValue(ClearDepth, ClearStencil);
        Depth.depthClearValue = ClearDepth;
        Depth.stencilReadOnly = !Info.DepthStencilRenderTarget.ExclusiveDepthStencil.IsStencilWrite();
        if (!Depth.stencilReadOnly)
        {
            Depth.stencilLoadOp = Load(GetStencilActions(Info.DepthStencilRenderTarget.Action));
            Depth.stencilStoreOp = Store(GetStencilActions(Info.DepthStencilRenderTarget.Action));
            Depth.stencilClearValue = ClearStencil;
        }
        else if (Info.DepthStencilRenderTarget.ExclusiveDepthStencil.IsUsingStencil())
            check(GetLoadAction(GetStencilActions(Info.DepthStencilRenderTarget.Action)) != ERenderTargetLoadAction::EClear);
        Desc.depthStencilAttachment = &Depth;
    }
    Pass = wgpuCommandEncoderBeginRenderPass(Encoder, &Desc);
}
void FWebGPUDynamicRHI::RHIEndRenderPass()
{
    check(Pass);
    wgpuRenderPassEncoderEnd(Pass);
    wgpuRenderPassEncoderRelease(Pass);
    Pass = nullptr;
    Attachments.Reset();
    PassDepthReadOnly = false;
}
void FWebGPUDynamicRHI::RHISetGraphicsPipelineState(FRHIGraphicsPipelineState *State, uint32 StencilRef, bool)
{
    check(Pass && StencilRef == 0);
    GraphicsPipeline = static_cast<FWebGPUGraphicsPipeline *>(State);
    FString Error;
    checkf(ValidatePipelineDepth(GraphicsPipeline->Initializer, Error), TEXT("%s"), *Error);
    wgpuRenderPassEncoderSetPipeline(Pass, GraphicsPipeline->Handle);
}
#if PLATFORM_USE_FALLBACK_PSO
void FWebGPUDynamicRHI::RHISetGraphicsPipelineState(const FGraphicsPipelineStateInitializer &In, uint32 Stencil,
                                                    bool Apply)
{
    auto State = RHICreateGraphicsPipelineState(In);
    RHISetGraphicsPipelineState(State, Stencil, Apply);
}
#endif
void FWebGPUDynamicRHI::RHISetComputePipelineState(FRHIComputePipelineState *State)
{
    if (GlobalProbeMode && !ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    check(!Pass);
    ComputePipeline = static_cast<FWebGPUComputePipeline *>(State);
}
void FWebGPUDynamicRHI::RHISetStreamSource(uint32 Stream, FRHIBuffer *Buffer, uint32 Offset)
{
    check(Stream < Limits.maxVertexBuffers);
    if (VertexBuffers.Num() <= int32(Stream))
    {
        VertexBuffers.SetNum(Stream + 1);
        VertexOffsets.SetNum(Stream + 1);
    }
    VertexBuffers[Stream] = static_cast<FWebGPUBuffer *>(Buffer);
    VertexOffsets[Stream] = Offset;
}
void FWebGPUDynamicRHI::RHISetViewport(float X0, float Y0, float Z0, float X1, float Y1, float Z1)
{
    check(Pass);
    wgpuRenderPassEncoderSetViewport(Pass, X0, Y0, X1 - X0, Y1 - Y0, Z0, Z1);
}
void FWebGPUDynamicRHI::RHISetScissorRect(bool Enable, uint32 X0, uint32 Y0, uint32 X1, uint32 Y1)
{
    check(Pass && !Attachments.IsEmpty());
    wgpuRenderPassEncoderSetScissorRect(Pass, Enable ? X0 : 0, Enable ? Y0 : 0,
                                        Enable ? X1 - X0 : Attachments[0]->GetSizeX(),
                                        Enable ? Y1 - Y0 : Attachments[0]->GetSizeY());
}
void FWebGPUDynamicRHI::SetDrawBindings()
{
    check(Pass && GraphicsPipeline);
    for (int32 Stream = 0; Stream < VertexBuffers.Num(); ++Stream)
        if (VertexBuffers[Stream])
        {
            RequireAccess(VertexBuffers[Stream], ERHIAccess::VertexOrIndexBuffer);
            wgpuRenderPassEncoderSetVertexBuffer(Pass, Stream, VertexBuffers[Stream]->Handle, VertexOffsets[Stream],
                                                 VertexBuffers[Stream]->GetSize() - VertexOffsets[Stream]);
        }
    auto &VS = ShaderData(GraphicsPipeline->GetShader(SF_Vertex));
    auto &PS = ShaderData(GraphicsPipeline->GetShader(SF_Pixel));
    FWebGPUShaderData *Shaders[] = {&VS, &PS};
    const auto Groups = CreateGroups(GraphicsPipeline->Handle, nullptr, Shaders);
    for (int32 Index = 0; Index < Groups.Num(); ++Index)
    {
        wgpuRenderPassEncoderSetBindGroup(Pass, Index, Groups[Index], 0, nullptr);
        wgpuBindGroupRelease(Groups[Index]);
    }
}
void FWebGPUDynamicRHI::RHIDrawPrimitive(uint32 Base, uint32 Primitives, uint32 Instances)
{
    SetDrawBindings();
    wgpuRenderPassEncoderDraw(Pass, VertexCount(GraphicsPipeline->Initializer.PrimitiveType, Primitives), Instances,
                              Base, 0);
    ++Draws;
}
void FWebGPUDynamicRHI::RHIDrawIndexedPrimitive(FRHIBuffer *Index, int32 Base, uint32 FirstInstance, uint32,
                                                uint32 StartIndex, uint32 Primitives, uint32 Instances)
{
    auto *Buffer = static_cast<FWebGPUBuffer *>(Index);
    check(Buffer->GetStride() == 2 || Buffer->GetStride() == 4);
    RequireAccess(Buffer, ERHIAccess::VertexOrIndexBuffer);
    check(GraphicsPipeline->Initializer.PrimitiveType == PT_TriangleList);
    SetDrawBindings();
    wgpuRenderPassEncoderSetIndexBuffer(Pass, Buffer->Handle,
                                        Buffer->GetStride() == 2 ? WGPUIndexFormat_Uint16 : WGPUIndexFormat_Uint32, 0,
                                        Buffer->GetSize());
    wgpuRenderPassEncoderDrawIndexed(Pass, Primitives * 3, Instances, StartIndex, Base, FirstInstance);
    ++Draws;
}
void FWebGPUDynamicRHI::RHIDispatchComputeShader(uint32 X, uint32 Y, uint32 Z)
{
    check(Encoder && !Pass && ComputePipeline);
    auto Compute = wgpuCommandEncoderBeginComputePass(Encoder, nullptr);
    wgpuComputePassEncoderSetPipeline(Compute, ComputePipeline->Handle);
    FWebGPUShaderData *Shaders[] = {&ShaderData(ComputePipeline->GetComputeShader())};
    const auto Groups = CreateGroups(nullptr, ComputePipeline->Handle, Shaders);
    for (int32 Index = 0; Index < Groups.Num(); ++Index)
    {
        wgpuComputePassEncoderSetBindGroup(Compute, Index, Groups[Index], 0, nullptr);
        wgpuBindGroupRelease(Groups[Index]);
    }
    wgpuComputePassEncoderDispatchWorkgroups(Compute, X, Y, Z);
    wgpuComputePassEncoderEnd(Compute);
    wgpuComputePassEncoderRelease(Compute);
    ++Dispatches;
}
void FWebGPUDynamicRHI::RHICopyTexture(FRHITexture *Source, FRHITexture *Destination, const FRHICopyTextureInfo &Info)
{
    check(Source->GetDesc().Dimension == ETextureDimension::Texture2D &&
          Destination->GetDesc().Dimension == ETextureDimension::Texture2D && Encoder && !Pass &&
          Source->GetFormat() == Destination->GetFormat() && Info.NumMips == 1 && Info.NumSlices == 1 &&
          Info.SourceMipIndex == 0 && Info.DestMipIndex == 0 && Info.SourceSliceIndex == 0 &&
          Info.DestSliceIndex == 0 && Info.SourcePosition.Z == 0 && Info.DestPosition.Z == 0 && Info.Size.Z <= 1);
    check(Source != Destination);
    RequireAccess(Source, ERHIAccess::CopySrc);
    RequireAccess(Destination, ERHIAccess::CopyDest);
    WGPUTexelCopyTextureInfo Src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT, Dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    Src.texture = static_cast<FWebGPUTexture *>(Source)->Handle;
    Dst.texture = static_cast<FWebGPUTexture *>(Destination)->Handle;
    Src.origin = {uint32(Info.SourcePosition.X), uint32(Info.SourcePosition.Y), uint32(Info.SourcePosition.Z)};
    Dst.origin = {uint32(Info.DestPosition.X), uint32(Info.DestPosition.Y), uint32(Info.DestPosition.Z)};
    WGPUExtent3D Size{Info.Size.X ? uint32(Info.Size.X) : Source->GetSizeX(),
                      Info.Size.Y ? uint32(Info.Size.Y) : Source->GetSizeY(), 1};
    wgpuCommandEncoderCopyTextureToTexture(Encoder, &Src, &Dst, &Size);
}
void FWebGPUDynamicRHI::RHICopyBufferRegion(FRHIBuffer *Dest, uint64 DstOffset, FRHIBuffer *Src, uint64 SrcOffset,
                                            uint64 Size)
{
    check(Encoder && !Pass && DstOffset % 4 == 0 && SrcOffset % 4 == 0 && Size % 4 == 0 &&
          DstOffset + Size <= Dest->GetSize() && SrcOffset + Size <= Src->GetSize());
    check(Dest != Src);
    RequireAccess(Src, ERHIAccess::CopySrc);
    RequireAccess(Dest, ERHIAccess::CopyDest);
    wgpuCommandEncoderCopyBufferToBuffer(Encoder, static_cast<FWebGPUBuffer *>(Src)->Handle, SrcOffset,
                                         static_cast<FWebGPUBuffer *>(Dest)->Handle, DstOffset, Size);
}
TArray<uint8> FWebGPUDynamicRHI::MapBuffer(WGPUBuffer Buffer, uint64 Bytes)
{
    auto State = MakeShared<FWebGPUCompletion, ESPMode::ThreadSafe>();
    WGPUBufferMapCallbackInfo Callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    Callback.mode = WGPUCallbackMode_AllowProcessEvents;
    // A delayed/cancelled callback owns its state even if the bounded wait has already returned.
    Callback.userdata1 = new FWebGPUCompletionRef(State);
    Callback.callback = [](WGPUMapAsyncStatus Status, WGPUStringView, void *Opaque, void *) {
        TUniquePtr<FWebGPUCompletionRef> Reference(static_cast<FWebGPUCompletionRef *>(Opaque));
        (*Reference)->Success = Status == WGPUMapAsyncStatus_Success;
        (*Reference)->Done = true;
    };
    wgpuBufferMapAsync(Buffer, WGPUMapMode_Read, 0, Bytes, Callback);
    TArray<uint8> Result;
    if (Wait([&] { return State->Done; }) && State->Success)
    {
        Result.Append(static_cast<const uint8 *>(wgpuBufferGetConstMappedRange(Buffer, 0, Bytes)), Bytes);
        wgpuBufferUnmap(Buffer);
    }
    else
        Errors.Add(TEXT("Readback map failed"));
    return Result;
}
void FWebGPUDynamicRHI::RHITick(float DeltaTime)
{
    RequireOwner();
#if !defined(PLATFORM_WEB) || !PLATFORM_WEB
    wgpuInstanceProcessEvents(Instance);
#endif
    // Browser callbacks run when UE yields back to the JavaScript event loop.
}

void FWebGPUDynamicRHI::RHIBlockUntilGPUIdle()
{
    RequireOwner();
    check(!ContextOpen);
    auto State = MakeShared<FWebGPUCompletion, ESPMode::ThreadSafe>();
    WGPUQueueWorkDoneCallbackInfo Callback = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
    Callback.mode = WGPUCallbackMode_AllowProcessEvents;
    Callback.userdata1 = new FWebGPUCompletionRef(State);
    Callback.callback = [](WGPUQueueWorkDoneStatus Status, WGPUStringView, void *Opaque, void *) {
        TUniquePtr<FWebGPUCompletionRef> Reference(static_cast<FWebGPUCompletionRef *>(Opaque));
        (*Reference)->Success = Status == WGPUQueueWorkDoneStatus_Success;
        (*Reference)->Done = true;
    };
    wgpuQueueOnSubmittedWorkDone(Queue, Callback);
    if (!Wait([&] { return State->Done; }) || !State->Success)
        Errors.Add(TEXT("Queue completion failed"));
}
TArray<uint8> FWebGPUDynamicRHI::ReadBuffer(FRHIBuffer *Source, uint64 Bytes)
{
    if (GlobalProbeMode && ContextOpen)
        SubmitCurrent();
    check(!ContextOpen && Bytes && Bytes <= Source->GetSize());
    RequireAccess(Source, ERHIAccess::CopySrc, true);
    WGPUBuffer Buffer = CreateBuffer(Bytes, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
    RHIGetCommandContext(ERHIPipeline::Graphics);
    wgpuCommandEncoderCopyBufferToBuffer(Encoder, static_cast<FWebGPUBuffer *>(Source)->Handle, 0, Buffer, 0, Bytes);
    SubmitCurrent();
    auto Result = MapBuffer(Buffer, Bytes);
    wgpuBufferRelease(Buffer);
    return Result;
}
void FWebGPUDynamicRHI::RHIReadSurfaceData(FRHITexture *Texture, FIntRect Rect, TArray<FColor> &Colors,
                                           FReadSurfaceDataFlags Flags)
{
    RequireOwner();
    if (GlobalProbeMode && ContextOpen)
        SubmitCurrent();
    check(Texture->GetDesc().Dimension == ETextureDimension::Texture2D && !ContextOpen &&
          (Texture->GetFormat() == PF_R8G8B8A8 || Texture->GetFormat() == PF_B8G8R8A8));
    RequireAccess(Texture, ERHIAccess::CopySrc, true);
    checkf(!Flags.GetLinearToGamma() && !Flags.GetOutputStencil() && Flags.GetMip() == 0 && Flags.GetGPUIndex() == 0 &&
               Flags.GetCompressionMode() == RCM_UNorm && Flags.GetCubeFace() == CubeFace_MAX,
           TEXT("WebGPU probe supports raw mip0 RGBA8/BGRA8 readback only"));
    check(Rect.Min.X >= 0 && Rect.Min.Y >= 0 && Rect.Width() > 0 && Rect.Height() > 0 &&
          Rect.Max.X <= int32(Texture->GetSizeX()) && Rect.Max.Y <= int32(Texture->GetSizeY()));
    Colors.Reset();
    const uint32 Pitch = Align(uint32(Rect.Width()) * 4, 256u), Size = Pitch * Rect.Height();
    WGPUBuffer Buffer = CreateBuffer(Size, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
    RHIGetCommandContext(ERHIPipeline::Graphics);
    WGPUTexelCopyTextureInfo Src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    Src.texture = static_cast<FWebGPUTexture *>(Texture)->Handle;
    Src.origin = {uint32(Rect.Min.X), uint32(Rect.Min.Y), 0};
    WGPUTexelCopyBufferInfo Dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    Dst.buffer = Buffer;
    Dst.layout.bytesPerRow = Pitch;
    Dst.layout.rowsPerImage = Rect.Height();
    WGPUExtent3D Extent{uint32(Rect.Width()), uint32(Rect.Height()), 1};
    wgpuCommandEncoderCopyTextureToBuffer(Encoder, &Src, &Dst, &Extent);
    SubmitCurrent();
    const auto Bytes = MapBuffer(Buffer, Size);
    wgpuBufferRelease(Buffer);
    if (Bytes.Num() != int32(Size))
        return;
    Colors.Reset();
    for (int32 Y = 0; Y < Rect.Height(); ++Y)
        for (int32 X = 0; X < Rect.Width(); ++X)
        {
            const uint8 *Pixel = Bytes.GetData() + Y * Pitch + X * 4;
            Colors.Emplace(Pixel[Texture->GetFormat() == PF_B8G8R8A8 ? 2 : 0], Pixel[1],
                           Pixel[Texture->GetFormat() == PF_B8G8R8A8 ? 0 : 2], Pixel[3]);
        }
}
