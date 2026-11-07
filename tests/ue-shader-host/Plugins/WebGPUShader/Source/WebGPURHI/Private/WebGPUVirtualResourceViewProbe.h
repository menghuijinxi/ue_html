#pragma once

#include "WebGPUProbeUtils.h"

inline bool RunWebGPUVirtualResourceViewCases(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd,
    TArray<TSharedPtr<FJsonValue>>& Cases)
{
    const char* Code =
        "@group(0) @binding(0) var tex: texture_2d<f32>;\n"
        "@group(0) @binding(1) var<storage,read_write> pixels: array<vec4f>;\n"
        "@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) i:vec3u) {\n"
        "pixels[i.x]=textureLoad(tex,vec2i(i32(i.x%2u),i32(i.x/2u)),0); }\n";
    auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
    WGSL.code = {Code, strlen(Code)};
    auto ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    ModuleDesc.nextInChain = &WGSL.chain;
    auto Module = wgpuDeviceCreateShaderModule(RHI.Device, &ModuleDesc);
    auto PipelineDesc = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    PipelineDesc.compute.module = Module;
    PipelineDesc.compute.entryPoint = {"main", 4};
    auto Pipeline = wgpuDeviceCreateComputePipeline(RHI.Device, &PipelineDesc);
    auto Layout = wgpuComputePipelineGetBindGroupLayout(Pipeline, 0);
    const FColor Colors[] = {FColor(32, 64, 128, 255), FColor(191, 32, 64, 128),
        FColor(64, 191, 32, 64), FColor(128, 64, 191, 32)};
    bool Pass = true;
    for (auto Format : {PF_R8G8B8A8, PF_B8G8R8A8})
    for (bool Storage : {false, true})
    {
        if (Storage && Format == PF_B8G8R8A8) continue;
        auto Init = Cmd.CreateTextureInitializer(FRHITextureCreateDesc::Create2D(TEXT("VirtualTextureViewProbe"), 2, 2, Format)
            .SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::SRGB |
                (Storage ? ETextureCreateFlags::UAV : ETextureCreateFlags::None))
            .SetInitialState(ERHIAccess::SRVCompute).SetInitActionInitializer());
        auto Subresource = Init.GetTexture2DSubresource(0);
        for (uint32 Index = 0; Index < 4; ++Index)
        {
            const auto C = Colors[Index];
            const uint8 Bytes[] = {Format == PF_B8G8R8A8 ? C.B : C.R, C.G,
                Format == PF_B8G8R8A8 ? C.R : C.B, C.A};
            FMemory::Memcpy(static_cast<uint8*>(Subresource.Data) + Index * 4, Bytes, 4);
        }
        auto Texture = Init.Finalize();
        for (uint32 Variant = 0; Variant < 3; ++Variant)
        {
            const bool Linear = Variant == 1;
            auto View = Cmd.CreateShaderResourceView(Texture, FRHIViewDesc::CreateTextureSRV()
                .SetDimensionFromTexture(Texture).SetDisableSRGB(Linear));
            auto Sink = RHI.CreateBuffer(64, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc);
            auto Readback = RHI.CreateBuffer(64, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst);
            WGPUBindGroupEntry Entries[2] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
            Entries[0].binding = 0;
            Entries[0].textureView = Variant == 2 ? static_cast<FWebGPUTexture*>(Texture.GetReference())->View :
                static_cast<FWebGPUTextureSRV*>(View.GetReference())->Handle;
            Entries[1].binding = 1;
            Entries[1].buffer = Sink;
            Entries[1].size = 64;
            auto GroupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            GroupDesc.layout = Layout;
            GroupDesc.entryCount = 2;
            GroupDesc.entries = Entries;
            auto Group = wgpuDeviceCreateBindGroup(RHI.Device, &GroupDesc);
            auto Encoder = wgpuDeviceCreateCommandEncoder(RHI.Device, nullptr);
            auto Compute = wgpuCommandEncoderBeginComputePass(Encoder, nullptr);
            wgpuComputePassEncoderSetPipeline(Compute, Pipeline);
            wgpuComputePassEncoderSetBindGroup(Compute, 0, Group, 0, nullptr);
            wgpuComputePassEncoderDispatchWorkgroups(Compute, 4, 1, 1);
            wgpuComputePassEncoderEnd(Compute);
            wgpuComputePassEncoderRelease(Compute);
            wgpuCommandEncoderCopyBufferToBuffer(Encoder, Sink, 0, Readback, 0, 64);
            auto Commands = wgpuCommandEncoderFinish(Encoder, nullptr);
            wgpuQueueSubmit(RHI.Queue, 1, &Commands);
            auto Bytes = RHI.MapBuffer(Readback, 64);
            bool OK = Bytes.Num() == 64;
            for (uint32 Index = 0; OK && Index < 4; ++Index)
            {
                float Actual[4];
                FMemory::Memcpy(Actual, Bytes.GetData() + Index * 16, 16);
                const auto C = Colors[Index];
                const FLinearColor Expected = Linear ? FLinearColor(C.R / 255.f, C.G / 255.f, C.B / 255.f, C.A / 255.f) : FLinearColor(C);
                for (uint32 Channel = 0; Channel < 4; ++Channel)
                    OK &= FMath::Abs(Actual[Channel] - Expected.Component(Channel)) < 0.002f;
            }
            auto Case = MakeShared<FJsonObject>();
            Case->SetNumberField(TEXT("format"), uint32(Format));
            Case->SetBoolField(TEXT("storage"), Storage);
            Case->SetNumberField(TEXT("view"), Variant);
            Case->SetBoolField(TEXT("pass"), OK);
            Cases.Add(MakeShared<FJsonValueObject>(Case));
            Pass &= OK;
            wgpuCommandBufferRelease(Commands);
            wgpuCommandEncoderRelease(Encoder);
            wgpuBindGroupRelease(Group);
            wgpuBufferRelease(Sink);
            wgpuBufferRelease(Readback);
        }
    }
    wgpuBindGroupLayoutRelease(Layout);
    wgpuComputePipelineRelease(Pipeline);
    wgpuShaderModuleRelease(Module);
    return Pass;
}

