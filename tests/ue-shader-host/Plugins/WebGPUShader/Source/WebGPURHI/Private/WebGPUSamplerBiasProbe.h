#pragma once

#include "WebGPUSamplerBias.h"
#include "WebGPUProbeUtils.h"

inline bool RunWebGPUSamplerBiasCases(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd,
    TArray<TSharedPtr<FJsonValue>>& Cases)
{
    FString Source = TEXT(
        "@group(0) @binding(0) var tex: texture_2d<f32>;\n"
        "@group(0) @binding(1) var biasSampler: sampler;\n"
        "@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {\n"
        "let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1); }\n"
        "@fragment fn ps(@builtin(position) p:vec4f)->@location(0) vec4f {\n"
        "let uv=p.xy/4.0;\n"
        "let a=textureSample(tex,biasSampler,uv);\n"
        "let b=textureSampleBias(tex,biasSampler,uv,1.0);\n"
        "let c=textureSampleGrad(tex,biasSampler,uv,vec2f(0.25,0),vec2f(0,0.25),vec2i(0,0));\n"
        "let d=textureSampleLevel(tex,biasSampler,uv,1.0);\n"
        "return array<vec4f,4>(a,b,c,d)[u32(p.y)]; }\n");
    FWebGPUShaderData Shader;
    FWebGPUShaderBinding Binding;
    Binding.Name = TEXT("View_MaterialTextureBilinearWrapedSampler");
    Binding.Descriptor = 0;
    Binding.Index = 1;
    Binding.Reflected = true;
    Shader.Bindings.Add(Binding);
    FString Error;
    if (!LowerWebGPUViewSamplerBias(Source, Shader, Error)) return false;
    const FTCHARToUTF8 Code(*Source);
    auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
    WGSL.code = {Code.Get(), size_t(Code.Length())};
    auto ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    ModuleDesc.nextInChain = &WGSL.chain;
    auto Module = wgpuDeviceCreateShaderModule(RHI.Device, &ModuleDesc);
    auto Color = WGPU_COLOR_TARGET_STATE_INIT;
    Color.format = WGPUTextureFormat_RGBA8Unorm;
    auto Fragment = WGPU_FRAGMENT_STATE_INIT;
    Fragment.module = Module;
    Fragment.entryPoint = {"ps", 2};
    Fragment.targetCount = 1;
    Fragment.targets = &Color;
    auto Desc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    Desc.vertex.module = Module;
    Desc.vertex.entryPoint = {"vs", 2};
    Desc.fragment = &Fragment;
    auto Pipeline = wgpuDeviceCreateRenderPipeline(RHI.Device, &Desc);
    auto Layout = wgpuRenderPipelineGetBindGroupLayout(Pipeline, 0);
    auto Init = Cmd.CreateTextureInitializer(FRHITextureCreateDesc::Create2D(TEXT("SamplerBiasMipProbe"), 4, 4, PF_R8G8B8A8)
        .SetNumMips(3).SetFlags(ETextureCreateFlags::ShaderResource)
        .SetInitialState(ERHIAccess::SRVGraphicsPixel).SetInitActionInitializer());
    const FColor MipColors[] = {FColor::Red, FColor::Green, FColor::Blue};
    for (uint32 Mip = 0; Mip < 3; ++Mip)
    {
        auto Subresource = Init.GetTexture2DSubresource(Mip);
        const auto C = MipColors[Mip];
        const uint8 Pixel[] = {C.R, C.G, C.B, C.A};
        for (uint64 Offset = 0; Offset < Subresource.Size; Offset += 4)
            FMemory::Memcpy(static_cast<uint8*>(Subresource.Data) + Offset, Pixel, 4);
    }
    auto Texture = Init.Finalize();
    bool Pass = true;
    for (float Bias : {-1.f, 0.f, 0.5f, 1.f, 2.f})
    {
        auto Sampler = RHI.RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Trilinear, AM_Clamp, AM_Clamp, AM_Clamp, Bias));
        const float Values[] = {Bias, 0, 0, 0};
        auto BiasBuffer = RHI.CreateBuffer(16, WGPUBufferUsage_Uniform, Values);
        WGPUBindGroupEntry Entries[3] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
        Entries[0].binding = 0;
        Entries[0].textureView = static_cast<FWebGPUTexture*>(Texture.GetReference())->View;
        Entries[1].binding = 1;
        Entries[1].sampler = RHI.ResolveSampler(static_cast<FWebGPUSampler*>(Sampler.GetReference()), true);
        Entries[2].binding = 2;
        Entries[2].buffer = BiasBuffer;
        Entries[2].size = 16;
        auto GroupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        GroupDesc.layout = Layout;
        GroupDesc.entryCount = 3;
        GroupDesc.entries = Entries;
        auto Group = wgpuDeviceCreateBindGroup(RHI.Device, &GroupDesc);
        auto Target = WebGPUProbe::Target(RHI, Cmd, 4, 4);
        Cmd.BeginRenderPass(FRHIRenderPassInfo(Target, ERenderTargetActions::Clear_Store), TEXT("SamplerBiasProbe"));
        wgpuRenderPassEncoderSetPipeline(RHI.Pass, Pipeline);
        wgpuRenderPassEncoderSetBindGroup(RHI.Pass, 0, Group, 0, nullptr);
        wgpuRenderPassEncoderDraw(RHI.Pass, 3, 1, 0, 0);
        Cmd.EndRenderPass();
        TArray<FColor> Pixels;
        Cmd.ReadSurfaceData(Target, FIntRect(0, 0, 4, 4), Pixels, WebGPUProbe::RawReadback());
        bool OK = Pixels.Num() == 16;
        for (int32 Index = 0; Index < Pixels.Num(); ++Index)
        {
            const uint32 Row = Index / 4;
            const float Level = FMath::Clamp(Row == 3 ? 1.f : Bias + (Row == 1 ? 1.f : 0.f), 0.f, 2.f);
            const int32 Lower = FMath::FloorToInt(Level), Upper = FMath::Min(Lower + 1, 2);
            const FColor Expected = FMath::Lerp(FLinearColor(MipColors[Lower]), FLinearColor(MipColors[Upper]), Level - Lower).ToFColor(false);
            const auto Actual = Pixels[Index];
            OK &= FMath::Abs(int32(Actual.R) - Expected.R) <= 1 &&
                FMath::Abs(int32(Actual.G) - Expected.G) <= 1 &&
                FMath::Abs(int32(Actual.B) - Expected.B) <= 1 && Actual.A == 255;
        }
        auto Case = MakeShared<FJsonObject>();
        Case->SetNumberField(TEXT("bias"), Bias);
        Case->SetNumberField(TEXT("checkedPixels"), Pixels.Num());
        Case->SetBoolField(TEXT("pass"), OK);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
        Pass &= OK;
        wgpuBindGroupRelease(Group);
        wgpuBufferRelease(BiasBuffer);
    }
    wgpuBindGroupLayoutRelease(Layout);
    wgpuRenderPipelineRelease(Pipeline);
    wgpuShaderModuleRelease(Module);
    return Pass;
}
