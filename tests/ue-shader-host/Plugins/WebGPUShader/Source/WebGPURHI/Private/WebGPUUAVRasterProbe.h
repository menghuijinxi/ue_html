#pragma once

#include "WebGPUProbeUtils.h"

inline bool RunWebGPUUAVRasterCases(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd,
    TArray<TSharedPtr<FJsonValue>>& Cases, TArray<TSharedPtr<FJsonValue>>& DepthCases)
{
    const auto Init = [&](FWebGPUShaderData& Data, FRHIShader* Owner, EShaderFrequency Frequency,
        const char* Code, bool Pixel) {
        Data.Owner = Owner;
        Data.Frequency = Frequency;
        Data.Entry = TEXT("main");
        Data.Metadata = MakeShared<FJsonObject>();
        Data.Metadata->SetNumberField(TEXT("frequency"), Frequency);
        TArray<TSharedPtr<FJsonValue>> Bindings, Reflected;
        if (Pixel)
        {
            for (uint32 Index = 0; Index < 3; ++Index)
            {
                auto Binding = MakeShared<FJsonObject>();
                Binding->SetStringField(TEXT("name"), Index == 2 ? TEXT("VolumeMark") : Index ? TEXT("Mask") : TEXT("Result"));
                Binding->SetNumberField(TEXT("group"), 0);
                Binding->SetNumberField(TEXT("binding"), Index);
                Binding->SetNumberField(TEXT("descriptorType"), Index ? 3 : 7);
                Binding->SetBoolField(TEXT("readOnlyStorage"), false);
                Binding->SetNumberField(TEXT("storageElementStride"), 4);
                Binding->SetNumberField(TEXT("storageElementFormat"), PF_R32_UINT);
                Binding->SetNumberField(TEXT("textureDimension"), Index == 2 ? 2 : 1);
                Binding->SetBoolField(TEXT("textureArrayed"), false);
                Binding->SetNumberField(TEXT("storageImageFormat"), Index == 2 ? 39 : 15);
                Binding->SetStringField(TEXT("textureSampleType"), Index == 2 ? TEXT("uint") : TEXT("float"));
                Binding->SetStringField(TEXT("storageTextureAccess"), TEXT("write"));
                Bindings.Add(MakeShared<FJsonValueObject>(Binding));
                FWebGPUShaderBinding Entry;
                Entry.Metadata = &Binding.Get();
                Entry.Name = Binding->GetStringField(TEXT("name"));
                Entry.Descriptor = Index ? 3 : 7;
                Entry.Index = Index;
                Entry.Reflected = true;
                Entry.TextureDimension = Index == 2 ? 2 : 1;
                Entry.TextureSampleType = Index == 2 ? TEXT("uint") : TEXT("float");
                Entry.StorageImageFormat = Index == 2 ? 39 : 15;
                Entry.StorageTextureAccess = TEXT("write");
                Entry.StorageContract.ReadOnlyValid = true;
                Entry.StorageContract.FormatValid = true;
                Entry.StorageContract.Format = PF_R32_UINT;
                Entry.StorageContract.StrideValid = true;
                Entry.StorageContract.Stride = 4;
                Entry.RouteInitialized = true;
                Entry.Route.Index = Index;
                Data.Bindings.Add(Entry);
                auto WebBinding = MakeShared<FJsonObject>();
                WebBinding->SetNumberField(TEXT("group"), 0);
                WebBinding->SetNumberField(TEXT("binding"), Index);
                WebBinding->SetStringField(TEXT("resource_type"), Index ? TEXT("WriteOnlyStorageTexture") : TEXT("StorageBuffer"));
                Reflected.Add(MakeShared<FJsonValueObject>(WebBinding));
            }
            Data.GroupVersions.Init(1, 1);
        }
        Data.Metadata->SetArrayField(TEXT("spirvBindings"), Bindings);
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Data.Entry);
        Entry->SetArrayField(TEXT("bindings"), Reflected);
        Entry->SetArrayField(TEXT("output_variables"), {});
        auto Reflection = MakeShared<FJsonObject>();
        Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(Entry)});
        Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
        auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
        WGSL.code = {Code, strlen(Code)};
        auto Desc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        Desc.nextInChain = &WGSL.chain;
        Data.Module = wgpuDeviceCreateShaderModule(RHI.Device, &Desc);
    };
    TRefCountPtr<FWebGPUVertexShader> VS = new FWebGPUVertexShader;
    TRefCountPtr<FWebGPUPixelShader> PS = new FWebGPUPixelShader;
    Init(VS->Data, VS, SF_Vertex,
        "@vertex fn main(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {\n"
        "let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));\n"
        "return vec4f(p[id],0,1); }\n", false);
    Init(PS->Data, PS, SF_Pixel,
        "@group(0) @binding(0) var<storage,read_write> Result: array<atomic<u32>>;\n"
        "@group(0) @binding(1) var Mask: texture_storage_2d<r8unorm,write>;\n"
        "@group(0) @binding(2) var VolumeMark: texture_storage_3d<r8uint,write>;\n"
        "@fragment fn main(@builtin(position) p: vec4f) {\n"
        "atomicAdd(&Result[u32(p.y)*32u+u32(p.x)],1u);\n"
        "textureStore(Mask,vec2i(p.xy),vec4f(0.5));\n"
        "textureStore(VolumeMark,vec3i(i32(p.x)%4,i32(p.y)%4,(i32(p.x)/4)%4),vec4u(255)); }\n", true);
    VS->InitResourceTable();
    PS->InitResourceTable();
    auto Blend = RHI.RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
    FRasterizerStateInitializerRHI RasterInitializer;
    RasterInitializer.FillMode = FM_Solid;
    RasterInitializer.CullMode = CM_None;
    auto Raster = RHI.RHICreateRasterizerState(RasterInitializer);
    auto Depth = RHI.RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
    FGraphicsPipelineStateInitializer Initializer;
    Initializer.BoundShaderState.VertexShaderRHI = VS;
    Initializer.BoundShaderState.PixelShaderRHI = PS;
    Initializer.BlendState = Blend;
    Initializer.RasterizerState = Raster;
    Initializer.DepthStencilState = Depth;
    Initializer.PrimitiveType = PT_TriangleList;
    Initializer.NumSamples = 0;
    auto Pipeline = RHI.RHICreateGraphicsPipelineState(Initializer);
    const uint16 Indices[3]{0, 1, 2};
    const uint32 Arguments[5]{3, 1, 0, 0, 0};
    auto Index = WebGPUProbe::Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateIndex(TEXT("UAVRasterIndices"), 6, 2)
        .SetInitialState(ERHIAccess::VertexOrIndexBuffer), Indices, sizeof(Indices));
    auto Indirect = WebGPUProbe::Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(TEXT("UAVRasterArguments"), 20, 4,
        BUF_DrawIndirect).SetInitialState(ERHIAccess::IndirectArgs), Arguments, sizeof(Arguments));
    bool Pass = true;
    for (const FIntPoint Extent : {FIntPoint(9, 7), FIntPoint(13, 11), FIntPoint(5, 3)})
    {
        uint32 Zero[32 * 16]{};
        auto Result = WebGPUProbe::Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(TEXT("UAVRasterResult"),
            sizeof(Zero), 4, BUF_UnorderedAccess | BUF_ShaderResource)
            .SetInitialState(ERHIAccess::UAVGraphics), Zero, sizeof(Zero));
        auto UAV = Cmd.CreateUnorderedAccessView(Result, FRHIViewDesc::CreateBufferUAV()
            .SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32_UINT));
        auto Mask = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("UAVRasterMask"), 32, 16, PF_R8)
            .SetFlags(ETextureCreateFlags::UAV).SetInitialState(ERHIAccess::UAVGraphics));
        auto MaskUAV = Cmd.CreateUnorderedAccessView(Mask, FRHIViewDesc::CreateTextureUAV()
            .SetDimension(ETextureDimension::Texture2D));
        auto Volume = Cmd.CreateTexture(FRHITextureCreateDesc::Create3D(TEXT("UAVRasterVolumeMark"), 4, 4, 4, PF_R8_UINT)
            .SetFlags(ETextureCreateFlags::UAV | ETextureCreateFlags::ShaderResource).SetInitialState(ERHIAccess::UAVGraphics));
        auto VolumeUAV = Cmd.CreateUnorderedAccessView(Volume, FRHIViewDesc::CreateTextureUAV()
            .SetDimension(ETextureDimension::Texture3D));
        PS->Data.Resources.Add(0, UAV.GetReference());
        PS->Data.Resources.Add(1, MaskUAV.GetReference());
        PS->Data.Resources.Add(2, VolumeUAV.GetReference());
        PS->Data.InvalidateGroups(1);
        if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        FRHIRenderPassInfo Info;
        Info.ResolveRect = FResolveRect(0, 0, Extent.X, Extent.Y);
        RHI.RHIBeginRenderPass(Info, TEXT("UAVRasterProbe"));
        RHI.RHISetViewport(0, 0, 0, Extent.X, Extent.Y, 1);
        RHI.RHISetScissorRect(false, 0, 0, 0, 0);
        RHI.RHISetGraphicsPipelineState(Pipeline, 0, false);
        RHI.RHIDrawIndexedPrimitiveIndirect(Index, Indirect, 0);
        RHI.RHIEndRenderPass();
        Cmd.Transition(FRHITransitionInfo(Result, ERHIAccess::UAVGraphics, ERHIAccess::CopySrc));
        const auto Bytes = RHI.ReadBuffer(Result, sizeof(Zero));
        bool OK = Bytes.Num() == sizeof(Zero);
        if (OK)
        {
            FMemory::Memcpy(Zero, Bytes.GetData(), sizeof(Zero));
            for (uint32 Y = 0; Y < 16; ++Y)
                for (uint32 X = 0; X < 32; ++X)
                    OK &= Zero[Y * 32 + X] == uint32(X < uint32(Extent.X) && Y < uint32(Extent.Y));
        }
        Cmd.Transition(FRHITransitionInfo(Mask, ERHIAccess::UAVGraphics, ERHIAccess::CopySrc));
        if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        auto Readback = RHI.CreateBuffer(256 * 16, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
        auto Source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        Source.texture = static_cast<FWebGPUTexture*>(Mask.GetReference())->Handle;
        auto Destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        Destination.buffer = Readback;
        Destination.layout.bytesPerRow = 256;
        Destination.layout.rowsPerImage = 16;
        const WGPUExtent3D Size{32, 16, 1};
        wgpuCommandEncoderCopyTextureToBuffer(RHI.Encoder, &Source, &Destination, &Size);
        RHI.SubmitCurrent();
        const auto MaskBytes = RHI.MapBuffer(Readback, 256 * 16);
        wgpuBufferRelease(Readback);
        OK &= MaskBytes.Num() == 256 * 16;
        if (MaskBytes.Num() == 256 * 16)
            for (int32 Y = 0; Y < Extent.Y; ++Y)
                for (int32 X = 0; X < Extent.X; ++X)
                    OK &= FMath::Abs(int32(MaskBytes[Y * 256 + X]) - 128) <= 1;
        Cmd.Transition(FRHITransitionInfo(Volume, ERHIAccess::UAVGraphics, ERHIAccess::CopySrc));
        if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        auto VolumeReadback = RHI.CreateBuffer(256 * 4 * 4, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
        Source.texture = static_cast<FWebGPUTexture*>(Volume.GetReference())->Handle;
        Destination.buffer = VolumeReadback;
        Destination.layout.rowsPerImage = 4;
        const WGPUExtent3D VolumeSize{4, 4, 4};
        wgpuCommandEncoderCopyTextureToBuffer(RHI.Encoder, &Source, &Destination, &VolumeSize);
        RHI.SubmitCurrent();
        const auto VolumeBytes = RHI.MapBuffer(VolumeReadback, 256 * 4 * 4);
        wgpuBufferRelease(VolumeReadback);
        OK &= VolumeBytes.Num() == 256 * 4 * 4;
        if (VolumeBytes.Num() == 256 * 4 * 4)
            for (int32 Z = 0; Z < 4; ++Z)
                for (int32 Y = 0; Y < 4; ++Y)
                    for (int32 X = 0; X < 4; ++X)
                    {
                        const uint8 Expected = (X + Z * 4) < Extent.X && Y < Extent.Y ? 255 : 0;
                        OK &= VolumeBytes[Z * 256 * 4 + Y * 256 + X] == Expected;
                    }
        auto Case = MakeShared<FJsonObject>();
        Case->SetNumberField(TEXT("width"), Extent.X);
        Case->SetNumberField(TEXT("height"), Extent.Y);
        Case->SetBoolField(TEXT("pixelAtomicsAndR8Storage"), true);
        Case->SetBoolField(TEXT("pixelVolumeR8UInt"), true);
        Case->SetNumberField(TEXT("extentAttachmentBytes"),
            RHI.RasterExtentAttachment->GetDesc().CalcMemorySizeEstimate());
        Case->SetBoolField(TEXT("pass"), OK);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
        Pass &= OK;
        PS->Data.Resources.Reset();
    }
    TRefCountPtr<FWebGPUPixelShader> SamplePS = new FWebGPUPixelShader;
    Init(SamplePS->Data, SamplePS, SF_Pixel,
        "@group(0) @binding(0) var SourceDepthAtlas: texture_2d<f32>;\n"
        "@group(0) @binding(1) var GlobalPointClampedSampler: sampler;\n"
        "@fragment fn main() -> @location(0) vec4f {\n"
        "let depth=textureSampleLevel(SourceDepthAtlas,GlobalPointClampedSampler,vec2f(0.5),0).x;\n"
        "return vec4f(depth,depth,depth,1); }\n", false);
    auto& SampleData = SamplePS->Data;
    TArray<TSharedPtr<FJsonValue>> SampleBindings, SampleReflected;
    for (uint32 BindingIndex = 0; BindingIndex < 2; ++BindingIndex)
    {
        auto Binding = MakeShared<FJsonObject>();
        Binding->SetStringField(TEXT("name"), BindingIndex ? TEXT("GlobalPointClampedSampler") : TEXT("SourceDepthAtlas"));
        Binding->SetNumberField(TEXT("group"), 0);
        Binding->SetNumberField(TEXT("binding"), BindingIndex);
        Binding->SetNumberField(TEXT("descriptorType"), BindingIndex ? 0 : 2);
        Binding->SetNumberField(TEXT("textureDimension"), 1);
        Binding->SetBoolField(TEXT("textureArrayed"), false);
        Binding->SetBoolField(TEXT("textureMultisampled"), false);
        Binding->SetStringField(TEXT("textureSampleType"), TEXT("float"));
        SampleBindings.Add(MakeShared<FJsonValueObject>(Binding));
        FWebGPUShaderBinding Entry;
        Entry.Name = Binding->GetStringField(TEXT("name"));
        Entry.Metadata = &Binding.Get();
        Entry.Descriptor = BindingIndex ? 0 : 2;
        Entry.Index = BindingIndex;
        Entry.Reflected = true;
        Entry.RouteInitialized = true;
        Entry.Route.Index = BindingIndex;
        Entry.TextureDimension = 1;
        Entry.TextureContractValid = true;
        Entry.TextureSampleType = TEXT("float");
        SampleData.Bindings.Add(Entry);
        auto Reflected = MakeShared<FJsonObject>();
        Reflected->SetNumberField(TEXT("group"), 0);
        Reflected->SetNumberField(TEXT("binding"), BindingIndex);
        Reflected->SetStringField(TEXT("resource_type"), BindingIndex ? TEXT("Sampler") : TEXT("SampledTexture"));
        SampleReflected.Add(MakeShared<FJsonValueObject>(Reflected));
    }
    SampleData.GroupVersions.Init(1, 1);
    SampleData.Metadata->SetArrayField(TEXT("spirvBindings"), SampleBindings);
    auto SampleEntry = SampleData.Metadata->GetObjectField(TEXT("reflection"))->GetArrayField(TEXT("entry_points"))[0]->AsObject();
    SampleEntry->SetArrayField(TEXT("bindings"), SampleReflected);
    auto Output = MakeShared<FJsonObject>();
    Output->SetNumberField(TEXT("location"), 0);
    SampleEntry->SetArrayField(TEXT("output_variables"), {MakeShared<FJsonValueObject>(Output)});
    SampleData.RuntimeMetadata.OutputMask = 1;
    SamplePS->InitResourceTable();
    auto SampleInitializer = Initializer;
    SampleInitializer.BoundShaderState.PixelShaderRHI = SamplePS;
    SampleInitializer.RenderTargetsEnabled = 1;
    SampleInitializer.RenderTargetFormats[0] = PF_R8G8B8A8;
    SampleInitializer.NumSamples = 1;
    auto Sampler = RHI.RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Point, AM_Clamp, AM_Clamp));
    for (const TCHAR *BindingName : {TEXT("SourceDepthAtlas"), TEXT("DepthAtlas"), TEXT("LumenCardScene_DepthAtlas"),
                                     TEXT("LoadOnlyTextureWithoutDepthName")})
    {
        const bool LoadOnly = FString(BindingName) == TEXT("LoadOnlyTextureWithoutDepthName");
        SampleBindings[0]->AsObject()->SetStringField(TEXT("name"), BindingName);
        SampleBindings[0]->AsObject()->SetBoolField(TEXT("sampledTextureLoadOnly"), LoadOnly);
        SampleData.Bindings[0].Name = BindingName;
        SampleData.Bindings[0].SampledTextureLoadOnly = LoadOnly;
        if (LoadOnly)
        {
            const char *Code = "@group(0) @binding(0) var SourceDepthAtlas: texture_2d<f32>;\n"
                               "@fragment fn main() -> @location(0) vec4f {\n"
                               "let depth=textureLoad(SourceDepthAtlas,vec2i(1),0).x;\n"
                               "return vec4f(depth,depth,depth,1); }\n";
            auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
            WGSL.code = {Code, strlen(Code)};
            auto Desc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
            Desc.nextInChain = &WGSL.chain;
            wgpuShaderModuleRelease(SampleData.Module);
            SampleData.Module = wgpuDeviceCreateShaderModule(RHI.Device, &Desc);
        }
        auto SamplePipeline = RHI.RHICreateGraphicsPipelineState(SampleInitializer);
        for (const EPixelFormat Format : {PF_DepthStencil, PF_G16})
        {
            if (!RHI.ContextOpen)
                RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            FTextureRHIRef Source;
            if (Format == PF_DepthStencil)
            {
                Source = Cmd.CreateTexture(
                    FRHITextureCreateDesc::Create2D(TEXT("DepthAtlasProbe"), 4, 4, Format)
                        .SetFlags(ETextureCreateFlags::DepthStencilTargetable | ETextureCreateFlags::ShaderResource)
                        .SetInitialState(ERHIAccess::DSVWrite)
                        .SetClearValue(FClearValueBinding(0.25f, 0)));
                RHI.RHIBeginRenderPass(
                    FRHIRenderPassInfo(Source, EDepthStencilTargetActions::ClearDepthStencil_StoreDepthStencil),
                    TEXT("DepthAtlasClear"));
                RHI.RHIEndRenderPass();
                Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::DSVWrite, ERHIAccess::SRVGraphicsPixel));
            }
            else
            {
                auto Upload = Cmd.CreateTextureInitializer(
                    FRHITextureCreateDesc::Create2D(TEXT("UNorm16AtlasProbe"), 4, 4, Format)
                        .SetFlags(ETextureCreateFlags::ShaderResource)
                        .SetInitialState(ERHIAccess::SRVGraphicsPixel)
                        .SetInitActionInitializer());
                const auto Row = Upload.GetTexture2DSubresource(0);
                for (uint32 Offset = 0; Offset < Row.Size; Offset += 2)
                {
                    const uint16 Value = 32768;
                    FMemory::Memcpy(static_cast<uint8 *>(Row.Data) + Offset, &Value, 2);
                }
                Source = Upload.Finalize();
            }
            auto Target = WebGPUProbe::Target(RHI, Cmd, 4, 4);
            SampleData.Resources.Add(0, Source.GetReference());
            SampleData.Resources.Add(1, Sampler.GetReference());
            SampleData.InvalidateGroups(1);
            RHI.RHIBeginRenderPass(FRHIRenderPassInfo(Target, ERenderTargetActions::Clear_Store),
                                   TEXT("DepthAtlasSample"));
            RHI.RHISetViewport(0, 0, 0, 4, 4, 1);
            RHI.RHISetGraphicsPipelineState(SamplePipeline, 0, false);
            RHI.RHIDrawIndexedPrimitiveIndirect(Index, Indirect, 0);
            RHI.RHIEndRenderPass();
            Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::RTV, ERHIAccess::CopySrc));
            RHI.SubmitCurrent();
            TArray<FColor> Colors;
            RHI.RHIReadSurfaceData(Target, FIntRect(0, 0, 4, 4), Colors, WebGPUProbe::RawReadback());
            bool OK = Colors.Num() == 16;
            const int32 Expected = Format == PF_DepthStencil ? 64 : 128;
            for (const auto Color : Colors)
                OK &= FMath::Abs(int32(Color.R) - Expected) <= 1 && Color.R == Color.G && Color.G == Color.B &&
                      Color.A == 255;
            auto Case = MakeShared<FJsonObject>();
            Case->SetNumberField(TEXT("format"), Format);
            Case->SetStringField(TEXT("binding"), BindingName);
            Case->SetNumberField(TEXT("checkedPixels"), Colors.Num());
            Case->SetBoolField(TEXT("pass"), OK);
            DepthCases.Add(MakeShared<FJsonValueObject>(Case));
            Pass &= OK;
            SampleData.Resources.Reset();
        }
    }
    return Pass;
}