inline bool RunWebGPUVolatilePassCase(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd)
{
    const char* Code =
        "struct Out { @builtin(position) p:vec4f, @location(0) c:vec4f }\n"
        "@vertex fn vs(@builtin(vertex_index) i:u32,@location(0) c:vec4f)->Out {\n"
        "let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return Out(vec4f(p[i],0,1),c); }\n"
        "@fragment fn ps(i:Out)->@location(0) vec4f {return i.c;}\n";
    auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
    WGSL.code = {Code, strlen(Code)};
    auto ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    ModuleDesc.nextInChain = &WGSL.chain;
    auto Module = wgpuDeviceCreateShaderModule(RHI.Device, &ModuleDesc);
    auto Attribute = WGPU_VERTEX_ATTRIBUTE_INIT;
    Attribute.format = WGPUVertexFormat_Float32x4;
    auto BufferLayout = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
    BufferLayout.arrayStride = 16;
    BufferLayout.stepMode = WGPUVertexStepMode_Instance;
    BufferLayout.attributeCount = 1;
    BufferLayout.attributes = &Attribute;
    auto Color = WGPU_COLOR_TARGET_STATE_INIT;
    Color.format = WGPUTextureFormat_RGBA8Unorm;
    auto Fragment = WGPU_FRAGMENT_STATE_INIT;
    Fragment.module = Module;
    Fragment.entryPoint = {"ps", 2};
    Fragment.targetCount = 1;
    Fragment.targets = &Color;
    auto PipelineDesc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    PipelineDesc.vertex.module = Module;
    PipelineDesc.vertex.entryPoint = {"vs", 2};
    PipelineDesc.vertex.bufferCount = 1;
    PipelineDesc.vertex.buffers = &BufferLayout;
    PipelineDesc.fragment = &Fragment;
    auto Pipeline = wgpuDeviceCreateRenderPipeline(RHI.Device, &PipelineDesc);
    auto Buffer = Cmd.CreateBuffer(FRHIBufferCreateDesc::CreateVertex(TEXT("VolatilePassProbe"), 1024)
        .AddUsage(EBufferUsageFlags::Volatile).SetInitialState(ERHIAccess::VertexOrIndexBuffer));
    auto Target = WebGPUProbe::Target(RHI, Cmd, 4, 2);
    Cmd.BeginRenderPass(FRHIRenderPassInfo(Target, ERenderTargetActions::Clear_Store), TEXT("VolatilePassProbe"));
    FString Error;
    bool Pass = !RHI.ValidateBufferLock(Buffer, 4, 16, RLM_WriteOnly, Error) &&
        !RHI.ValidateBufferLock(Buffer, 0, 16, RLM_ReadOnly, Error);
    for (uint32 Round = 0; Round < 2; ++Round)
    {
        const float Value[] = {Round ? 0.f : 1.f, Round ? 1.f : 0.f, 0.f, 1.f};
        auto* Data = RHI.LockBuffer_BottomOfPipe(Cmd, Buffer, 0, sizeof(Value), RLM_WriteOnly);
        FMemory::Memcpy(Data, Value, sizeof(Value));
        RHI.UnlockBuffer_BottomOfPipe(Cmd, Buffer);
        wgpuRenderPassEncoderSetPipeline(RHI.Pass, Pipeline);
        wgpuRenderPassEncoderSetViewport(RHI.Pass, Round * 2, 0, 2, 2, 0, 1);
        wgpuRenderPassEncoderSetVertexBuffer(RHI.Pass, 0,
            static_cast<FWebGPUBuffer*>(Buffer.GetReference())->Handle, 0, 16);
        wgpuRenderPassEncoderDraw(RHI.Pass, 3, 1, 0, 0);
    }
    Cmd.EndRenderPass();
    TArray<FColor> Pixels;
    Cmd.ReadSurfaceData(Target, FIntRect(0, 0, 4, 2), Pixels, WebGPUProbe::RawReadback());
    Pass &= Pixels.Num() == 8;
    for (int32 Index = 0; Index < Pixels.Num(); ++Index)
        Pass &= Pixels[Index] == (Index % 4 < 2 ? FColor::Red : FColor::Green);
    wgpuRenderPipelineRelease(Pipeline);
    wgpuShaderModuleRelease(Module);
    return Pass;
}
