#pragma once

#include "WebGPUProbeUtils.h"

inline TSharedRef<FJsonObject> RunWebGPUColorSpaceProbe(FWebGPUDynamicRHI& RHI)
{
    auto& Cmd = FRHICommandListExecutor::GetImmediateCommandList();
    GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
        ERHISubmitFlags::EnableBypass);
    const char* Code = "@group(0) @binding(0) var tex:texture_2d<f32>;"
        "@group(0) @binding(1) var<storage,read_write> result:vec4f;"
        "@compute @workgroup_size(1) fn main(){result=textureLoad(tex,vec2i(0),0);}";
    auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT; WGSL.code = {Code, strlen(Code)};
    auto ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT; ModuleDesc.nextInChain = &WGSL.chain;
    auto Module = wgpuDeviceCreateShaderModule(RHI.Device, &ModuleDesc);
    WGPUBindGroupLayoutEntry LayoutEntries[2] = {WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT, WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT};
    LayoutEntries[0].binding = 0; LayoutEntries[0].visibility = WGPUShaderStage_Compute;
    LayoutEntries[0].texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
    LayoutEntries[0].texture.viewDimension = WGPUTextureViewDimension_2D;
    LayoutEntries[1].binding = 1; LayoutEntries[1].visibility = WGPUShaderStage_Compute;
    LayoutEntries[1].buffer.type = WGPUBufferBindingType_Storage;
    auto LayoutDesc = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    LayoutDesc.entries = LayoutEntries; LayoutDesc.entryCount = 2;
    auto Layout = wgpuDeviceCreateBindGroupLayout(RHI.Device, &LayoutDesc);
    auto PipelineLayoutDesc = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    PipelineLayoutDesc.bindGroupLayoutCount = 1; PipelineLayoutDesc.bindGroupLayouts = &Layout;
    auto PipelineLayout = wgpuDeviceCreatePipelineLayout(RHI.Device, &PipelineLayoutDesc);
    auto PipelineDesc = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    PipelineDesc.layout = PipelineLayout; PipelineDesc.compute.module = Module;
    PipelineDesc.compute.entryPoint = {"main", 4};
    auto Pipeline = wgpuDeviceCreateComputePipeline(RHI.Device, &PipelineDesc);
    TArray<TSharedPtr<FJsonValue>> Cases;
    bool Pass = true;
    for (auto Format : {PF_FloatRGBA, PF_A32B32G32R32F, PF_R16F, PF_G16R16F, PF_R32_FLOAT,
        PF_G32R32F, PF_FloatRGB, PF_FloatR11G11B10, PF_R8G8B8A8, PF_B8G8R8A8})
    for (bool SRGB : {false, true})
    {
        const bool HasSRGB = Format == PF_R8G8B8A8 || Format == PF_B8G8R8A8;
        const uint32 Channels = Format == PF_R16F || Format == PF_R32_FLOAT ? 1 :
            Format == PF_G16R16F || Format == PF_G32R32F ? 2 :
            Format == PF_FloatRGB || Format == PF_FloatR11G11B10 ? 3 : 4;
        const FLinearColor Clear(0.25f, 0.5f, 1, 0.75f);
        auto Texture = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("HDRColorSpaceProbe"), 1, 1, Format)
            .SetFlags(ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::ShaderResource |
                (SRGB ? ETextureCreateFlags::SRGB : ETextureCreateFlags::None))
            .SetClearValue(FClearValueBinding(Clear)).SetInitialState(ERHIAccess::RTV));
        Cmd.BeginRenderPass(FRHIRenderPassInfo(Texture, ERenderTargetActions::Clear_Store), TEXT("HDRColorSpaceProbe"));
        Cmd.EndRenderPass();
        Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::RTV, ERHIAccess::SRVCompute));
        RHI.SubmitCurrent();
        for (uint32 Variant = 0; Variant < 3; ++Variant)
        {
            auto View = Cmd.CreateShaderResourceView(Texture, FRHIViewDesc::CreateTextureSRV()
                .SetDimensionFromTexture(Texture).SetDisableSRGB(Variant == 1));
            auto Sink = RHI.CreateBuffer(16, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc);
            auto Readback = RHI.CreateBuffer(16, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst);
            WGPUBindGroupEntry Entries[2] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
            Entries[0].binding = 0;
            Entries[0].textureView = Variant == 2 ? static_cast<FWebGPUTexture*>(Texture.GetReference())->View :
                static_cast<FWebGPUTextureSRV*>(View.GetReference())->Handle;
            Entries[1].binding = 1; Entries[1].buffer = Sink; Entries[1].size = 16;
            auto GroupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            GroupDesc.layout = Layout; GroupDesc.entryCount = 2; GroupDesc.entries = Entries;
            auto Group = wgpuDeviceCreateBindGroup(RHI.Device, &GroupDesc);
            auto Encoder = wgpuDeviceCreateCommandEncoder(RHI.Device, nullptr);
            auto Compute = wgpuCommandEncoderBeginComputePass(Encoder, nullptr);
            wgpuComputePassEncoderSetPipeline(Compute, Pipeline);
            wgpuComputePassEncoderSetBindGroup(Compute, 0, Group, 0, nullptr);
            wgpuComputePassEncoderDispatchWorkgroups(Compute, 1, 1, 1);
            wgpuComputePassEncoderEnd(Compute); wgpuComputePassEncoderRelease(Compute);
            wgpuCommandEncoderCopyBufferToBuffer(Encoder, Sink, 0, Readback, 0, 16);
            auto Commands = wgpuCommandEncoderFinish(Encoder, nullptr);
            wgpuQueueSubmit(RHI.Queue, 1, &Commands);
            const auto Bytes = RHI.MapBuffer(Readback, 16);
            float Actual[4] = {}; bool OK = Bytes.Num() == 16;
            if (OK) FMemory::Memcpy(Actual, Bytes.GetData(), 16);
            const auto Encoded = Clear.ToFColorSRGB();
            const float EncodedValues[] = {Encoded.R / 255.f, Encoded.G / 255.f, Encoded.B / 255.f, Encoded.A / 255.f};
            TArray<TSharedPtr<FJsonValue>> Values, Expected;
            for (uint32 Channel = 0; Channel < 4; ++Channel)
            {
                const float Value = Channel >= Channels ? (Channel == 3 ? 1.f : 0.f) :
                    HasSRGB && SRGB && Variant == 1 ? EncodedValues[Channel] : Clear.Component(Channel);
                OK &= FMath::IsFinite(Actual[Channel]) && FMath::Abs(Actual[Channel] - Value) < (HasSRGB ? 0.005f : 0.00001f);
                Values.Add(MakeShared<FJsonValueNumber>(Actual[Channel]));
                Expected.Add(MakeShared<FJsonValueNumber>(Value));
            }
            auto Case = MakeShared<FJsonObject>(); Case->SetStringField(TEXT("format"), GPixelFormats[Format].Name);
            Case->SetBoolField(TEXT("srgb"), SRGB); Case->SetNumberField(TEXT("view"), Variant);
            Case->SetArrayField(TEXT("actual"), Values); Case->SetArrayField(TEXT("expected"), Expected);
            Case->SetBoolField(TEXT("pass"), OK); Cases.Add(MakeShared<FJsonValueObject>(Case)); Pass &= OK;
            wgpuCommandBufferRelease(Commands); wgpuCommandEncoderRelease(Encoder); wgpuBindGroupRelease(Group);
            wgpuBufferRelease(Sink); wgpuBufferRelease(Readback);
        }
    }
    wgpuComputePipelineRelease(Pipeline); wgpuPipelineLayoutRelease(PipelineLayout);
    wgpuBindGroupLayoutRelease(Layout); wgpuShaderModuleRelease(Module);
    auto Report = MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), Pass);
    Report->SetArrayField(TEXT("cases"), Cases); return Report;
}
