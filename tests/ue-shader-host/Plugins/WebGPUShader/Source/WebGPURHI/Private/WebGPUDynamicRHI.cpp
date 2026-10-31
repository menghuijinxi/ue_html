#include "WebGPUDynamicRHI.h"
#include "DataDrivenShaderPlatformInfo.h"
#include "GlobalRenderResources.h"
#include "RenderResource.h"
#include "Containers/ResourceArray.h"
#include "RHITextureUtils.h"
#include "RHITextureReference.h"
#include "RHIUtilities.h"
#include "RHIStats.h"

#include "HAL/PlatformProcess.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformTLS.h"
#include "Misc/FileHelper.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderParameterStruct.h"
#include "Stats/StatsData.h"
#if defined(PLATFORM_WEB) && PLATFORM_WEB
#include <emscripten.h>
#endif

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
WGPULimits RenderingLimits(WGPUAdapter Adapter)
{
    WGPULimits Supported = WGPU_LIMITS_INIT;
    check(wgpuAdapterGetLimits(Adapter, &Supported) == WGPUStatus_Success);
    WGPULimits Required = WGPU_LIMITS_INIT;
    Required.maxColorAttachmentBytesPerSample = FMath::Min(64u, Supported.maxColorAttachmentBytesPerSample);
    Required.maxSampledTexturesPerShaderStage = FMath::Min(32u, Supported.maxSampledTexturesPerShaderStage);
    Required.maxStorageBuffersPerShaderStage = FMath::Min(16u, Supported.maxStorageBuffersPerShaderStage);
    // Desktop Bloom can emit 17 interpolants; the default device limit is only 16.
    Required.maxInterStageShaderVariables = FMath::Min(28u, Supported.maxInterStageShaderVariables);
    Required.maxDynamicUniformBuffersPerPipelineLayout = Supported.maxDynamicUniformBuffersPerPipelineLayout;
    return Required;
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
    return Value == PF_R8G8B8A8_UINT || Value == PF_R32_UINT || Value == PF_R16_UINT ||
        Value == PF_R32G32_UINT || Value == PF_R32G32B32A32_UINT;
}
bool IsBCTextureFormat(EPixelFormat Value)
{
    return Value == PF_DXT1 || Value == PF_DXT3 || Value == PF_DXT5 || Value == PF_BC4 ||
           Value == PF_BC5 || Value == PF_BC6H || Value == PF_BC7;
}
bool SupportsSRGB(EPixelFormat Value)
{
    return Value == PF_R8G8B8A8 || Value == PF_B8G8R8A8 || Value == PF_DXT1 ||
           Value == PF_DXT3 || Value == PF_DXT5 || Value == PF_BC7;
}
bool IsSampled2DTextureFormat(EPixelFormat Value)
{
    return Value == PF_R8G8B8A8 || Value == PF_B8G8R8A8 || Value == PF_G8 || Value == PF_R8 ||
           Value == PF_R8G8 || Value == PF_G16R16 || Value == PF_A16B16G16R16 ||
           Value == PF_A2B10G10R10 || Value == PF_FloatRGBA || Value == PF_A32B32G32R32F ||
           Value == PF_FloatRGB || Value == PF_FloatR11G11B10 ||
           Value == PF_R16F || Value == PF_G16R16F || Value == PF_R32_FLOAT ||
           IsUnsignedTextureFormat(Value) || IsBCTextureFormat(Value);
}
uint32 StorageImageFormat(EPixelFormat Value)
{
    // SPIR-V image formats must match the WGSL storage texture and the RHI view.
    switch (Value)
    {
    case PF_A32B32G32R32F: return 1;
    case PF_FloatRGBA: return 2;
    case PF_R32_FLOAT: return 3;
    case PF_R8G8B8A8: return 4;
    case PF_G16R16F: return 7;
    case PF_FloatRGB:
    case PF_FloatR11G11B10: return 8;
    case PF_R16F: return 9;
    case PF_A16B16G16R16: return 10;
    case PF_G16R16: return 12;
    case PF_R8G8: return 13;
    case PF_G8:
    case PF_R8: return 15;
    case PF_R8G8B8A8_UINT: return 32;
    case PF_R32G32B32A32_UINT: return 30;
    case PF_R32_UINT: return 33;
    case PF_R32G32_UINT: return 35;
    case PF_R16_UINT: return 38;
    default: return 0;
    }
}
WGPUTextureFormat StorageFormat(uint32 ImageFormat)
{
    switch (ImageFormat)
    {
    case 1: return WGPUTextureFormat_RGBA32Float;
    case 2: return WGPUTextureFormat_RGBA16Float;
    case 3: return WGPUTextureFormat_R32Float;
    case 4: return WGPUTextureFormat_RGBA8Unorm;
    case 7: return WGPUTextureFormat_RG16Float;
    case 8: return WGPUTextureFormat_RG11B10Ufloat;
    case 9: return WGPUTextureFormat_R16Float;
    case 10: return WGPUTextureFormat_RGBA16Unorm;
    case 12: return WGPUTextureFormat_RG16Unorm;
    case 13: return WGPUTextureFormat_RG8Unorm;
    case 15: return WGPUTextureFormat_R8Unorm;
    case 32: return WGPUTextureFormat_RGBA8Uint;
    case 30: return WGPUTextureFormat_RGBA32Uint;
    case 33: return WGPUTextureFormat_R32Uint;
    case 35: return WGPUTextureFormat_RG32Uint;
    case 38: return WGPUTextureFormat_R16Uint;
    default:
        checkf(false, TEXT("WebGPU storage image format unsupported: %u"), ImageFormat);
        return WGPUTextureFormat_Undefined;
    }
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
    case PF_G16R16:
        return WGPUTextureFormat_RG16Unorm;
    case PF_A16B16G16R16:
        return WGPUTextureFormat_RGBA16Unorm;
    case PF_A2B10G10R10:
        return WGPUTextureFormat_RGB10A2Unorm;
    case PF_FloatRGBA:
        return WGPUTextureFormat_RGBA16Float;
    case PF_A32B32G32R32F:
        return WGPUTextureFormat_RGBA32Float;
    case PF_FloatRGB:
    case PF_FloatR11G11B10:
        return WGPUTextureFormat_RG11B10Ufloat;
    case PF_R16F:
        return WGPUTextureFormat_R16Float;
    case PF_G16R16F:
        return WGPUTextureFormat_RG16Float;
    case PF_R32_FLOAT:
        return WGPUTextureFormat_R32Float;
    case PF_R8G8B8A8_UINT:
        return WGPUTextureFormat_RGBA8Uint;
    case PF_R32G32B32A32_UINT:
        return WGPUTextureFormat_RGBA32Uint;
    case PF_R32G32_UINT:
        return WGPUTextureFormat_RG32Uint;
    case PF_R32_UINT:
        return WGPUTextureFormat_R32Uint;
    case PF_R16_UINT:
        return WGPUTextureFormat_R16Uint;
    case PF_DXT1:
        return SRGB ? WGPUTextureFormat_BC1RGBAUnormSrgb : WGPUTextureFormat_BC1RGBAUnorm;
    case PF_DXT3:
        return SRGB ? WGPUTextureFormat_BC2RGBAUnormSrgb : WGPUTextureFormat_BC2RGBAUnorm;
    case PF_DXT5:
        return SRGB ? WGPUTextureFormat_BC3RGBAUnormSrgb : WGPUTextureFormat_BC3RGBAUnorm;
    case PF_BC4:
        return WGPUTextureFormat_BC4RUnorm;
    case PF_BC5:
        return WGPUTextureFormat_BC5RGUnorm;
    case PF_BC6H:
        return WGPUTextureFormat_BC6HRGBUfloat;
    case PF_BC7:
        return SRGB ? WGPUTextureFormat_BC7RGBAUnormSrgb : WGPUTextureFormat_BC7RGBAUnorm;
    case PF_DepthStencil:
        return WGPUTextureFormat_Depth24PlusStencil8;
    case PF_ShadowDepth:
        return WGPUTextureFormat_Depth16Unorm;
    default:
        checkf(false, TEXT("WebGPURHI pixel format unsupported: %d"), Value);
        return WGPUTextureFormat_Undefined;
    }
}
WGPUVertexFormat VertexFormat(EVertexElementType Type)
{
    switch (Type)
    {
    case VET_Float1: return WGPUVertexFormat_Float32;
    case VET_Float2: return WGPUVertexFormat_Float32x2;
    case VET_Float3: return WGPUVertexFormat_Float32x3;
    case VET_Float4: return WGPUVertexFormat_Float32x4;
    case VET_PackedNormal: return WGPUVertexFormat_Snorm8x4;
    case VET_UByte4: return WGPUVertexFormat_Uint8x4;
    case VET_UByte4N: return WGPUVertexFormat_Unorm8x4;
    case VET_Color: return WGPUVertexFormat_Unorm8x4BGRA;
    case VET_Half2: return WGPUVertexFormat_Float16x2;
    case VET_Half4: return WGPUVertexFormat_Float16x4;
    case VET_Short4N: return WGPUVertexFormat_Snorm16x4;
    case VET_UShort2: return WGPUVertexFormat_Uint16x2;
    default:
        checkf(false, TEXT("WebGPU vertex element type unsupported: %u"), uint32(Type));
        return WGPUVertexFormat_Float32;
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
WGPUStencilOperation StencilOperation(EStencilOp In)
{
    switch (In)
    {
    case SO_Keep: return WGPUStencilOperation_Keep;
    case SO_Zero: return WGPUStencilOperation_Zero;
    case SO_Replace: return WGPUStencilOperation_Replace;
    case SO_SaturatedIncrement: return WGPUStencilOperation_IncrementClamp;
    case SO_SaturatedDecrement: return WGPUStencilOperation_DecrementClamp;
    case SO_Invert: return WGPUStencilOperation_Invert;
    case SO_Increment: return WGPUStencilOperation_IncrementWrap;
    case SO_Decrement: return WGPUStencilOperation_DecrementWrap;
    default: checkNoEntry(); return WGPUStencilOperation_Keep;
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
void WriteTextureMip(FWebGPUDynamicRHI &RHI, FWebGPUTexture *Texture, uint32 Mip, const uint8 *Bytes, uint64 Size,
                     uint32 Face = 0)
{
    uint64 Stride;
    check(UE::RHITextureUtils::CalculateTextureMipSize(Texture->GetDesc(), Mip, Stride) == Size);
    const auto Blocks = UE::RHITextureUtils::CalculateMipBlockCounts(Texture->GetDesc(), Mip);
    const auto &Pixel = GPixelFormats[Texture->GetFormat()];
    WGPUTexelCopyTextureInfo Destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    Destination.texture = Texture->Handle;
    Destination.mipLevel = Mip;
    Destination.origin.z = Face;
    WGPUTexelCopyBufferLayout Layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
    Layout.bytesPerRow = Stride;
    Layout.rowsPerImage = Blocks.Y;
    // WebGPU copies address physical blocks, including the 2x2 and 1x1 mip tails.
    WGPUExtent3D Extent{Blocks.X * Pixel.BlockSizeX, Blocks.Y * Pixel.BlockSizeY, Blocks.Z * Pixel.BlockSizeZ};
    wgpuQueueWriteTexture(RHI.Queue, &Destination, Bytes, Size, &Layout, &Extent);
    if (RHI.StartupProbeMode)
        UE_LOG(LogRHI, Display, TEXT("P3_TEXTURE_UPLOAD name=%s mip=%u extent=%ux%ux%u bytes=%llu"),
               *Texture->GetName().ToString(), Mip, Extent.width, Extent.height, Extent.depthOrArrayLayers, Size);
}
uint32 TextureLockLayer(const FRHILockTextureArgs& Args)
{
    check(Args.Texture);
    const auto& Desc = Args.Texture->GetDesc();
    const bool Cube = Desc.IsTextureCube();
    check((Desc.Dimension == ETextureDimension::Texture2D ||
           Desc.Dimension == ETextureDimension::Texture2DArray || Cube) &&
          IsSampled2DTextureFormat(Desc.Format) &&
          Args.ArrayIndex < Desc.ArraySize && Args.FaceIndex < (Cube ? 6u : 1u) &&
          !Args.bLockWithinMiptail && Args.MipIndex < Desc.NumMips);
    return Args.ArrayIndex * (Cube ? 6u : 1u) + Args.FaceIndex;
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
                      for (uint32 Array = 0; Array < Texture->GetDesc().ArraySize; ++Array)
                      for (uint32 Face = 0; Face < (Texture->GetDesc().IsTextureCube() ? 6u : 1u); ++Face)
                      for (uint32 Mip = 0; Mip < Texture->GetNumMips(); ++Mip)
                      {
                          uint64 Stride, Size;
                          const uint64 Offset = UE::RHITextureUtils::CalculateSubresourceOffset(
                              Texture->GetDesc(), Face, Array, Mip, Stride, Size);
                          check(Offset + Size <= uint64(Texture->InitialBytes.Num()));
                          WriteTextureMip(RHI, Texture, Mip, Texture->InitialBytes.GetData() + Offset, Size,
                              Face + Array * (Texture->GetDesc().IsTextureCube() ? 6u : 1u));
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
                  check(Writable && uint32(Index.MipIndex) < uint32(Texture->GetNumMips()) &&
                        uint32(Index.ArrayIndex) < Texture->GetDesc().ArraySize &&
                        uint32(Index.FaceIndex) < (Texture->GetDesc().IsTextureCube() ? 6u : 1u) &&
                        !Texture->InitialBytes.IsEmpty());
                  uint64 Stride, Size;
                  const uint64 Offset = UE::RHITextureUtils::CalculateSubresourceOffset(
                      Texture->GetDesc(), Index.FaceIndex, Index.ArrayIndex, Index.MipIndex, Stride, Size);
                  check(Offset + Size <= uint64(Texture->InitialBytes.Num()));
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
    EmitDebugMarkers = EM_ASM_INT({ return globalThis.__webStartupDiagnostics?.mode !== 'normal'; }) != 0;
    const bool Mobile = FParse::Param(FCommandLine::Get(), TEXT("es31"));
    GMaxRHIFeatureLevel = Mobile ? ERHIFeatureLevel::ES3_1 : ERHIFeatureLevel::SM5;
    GMaxRHIShaderPlatform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(
        Mobile ? TEXT("SP_WEBGPU_ES31") : TEXT("SP_WEBGPU_SM5"));
    GSupportsTexture3D = true;
    // Compute access to 3D textures is supported; layered raster output is not.
    // This must match DDPI's lack of geometry shaders and vertex shader layers.
    GSupportsVolumeTextureRendering = false;
    GRHIGlobals.UseTexture3DBulkData = true;
    GRHIGlobals.SupportsTexture3DAnisotropicFiltering = false;
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
    GSupportsParallelRenderingTasksWithSeparateRHIThread = false;
    GRHISupportsMultithreadedResources = false;
    GRHISupportsMultithreadedShaderCreation = false;
    GRHISupportsAsyncPipelinePrecompile = false;
    GRHISupportsPSOPrecaching = false;
    GRHISupportsPipelineFileCache = false;
    GRHISupportsTextureStreaming = true;
    GRHIRequiresRenderTargetForPixelShaderUAVs = true;
    GRHISupportsAsyncTextureCreation = false;
    GRHISupportsExactOcclusionQueries = false;
    const auto* Pool = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Streaming.PoolSize"));
    GTexturePoolSize = int64(Pool && Pool->GetInt() >= 0 ? Pool->GetInt() : 256) * 1024 * 1024;
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
        TArray<WGPUFeatureName> Features;
        for (WGPUFeatureName Feature : {WGPUFeatureName_TextureCompressionBC,
                 WGPUFeatureName_TextureFormatsTier1, WGPUFeatureName_TextureFormatsTier2, WGPUFeatureName_RG11B10UfloatRenderable,
                 WGPUFeatureName_Subgroups, WGPUFeatureName_Float32Filterable})
        {
            if (wgpuAdapterHasFeature(Adapter, Feature))
                Features.Add(Feature);
        }
        DeviceDesc.requiredFeatureCount = Features.Num();
        DeviceDesc.requiredFeatures = Features.GetData();
        const WGPULimits Required = RenderingLimits(Adapter);
        DeviceDesc.requiredLimits = &Required;
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
    // Browsers may withhold the PCI vendor ID; distinguish that from an unqueried adapter.
    GRHIVendorId = uint32(EGpuVendorId::Unknown);
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
    TArray<WGPUFeatureName> Features;
    for (WGPUFeatureName Feature : {WGPUFeatureName_TextureCompressionBC,
             WGPUFeatureName_TextureFormatsTier1, WGPUFeatureName_TextureFormatsTier2, WGPUFeatureName_RG11B10UfloatRenderable,
             WGPUFeatureName_Subgroups, WGPUFeatureName_Float32Filterable})
    {
        if (wgpuAdapterHasFeature(Adapter, Feature))
            Features.Add(Feature);
    }
    Desc.requiredFeatureCount = Features.Num();
    Desc.requiredFeatures = Features.GetData();
    const WGPULimits Required = RenderingLimits(Adapter);
    Desc.requiredLimits = &Required;
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
    check(!PreviousDepthFormat.IsSet() && !PreviousStencilFormat.IsSet() && !PreviousShadowFormat.IsSet());
    PreviousDepthFormat = GPixelFormats[PF_DepthStencil];
    PreviousStencilFormat = GPixelFormats[PF_X24_G8];
    PreviousShadowFormat = GPixelFormats[PF_ShadowDepth];
    PreviousPackedHDRFormat = GPixelFormats[PF_FloatR11G11B10];
    PreviousFloatRGBFormat = GPixelFormats[PF_FloatRGB];
    auto& PackedHDRFormat = GPixelFormats[PF_FloatR11G11B10];
    PackedHDRFormat.Supported = true;
    PackedHDRFormat.PlatformFormat = WGPUTextureFormat_RG11B10Ufloat;
    PackedHDRFormat.Capabilities = EPixelFormatCapabilities::Texture2D | EPixelFormatCapabilities::TextureCube |
        EPixelFormatCapabilities::Texture3D |
        EPixelFormatCapabilities::TextureLoad | EPixelFormatCapabilities::TextureSample |
        EPixelFormatCapabilities::TextureFilterable;
    if (wgpuDeviceHasFeature(Device, WGPUFeatureName_RG11B10UfloatRenderable))
        PackedHDRFormat.Capabilities |= EPixelFormatCapabilities::RenderTarget;
    if (wgpuDeviceHasFeature(Device, WGPUFeatureName_TextureFormatsTier1))
        PackedHDRFormat.Capabilities |= EPixelFormatCapabilities::TextureStore |
            EPixelFormatCapabilities::UAV | EPixelFormatCapabilities::TypedUAVLoad | EPixelFormatCapabilities::TypedUAVStore;
    auto& FloatRGBFormat = GPixelFormats[PF_FloatRGB];
    FloatRGBFormat.Supported = PackedHDRFormat.Supported;
    FloatRGBFormat.PlatformFormat = PackedHDRFormat.PlatformFormat;
    FloatRGBFormat.Capabilities = PackedHDRFormat.Capabilities;
    auto& DepthFormat = GPixelFormats[PF_DepthStencil];
    DepthFormat.Supported = true;
    DepthFormat.PlatformFormat = WGPUTextureFormat_Depth24PlusStencil8;
    DepthFormat.Capabilities = EPixelFormatCapabilities::Texture2D | EPixelFormatCapabilities::DepthStencil |
        EPixelFormatCapabilities::TextureLoad;
    auto& StencilFormat = GPixelFormats[PF_X24_G8];
    StencilFormat.Supported = true;
    StencilFormat.PlatformFormat = WGPUTextureFormat_Stencil8;
    StencilFormat.Capabilities = EPixelFormatCapabilities::Texture2D | EPixelFormatCapabilities::TextureLoad;
    auto& ShadowFormat = GPixelFormats[PF_ShadowDepth];
    ShadowFormat.Supported = true;
    // Match the native D3D12 shadow format and its memory accounting.
    ShadowFormat.PlatformFormat = WGPUTextureFormat_Depth16Unorm;
    ShadowFormat.BlockBytes = 2;
    ShadowFormat.Capabilities = EPixelFormatCapabilities::Texture2D | EPixelFormatCapabilities::TextureCube | EPixelFormatCapabilities::DepthStencil |
        EPixelFormatCapabilities::TextureLoad | EPixelFormatCapabilities::TextureSample;
    Queue = wgpuDeviceGetQueue(Device);
    const TCHAR* Filters[] = {TEXT("Point"), TEXT("Bilinear"), TEXT("Trilinear")};
    for (uint32 Filter = 0; Filter < UE_ARRAY_COUNT(Filters); ++Filter)
    for (uint32 Wrap = 0; Wrap < 2; ++Wrap)
    {
        const auto Address = Wrap ? AM_Wrap : AM_Clamp;
        GlobalSamplers.Add(FString::Printf(TEXT("VulkanGlobal%s%sSampler"), Filters[Filter],
            Wrap ? TEXT("Wrapped") : TEXT("Clamped")),
            RHICreateSamplerState(FSamplerStateInitializerRHI(ESamplerFilter(Filter), Address, Address, Address)));
    }
    if (StartupProbeMode || GlobalProbeMode)
    {
        GRHIMaxDispatchThreadGroupsPerDimension = FIntVector(Limits.maxComputeWorkgroupsPerDimension);
        GRHIGlobals.MaxComputeSharedMemory = Limits.maxComputeWorkgroupStorageSize;
    }
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
        GMaxShadowDepthBufferSizeX = Limits.maxTextureDimension2D;
        GMaxShadowDepthBufferSizeY = Limits.maxTextureDimension2D;
        GMaxCubeTextureDimensions = Limits.maxTextureDimension2D;
        GMaxTextureArrayLayers = Limits.maxTextureArrayLayers;
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
                                    {TEXT("GBlackTextureDepthCube"), GBlackTextureDepthCube},
                                    {TEXT("GBlackCubeArrayTexture"), GBlackCubeArrayTexture},
                                    {TEXT("GBlackUintTexture"), GBlackUintTexture}};
            for (const auto &Entry : OptionalDefaults)
            {
                // Desktop material and reflection passes retain their native fallback bindings.
                if (GMaxRHIFeatureLevel >= ERHIFeatureLevel::SM5 &&
                    (Entry.Resource == GBlackCubeArrayTexture || Entry.Resource == GBlackArrayTexture ||
                     Entry.Resource == GBlackUintTexture))
                    continue;
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
    BindGroupCache.Empty();
    ReleaseFrameBindings();
    if (FrameUniformBuffer) wgpuBufferRelease(FrameUniformBuffer);
    FrameUniformBuffer = nullptr;
    ReleaseBindings();
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    EM_ASM({ globalThis.__webFlushRetiredGPUResources(); });
#endif
    GlobalSamplers.Empty();
    for (const auto& Entry : ClearPipelines)
        wgpuComputePipelineRelease(Entry.Value);
    ClearPipelines.Empty();
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
        GPixelFormats[PF_ShadowDepth] = PreviousShadowFormat.GetValue();
        GPixelFormats[PF_FloatR11G11B10] = PreviousPackedHDRFormat.GetValue();
        GPixelFormats[PF_FloatRGB] = PreviousFloatRGBFormat.GetValue();
        PreviousDepthFormat.Reset();
        PreviousStencilFormat.Reset();
        PreviousShadowFormat.Reset();
        PreviousPackedHDRFormat.Reset();
        PreviousFloatRGBFormat.Reset();
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
    AttachmentSubresources.Reset();
    StaticUniformBuffers.Reset();
}
void FWebGPUDynamicRHI::RHIEndFrame(const FRHIEndFrameArgs &Args)
{
    RequireOwner();
    check(!ContextOpen && !Encoder && !Pass && !Args.bProfileNextFrame);
    // Reuse unchanged material bindings across frames. Drop every group not used this frame:
    // obsolete streaming views and previous uniform pages survive at most one additional frame.
    for (auto Bucket = BindGroupCache.CreateIterator(); Bucket; ++Bucket)
    {
        BindGroupCacheEntries -= Bucket.Value().RemoveAll([this](const auto& Entry) {
            return Entry->LastUsedFrame != EndFrames;
        });
        if (Bucket.Value().IsEmpty()) Bucket.RemoveCurrent();
    }
    ReleaseFrameBindings();
    ReleaseBindings();
    if (FrameUniformBuffer) wgpuBufferRelease(FrameUniformBuffer);
    FrameUniformBuffer = nullptr;
    FrameUniformOffset = 0;
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    // All encoders have been submitted. Retire allocations even if JS has not run GC.
    EM_ASM({ globalThis.__webFlushRetiredGPUResources(); });
#endif
#if STATS
    // WebGPU has no GPU-profiler EOP worker; retire the CPU statistics at submission.
    if (Args.StatsFrame.IsSet())
    {
        FEndOfPipeStats* Stats = FEndOfPipeStats::Get();
        Stats->AddMessage(FStatConstants::AdvanceFrame.GetEncodedName(),
            EStatOperation::AdvanceFrameEventEndOfPipe, Args.StatsFrame.GetValue());
        Stats->Flush();
    }
#endif
    ++EndFrames;
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    if (EndFrames % 30 == 0)
        EM_ASM({
            globalThis.__webOcclusionRHI = {};
            globalThis.__webOcclusionRHI.ready = $0;
            globalThis.__webOcclusionRHI.pending = $1;
            globalThis.__webOcclusionRHI.zero = $2;
            globalThis.__webOcclusionRHI.bindGroupCacheHits = $3;
            globalThis.__webOcclusionRHI.bindGroupsCreated = $4;
            globalThis.__webOcclusionRHI.cachedBindGroups = $5;
        }, OcclusionResultsReady, OcclusionResultsPending, OcclusionResultsZero, BindGroupCacheHits,
            BoundGroups, BindGroupCacheEntries);
#endif
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
    Data.Frequency = Frequency;
    for (const auto &Item : Metadata->GetArrayField(TEXT("spirvBindings")))
    {
        const auto Binding = Item->AsObject();
        FWebGPUShaderBinding Entry;
        Entry.Metadata = Binding.Get();
        Entry.Name = Binding->GetStringField(TEXT("name"));
        Entry.Descriptor = Binding->GetIntegerField(TEXT("descriptorType"));
        Entry.Group = Binding->GetIntegerField(TEXT("group"));
        Entry.Index = Binding->GetIntegerField(TEXT("binding"));
        Entry.PaddedSize = Entry.Descriptor == 6 || Entry.Name == TEXT("$Globals") ?
            Binding->GetIntegerField(TEXT("paddedSize")) : 0;
        if (Entry.Descriptor == 2)
        {
            double Dimension;
            Entry.TextureContractValid = Binding->TryGetNumberField(TEXT("textureDimension"), Dimension) &&
                Binding->TryGetBoolField(TEXT("textureArrayed"), Entry.TextureArrayed) &&
                Binding->TryGetBoolField(TEXT("textureMultisampled"), Entry.TextureMultisampled) &&
                Binding->TryGetStringField(TEXT("textureSampleType"), Entry.TextureSampleType);
            if (Entry.TextureContractValid) Entry.TextureDimension = Dimension;
        }
        Data.Bindings.Add(MoveTemp(Entry));
        if (Data.Bindings.Last().Name == TEXT("$Globals"))
            Data.Globals.SetNumZeroed(Data.Bindings.Last().PaddedSize);
    }
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
        Shader->Data.Owner = Shader.GetReference();                                                                    \
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
    if (StartupProbeMode && EndFrames == 0)
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
    checkf(In.Filter <= SF_AnisotropicLinear && In.MipBias == 0 &&
               (In.SamplerComparisonFunction == SCF_Never || In.SamplerComparisonFunction == SCF_Less),
           TEXT("WebGPU sampler requires a supported filter without mip bias"));
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
    const bool Anisotropic = In.Filter == SF_AnisotropicPoint || In.Filter == SF_AnisotropicLinear;
    Desc.minFilter = Desc.magFilter = In.Filter == SF_Point ? WGPUFilterMode_Nearest : WGPUFilterMode_Linear;
    Desc.mipmapFilter = In.Filter == SF_Trilinear || Anisotropic ? WGPUMipmapFilterMode_Linear
                                                               : WGPUMipmapFilterMode_Nearest;
    Desc.maxAnisotropy = Anisotropic ? FMath::Clamp(ComputeAnisotropyRT(In.MaxAnisotropy), 1, 16) : 1;
    Desc.lodMinClamp = In.MinMipLevel;
    Desc.lodMaxClamp = In.MaxMipLevel;
    if (In.SamplerComparisonFunction == SCF_Less)
        Desc.compare = WGPUCompareFunction_Less;
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
    if (EnumHasAnyFlags(Desc.Usage, BUF_DrawIndirect))
        Usage |= WGPUBufferUsage_Indirect;
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
void FWebGPUDynamicRHI::RHIGetTextureMemoryStats(FTextureMemoryStats& OutStats)
{
    // WebGPU does not expose adapter VRAM capacity or physical allocation sizes.
    OutStats = FTextureMemoryStats();
    UE::RHICore::FillBaselineTextureMemoryStats(OutStats);
}
FRHILockTextureResult FWebGPUDynamicRHI::RHILockTexture(FRHICommandListImmediate &,
                                                        const FRHILockTextureArgs &Args)
{
    RequireOwner();
    auto *Texture = static_cast<FWebGPUTexture *>(Args.Texture);
    check(Args.LockMode == RLM_WriteOnly);
    const uint32 Layer = TextureLockLayer(Args);
    const uint32 Key = Args.MipIndex * Texture->LayerCount() + Layer;
    check(!Texture->MipLocks.Contains(Key));
    RequireAccess(Texture, ERHIAccess::CopyDest, true, 0, Args.MipIndex, Layer);
    if (ContextOpen)
        SubmitCurrent();
    uint64 Stride;
    const uint64 Size = UE::RHITextureUtils::CalculateTextureMipSize(Texture->GetDesc(), Args.MipIndex, Stride);
    check(Size <= MAX_int32 && Stride <= MAX_uint32);
    auto& Bytes = Texture->MipLocks.Add(Key);
    Bytes.SetNumZeroed(Size);
    return {Bytes.GetData(), Size, uint32(Stride)};
}
void FWebGPUDynamicRHI::RHIUnlockTexture(FRHICommandListImmediate &, const FRHILockTextureArgs &Args)
{
    RequireOwner();
    auto *Texture = static_cast<FWebGPUTexture *>(Args.Texture);
    const uint32 Layer = TextureLockLayer(Args);
    TArray<uint8> Bytes;
    const bool Unlocked = Texture->MipLocks.RemoveAndCopyValue(
        Args.MipIndex * Texture->LayerCount() + Layer, Bytes);
    check(Unlocked && !Bytes.IsEmpty());
    // Queue writes follow previously submitted draws and copy their CPU data before returning.
    RequireAccess(Texture, ERHIAccess::CopyDest, true, 0, Args.MipIndex, Layer);
    if (ContextOpen)
        SubmitCurrent();
    WriteTextureMip(*this, Texture, Args.MipIndex, Bytes.GetData(), Bytes.Num(), Layer);
}
bool FWebGPUDynamicRHI::ValidateTextureInitialization(const FRHITextureCreateDesc &In, FString &Error) const
{
    const bool Volume = In.Dimension == ETextureDimension::Texture3D;
    const bool Cube = In.IsTextureCube();
    const bool CubeArray = In.Dimension == ETextureDimension::TextureCubeArray;
    const bool Array = In.Dimension == ETextureDimension::Texture2DArray;
    if ((In.Format == PF_FloatRGB || In.Format == PF_FloatR11G11B10) &&
        (!EnumHasAnyFlags(In.Flags, ETextureCreateFlags::ShaderResource) ||
         EnumHasAnyFlags(In.Flags, ETextureCreateFlags::DepthStencilTargetable | ETextureCreateFlags::SRGB) ||
         (EnumHasAnyFlags(In.Flags, ETextureCreateFlags::UAV) &&
             !wgpuDeviceHasFeature(Device, WGPUFeatureName_TextureFormatsTier1)) ||
         (EnumHasAnyFlags(In.Flags, ETextureCreateFlags::RenderTargetable) &&
             !wgpuDeviceHasFeature(Device, WGPUFeatureName_RG11B10UfloatRenderable))))
    {
        Error = TEXT("R11G11B10 requires linear textures and the corresponding render/storage features");
        return false;
    }
    if (Array && (!IsSampled2DTextureFormat(In.Format) || IsBCTextureFormat(In.Format) ||
        !EnumHasAnyFlags(In.Flags, ETextureCreateFlags::ShaderResource) ||
        EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB)))
    {
        Error = TEXT("2D arrays require a supported linear sampled color format");
        return false;
    }
    if (IsBCTextureFormat(In.Format) &&
        (!wgpuDeviceHasFeature(Device, WGPUFeatureName_TextureCompressionBC) ||
         (Volume || In.Extent.X % 4 || In.Extent.Y % 4) ||
         !EnumHasAnyFlags(In.Flags, ETextureCreateFlags::ShaderResource) ||
         EnumHasAnyFlags(In.Flags, ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::DepthStencilTargetable |
             ETextureCreateFlags::UAV)))
    {
        Error = TEXT("BC textures require texture-compression-bc, block-aligned sampled 2D/cube data and no render/storage usage");
        return false;
    }
    if ((In.Format == PF_G16R16 || In.Format == PF_A16B16G16R16) &&
        !wgpuDeviceHasFeature(Device, WGPUFeatureName_TextureFormatsTier1))
    {
        Error = TEXT("Desktop UNORM16 render targets require texture-formats-tier1");
        return false;
    }
    const bool Color = Volume ? In.Format == PF_R8G8B8A8 || In.Format == PF_B8G8R8A8 ||
                                    In.Format == PF_R8G8B8A8_UINT || In.Format == PF_FloatRGBA ||
                                    In.Format == PF_FloatRGB || In.Format == PF_FloatR11G11B10 ||
                                    In.Format == PF_R16F || In.Format == PF_G16R16F ||
                                    In.Format == PF_R8 || In.Format == PF_G8 ||
                                    In.Format == PF_R32_UINT || In.Format == PF_R32_FLOAT
                              : IsSampled2DTextureFormat(In.Format);
    const uint32 Limit = Volume ? Limits.maxTextureDimension3D : Limits.maxTextureDimension2D;
    if ((In.Dimension != ETextureDimension::Texture2D && !Volume && !Cube && !Array) ||
        (Cube && (In.Extent.X != In.Extent.Y || (!Color && (CubeArray || In.Format != PF_ShadowDepth)))) ||
        ((Array || CubeArray) ? !In.ArraySize ||
            uint32(In.ArraySize) * (Cube ? 6u : 1u) > Limits.maxTextureArrayLayers : In.ArraySize != 1) || !In.Depth ||
        (!Volume && In.Depth != 1) || !In.NumMips ||
        In.NumSamples != 1 || In.Extent.X <= 0 || In.Extent.Y <= 0 ||
        uint32(In.Extent.X) > Limit || uint32(In.Extent.Y) > Limit || (Volume && In.Depth > Limit) ||
        (!Color && (Volume || (In.Format != PF_DepthStencil && In.Format != PF_ShadowDepth))) ||
        (Volume && (!EnumHasAnyFlags(In.Flags, ETextureCreateFlags::ShaderResource) ||
                    (EnumHasAnyFlags(In.Flags, ETextureCreateFlags::RenderTargetable) &&
                     !EnumHasAnyFlags(In.Flags, ETextureCreateFlags::UAV)))) ||
        (Volume && EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB)) ||
        (!SupportsSRGB(In.Format) && EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB)) ||
        (!Color && (In.NumMips != 1 ||
                    !EnumHasAnyFlags(In.Flags, ETextureCreateFlags::DepthStencilTargetable) ||
                    EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB | ETextureCreateFlags::UAV |
                        ETextureCreateFlags::RenderTargetable))) ||
        In.NumMips > FMath::FloorLog2(FMath::Max(uint32(FMath::Max(In.Extent.X, In.Extent.Y)), uint32(In.Depth))) + 1 ||
        (EnumHasAnyFlags(In.Flags, ETextureCreateFlags::UAV) &&
         (!StorageImageFormat(In.Format) ||
          ((In.Format == PF_R16F || In.Format == PF_G16R16F || In.Format == PF_R16_UINT ||
            In.Format == PF_R8 || In.Format == PF_G8 || In.Format == PF_R8G8) &&
           !wgpuDeviceHasFeature(Device, WGPUFeatureName_TextureFormatsTier1)))) ||
        (In.InitAction != ERHITextureInitAction::Default && In.InitAction != ERHITextureInitAction::Initializer &&
         In.InitAction != ERHITextureInitAction::BulkData) ||
        (In.InitAction != ERHITextureInitAction::Default && !Color))
    {
        Error =
            TEXT("Only supported sampled 2D/cube formats (including BC), single-mip depth or existing linear sampled 3D textures are implemented");
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
                                                                      const FRHITextureCreateDesc &Requested)
{
    RequireOwner();
    FRHITextureCreateDesc In = Requested;
    // FTextureCubeResource uses the legacy implicit sampling capability for asset cubes.
    if (In.IsTextureCube() &&
        !EnumHasAnyFlags(In.Flags, ~(ETextureCreateFlags::SRGB | ETextureCreateFlags::OfflineProcessed)))
        In.Flags |= ETextureCreateFlags::ShaderResource;
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
    Desc.size = {uint32(In.Extent.X), uint32(In.Extent.Y), In.IsTextureCube() ? 6u * In.ArraySize :
        In.Dimension == ETextureDimension::Texture2DArray ? uint32(In.ArraySize) : uint32(In.Depth)};
    Desc.format = Format(In.Format, EnumHasAnyFlags(In.Flags, ETextureCreateFlags::SRGB));
    Desc.mipLevelCount = In.NumMips;
    Desc.usage = Volume || IsBCTextureFormat(In.Format) ||
        ((In.Format == PF_FloatRGB || In.Format == PF_FloatR11G11B10) &&
            !wgpuDeviceHasFeature(Device, WGPUFeatureName_RG11B10UfloatRenderable)) ?
        WGPUTextureUsage_None : WGPUTextureUsage_RenderAttachment;
    if (EnumHasAnyFlags(In.Flags, ETextureCreateFlags::UAV))
        Desc.usage |= WGPUTextureUsage_StorageBinding;
    if (In.Format != PF_DepthStencil && In.Format != PF_ShadowDepth)
        Desc.usage |= WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst | WGPUTextureUsage_TextureBinding;
    else if (EnumHasAnyFlags(In.Flags, ETextureCreateFlags::ShaderResource))
        Desc.usage |= WGPUTextureUsage_TextureBinding;
    if (In.Format == PF_ShadowDepth)
        Desc.usage |= WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst;
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
#if defined(PLATFORM_WEB) && PLATFORM_WEB
        if (Resource && Resource == GNullVertexBuffer.VertexBufferRHI)
        {
            // Passthrough skinning binds this zero SRV before it has previous-frame positions,
            // even with manual vertex fetch disabled. It must be a real binding, not nullptr.
            // Web storage buffers have no typed views: expose the three zero position scalars
            // as float32, matching GPUSkinPassThroughVFLooseParameters.PreviousPositionBuffer.
            const auto& View = Desc.Buffer.SRV;
            check(View.BufferType == FRHIViewDesc::EBufferType::Typed && View.Format == PF_R8G8B8A8 &&
                !View.Stride && !View.NumElements && !View.OffsetInBytes && !View.bAtomicCounter &&
                !View.bAppendBuffer && static_cast<FRHIBuffer*>(Resource)->GetSize() == 12);
            auto PositionDesc = Desc;
            PositionDesc.Buffer.SRV.Format = PF_R32_FLOAT;
            checkf(ValidateBufferSRV(Resource, PositionDesc, Error), TEXT("WebGPU default position SRV: %s"), *Error);
            UE_LOG(LogRHI, Display, TEXT("P3_DEFAULT_POSITION_SRV bytes=12 format=float32 zero=1"));
            return new FWebGPUBufferSRV(static_cast<FWebGPUBuffer*>(Resource), PositionDesc);
        }
#endif
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
    View.dimension = Info.Dimension == FRHIViewDesc::EDimension::Texture3D ? WGPUTextureViewDimension_3D :
        Info.Dimension == FRHIViewDesc::EDimension::TextureCube ? WGPUTextureViewDimension_Cube :
        Info.Dimension == FRHIViewDesc::EDimension::TextureCubeArray ? WGPUTextureViewDimension_CubeArray :
        Info.Dimension == FRHIViewDesc::EDimension::Texture2DArray ? WGPUTextureViewDimension_2DArray :
        WGPUTextureViewDimension_2D;
    View.baseMipLevel = Info.MipRange.First;
    View.mipLevelCount = Info.MipRange.Num;
    View.baseArrayLayer = Info.ArrayRange.First;
    View.arrayLayerCount = Info.ArrayRange.Num;
    if (Info.Dimension == FRHIViewDesc::EDimension::TextureCube ||
        Info.Dimension == FRHIViewDesc::EDimension::TextureCubeArray)
    {
        View.baseArrayLayer *= 6;
        View.arrayLayerCount *= 6;
    }
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
          (Texture->GetFormat() == PF_R8G8B8A8 || Texture->GetFormat() == PF_R32_FLOAT) &&
          Region.Width && Region.Height &&
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
                                                               EUniformBufferUsage Usage, EUniformBufferValidation)
{
    RequireOwner();
    check(Layout && !EnumHasAnyFlags(Layout->Flags, ERHIUniformBufferFlags::UniformView));
    auto *Result = new FWebGPUUniform(Layout);
    Result->SingleFrame = Usage != UniformBuffer_MultiFrame;
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
    if (Resource && Resource->GetType() == RRT_Texture &&
        Desc.Common.ViewType == FRHIViewDesc::EViewType::TextureUAV)
    {
        auto* Texture = static_cast<FWebGPUTexture*>(Resource);
        const auto Info = Desc.Texture.UAV.GetViewInfo(Texture);
        check(EnumHasAnyFlags(Texture->GetFlags(), ETextureCreateFlags::UAV) &&
              StorageImageFormat(Info.Format) &&
              Info.Format == Texture->GetFormat() && Info.Plane == ERHITexturePlane::Primary &&
              Info.MipLevel < Texture->GetNumMips());
        WGPUTextureViewDescriptor View = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        View.format = Format(Info.Format);
        View.dimension = Info.Dimension == FRHIViewDesc::EDimension::Texture3D ? WGPUTextureViewDimension_3D :
            Info.Dimension == FRHIViewDesc::EDimension::Texture2DArray ||
            Info.Dimension == FRHIViewDesc::EDimension::TextureCube ||
            Info.Dimension == FRHIViewDesc::EDimension::TextureCubeArray ? WGPUTextureViewDimension_2DArray :
            WGPUTextureViewDimension_2D;
        View.baseMipLevel = Info.MipLevel;
        View.mipLevelCount = 1;
        View.baseArrayLayer = Info.ArrayRange.First;
        View.arrayLayerCount = Info.ArrayRange.Num;
        if (Info.Dimension == FRHIViewDesc::EDimension::TextureCube ||
            Info.Dimension == FRHIViewDesc::EDimension::TextureCubeArray)
        {
            View.baseArrayLayer *= 6;
            View.arrayLayerCount *= 6;
        }
        View.usage = WGPUTextureUsage_StorageBinding;
        return new FWebGPUTextureUAV(Texture, Desc, wgpuTextureCreateView(Texture->Handle, &View));
    }
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
    if (View.BufferType == FRHIViewDesc::EBufferType::Raw)
    {
        const uint64 Size = Buffer->GetSize();
        const uint64 Bytes = View.NumElements ? uint64(View.NumElements) * sizeof(uint32) : Size;
        if (View.Format != PF_Unknown || View.Stride || View.bAtomicCounter || View.bAppendBuffer ||
            !EnumHasAllFlags(Buffer->GetUsage(), BUF_ByteAddressBuffer | BUF_UnorderedAccess) ||
            EnumHasAnyFlags(Buffer->GetUsage(), BUF_AccelerationStructure) ||
            !Size || Size % sizeof(uint32) || !Bytes || Bytes > Limits.maxStorageBufferBindingSize ||
            View.OffsetInBytes >= Size || View.OffsetInBytes % Limits.minStorageBufferOffsetAlignment ||
            (View.OffsetInBytes && !View.NumElements) || uint64(View.OffsetInBytes) + Bytes > Size)
        {
            Error = TEXT("Raw UAV requires a ByteAddress UnorderedAccess buffer, aligned uint32 range and no format/stride/counter");
            return false;
        }
        return true;
    }
    if (View.BufferType == FRHIViewDesc::EBufferType::Typed)
    {
        if ((View.Format != PF_R32_UINT && View.Format != PF_R32G32B32A32_UINT && View.Format != PF_A32B32G32R32F &&
                View.Format != PF_R32_FLOAT && View.Format != PF_R32_SINT) ||
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
    const bool Cube = Target.IsTextureCube();
    const bool CubeArray = Target.Dimension == ETextureDimension::TextureCubeArray;
    const bool Array = Target.Dimension == ETextureDimension::Texture2DArray;
    const bool DepthStencil = Target.Format == PF_DepthStencil || Target.Format == PF_ShadowDepth;
    const bool DepthPlane = View.Plane == ERHITexturePlane::Primary || View.Plane == ERHITexturePlane::Depth ||
        (Target.Format == PF_DepthStencil && View.Plane == ERHITexturePlane::Stencil);
    if ((Target.Dimension != ETextureDimension::Texture2D && !Volume && !Cube && !Array) ||
        (!Array && !CubeArray && Target.ArraySize != 1) ||
        (!Volume && Target.Depth != 1) || Target.NumSamples != 1 ||
        (Volume ? View.Dimension != FRHIViewDesc::EDimension::Texture3D :
         Cube ? View.Dimension != FRHIViewDesc::EDimension::TextureCube &&
                    View.Dimension != FRHIViewDesc::EDimension::TextureCubeArray &&
                    View.Dimension != FRHIViewDesc::EDimension::Texture2DArray &&
                    View.Dimension != FRHIViewDesc::EDimension::Texture2D :
         Array ? View.Dimension != FRHIViewDesc::EDimension::Texture2DArray &&
                     View.Dimension != FRHIViewDesc::EDimension::Texture2D :
         View.Dimension != FRHIViewDesc::EDimension::Texture2D) ||
        (DepthStencil ? !DepthPlane : View.Plane != ERHITexturePlane::Primary))
    {
        Error = TEXT("Texture SRV requires matching 2D/3D dimension, primary plane, single mip and single array layer");
        return false;
    }
    const bool SupportedFormat = Volume ? Target.Format == PF_R8G8B8A8 || Target.Format == PF_B8G8R8A8 ||
                                             Target.Format == PF_R8G8B8A8_UINT || Target.Format == PF_FloatRGBA ||
                                             Target.Format == PF_R16F || Target.Format == PF_G16R16F ||
                                             Target.Format == PF_R8 || Target.Format == PF_G8 ||
                                             Target.Format == PF_R32_UINT || Target.Format == PF_R32_FLOAT
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
    // Reject invalid ranges before GetViewInfo, which asserts on malformed descriptors.
    const uint32 Mips = View.MipRange.Num ? View.MipRange.Num : Target.NumMips;
    const bool CubeView = View.Dimension == FRHIViewDesc::EDimension::TextureCube ||
        View.Dimension == FRHIViewDesc::EDimension::TextureCubeArray;
    const uint32 Layers = CubeView ? Target.ArraySize : Texture->LayerCount();
    const uint32 Arrays = View.ArrayRange.Num ? View.ArrayRange.Num :
        Cube && View.Dimension == FRHIViewDesc::EDimension::Texture2DArray ? Texture->LayerCount() : Target.ArraySize;
    if ((!View.MipRange.Num && View.MipRange.First) || (!View.ArrayRange.Num && View.ArrayRange.First) ||
        uint32(View.MipRange.First) + Mips > Target.NumMips ||
        uint32(View.ArrayRange.First) + Arrays > Layers)
    {
        Error = TEXT("Texture SRV mip/array range is outside the supported texture");
        return false;
    }
    return true;
}
bool FWebGPUDynamicRHI::ValidateTextureBinding(FRHIResource *Resource, const FJsonObject &Binding, ERHIAccess Access,
                                               FString &Error) const
{
    FWebGPUShaderBinding Reflected;
    double Dimension;
    Reflected.TextureContractValid = Binding.TryGetNumberField(TEXT("textureDimension"), Dimension) &&
        Binding.TryGetBoolField(TEXT("textureArrayed"), Reflected.TextureArrayed) &&
        Binding.TryGetBoolField(TEXT("textureMultisampled"), Reflected.TextureMultisampled) &&
        Binding.TryGetStringField(TEXT("textureSampleType"), Reflected.TextureSampleType);
    if (Reflected.TextureContractValid) Reflected.TextureDimension = Dimension;
    FWebGPUTexture* Texture;
    WGPUTextureView View;
    return ValidateTextureBinding(Resource, Reflected, Access, Error, Texture, View);
}
bool FWebGPUDynamicRHI::ValidateTextureBinding(FRHIResource *Resource, const FWebGPUShaderBinding &Binding,
    ERHIAccess Access, FString &Error, FWebGPUTexture *&Texture, WGPUTextureView &View) const
{
    if (!ResolveSampledTexture(Resource, Texture, View, Access, Error))
        return false;
    const auto ViewDimension = Resource->GetType() == RRT_ShaderResourceView ?
        static_cast<FRHIShaderResourceView*>(Resource)->GetDesc().Texture.SRV.Dimension :
        Texture->GetDesc().Dimension == ETextureDimension::TextureCubeArray ? FRHIViewDesc::EDimension::TextureCubeArray :
        Texture->GetDesc().IsTextureCube() ? FRHIViewDesc::EDimension::TextureCube :
        Texture->GetDesc().Dimension == ETextureDimension::Texture2DArray ? FRHIViewDesc::EDimension::Texture2DArray :
        Texture->GetDesc().Dimension == ETextureDimension::Texture3D ? FRHIViewDesc::EDimension::Texture3D :
        FRHIViewDesc::EDimension::Texture2D;
    const bool ArrayView = ViewDimension == FRHIViewDesc::EDimension::Texture2DArray ||
        ViewDimension == FRHIViewDesc::EDimension::TextureCubeArray;
    const uint32 Expected = ViewDimension == FRHIViewDesc::EDimension::Texture3D ? 2 :
        ViewDimension == FRHIViewDesc::EDimension::TextureCube ||
        ViewDimension == FRHIViewDesc::EDimension::TextureCubeArray ? 3 : 1;
    if (!Binding.TextureContractValid || Binding.TextureDimension != Expected ||
        Binding.TextureArrayed != ArrayView || Binding.TextureMultisampled)
    {
        Error = TEXT("Sampled texture and reflected shader dimensions do not match");
        return false;
    }
    const bool Stencil = Resource->GetType() == RRT_ShaderResourceView &&
        static_cast<FRHIShaderResourceView*>(Resource)->GetDesc().Texture.SRV.GetViewInfo(Texture).Plane ==
            ERHITexturePlane::Stencil;
    const TCHAR *ExpectedSampleType = Stencil || IsUnsignedTextureFormat(Texture->GetFormat()) ? TEXT("uint") : TEXT("float");
    if (Binding.TextureSampleType != ExpectedSampleType)
    {
        Error = TEXT("Sampled texture format and reflected shader scalar type do not match");
        return false;
    }
    return true;
}
uint64 FWebGPUDynamicRHI::RHIGetMinimumAlignmentForBufferBackedSRV(EPixelFormat InFormat)
{
    return InFormat == PF_R32_UINT || InFormat == PF_R32G32B32A32_UINT || InFormat == PF_A32B32G32R32F ||
                   InFormat == PF_R32_FLOAT || InFormat == PF_R32_SINT || InFormat == PF_G8
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
    if (View.BufferType == FRHIViewDesc::EBufferType::Raw)
    {
        const uint64 Size = Buffer->GetSize();
        const uint64 Bytes = View.NumElements ? uint64(View.NumElements) * sizeof(uint32) : Size;
        if (View.Format != PF_Unknown || View.Stride || View.bAtomicCounter || View.bAppendBuffer ||
            !EnumHasAllFlags(Buffer->GetUsage(), BUF_ByteAddressBuffer | BUF_ShaderResource) ||
            EnumHasAnyFlags(Buffer->GetUsage(), BUF_AccelerationStructure) ||
            !Size || Size % sizeof(uint32) || !Bytes || Bytes > Limits.maxStorageBufferBindingSize ||
            View.OffsetInBytes >= Size || View.OffsetInBytes % Limits.minStorageBufferOffsetAlignment ||
            (View.OffsetInBytes && !View.NumElements) || uint64(View.OffsetInBytes) + Bytes > Size)
        {
            Error = TEXT("Raw SRV requires a ByteAddress ShaderResource buffer, aligned uint32 range and no format/stride/counter");
            return false;
        }
        return true;
    }
    if (View.BufferType != FRHIViewDesc::EBufferType::Typed ||
        (View.Format != PF_R32_UINT && View.Format != PF_R32G32B32A32_UINT && View.Format != PF_A32B32G32R32F &&
            View.Format != PF_R32_FLOAT && View.Format != PF_R32_SINT && View.Format != PF_G8) ||
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
    if (!Size || Size % Stride || !Bytes || (View.Format == PF_G8 && Bytes % 4) ||
        Bytes > Limits.maxStorageBufferBindingSize || View.OffsetInBytes >= Size ||
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
    if (Typed && Desc.Format == PF_G8)
    {
        FString Packing;
        if (!Binding.TryGetStringField(TEXT("storagePacking"), Packing) || Packing != TEXT("unorm8x4"))
        {
            Error = TEXT("G8 buffer SRV requires explicit packed UNORM8 shader decoding");
            return false;
        }
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
    const uint32 Plane = Resource->GetType() == RRT_ShaderResourceView &&
        static_cast<FRHIShaderResourceView *>(Resource)->GetDesc().Texture.SRV.Plane ==
            ERHITexturePlane::Stencil ? 1 : 0;
    if (Resource->GetType() == RRT_ShaderResourceView)
    {
        const auto Info = static_cast<FRHIShaderResourceView*>(Resource)->GetDesc().Texture.SRV.GetViewInfo(Texture);
        const uint32 Faces = Info.Dimension == FRHIViewDesc::EDimension::TextureCube ||
            Info.Dimension == FRHIViewDesc::EDimension::TextureCubeArray ? 6 : 1;
        for (uint32 Slice = Info.ArrayRange.First * Faces; Slice < (Info.ArrayRange.First + Info.ArrayRange.Num) * Faces; ++Slice)
        for (uint32 Mip = Info.MipRange.First; Mip < uint32(Info.MipRange.First) + Info.MipRange.Num; ++Mip)
            if (!ValidateAccess(Texture, Access, Error, false, Plane, Mip, Slice))
                return false;
        return true;
    }
    return ValidateSampledTexture(Texture, Error, Access, Plane);
}
bool FWebGPUDynamicRHI::ValidateSampledTexture(FRHITexture *Texture, FString &Error, ERHIAccess Access,
                                              uint32 Plane) const
{
    return ValidateAccess(Texture, Access, Error, false, Plane);
}
bool FWebGPUDynamicRHI::IsRenderAttachment(FWebGPUTexture* Texture, uint32 Mip, uint32 Slice) const
{
    for (int32 Index = 0; Index < Attachments.Num(); ++Index)
        if (Attachments[Index] == Texture && uint32(AttachmentSubresources[Index].X) == Mip &&
            uint32(AttachmentSubresources[Index].Y) == Slice)
            return true;
    return false;
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
    if (const auto* Route = Shader.BindingRoutes.Find(&Binding))
    {
        FRHIUniformBuffer* Uniform = nullptr;
        if (Route->Kind != FWebGPUBindingRoute::EKind::Direct &&
            !ResolveUniform(Shader, Route->Slot, Uniform, Error))
            return false;
        if (Route->Kind == FWebGPUBindingRoute::EKind::Uniform)
        {
            Resource = Uniform;
            return true;
        }
        if (Route->Kind == FWebGPUBindingRoute::EKind::Direct)
        {
            const auto* Found = Shader.Resources.Find(Route->Index);
            if (!Found || !Found->IsValid())
            {
                Error = TEXT("Direct shader resource is not bound");
                return false;
            }
            Resource = Found->GetReference();
        }
        else
        {
            const auto& Layout = Uniform->GetLayout();
            if (!Layout.Resources.IsValidIndex(Route->Index) ||
                Layout.Resources[Route->Index].MemberType != Route->MemberType ||
                !Uniform->GetResourceTable().IsValidIndex(Route->Index))
            {
                Error = TEXT("Resource table member index/type mismatch");
                return false;
            }
            Resource = Uniform->GetResourceTable()[Route->Index].GetReference();
            FromTable = true;
        }
        if (Resource && Resource->GetType() == RRT_TextureReference)
            Resource = static_cast<FRHITextureReference*>(Resource)->GetReferencedTexture();
        if (FromTable && (!Resource || Resource->GetType() != Route->ResourceType))
        {
            Error = TEXT("Resource table member is null or has wrong RHI type");
            return false;
        }
        return true;
    }
    const auto CacheRoute = [&](FWebGPUBindingRoute Route) {
        // Synthetic validation bindings may be mutable and are deliberately never cached.
        if (Shader.Bindings.ContainsByPredicate([&](const auto& Entry) { return Entry.Metadata == &Binding; }))
            Shader.BindingRoutes.Add(&Binding, Route);
    };
    const FString Name = Binding.GetStringField(TEXT("name"));
    const uint32 Descriptor = Binding.GetIntegerField(TEXT("descriptorType"));
    if (Descriptor == 0)
        if (const auto* Sampler = GlobalSamplers.Find(Name))
        {
            Resource = Sampler->GetReference();
            return true;
        }
    for (const auto &Item : Shader.Metadata->GetArrayField(TEXT("ueParameterMap")))
    {
        const auto Parameter = Item->AsObject();
        if (Parameter->GetStringField(TEXT("name")) != Name)
            continue;
        const uint32 Type = Parameter->GetIntegerField(TEXT("type"));
        if ((Descriptor == 6 && Type != 1) || (Descriptor == 2 && Type != 3) || (Descriptor == 0 && Type != 2) ||
            (Descriptor == 7 && Type != 3 && Type != 4) || (Descriptor == 3 && Type != 4))
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
            CacheRoute({FWebGPUBindingRoute::EKind::Uniform, Index});
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
        if (Resource->GetType() == RRT_TextureReference)
            Resource = static_cast<FRHITextureReference *>(Resource)->GetReferencedTexture();
        CacheRoute({FWebGPUBindingRoute::EKind::Direct, 0, (ResourceType << 16) | Index});
        return true;
    }
    TArray<const TArray<uint32>*> Streams;
    if (Descriptor == 2)
        Streams = {&Shader.ResourceTable.TextureMap, &Shader.ResourceTable.ShaderResourceViewMap};
    else if (Descriptor == 0)
        Streams.Add(&Shader.ResourceTable.SamplerMap);
    else if (Descriptor == 3)
        Streams.Add(&Shader.ResourceTable.UnorderedAccessViewMap);
    else if (Descriptor == 7)
        Streams.Add(Binding.GetBoolField(TEXT("readOnlyStorage")) ? &Shader.ResourceTable.ShaderResourceViewMap :
            &Shader.ResourceTable.UnorderedAccessViewMap);
    if (Streams.IsEmpty())
    {
        Error = TEXT("Resource table descriptor is unsupported: ") + Name;
        return false;
    }
    for (const auto* Stream : Streams)
    for (const auto &Item : Shader.Metadata->GetArrayField(TEXT("ueParameterMap")))
    {
        const auto Parameter = Item->AsObject();
        if (Parameter->GetIntegerField(TEXT("type")) != 1)
            continue;
        const uint32 Slot = Parameter->GetIntegerField(TEXT("bufferIndex"));
        if (Slot >= 32 || !(Shader.ResourceTable.ResourceTableBits & (1u << Slot)))
            continue;
        if (Stream->IsEmpty())
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
                           (Stream == &Shader.ResourceTable.TextureMap ?
                                Member->GetIntegerField(TEXT("type")) == UBMT_TEXTURE ||
                                Member->GetIntegerField(TEXT("type")) == UBMT_RDG_TEXTURE :
                            Stream == &Shader.ResourceTable.SamplerMap ?
                                Member->GetIntegerField(TEXT("type")) == UBMT_SAMPLER :
                            Stream == &Shader.ResourceTable.ShaderResourceViewMap ?
                                Member->GetIntegerField(TEXT("type")) == UBMT_SRV ||
                                Member->GetIntegerField(TEXT("type")) == UBMT_RDG_TEXTURE_SRV ||
                                Member->GetIntegerField(TEXT("type")) == UBMT_RDG_TEXTURE_NON_PIXEL_SRV ||
                                Member->GetIntegerField(TEXT("type")) == UBMT_RDG_BUFFER_SRV :
                                Member->GetIntegerField(TEXT("type")) == UBMT_UAV ||
                                Member->GetIntegerField(TEXT("type")) == UBMT_RDG_TEXTURE_UAV ||
                                Member->GetIntegerField(TEXT("type")) == UBMT_RDG_BUFFER_UAV);
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
                uint32(Layout.Resources[ResourceIndex].MemberType) !=
                    uint32((*Entry)->AsObject()->GetIntegerField(TEXT("type"))) ||
                !Uniform->GetResourceTable().IsValidIndex(ResourceIndex))
            {
                Error = TEXT("Resource table member index/type mismatch");
                return false;
            }
            Resource = Uniform->GetResourceTable()[ResourceIndex].GetReference();
            if (Resource && Resource->GetType() == RRT_TextureReference)
                Resource = static_cast<FRHITextureReference *>(Resource)->GetReferencedTexture();
            const ERHIResourceType ExpectedType = Stream == &Shader.ResourceTable.TextureMap ? RRT_Texture :
                Stream == &Shader.ResourceTable.SamplerMap ? RRT_SamplerState :
                Stream == &Shader.ResourceTable.ShaderResourceViewMap ? RRT_ShaderResourceView : RRT_UnorderedAccessView;
            if (!Resource || Resource->GetType() != ExpectedType)
            {
                Error = FString::Printf(TEXT("Resource table member is null or has wrong RHI type: %s descriptor=%u actual=%u"),
                    *Name, Descriptor, Resource ? uint32(Resource->GetType()) : MAX_uint32);
                return false;
            }
            FromTable = true;
            CacheRoute({FWebGPUBindingRoute::EKind::Table, Slot, ResourceIndex,
                Layout.Resources[ResourceIndex].MemberType, ExpectedType});
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
void FWebGPUDynamicRHI::TrackShaderBindings(FWebGPUShaderData& Shader)
{
    if (Shader.BindingFrame != EndFrames)
    {
        check(Shader.Owner);
        Shader.BindingFrame = EndFrames;
        FrameShaders.Add(Shader.Owner);
    }
}
void FWebGPUDynamicRHI::ReleaseFrameBindings()
{
    for (const auto& Shader : FrameShaders)
    {
        auto& Data = ShaderData(Shader);
        Data.Resources.Reset();
        if (Data.GlobalsBuffer) wgpuBufferRelease(Data.GlobalsBuffer);
        Data.GlobalsBuffer = nullptr;
        Data.GlobalsBufferOffset = 0;
        Data.BindingFrame = MAX_uint32;
    }
    FrameShaders.Reset();
}
FWebGPUUniform::FConstantSnapshot FWebGPUDynamicRHI::UploadFrameConstants(const void* Data, uint64 Bytes)
{
    constexpr uint64 PageBytes = 1024 * 1024;
    check(Bytes && Bytes <= 64 * 1024);
    if (!FrameUniformBuffer || Align(FrameUniformOffset, uint64(256)) + Bytes > PageBytes)
    {
        if (FrameUniformBuffer) wgpuBufferRelease(FrameUniformBuffer);
        FrameUniformBuffer = CreateBuffer(PageBytes, WGPUBufferUsage_Uniform);
        FrameUniformOffset = 0;
    }
    FWebGPUUniform::FConstantSnapshot Snapshot{FrameUniformBuffer, Align(FrameUniformOffset, uint64(256))};
    FrameUniformOffset = Snapshot.Offset + Bytes;
    wgpuBufferAddRef(Snapshot.Buffer);
    wgpuQueueWriteBuffer(Queue, Snapshot.Buffer, Snapshot.Offset, Data, Bytes);
    return Snapshot;
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
    TrackShaderBindings(Shader);
    for (const auto &Value : Values)
    {
        check(Value.BufferIndex == 0 && Value.BaseIndex + Value.ByteSize <= Shader.Globals.Num() &&
              Value.ByteOffset + Value.ByteSize <= Bytes.Num());
        if (Shader.GlobalsBuffer &&
            FMemory::Memcmp(Shader.Globals.GetData() + Value.BaseIndex, Bytes.GetData() + Value.ByteOffset,
                Value.ByteSize) != 0)
        {
            wgpuBufferRelease(Shader.GlobalsBuffer);
            Shader.GlobalsBuffer = nullptr;
        }
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
TArray<FWebGPUResolvedGroup> FWebGPUDynamicRHI::CreateGroups(WGPURenderPipeline Render, WGPUComputePipeline Compute,
                                                      TConstArrayView<FWebGPUShaderData *> Shaders)
{
    TMap<uint32, TArray<WGPUBindGroupEntry>> Groups;
    TMap<uint32, TArray<TPair<uint32, uint32>>> DynamicOffsets;
    const auto& DynamicBindings = Render ? GraphicsPipeline->DynamicBindings : ComputePipeline->DynamicBindings;
    uint32 Maximum = 0;
    bool HasBindings = false;
    for (FWebGPUShaderData *Shader : Shaders)
    {
        TrackShaderBindings(*Shader);
        for (const auto &Reflected : Shader->Bindings)
        {
            const auto* Binding = Reflected.Metadata;
            const auto& Name = Reflected.Name;
            WGPUBindGroupEntry Entry = WGPU_BIND_GROUP_ENTRY_INIT;
            Entry.binding = Reflected.Index;
            const uint32 Group = Reflected.Group;
            const uint32 Descriptor = Reflected.Descriptor;
            HasBindings = true;
            Maximum = FMath::Max(Maximum, Group);
            if (Name == TEXT("$Globals"))
            {
                if (!Shader->GlobalsBuffer)
                {
                    const auto Snapshot = UploadFrameConstants(Shader->Globals.GetData(), Shader->Globals.Num());
                    Shader->GlobalsBuffer = Snapshot.Buffer;
                    Shader->GlobalsBufferOffset = Snapshot.Offset;
                    ++UniformUploads;
                }
                Entry.buffer = Shader->GlobalsBuffer;
                Entry.offset = Shader->GlobalsBufferOffset;
                Entry.size = Shader->Globals.Num();
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
                    auto *Uniform = static_cast<FWebGPUUniform *>(Resource);
                    Entry.size = Reflected.PaddedSize;
                    check(Entry.size <= uint64(Uniform->Bytes.Num()));
                    auto& Snapshot = Uniform->ConstantBuffers.FindOrAdd(uint32(Entry.size));
                    if (!Snapshot.Buffer)
                    {
                        if (Uniform->SingleFrame && Entry.size <= 64 * 1024)
                        {
                            Snapshot = UploadFrameConstants(Uniform->Bytes.GetData(), Entry.size);
                        }
                        else
                            Snapshot.Buffer = CreateBuffer(Entry.size, WGPUBufferUsage_Uniform, Uniform->Bytes.GetData());
                        ++UniformUploads;
                    }
                    Entry.buffer = Snapshot.Buffer;
                    Entry.offset = Snapshot.Offset;
                }
                else if (Descriptor == 2)
                {
                    FWebGPUTexture *Texture;
                    const ERHIAccess Access = Compute ? ERHIAccess::SRVCompute
                                              : Shader->Frequency == SF_Vertex
                                                  ? ERHIAccess::SRVGraphicsNonPixel
                                                  : ERHIAccess::SRVGraphicsPixel;
                    checkf(ValidateTextureBinding(Resource, Reflected, Access, Error, Texture, Entry.textureView),
                        TEXT("%s"), *Error);
                    ++AccessChecks; // ResolveSampledTexture validated the exact SRV mip and face range.
                }
                else if (Descriptor == 0)
                    Entry.sampler = ResolveSampler(static_cast<FWebGPUSampler *>(Resource));
                else if (Descriptor == 3)
                {
                    check(Resource && Resource->GetType() == RRT_UnorderedAccessView);
                    auto* View = static_cast<FWebGPUTextureUAV*>(Resource);
                    check(View->GetResource()->GetType() == RRT_Texture);
                    auto* Texture = static_cast<FRHITexture*>(View->GetResource());
                    const auto Info = View->GetDesc().Texture.UAV.GetViewInfo(Texture);
                    const uint32 Faces = Info.Dimension == FRHIViewDesc::EDimension::TextureCube ||
                        Info.Dimension == FRHIViewDesc::EDimension::TextureCubeArray ? 6 : 1;
                    checkf(Binding->GetIntegerField(TEXT("storageImageFormat")) ==
                        StorageImageFormat(Info.Format),
                        TEXT("WebGPU storage format mismatch: shader=%s binding=%s texture=%s shaderFormat=%d textureFormat=%d"),
                        *Shader->Entry, *Binding->GetStringField(TEXT("name")), *Texture->GetName().ToString(),
                        int32(Binding->GetIntegerField(TEXT("storageImageFormat"))),
                        int32(StorageImageFormat(Info.Format)));
                    for (uint32 Slice = Info.ArrayRange.First * Faces; Slice < (Info.ArrayRange.First + Info.ArrayRange.Num) * Faces; ++Slice)
                        RequireAccess(Texture, Compute ? ERHIAccess::UAVCompute : ERHIAccess::UAVGraphics,
                            false, 0, Info.MipLevel, Slice);
                    Entry.textureView = View->Handle;
                }
                else if (Descriptor == 7)
                {
                    if (Resource->GetType() == RRT_ShaderResourceView)
                    {
                        const auto Access = Compute ? ERHIAccess::SRVCompute
                                            : Shader->Frequency == SF_Vertex
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
            if (DynamicBindings.Contains((uint64(Group) << 32) | Entry.binding))
            {
                check(Entry.buffer && Entry.offset <= MAX_uint32 && Entry.offset % Limits.minUniformBufferOffsetAlignment == 0);
                DynamicOffsets.FindOrAdd(Group).Emplace(Entry.binding, uint32(Entry.offset));
                Entry.offset = 0;
            }
            check(!Groups.FindOrAdd(Group).ContainsByPredicate(
                [&](const auto &Other) { return Other.binding == Entry.binding; }));
            Groups.FindOrAdd(Group).Add(Entry);
        }
    }
    TArray<FWebGPUResolvedGroup> Result;
    for (uint32 Group = 0; HasBindings && Group <= Maximum; ++Group)
    {
        auto& Resolved = Result.AddDefaulted_GetRef();
        if (auto* Offsets = DynamicOffsets.Find(Group))
        {
            Offsets->Sort([](const auto& A, const auto& B) { return A.Key < B.Key; });
            for (const auto& Offset : *Offsets) Resolved.DynamicOffsets.Add(Offset.Value);
        }
        const auto* Entries = Groups.Find(Group);
        uint32 Hash = HashCombineFast(GetTypeHash(reinterpret_cast<UPTRINT>(Render)),
            GetTypeHash(reinterpret_cast<UPTRINT>(Compute)));
        Hash = HashCombineFast(Hash, Group);
        if (Entries)
            for (const auto& Entry : *Entries)
            {
                Hash = HashCombineFast(Hash, Entry.binding);
                Hash = HashCombineFast(Hash, GetTypeHash(reinterpret_cast<UPTRINT>(Entry.buffer)));
                Hash = HashCombineFast(Hash, GetTypeHash(Entry.offset));
                Hash = HashCombineFast(Hash, GetTypeHash(Entry.size));
                Hash = HashCombineFast(Hash, GetTypeHash(reinterpret_cast<UPTRINT>(Entry.textureView)));
                Hash = HashCombineFast(Hash, GetTypeHash(reinterpret_cast<UPTRINT>(Entry.sampler)));
            }
        const auto Matches = [&](const FWebGPUBindGroupCacheEntry& Cached) {
            if (Cached.Render != Render || Cached.Compute != Compute || Cached.Group != Group ||
                Cached.Entries.Num() != (Entries ? Entries->Num() : 0))
                return false;
            for (int32 Index = 0; Index < Cached.Entries.Num(); ++Index)
            {
                const auto& A = Cached.Entries[Index];
                const auto& B = (*Entries)[Index];
                if (A.binding != B.binding || A.buffer != B.buffer || A.offset != B.offset ||
                    A.size != B.size || A.textureView != B.textureView || A.sampler != B.sampler)
                    return false;
            }
            return true;
        };
        WGPUBindGroup CachedHandle = nullptr;
        if (const auto* Bucket = BindGroupCache.Find(Hash))
            for (const auto& Cached : *Bucket)
                if (Matches(*Cached))
                {
                    Cached->LastUsedFrame = EndFrames;
                    CachedHandle = Cached->Handle;
                    break;
                }
        if (CachedHandle)
        {
            wgpuBindGroupAddRef(CachedHandle);
            Resolved.Handle = CachedHandle;
            ++BindGroupCacheHits;
            continue;
        }
        auto& Layouts = Render ? GraphicsPipeline->GroupLayouts : ComputePipeline->GroupLayouts;
        check(Render ? GraphicsPipeline->Handle == Render : ComputePipeline->Handle == Compute);
        if (!Layouts.IsValidIndex(Group)) Layouts.SetNumZeroed(Group + 1);
        auto& Layout = Layouts[Group];
        if (!Layout) Layout = Render ? wgpuRenderPipelineGetBindGroupLayout(Render, Group)
                                    : wgpuComputePipelineGetBindGroupLayout(Compute, Group);
        WGPUBindGroupDescriptor Desc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        Desc.layout = Layout;
        if (Entries)
        {
            Desc.entryCount = Entries->Num();
            Desc.entries = Entries->GetData();
        }
        Resolved.Handle = wgpuDeviceCreateBindGroup(Device, &Desc);
        ++BoundGroups;
        if (BindGroupCacheEntries < 8192)
        {
            auto Cached = MakeUnique<FWebGPUBindGroupCacheEntry>();
            Cached->Render = Render;
            Cached->Compute = Compute;
            Cached->Group = Group;
            Cached->LastUsedFrame = EndFrames;
            Cached->Handle = Resolved.Handle;
            wgpuBindGroupAddRef(Cached->Handle);
            if (Render) wgpuRenderPipelineAddRef(Render);
            if (Compute) wgpuComputePipelineAddRef(Compute);
            if (Entries) Cached->Entries = *Entries;
            // Retain opaque handles as well as the group; released JS handles can otherwise be reused.
            for (const auto& Entry : Cached->Entries)
            {
                if (Entry.buffer) wgpuBufferAddRef(Entry.buffer);
                if (Entry.textureView) wgpuTextureViewAddRef(Entry.textureView);
                if (Entry.sampler) wgpuSamplerAddRef(Entry.sampler);
            }
            BindGroupCache.FindOrAdd(Hash).Add(MoveTemp(Cached));
            ++BindGroupCacheEntries;
        }
    }
    return Result;
}
static WGPUPipelineLayout CreateWebPipelineLayout(WGPUDevice Device,
    TConstArrayView<const FWebGPUShaderData*> Shaders, uint32 DynamicLimit, TSet<uint64>& DynamicBindings)
{
    // Dynamic offsets remove per-draw offsets from the immutable bind-group key. Respect the
    // actual adapter limit and prioritize globals/primitive constants; remaining uniforms stay static.
    for (bool Priority : {true, false})
        for (const auto* Shader : Shaders)
            for (const auto& Binding : Shader->Bindings)
                if (Binding.Descriptor == 6 && DynamicBindings.Num() < int32(DynamicLimit) &&
                    (Binding.Name == TEXT("$Globals") || Binding.Name == TEXT("Primitive")) == Priority)
                    DynamicBindings.Add((uint64(Binding.Group) << 32) | Binding.Index);
    TMap<uint32, TArray<WGPUBindGroupLayoutEntry>> Groups;
    uint32 GroupCount = 0;
    for (const auto* Shader : Shaders)
    for (const auto& Item : Shader->Metadata->GetArrayField(TEXT("spirvBindings")))
    {
        const auto Binding = Item->AsObject();
        const FString Name = Binding->GetStringField(TEXT("name"));
        const uint32 Group = Binding->GetIntegerField(TEXT("group"));
        const auto& ReflectedBindings = Shader->Metadata->GetObjectField(TEXT("reflection"))
            ->GetArrayField(TEXT("entry_points"))[0]->AsObject()->GetArrayField(TEXT("bindings"));
        const auto* Reflected = ReflectedBindings.FindByPredicate([&](const auto& Value) {
            const auto WebBinding = Value->AsObject();
            return WebBinding->GetIntegerField(TEXT("group")) == int32(Group) &&
                WebBinding->GetIntegerField(TEXT("binding")) == Binding->GetIntegerField(TEXT("binding"));
        });
        check(Reflected);
        const FString ResourceType = (*Reflected)->AsObject()->GetStringField(TEXT("resource_type"));
        bool ComparisonSampler = false;
        Binding->TryGetBoolField(TEXT("samplerComparison"), ComparisonSampler);
        GroupCount = FMath::Max(GroupCount, Group + 1);
        auto Entry = WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
        Entry.binding = Binding->GetIntegerField(TEXT("binding"));
        const uint32 Frequency = Shader->Metadata->GetIntegerField(TEXT("frequency"));
        Entry.visibility = Frequency == SF_Vertex ? WGPUShaderStage_Vertex :
            Frequency == SF_Pixel ? WGPUShaderStage_Fragment : WGPUShaderStage_Compute;
        // Mobile CSM uses manual PCF with a point sampler over the depth atlas.
        // HZB starts from the depth attachment and uses a point sampler at every mip.
        // Cloud depth is encoded in filterable RGBA16F color targets.
        const bool Depth = !Name.Contains(TEXT("VolumetricDepthTexture")) &&
            (Name.Contains(TEXT("SceneDepth")) || Name.Contains(TEXT("ShadowDepth")) ||
                Name.Contains(TEXT("DirectionalLightShadowTexture")) ||
                Name.Contains(TEXT("DirectionalLightShadowSampler")) ||
                Name.Contains(TEXT("DepthTexture")) || Name == TEXT("ParentTextureMip") ||
                Name == TEXT("ParentTextureMipSampler"));
        // ACES tables use integer-coordinate loads from core, unfilterable R32Float textures.
        const bool ACESLookup = Name.Contains(TEXT("ACESReachTable")) ||
            Name.Contains(TEXT("ACESGamutTable")) || Name.Contains(TEXT("ACESGammaTable"));
        // TAA point-samples UNORM16 velocity; it must also accept unfilterable browser formats.
        const bool TAAVelocity = Name == TEXT("GBufferVelocityTexture") ||
            Name == TEXT("GBufferVelocityTextureSampler");
        // DFAO preserves bilinear UNORM16 sampling with explicit texel loads.
        const bool UnfilterableVelocity = TAAVelocity || Name == TEXT("VelocityTexture");
        switch (Binding->GetIntegerField(TEXT("descriptorType")))
        {
        case 0:
            Entry.sampler.type = ComparisonSampler ? WGPUSamplerBindingType_Comparison :
                Depth || TAAVelocity || Name.Contains(TEXT("Point")) || Name == TEXT("WaterDepthSampler") ?
                WGPUSamplerBindingType_NonFiltering : WGPUSamplerBindingType_Filtering;
            break;
        case 2:
        case 3:
        {
            const uint32 Dimension = Binding->GetIntegerField(TEXT("textureDimension"));
            const bool Array = Binding->GetBoolField(TEXT("textureArrayed"));
            const auto ViewDimension = Dimension == 3 ? (Array ? WGPUTextureViewDimension_CubeArray : WGPUTextureViewDimension_Cube) :
                Dimension == 2 ? WGPUTextureViewDimension_3D :
                Array ? WGPUTextureViewDimension_2DArray : WGPUTextureViewDimension_2D;
            if (Binding->GetIntegerField(TEXT("descriptorType")) == 3)
            {
                FString Access;
                Binding->TryGetStringField(TEXT("storageTextureAccess"), Access);
                Entry.storageTexture.access = Access == TEXT("read_write") ? WGPUStorageTextureAccess_ReadWrite :
                    Access == TEXT("read") ? WGPUStorageTextureAccess_ReadOnly : WGPUStorageTextureAccess_WriteOnly;
                Entry.storageTexture.viewDimension = ViewDimension;
                const uint32 ImageFormat = Binding->GetIntegerField(TEXT("storageImageFormat"));
                Entry.storageTexture.format = StorageFormat(ImageFormat);
            }
            else
            {
                const FString Type = Binding->GetStringField(TEXT("textureSampleType"));
                Entry.texture.sampleType = ResourceType == TEXT("DepthTexture") ? WGPUTextureSampleType_Depth :
                    Type == TEXT("uint") ? WGPUTextureSampleType_Uint :
                    Type == TEXT("sint") ? WGPUTextureSampleType_Sint :
                    Depth || ACESLookup || UnfilterableVelocity ? WGPUTextureSampleType_UnfilterableFloat : WGPUTextureSampleType_Float;
                Entry.texture.viewDimension = ViewDimension;
                Entry.texture.multisampled = Binding->GetBoolField(TEXT("textureMultisampled"));
            }
            break;
        }
        case 6:
            Entry.buffer.type = WGPUBufferBindingType_Uniform;
            Entry.buffer.minBindingSize = Binding->GetIntegerField(TEXT("paddedSize"));
            Entry.buffer.hasDynamicOffset = DynamicBindings.Contains((uint64(Group) << 32) | Entry.binding);
            break;
        case 7:
            Entry.buffer.type = Binding->GetBoolField(TEXT("readOnlyStorage")) ?
                WGPUBufferBindingType_ReadOnlyStorage : WGPUBufferBindingType_Storage;
            break;
        default:
            checkNoEntry();
        }
        auto& Entries = Groups.FindOrAdd(Group);
        auto* Existing = Entries.FindByPredicate([&](const auto& Other) { return Other.binding == Entry.binding; });
        if (Existing)
            Existing->visibility |= Entry.visibility;
        else
            Entries.Add(Entry);
    }
    TArray<WGPUBindGroupLayout> Layouts;
    for (uint32 Group = 0; Group < GroupCount; ++Group)
    {
        auto Desc = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        if (const auto* Entries = Groups.Find(Group))
        {
            Desc.entryCount = Entries->Num();
            Desc.entries = Entries->GetData();
        }
        Layouts.Add(wgpuDeviceCreateBindGroupLayout(Device, &Desc));
    }
    auto Desc = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    Desc.bindGroupLayoutCount = Layouts.Num();
    Desc.bindGroupLayouts = Layouts.GetData();
    auto Result = wgpuDeviceCreatePipelineLayout(Device, &Desc);
    for (auto Layout : Layouts)
        wgpuBindGroupLayoutRelease(Layout);
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
    auto *Pixel = static_cast<FWebGPUPixelShader *>(In.BoundShaderState.GetPixelShader());
    WGPURenderPipelineDescriptor Desc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    TArray<const FWebGPUShaderData*> ShaderStages{&VS};
    if (Pixel)
        ShaderStages.Add(&Pixel->Data);
    Desc.layout = CreateWebPipelineLayout(Device, ShaderStages, Limits.maxDynamicUniformBuffersPerPipelineLayout,
        Result->DynamicBindings);
    Desc.vertex.module = VS.Module;
    const FTCHARToUTF8 VertexEntry(*VS.Entry), PixelEntry(Pixel ? *Pixel->Data.Entry : TEXT(""));
    const FTCHARToUTF8 PipelineLabel(*(VS.Entry + TEXT(" / ") + (Pixel ? Pixel->Data.Entry : TEXT("depth-only"))));
    Desc.label = Text(PipelineLabel.Get());
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
            Attribute.format = VertexFormat(EVertexElementType(Element.Type));
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
    checkf(Rasterizer.FillMode == FM_Solid && Rasterizer.CullMode <= CM_CCW && Rasterizer.DepthBias == 0 &&
          Rasterizer.SlopeScaleDepthBias == 0 &&
          Rasterizer.DepthClipMode == ERasterizerDepthClipMode::DepthClip && !Blend.bUseAlphaToCoverage &&
          In.RenderTargetsEnabled <= Limits.maxColorAttachments,
          TEXT("Raster state fill=%u cull=%u bias=%g slope=%g clip=%u alphaCoverage=%u stencilFront=%u stencilBack=%u"),
          uint32(Rasterizer.FillMode), uint32(Rasterizer.CullMode), Rasterizer.DepthBias,
          Rasterizer.SlopeScaleDepthBias, uint32(Rasterizer.DepthClipMode), Blend.bUseAlphaToCoverage,
          DepthState.bEnableFrontFaceStencil, DepthState.bEnableBackFaceStencil);
    // CM_CW rejects clockwise triangles; keep WebGPU's counter-clockwise front face.
    Desc.primitive.frontFace = WGPUFrontFace_CCW;
    Desc.primitive.cullMode = Rasterizer.CullMode == CM_CW ? WGPUCullMode_Back :
        Rasterizer.CullMode == CM_CCW ? WGPUCullMode_Front : WGPUCullMode_None;
    TArray<WGPUColorTargetState> Targets;
    TArray<WGPUBlendState> Blends;
    uint32 OutputMask = 0;
    if (Pixel)
    {
        const auto Reflection = Pixel->Data.Metadata->GetObjectField(TEXT("reflection"));
        for (const auto& Entry : Reflection->GetArrayField(TEXT("entry_points")))
        {
            if (Entry->AsObject()->GetStringField(TEXT("name")) != Pixel->Data.Entry)
                continue;
            for (const auto& Output : Entry->AsObject()->GetArrayField(TEXT("output_variables")))
            {
                double Location;
                if (Output->AsObject()->TryGetNumberField(TEXT("location"), Location) && Location < 32)
                    OutputMask |= 1u << uint32(Location);
            }
        }
    }
    Blends.SetNum(In.RenderTargetsEnabled);
    for (uint32 Index = 0; Index < In.RenderTargetsEnabled; ++Index)
    {
        auto Target = WGPU_COLOR_TARGET_STATE_INIT;
        Target.format = Format(EPixelFormat(In.RenderTargetFormats[Index]),
            EnumHasAnyFlags(In.RenderTargetFlags[Index], ETextureCreateFlags::SRGB));
        const auto &State = Blend.RenderTargets[Blend.bUseIndependentRenderTargetBlendStates ? Index : 0];
        auto &NativeBlend = Blends[Index];
        NativeBlend.color = {BlendOperation(State.ColorBlendOp), BlendFactor(State.ColorSrcBlend),
                             BlendFactor(State.ColorDestBlend)};
        NativeBlend.alpha = {BlendOperation(State.AlphaBlendOp), BlendFactor(State.AlphaSrcBlend),
                             BlendFactor(State.AlphaDestBlend)};
        const bool Overwrite = State.ColorBlendOp == BO_Add && State.ColorSrcBlend == BF_One &&
            State.ColorDestBlend == BF_Zero && State.AlphaBlendOp == BO_Add &&
            State.AlphaSrcBlend == BF_One && State.AlphaDestBlend == BF_Zero;
        const bool HasOutput = (OutputMask & (1u << Index)) != 0;
        Target.blend = HasOutput && !Overwrite ? &NativeBlend : nullptr;
        Target.writeMask = HasOutput ? State.ColorWriteMask : WGPUColorWriteMask_None;
        Targets.Add(Target);
    }
    WGPUShaderModule DepthOnlyFragment = nullptr;
    if (!Pixel && !Targets.IsEmpty())
    {
        auto Source = WGPU_SHADER_SOURCE_WGSL_INIT;
        Source.code = Text("@fragment fn main() {}");
        auto Module = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        Module.nextInChain = &Source.chain;
        DepthOnlyFragment = wgpuDeviceCreateShaderModule(Device, &Module);
    }
    WGPUFragmentState Fragment = WGPU_FRAGMENT_STATE_INIT;
    Fragment.module = Pixel ? Pixel->Data.Module : DepthOnlyFragment;
    Fragment.entryPoint = Pixel ? Text(PixelEntry.Get()) : Text("main");
    Fragment.targetCount = Targets.Num();
    Fragment.targets = Targets.GetData();
    Desc.fragment = Fragment.module ? &Fragment : nullptr;
    WGPUDepthStencilState Depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    if (In.DepthStencilTargetFormat != PF_Unknown)
    {
        Depth.format = Format(In.DepthStencilTargetFormat);
        Depth.depthWriteEnabled = DepthState.bEnableDepthWrite ? WGPUOptionalBool_True : WGPUOptionalBool_False;
        Depth.depthCompare = Compare(DepthState.DepthTest);
        if (DepthState.bEnableFrontFaceStencil || DepthState.bEnableBackFaceStencil)
        {
            Depth.stencilFront.compare = Compare(DepthState.FrontFaceStencilTest);
            Depth.stencilFront.failOp = StencilOperation(DepthState.FrontFaceStencilFailStencilOp);
            Depth.stencilFront.depthFailOp = StencilOperation(DepthState.FrontFaceDepthFailStencilOp);
            Depth.stencilFront.passOp = StencilOperation(DepthState.FrontFacePassStencilOp);
            Depth.stencilBack = Depth.stencilFront;
            if (DepthState.bEnableBackFaceStencil)
            {
                Depth.stencilBack.compare = Compare(DepthState.BackFaceStencilTest);
                Depth.stencilBack.failOp = StencilOperation(DepthState.BackFaceStencilFailStencilOp);
                Depth.stencilBack.depthFailOp = StencilOperation(DepthState.BackFaceDepthFailStencilOp);
                Depth.stencilBack.passOp = StencilOperation(DepthState.BackFacePassStencilOp);
            }
            Depth.stencilReadMask = DepthState.StencilReadMask;
            Depth.stencilWriteMask = DepthState.StencilWriteMask;
        }
        else
            Depth.stencilWriteMask = 0;
        Desc.depthStencil = &Depth;
    }
    Result->Handle = wgpuDeviceCreateRenderPipeline(Device, &Desc);
    if (DepthOnlyFragment)
        wgpuShaderModuleRelease(DepthOnlyFragment);
    wgpuPipelineLayoutRelease(Desc.layout);
    return Result;
}
FComputePipelineStateRHIRef FWebGPUDynamicRHI::RHICreateComputePipelineState(const FComputePipelineStateInitializer &In)
{
    RequireOwner();
    check(In.SpecializationConstants.IsEmpty());
    const auto &Shader = static_cast<FWebGPUComputeShader *>(In.ComputeShader)->Data;
    WGPUComputePipelineDescriptor Desc = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    const FWebGPUShaderData* ShaderStages[] = {&Shader};
    TSet<uint64> DynamicBindings;
    Desc.layout = CreateWebPipelineLayout(Device, ShaderStages, Limits.maxDynamicUniformBuffersPerPipelineLayout,
        DynamicBindings);
    Desc.compute.module = Shader.Module;
    const FTCHARToUTF8 Entry(*Shader.Entry);
    Desc.compute.entryPoint = Text(Entry.Get());
    ++ComputePipelinesCreated;
    auto Handle = wgpuDeviceCreateComputePipeline(Device, &Desc);
    wgpuPipelineLayoutRelease(Desc.layout);
    auto* Result = new FWebGPUComputePipeline(In.ComputeShader, Handle);
    Result->DynamicBindings = MoveTemp(DynamicBindings);
    return Result;
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
    auto* List = new FWebGPUCommandList(wgpuCommandEncoderFinish(Encoder, nullptr), Finalized + 1);
    List->Readbacks = MoveTemp(PendingReadbacks);
    List->Fences = MoveTemp(PendingFences);
    Result.CommandLists[ERHIPipeline::Graphics] = List;
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
        for (const auto& State : List->Readbacks)
        {
            WGPUBufferMapCallbackInfo Callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
            Callback.mode = WGPUCallbackMode_AllowSpontaneous;
            Callback.userdata1 = new FWebGPUReadbackRef(State);
            Callback.callback = [](WGPUMapAsyncStatus Status, WGPUStringView, void* Opaque, void*) {
                TUniquePtr<FWebGPUReadbackRef> Reference(static_cast<FWebGPUReadbackRef*>(Opaque));
                const auto& Readback = *Reference;
                if (Status == WGPUMapAsyncStatus_Success)
                {
                    Readback->Bytes.Append(static_cast<const uint8*>(
                        wgpuBufferGetConstMappedRange(Readback->Handle, 0, Readback->Size)), Readback->Size);
                    wgpuBufferUnmap(Readback->Handle);
                    Readback->Ready.store(true);
                }
            };
            wgpuBufferMapAsync(State->Handle, WGPUMapMode_Read, 0, State->Size, Callback);
        }
        for (const auto& State : List->Fences)
        {
            WGPUQueueWorkDoneCallbackInfo Callback = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
            Callback.mode = WGPUCallbackMode_AllowSpontaneous;
            Callback.userdata1 = new FWebGPUFenceRef(State);
            Callback.callback = [](WGPUQueueWorkDoneStatus Status, WGPUStringView, void* Opaque, void*) {
                TUniquePtr<FWebGPUFenceRef> Reference(static_cast<FWebGPUFenceRef*>(Opaque));
                (*Reference)->Complete.store(Status == WGPUQueueWorkDoneStatus_Success);
            };
            wgpuQueueOnSubmittedWorkDone(Queue, Callback);
        }
        delete List;
        ++Submitted;
    }
}
FGPUFenceRHIRef FWebGPUDynamicRHI::RHICreateGPUFence(const FName& Name)
{
    return new FWebGPUFence(Name);
}
FStagingBufferRHIRef FWebGPUDynamicRHI::RHICreateStagingBuffer()
{
    return new FWebGPUStagingBuffer();
}
void FWebGPUDynamicRHI::RHICopyToStagingBuffer(FRHIBuffer* Source, FRHIStagingBuffer* Destination,
                                              uint32 Offset, uint32 Size)
{
    RequireOwner();
    check(Encoder && !Pass && Size && Offset % 4 == 0 && Size % 4 == 0 &&
          uint64(Offset) + Size <= Source->GetSize());
    RequireAccess(Source, ERHIAccess::CopySrc);
    auto State = MakeShared<FWebGPUReadbackState, ESPMode::ThreadSafe>();
    State->Size = Size;
    State->Handle = CreateBuffer(Size, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
    static_cast<FWebGPUStagingBuffer*>(Destination)->State = State;
    wgpuCommandEncoderCopyBufferToBuffer(Encoder, static_cast<FWebGPUBuffer*>(Source)->Handle,
        Offset, State->Handle, 0, Size);
    PendingReadbacks.Add(State);
}
void FWebGPUDynamicRHI::RHIWriteGPUFence(FRHIGPUFence* Fence)
{
    RequireOwner();
    check(Encoder && !Pass && Fence);
    const auto& State = static_cast<FWebGPUFence*>(Fence)->State;
    State->Readbacks = PendingReadbacks;
    PendingFences.Add(State);
}
void* FWebGPUDynamicRHI::RHILockStagingBuffer(FRHIStagingBuffer* Buffer, FRHIGPUFence* Fence,
                                            uint32 Offset, uint32 Size)
{
    RequireOwner();
    return !Fence || Fence->Poll() ? Buffer->Lock(Offset, Size) : nullptr;
}
void FWebGPUDynamicRHI::RHIUnlockStagingBuffer(FRHIStagingBuffer* Buffer)
{
    RequireOwner();
    check(Buffer);
    Buffer->Unlock();
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
    check(ContextOpen && Encoder && !Pass && !Info.MultiViewCount && !OcclusionBatch);
    Attachments.Reset();
    AttachmentSubresources.Reset();
    PassDepthReadOnly = false;
    TArray<WGPURenderPassColorAttachment> Colors;
    for (const auto &Color : Info.ColorRenderTargets)
    {
        if (!Color.RenderTarget)
            break;
        auto *Texture = static_cast<FWebGPUTexture *>(Color.RenderTarget);
        RequireAccess(Texture, ERHIAccess::RTV, false, 0, Color.MipIndex, FMath::Max(Color.ArraySlice, 0));
        check(!Color.ResolveTarget);
        Attachments.Add(Texture);
        AttachmentSubresources.Emplace(Color.MipIndex, FMath::Max(Color.ArraySlice, 0));
        WGPURenderPassColorAttachment Attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        Attachment.view = Texture->AttachmentView(Color.MipIndex, FMath::Max(Color.ArraySlice, 0));
        Attachment.loadOp = Load(Color.Action);
        Attachment.storeOp = Store(Color.Action);
        const auto Clear = GetLoadAction(Color.Action) == ERenderTargetLoadAction::EClear
            ? Texture->GetClearColor() : FLinearColor::Transparent;
        Attachment.clearValue = {Clear.R, Clear.G, Clear.B, Clear.A};
        Colors.Add(Attachment);
    }
    WGPURenderPassDepthStencilAttachment Depth = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    WGPURenderPassDescriptor Desc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    Desc.colorAttachmentCount = Colors.Num();
    Desc.colorAttachments = Colors.GetData();
    if (Info.NumOcclusionQueries)
    {
        OcclusionBatch = MakeShared<FWebGPUOcclusionBatch, ESPMode::ThreadSafe>();
        OcclusionBatch->Capacity = Info.NumOcclusionQueries;
        WGPUQuerySetDescriptor Queries = WGPU_QUERY_SET_DESCRIPTOR_INIT;
        Queries.type = WGPUQueryType_Occlusion;
        Queries.count = Info.NumOcclusionQueries;
        OcclusionBatch->Queries = wgpuDeviceCreateQuerySet(Device, &Queries);
        Desc.occlusionQuerySet = OcclusionBatch->Queries;
    }
    if (Info.DepthStencilRenderTarget.DepthStencilTarget)
    {
        auto *Texture = static_cast<FWebGPUTexture *>(Info.DepthStencilRenderTarget.DepthStencilTarget);
        RequireAccess(Texture, Info.DepthStencilRenderTarget.ExclusiveDepthStencil.IsDepthWrite()
                                   ? ERHIAccess::DSVWrite
                                   : ERHIAccess::DSVRead);
        if (Info.DepthStencilRenderTarget.ExclusiveDepthStencil.IsUsingStencil())
            RequireAccess(Texture, Info.DepthStencilRenderTarget.ExclusiveDepthStencil.IsStencilWrite()
                ? ERHIAccess::DSVWrite : ERHIAccess::DSVRead, false, 1);
        Attachments.Add(Texture);
        AttachmentSubresources.Emplace(0, 0);
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
        float ClearDepth = 0.0f;
        uint32 ClearStencil = 0;
        // WebGPU maps UE's don't-care load to a deterministic clear, without requiring a bound clear value.
        if (GetLoadAction(GetDepthActions(Info.DepthStencilRenderTarget.Action)) == ERenderTargetLoadAction::EClear ||
            (Info.DepthStencilRenderTarget.ExclusiveDepthStencil.IsStencilWrite() &&
                GetLoadAction(GetStencilActions(Info.DepthStencilRenderTarget.Action)) == ERenderTargetLoadAction::EClear))
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
    check(Pass && !ActiveOcclusionQuery);
    wgpuRenderPassEncoderEnd(Pass);
    wgpuRenderPassEncoderRelease(Pass);
    Pass = nullptr;
    if (OcclusionBatch && OcclusionBatch->Count)
    {
        const uint32 Bytes = OcclusionBatch->Count * sizeof(uint64);
        OcclusionBatch->Resolve = CreateBuffer(Bytes, WGPUBufferUsage_QueryResolve | WGPUBufferUsage_CopySrc);
        auto Readback = MakeShared<FWebGPUReadbackState, ESPMode::ThreadSafe>();
        Readback->Size = Bytes;
        Readback->Handle = CreateBuffer(Bytes, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
        OcclusionBatch->Readback = Readback;
        wgpuCommandEncoderResolveQuerySet(Encoder, OcclusionBatch->Queries, 0, OcclusionBatch->Count,
            OcclusionBatch->Resolve, 0);
        wgpuCommandEncoderCopyBufferToBuffer(Encoder, OcclusionBatch->Resolve, 0, Readback->Handle, 0, Bytes);
        PendingReadbacks.Add(Readback);
    }
    OcclusionBatch.Reset();
    Attachments.Reset();
    AttachmentSubresources.Reset();
    PassDepthReadOnly = false;
}
FRenderQueryRHIRef FWebGPUDynamicRHI::RHICreateRenderQuery(ERenderQueryType Type)
{
    check(Type == RQT_Occlusion);
    return new FWebGPURenderQuery();
}
void FWebGPUDynamicRHI::RHIBeginRenderQuery(FRHIRenderQuery* Query)
{
    RequireOwner();
    check(Pass && OcclusionBatch && !ActiveOcclusionQuery && Query &&
        OcclusionBatch->Count < OcclusionBatch->Capacity);
    ActiveOcclusionQuery = static_cast<FWebGPURenderQuery*>(Query);
    ActiveOcclusionQuery->Batch = OcclusionBatch;
    ActiveOcclusionQuery->Index = OcclusionBatch->Count++;
    wgpuRenderPassEncoderBeginOcclusionQuery(Pass, ActiveOcclusionQuery->Index);
}
void FWebGPUDynamicRHI::RHIEndRenderQuery(FRHIRenderQuery* Query)
{
    RequireOwner();
    check(Pass && Query == ActiveOcclusionQuery.GetReference());
    wgpuRenderPassEncoderEndOcclusionQuery(Pass);
    ActiveOcclusionQuery.SafeRelease();
}
bool FWebGPUDynamicRHI::RHIGetRenderQueryResult(FRHIRenderQuery* Query, uint64& Result, bool WaitForResult, uint32)
{
    RequireOwner();
    const auto* Value = static_cast<FWebGPURenderQuery*>(Query);
    const auto Batch = Value->Batch;
    if (!Batch || !Batch->Readback)
    {
        ++OcclusionResultsPending;
        return false;
    }
#if !defined(PLATFORM_WEB) || !PLATFORM_WEB
    if (WaitForResult && !Batch->Readback->Ready.load())
        Wait([&] { return Batch->Readback->Ready.load(); });
#endif
    // A browser cannot block its event loop. UE treats unavailable results as visible.
    if (!Batch->Readback->Ready.load())
    {
        ++OcclusionResultsPending;
        return false;
    }
    FMemory::Memcpy(&Result, Batch->Readback->Bytes.GetData() + Value->Index * sizeof(uint64), sizeof(Result));
    ++OcclusionResultsReady;
    OcclusionResultsZero += Result == 0;
    return true;
}
void FWebGPUDynamicRHI::RHISetGraphicsPipelineState(FRHIGraphicsPipelineState *State, uint32 StencilRef, bool)
{
    check(Pass && StencilRef <= 255);
    GraphicsPipeline = static_cast<FWebGPUGraphicsPipeline *>(State);
    FString Error;
    checkf(ValidatePipelineDepth(GraphicsPipeline->Initializer, Error), TEXT("%s"), *Error);
    wgpuRenderPassEncoderSetPipeline(Pass, GraphicsPipeline->Handle);
    wgpuRenderPassEncoderSetStencilReference(Pass, StencilRef);
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
    auto *Pixel = GraphicsPipeline->GetShader(SF_Pixel);
    FWebGPUShaderData *Shaders[] = {&VS, Pixel ? &ShaderData(Pixel) : nullptr};
    const auto Groups = CreateGroups(GraphicsPipeline->Handle, nullptr, MakeArrayView(Shaders, Pixel ? 2 : 1));
    for (int32 Index = 0; Index < Groups.Num(); ++Index)
    {
        const auto& Group = Groups[Index];
        wgpuRenderPassEncoderSetBindGroup(Pass, Index, Group.Handle, Group.DynamicOffsets.Num(), Group.DynamicOffsets.GetData());
        wgpuBindGroupRelease(Group.Handle);
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
bool FWebGPUDynamicRHI::ValidateIndirectArguments(FRHIBuffer* Buffer, uint32 Offset, uint32 Bytes,
                                                  FString& Error) const
{
    if (!Buffer || !EnumHasAnyFlags(Buffer->GetUsage(), BUF_DrawIndirect) || Offset % 4 ||
        uint64(Offset) + Bytes > Buffer->GetSize())
    {
        Error = TEXT("Indirect arguments require DrawIndirect usage and an aligned in-bounds argument range");
        return false;
    }
    return ValidateAccess(Buffer, ERHIAccess::IndirectArgs, Error);
}
void FWebGPUDynamicRHI::RHIDrawPrimitiveIndirect(FRHIBuffer* Arguments, uint32 Offset)
{
    FString Error;
    checkf(ValidateIndirectArguments(Arguments, Offset, 16, Error), TEXT("%s"), *Error);
    SetDrawBindings();
    wgpuRenderPassEncoderDrawIndirect(Pass, static_cast<FWebGPUBuffer*>(Arguments)->Handle, Offset);
    ++Draws;
}
void FWebGPUDynamicRHI::RHIDrawIndexedPrimitiveIndirect(FRHIBuffer* Index, FRHIBuffer* Arguments, uint32 Offset)
{
    FString Error;
    checkf(ValidateIndirectArguments(Arguments, Offset, 20, Error), TEXT("%s"), *Error);
    check(GraphicsPipeline && GraphicsPipeline->Initializer.PrimitiveType == PT_TriangleList);
    auto* Buffer = static_cast<FWebGPUBuffer*>(Index);
    check(Buffer && (Buffer->GetStride() == 2 || Buffer->GetStride() == 4));
    RequireAccess(Buffer, ERHIAccess::VertexOrIndexBuffer);
    SetDrawBindings();
    wgpuRenderPassEncoderSetIndexBuffer(Pass, Buffer->Handle,
        Buffer->GetStride() == 2 ? WGPUIndexFormat_Uint16 : WGPUIndexFormat_Uint32, 0, Buffer->GetSize());
    wgpuRenderPassEncoderDrawIndexedIndirect(Pass, static_cast<FWebGPUBuffer*>(Arguments)->Handle, Offset);
    ++Draws;
}
WGPUComputePassEncoder FWebGPUDynamicRHI::BeginComputePass()
{
    check(Encoder && !Pass && ComputePipeline);
    auto Compute = wgpuCommandEncoderBeginComputePass(Encoder, nullptr);
    wgpuComputePassEncoderSetPipeline(Compute, ComputePipeline->Handle);
    FWebGPUShaderData *Shaders[] = {&ShaderData(ComputePipeline->GetComputeShader())};
    const auto Groups = CreateGroups(nullptr, ComputePipeline->Handle, Shaders);
    for (int32 Index = 0; Index < Groups.Num(); ++Index)
    {
        const auto& Group = Groups[Index];
        wgpuComputePassEncoderSetBindGroup(Compute, Index, Group.Handle, Group.DynamicOffsets.Num(), Group.DynamicOffsets.GetData());
        wgpuBindGroupRelease(Group.Handle);
    }
    return Compute;
}
void FWebGPUDynamicRHI::RHIDispatchComputeShader(uint32 X, uint32 Y, uint32 Z)
{
    auto Compute = BeginComputePass();
    wgpuComputePassEncoderDispatchWorkgroups(Compute, X, Y, Z);
    wgpuComputePassEncoderEnd(Compute);
    wgpuComputePassEncoderRelease(Compute);
    ++Dispatches;
}
void FWebGPUDynamicRHI::RHIDispatchIndirectComputeShader(FRHIBuffer* Arguments, uint32 Offset)
{
    FString Error;
    checkf(ValidateIndirectArguments(Arguments, Offset, 12, Error), TEXT("%s"), *Error);
    auto Compute = BeginComputePass();
    wgpuComputePassEncoderDispatchWorkgroupsIndirect(Compute, static_cast<FWebGPUBuffer*>(Arguments)->Handle, Offset);
    wgpuComputePassEncoderEnd(Compute);
    wgpuComputePassEncoderRelease(Compute);
    ++Dispatches;
}
void FWebGPUDynamicRHI::RHICopyTexture(FRHITexture *Source, FRHITexture *Destination, const FRHICopyTextureInfo &Info)
{
    check((Source->GetDesc().Dimension == ETextureDimension::Texture2D || Source->GetDesc().IsTextureCube()) &&
          (Destination->GetDesc().Dimension == ETextureDimension::Texture2D || Destination->GetDesc().IsTextureCube()) &&
          Encoder && !Pass && Source->GetFormat() == Destination->GetFormat() &&
          Info.NumMips && Info.NumSlices &&
          Info.SourceMipIndex + Info.NumMips <= Source->GetNumMips() &&
          Info.DestMipIndex + Info.NumMips <= Destination->GetNumMips() &&
          Info.SourceSliceIndex + Info.NumSlices <= (Source->GetDesc().IsTextureCube() ? 6u : 1u) &&
          Info.DestSliceIndex + Info.NumSlices <= (Destination->GetDesc().IsTextureCube() ? 6u : 1u) &&
          Info.SourcePosition.Z == 0 && Info.DestPosition.Z == 0 && Info.Size.Z <= 1);
    check(Source != Destination);
    for (uint32 Mip = 0; Mip < Info.NumMips; ++Mip)
    for (uint32 Slice = 0; Slice < Info.NumSlices; ++Slice)
    {
    RequireAccess(Source, ERHIAccess::CopySrc, false, 0, Info.SourceMipIndex + Mip, Info.SourceSliceIndex + Slice);
    RequireAccess(Destination, ERHIAccess::CopyDest, false, 0, Info.DestMipIndex + Mip, Info.DestSliceIndex + Slice);
    WGPUTexelCopyTextureInfo Src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT, Dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    Src.texture = static_cast<FWebGPUTexture *>(Source)->Handle;
    Dst.texture = static_cast<FWebGPUTexture *>(Destination)->Handle;
    Src.mipLevel = Info.SourceMipIndex + Mip;
    Dst.mipLevel = Info.DestMipIndex + Mip;
    Src.origin = {uint32(Info.SourcePosition.X) >> Mip, uint32(Info.SourcePosition.Y) >> Mip, Info.SourceSliceIndex + Slice};
    Dst.origin = {uint32(Info.DestPosition.X) >> Mip, uint32(Info.DestPosition.Y) >> Mip, Info.DestSliceIndex + Slice};
    WGPUExtent3D Size{FMath::Max(1u, Info.Size.X ? uint32(Info.Size.X) >> Mip : Source->GetSizeX() >> Src.mipLevel),
                      FMath::Max(1u, Info.Size.Y ? uint32(Info.Size.Y) >> Mip : Source->GetSizeY() >> Src.mipLevel), 1};
    if (IsBCTextureFormat(Source->GetFormat()))
    {
        const auto& Pixel = GPixelFormats[Source->GetFormat()];
        check(Src.origin.x % Pixel.BlockSizeX == 0 && Src.origin.y % Pixel.BlockSizeY == 0 &&
              Dst.origin.x % Pixel.BlockSizeX == 0 && Dst.origin.y % Pixel.BlockSizeY == 0);
        check((Size.width % Pixel.BlockSizeX == 0 ||
                (Src.origin.x + Size.width == FMath::Max(1u, Source->GetSizeX() >> Src.mipLevel) &&
                 Dst.origin.x + Size.width == FMath::Max(1u, Destination->GetSizeX() >> Dst.mipLevel))) &&
              (Size.height % Pixel.BlockSizeY == 0 ||
                (Src.origin.y + Size.height == FMath::Max(1u, Source->GetSizeY() >> Src.mipLevel) &&
                 Dst.origin.y + Size.height == FMath::Max(1u, Destination->GetSizeY() >> Dst.mipLevel))));
        Size.width = Align(Size.width, uint32(Pixel.BlockSizeX));
        Size.height = Align(Size.height, uint32(Pixel.BlockSizeY));
    }
    wgpuCommandEncoderCopyTextureToTexture(Encoder, &Src, &Dst, &Size);
    }
}
void FWebGPUDynamicRHI::RHIClearUAVUint(FRHIUnorderedAccessView* View, const FUintVector4& Values)
{
    RequireOwner();
    if (GlobalProbeMode && !ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    check(Encoder && !Pass && View);
    auto* Resource = View->GetResource();
    if ((Resource && Resource->GetType() == RRT_Texture &&
         static_cast<FRHITexture*>(Resource)->GetDesc().Dimension == ETextureDimension::Texture3D) ||
        (Resource && Resource->GetType() == RRT_Buffer && Values != FUintVector4(0)))
    {
        ClearStorageUAV(View, Values, false);
        return;
    }
    if (Resource && Resource->GetType() == RRT_Texture)
    {
        auto* Texture = static_cast<FWebGPUTexture*>(Resource);
        const auto Info = View->GetDesc().Texture.UAV.GetViewInfo(Texture);
        check(IsUnsignedTextureFormat(Info.Format) &&
            Texture->GetDesc().Dimension != ETextureDimension::Texture3D);
        const uint32 Faces = Texture->GetDesc().IsTextureCube() ? 6 : 1;
        for (uint32 Slice = Info.ArrayRange.First * Faces;
             Slice < (Info.ArrayRange.First + Info.ArrayRange.Num) * Faces; ++Slice)
        {
            RequireAccess(Texture, ERHIAccess::UAVCompute, false, 0, Info.MipLevel, Slice);
            WGPUTextureViewDescriptor Desc = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            Desc.format = Format(Info.Format);
            Desc.dimension = WGPUTextureViewDimension_2D;
            Desc.baseMipLevel = Info.MipLevel;
            Desc.mipLevelCount = 1;
            Desc.baseArrayLayer = Slice;
            Desc.arrayLayerCount = 1;
            Desc.usage = WGPUTextureUsage_RenderAttachment;
            auto Attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
            Attachment.view = wgpuTextureCreateView(Texture->Handle, &Desc);
            Attachment.loadOp = WGPULoadOp_Clear;
            Attachment.storeOp = WGPUStoreOp_Store;
            Attachment.clearValue = {double(Values.X), double(Values.Y), double(Values.Z), double(Values.W)};
            auto Clear = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
            Clear.colorAttachmentCount = 1;
            Clear.colorAttachments = &Attachment;
            auto ClearPass = wgpuCommandEncoderBeginRenderPass(Encoder, &Clear);
            wgpuRenderPassEncoderEnd(ClearPass);
            wgpuRenderPassEncoderRelease(ClearPass);
            wgpuTextureViewRelease(Attachment.view);
        }
        return;
    }
    check(Values == FUintVector4(0));
    FString Error;
    checkf(Resource && Resource->GetType() == RRT_Buffer &&
        ValidateUAV(static_cast<FRHIBuffer*>(Resource), View->GetDesc(), Error), TEXT("%s"), *Error);
    auto* Buffer = static_cast<FWebGPUBuffer*>(Resource);
    RequireAccess(Buffer, ERHIAccess::UAVCompute);
    const auto Info = View->GetDesc().Buffer.UAV.GetViewInfo(Buffer);
    wgpuCommandEncoderClearBuffer(Encoder, Buffer->Handle, Info.OffsetInBytes,
        uint64(Info.NumElements) * Info.StrideInBytes);
}
void FWebGPUDynamicRHI::RHIClearUAVFloat(FRHIUnorderedAccessView* View, const FVector4f& Values)
{
    FUintVector4 Bits;
    FMemory::Memcpy(&Bits, &Values, sizeof(Bits));
    ClearStorageUAV(View, Bits, true);
}
void FWebGPUDynamicRHI::ClearStorageUAV(FRHIUnorderedAccessView* View, const FUintVector4& Values, bool Float)
{
    RequireOwner();
    if (GlobalProbeMode && !ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    check(Encoder && !Pass && View && View->GetResource());
    auto* Resource = View->GetResource();
    const bool Texture = Resource->GetType() == RRT_Texture;
    FString Key, Declaration, Body;
    FUintVector4 Extent(0);
    WGPUBindGroupEntry Entries[2] = {};
    Entries[0].binding = 0;
    if (Texture)
    {
        auto* Target = static_cast<FWebGPUTexture*>(Resource);
        const auto Info = View->GetDesc().Texture.UAV.GetViewInfo(Target);
        const bool Volume = Target->GetDesc().Dimension == ETextureDimension::Texture3D;
        check(Volume || Info.Dimension == FRHIViewDesc::EDimension::Texture2D);
        check(Float != IsUnsignedTextureFormat(Info.Format));
        RequireAccess(Target, ERHIAccess::UAVCompute, false, 0, Info.MipLevel);
        Extent = FUintVector4(FMath::Max(1u, Target->GetSizeX() >> Info.MipLevel),
            FMath::Max(1u, Target->GetSizeY() >> Info.MipLevel),
            Volume ? FMath::Max(1u, uint32(Target->GetSizeXYZ().Z) >> Info.MipLevel) : 1, 0);
        const char* FormatName = Info.Format == PF_R32_UINT ? "r32uint" :
            Info.Format == PF_R32_FLOAT ? "r32float" :
            Info.Format == PF_G8 || Info.Format == PF_R8 ? "r8unorm" :
            Info.Format == PF_R8G8B8A8 ? "rgba8unorm" :
            Info.Format == PF_R8G8B8A8_UINT ? "rgba8uint" :
            Info.Format == PF_FloatRGBA ? "rgba16float" :
            Info.Format == PF_R16F ? "r16float" : nullptr;
        checkf(FormatName, TEXT("Storage clear format is not implemented: %d"), int32(Info.Format));
        Key = FString::Printf(TEXT("texture-%s-%s-%d"), ANSI_TO_TCHAR(FormatName),
            Volume ? TEXT("3d") : TEXT("2d"), int32(Float));
        Declaration = FString::Printf(TEXT("@group(0) @binding(0) var destination: texture_storage_%s<%s, write>;"),
            Volume ? TEXT("3d") : TEXT("2d"), ANSI_TO_TCHAR(FormatName));
        Body = FString::Printf(TEXT("if (all(id < params.extent.xyz)) { textureStore(destination, %s, %s); }"),
            Volume ? TEXT("vec3<i32>(id)") : TEXT("vec2<i32>(id.xy)"),
            Float ? TEXT("bitcast<vec4<f32>>(params.value)") : TEXT("params.value"));
        Entries[0].textureView = static_cast<FWebGPUTextureUAV*>(View)->Handle;
    }
    else
    {
        auto* Target = static_cast<FWebGPUBuffer*>(Resource);
        FString Error;
        checkf(ValidateUAV(Target, View->GetDesc(), Error), TEXT("%s"), *Error);
        RequireAccess(Target, ERHIAccess::UAVCompute);
        const auto Info = View->GetDesc().Buffer.UAV.GetViewInfo(Target);
        check(Info.StrideInBytes == 4 || Info.StrideInBytes == 8 || Info.StrideInBytes == 16);
        Extent.X = Info.NumElements * (Info.StrideInBytes / 4);
        Extent.Y = Info.StrideInBytes / 4;
        Extent.Z = FMath::Min(FMath::DivideAndRoundUp(Extent.X, 256u),
            Limits.maxComputeWorkgroupsPerDimension) * 256;
        Key = TEXT("buffer");
        Declaration = TEXT("@group(0) @binding(0) var<storage, read_write> destination: array<u32>;");
        Body = TEXT("let index = id.x + id.y * params.extent.z; if (index < params.extent.x) { "
            "destination[index] = params.value[index % params.extent.y]; }");
        Entries[0].buffer = Target->Handle;
        Entries[0].offset = Info.OffsetInBytes;
        Entries[0].size = uint64(Info.NumElements) * Info.StrideInBytes;
    }
    auto* Found = ClearPipelines.Find(Key);
    if (!Found)
    {
        const FString Source = Declaration +
            TEXT("\nstruct Params { value: vec4<u32>, extent: vec4<u32> }; "
                "@group(0) @binding(1) var<uniform> params: Params;\n") +
            (Texture ? TEXT("@compute @workgroup_size(8, 4, 4) ") :
                TEXT("@compute @workgroup_size(256, 1, 1) ")) +
            TEXT("fn main(@builtin(global_invocation_id) id: vec3<u32>) { ") +
            Body + TEXT(" }");
        FTCHARToUTF8 UTF8(*Source);
        WGPUShaderSourceWGSL WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
        WGSL.code = {UTF8.Get(), size_t(UTF8.Length())};
        WGPUShaderModuleDescriptor ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        ModuleDesc.nextInChain = &WGSL.chain;
        auto Module = wgpuDeviceCreateShaderModule(Device, &ModuleDesc);
        WGPUComputePipelineDescriptor PipelineDesc = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
        PipelineDesc.compute.module = Module;
        PipelineDesc.compute.entryPoint = {"main", WGPU_STRLEN};
        auto Pipeline = wgpuDeviceCreateComputePipeline(Device, &PipelineDesc);
        wgpuShaderModuleRelease(Module);
        Found = &ClearPipelines.Add(Key, Pipeline);
    }
    const FUintVector4 Params[] = {Values, Extent};
    auto Uniform = CreateBuffer(sizeof(Params), WGPUBufferUsage_Uniform, Params);
    Entries[1].binding = 1;
    Entries[1].buffer = Uniform;
    Entries[1].size = sizeof(Params);
    auto Layout = wgpuComputePipelineGetBindGroupLayout(*Found, 0);
    WGPUBindGroupDescriptor GroupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    GroupDesc.layout = Layout;
    GroupDesc.entryCount = UE_ARRAY_COUNT(Entries);
    GroupDesc.entries = Entries;
    auto Group = wgpuDeviceCreateBindGroup(Device, &GroupDesc);
    auto Compute = wgpuCommandEncoderBeginComputePass(Encoder, nullptr);
    wgpuComputePassEncoderSetPipeline(Compute, *Found);
    wgpuComputePassEncoderSetBindGroup(Compute, 0, Group, 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(Compute,
        Texture ? FMath::DivideAndRoundUp(Extent.X, 8u) : Extent.Z / 256,
        Texture ? FMath::DivideAndRoundUp(Extent.Y, 4u) : FMath::DivideAndRoundUp(Extent.X, Extent.Z),
        Texture ? FMath::DivideAndRoundUp(Extent.Z, 4u) : 1);
    wgpuComputePassEncoderEnd(Compute);
    wgpuComputePassEncoderRelease(Compute);
    wgpuBindGroupRelease(Group);
    wgpuBindGroupLayoutRelease(Layout);
    wgpuBufferRelease(Uniform);
    ++Dispatches;
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
