#pragma once

#include "WebGPUShaderDeclarations.h"
#include "WebGPUProbeUtils.h"

inline bool RunWebGPUPackedShadowMaskCases(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd,
    TArray<TSharedPtr<FJsonValue>>& Cases)
{
    TRefCountPtr<FWebGPUComputeShader> Shader = new FWebGPUComputeShader;
    auto& Data = Shader->Data;
    Data.Owner = Shader;
    Data.Frequency = SF_Compute;
    Data.Entry = TEXT("main");
    const FString Source = TEXT(
        "// A decoy texture_storage_2d<rgba32float, write> must not affect offsets.\n"
        "/* outer /* nested */ comment */\n"
        "@binding(0u) @group(0u) var mask : texture_storage_2d<rgba32uint, write>;\n"
        "@compute @workgroup_size(1) fn main() {\n"
        "textureStore(mask, vec2i(0), vec4u(0x89abcdefu, 0xfedcba98u, 0x80000001u, 0xffffffffu)); }\n");
    FWebGPUShaderBinding Binding;
    Binding.Name = TEXT("OutShadowMaskBits");
    Binding.Descriptor = 3;
    Binding.Reflected = true;
    Binding.TextureDimension = 1;
    Binding.TextureSampleType = TEXT("uint");
    Binding.StorageImageFormat = 30;
    Binding.StorageTextureAccess = TEXT("write");
    Binding.RouteInitialized = true;
    Data.Bindings.Add(Binding);
    Data.GroupVersions.Init(1, 1);
    FString Error;
    if (!PrepareWebGPUPackedShadowMaskFormat(Source, Data, Error)) return false;
    Shader->InitResourceTable();
    auto Pipeline = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Shader));
    bool Pass = true;
    const uint32 Expected[] = {0x89abcdefu, 0xfedcba98u, 0x80000001u, 0xffffffffu};
    for (const auto Format : {PF_R32_UINT, PF_R32G32_UINT, PF_R32G32B32A32_UINT, PF_R32G32_UINT})
    {
        auto Texture = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("PackedShadowMaskProbe"), 1, 1, Format)
            .SetFlags(ETextureCreateFlags::UAV | ETextureCreateFlags::ShaderResource)
            .SetInitialState(ERHIAccess::UAVCompute));
        auto UAV = Cmd.CreateUnorderedAccessView(Texture, FRHIViewDesc::CreateTextureUAV()
            .SetDimension(ETextureDimension::Texture2D));
        Data.Resources.Add(0, UAV.GetReference());
        Data.InvalidateGroups(1);
        RHI.RHISetComputePipelineState(Pipeline);
        RHI.RHIDispatchComputeShader(1, 1, 1);
        Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
        auto Readback = RHI.CreateBuffer(256, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
        if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        auto Src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        Src.texture = static_cast<FWebGPUTexture*>(Texture.GetReference())->Handle;
        auto Dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        Dst.buffer = Readback;
        Dst.layout.bytesPerRow = 256;
        Dst.layout.rowsPerImage = 1;
        const WGPUExtent3D Size{1, 1, 1};
        RHI.EndComputePass();
        wgpuCommandEncoderCopyTextureToBuffer(RHI.Encoder, &Src, &Dst, &Size);
        RHI.SubmitCurrent();
        const auto Bytes = RHI.MapBuffer(Readback, 256);
        const uint32 PixelBytes = GPixelFormats[Format].BlockBytes;
        const bool OK = Bytes.Num() == 256 && FMemory::Memcmp(Bytes.GetData(), Expected, PixelBytes) == 0;
        auto Case = MakeShared<FJsonObject>();
        Case->SetNumberField(TEXT("bits"), PixelBytes * 8);
        Case->SetBoolField(TEXT("pass"), OK);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
        Pass &= OK;
        wgpuBufferRelease(Readback);
    }
    Pass &= static_cast<FWebGPUComputePipeline*>(Pipeline.GetReference())->FormatVariants.Num() == 3;
    Data.Resources.Reset();
    return Pass;
}
