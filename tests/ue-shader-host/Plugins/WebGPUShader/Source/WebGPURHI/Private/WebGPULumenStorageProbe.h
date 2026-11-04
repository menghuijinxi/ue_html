#pragma once

#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"
#include "WebGPUUAVRasterProbe.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"
#include "Math/Float16.h"

inline bool RunWebGPULumenStorageProbe(IDynamicRHIModule& Module, const FString& Output)
{
    bool Success = false;
    IFileManager::Get().MakeDirectory(*Output, true);
    ENQUEUE_RENDER_COMMAND(WebLumenStorageProbe)([&](FRHICommandListImmediate& Cmd) {
        FWebGPUGlobalScope Scope(Module);
        auto& RHI = *Scope.RHI;
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
            ERHISubmitFlags::EnableBypass);
        const auto ReadTexture = [&](FRHITexture* Texture) {
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
            auto Buffer = RHI.CreateBuffer(256, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
            if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            auto Source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            Source.texture = static_cast<FWebGPUTexture*>(Texture)->Handle;
            auto Destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            Destination.buffer = Buffer;
            Destination.layout.bytesPerRow = 256;
            Destination.layout.rowsPerImage = 1;
            const WGPUExtent3D Extent{1, 1, 1};
            wgpuCommandEncoderCopyTextureToBuffer(RHI.Encoder, &Source, &Destination, &Extent);
            RHI.SubmitCurrent();
            auto Result = RHI.MapBuffer(Buffer, 256);
            wgpuBufferRelease(Buffer);
            return Result;
        };
        TArray<TSharedPtr<FJsonValue>> Cases;
        TArray<TSharedPtr<FJsonValue>> VolumeCases;
        TArray<TSharedPtr<FJsonValue>> BufferCases;
        TArray<TSharedPtr<FJsonValue>> UniformCases;
        bool Pass = true;
        {
            TRefCountPtr<FWebGPUComputeShader> Shader = new FWebGPUComputeShader;
            auto& Data = Shader->Data;
            Data.Owner = Shader;
            Data.Frequency = SF_Compute;
            Data.Entry = TEXT("main");
            Data.StorageFormatSource = TEXT(
                "@group(0) @binding(0) var Lighting: texture_storage_2d<rgba32float, write>;\n"
                "@group(0) @binding(1) var Mask: texture_storage_2d<rgba32float, write>;\n"
                "@group(0) @binding(2) var<storage, read_write> Result: array<vec4f>;\n"
                "@compute @workgroup_size(1) fn main() {\n"
                "textureStore(Lighting, vec2i(0), vec4f(0.25, 0.5, 1, 0.75));\n"
                "textureStore(Mask, vec2i(0), vec4f(0.5));\n"
                "Result[0] = vec4f(123);\n"
                "Result[1] = vec4f(456);\n"
                "}\n");
            Data.Metadata = MakeShared<FJsonObject>();
            Data.Metadata->SetNumberField(TEXT("frequency"), SF_Compute);
            TArray<TSharedPtr<FJsonValue>> Bindings, Reflected;
            for (uint32 Index = 0; Index < 3; ++Index)
            {
                auto Binding = MakeShared<FJsonObject>();
                Binding->SetStringField(TEXT("name"), Index == 0 ? TEXT("Lighting") : Index == 1 ? TEXT("Mask") : TEXT("Result"));
                Binding->SetNumberField(TEXT("group"), 0);
                Binding->SetNumberField(TEXT("binding"), Index);
                Binding->SetNumberField(TEXT("descriptorType"), Index < 2 ? 3 : 7);
                Binding->SetBoolField(TEXT("readOnlyStorage"), false);
                Binding->SetNumberField(TEXT("storageElementStride"), 16);
                Binding->SetNumberField(TEXT("textureDimension"), 1);
                Binding->SetBoolField(TEXT("textureArrayed"), false);
                Binding->SetNumberField(TEXT("storageImageFormat"), 1);
                Binding->SetStringField(TEXT("storageTextureAccess"), TEXT("write"));
                Bindings.Add(MakeShared<FJsonValueObject>(Binding));
                auto WebBinding = MakeShared<FJsonObject>();
                WebBinding->SetNumberField(TEXT("group"), 0);
                WebBinding->SetNumberField(TEXT("binding"), Index);
                WebBinding->SetStringField(TEXT("resource_type"), Index < 2 ? TEXT("ReadWriteStorageTexture") : TEXT("StorageBuffer"));
                Reflected.Add(MakeShared<FJsonValueObject>(WebBinding));
                FWebGPUShaderBinding Entry;
                Entry.Metadata = &Binding.Get();
                Entry.Name = Binding->GetStringField(TEXT("name"));
                Entry.Descriptor = Index < 2 ? 3 : 7;
                Entry.Index = Index;
                Entry.Reflected = true;
                Entry.TextureDimension = 1;
                Entry.StorageImageFormat = 1;
                Entry.StorageTextureAccess = TEXT("write");
                Entry.StorageContract.ReadOnlyValid = true;
                Entry.StorageContract.StrideValid = true;
                Entry.StorageContract.Stride = 16;
                Entry.RouteInitialized = true;
                Entry.Route.Index = Index;
                if (Index < 2)
                {
                    Entry.StorageFormatOffset = Data.StorageFormatSource.Find(TEXT("rgba32float"),
                        ESearchCase::CaseSensitive, ESearchDir::FromStart,
                        Index ? Data.Bindings[0].StorageFormatOffset + 11 : 0);
                    Entry.StorageFormatLength = 11;
                }
                Data.Bindings.Add(MoveTemp(Entry));
            }
            Data.GroupVersions.Init(1, 1);
            Data.Metadata->SetArrayField(TEXT("spirvBindings"), Bindings);
            auto Entry = MakeShared<FJsonObject>();
            Entry->SetArrayField(TEXT("bindings"), Reflected);
            auto Reflection = MakeShared<FJsonObject>();
            Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(Entry)});
            Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
            Shader->InitResourceTable();
            auto Pipeline = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Shader));
            for (const auto Format : {PF_FloatR11G11B10, PF_FloatRGBA, PF_A32B32G32R32F,
                PF_FloatR11G11B10, PF_R16F, PF_R8G8, PF_R8, PF_G16, PF_A2B10G10R10})
            {
                auto Lighting = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("LumenStorageLighting"), 1, 1, Format)
                    .SetFlags(ETextureCreateFlags::UAV | ETextureCreateFlags::ShaderResource).SetInitialState(ERHIAccess::UAVCompute));
                auto Mask = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("LumenStorageMask"), 1, 1, PF_R8)
                    .SetFlags(ETextureCreateFlags::UAV | ETextureCreateFlags::ShaderResource).SetInitialState(ERHIAccess::UAVCompute));
                auto LightingUAV = Cmd.CreateUnorderedAccessView(Lighting, FRHIViewDesc::CreateTextureUAV()
                    .SetDimension(ETextureDimension::Texture2D));
                auto MaskUAV = Cmd.CreateUnorderedAccessView(Mask, FRHIViewDesc::CreateTextureUAV()
                    .SetDimension(ETextureDimension::Texture2D));
                const FVector4f Zero[2] = {FVector4f(0), FVector4f(0)};
                auto Sink = WebGPUProbe::Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateStructured(
                    TEXT("LumenStorageReadback"), sizeof(Zero), 16).AddUsage(BUF_UnorderedAccess)
                    .SetInitialState(ERHIAccess::UAVCompute), Zero, sizeof(Zero));
                auto SinkUAV = Cmd.CreateUnorderedAccessView(Sink, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Sink));
                Data.Resources.Add(0, LightingUAV.GetReference());
                Data.Resources.Add(1, MaskUAV.GetReference());
                Data.Resources.Add(2, SinkUAV.GetReference());
                Data.InvalidateGroups(1);
                RHI.RHISetComputePipelineState(Pipeline);
                RHI.RHIDispatchComputeShader(1, 1, 1);
                const auto Bytes = RHI.ReadBuffer(Sink, sizeof(Zero));
                FVector4f Actual[2] = {FVector4f(0), FVector4f(0)};
                bool OK = Bytes.Num() == sizeof(Actual);
                if (OK) FMemory::Memcpy(Actual, Bytes.GetData(), sizeof(Actual));
                for (int32 Component = 0; Component < 4; ++Component)
                    OK &= Actual[0][Component] == 123 && Actual[1][Component] == 456;
                const auto LightingBytes = ReadTexture(Lighting), MaskBytes = ReadTexture(Mask);
                TArray<uint8> Expected;
                const auto Append = [&](const auto& Value) {
                    Expected.Append(reinterpret_cast<const uint8*>(&Value), sizeof(Value));
                };
                if (Format == PF_FloatR11G11B10) Append((13u << 6) | (14u << 17) | (15u << 27));
                else if (Format == PF_FloatRGBA || Format == PF_R16F)
                {
                    for (float Value : {0.25f, 0.5f, 1.0f, 0.75f})
                    {
                        Append(FFloat16(Value).Encoded);
                        if (Format == PF_R16F) break;
                    }
                }
                else if (Format == PF_A32B32G32R32F)
                    for (float Value : {0.25f, 0.5f, 1.0f, 0.75f}) Append(Value);
                else if (Format == PF_G16) Append(uint16(16384));
                else if (Format == PF_A2B10G10R10) Append(256u | (512u << 10) | (1023u << 20) | (2u << 30));
                else
                {
                    Expected.Add(64);
                    if (Format == PF_R8G8) Expected.Add(128);
                }
                bool LightingMatches = LightingBytes.Num() >= Expected.Num();
                if (LightingMatches)
                {
                    if (Format == PF_G16)
                    {
                        uint16 ActualUNorm = 0;
                        FMemory::Memcpy(&ActualUNorm, LightingBytes.GetData(), sizeof(ActualUNorm));
                        LightingMatches = FMath::Abs(int32(ActualUNorm) - 16384) <= 1;
                    }
                    else if (Format == PF_A2B10G10R10)
                    {
                        uint32 ActualPacked = 0;
                        FMemory::Memcpy(&ActualPacked, LightingBytes.GetData(), sizeof(ActualPacked));
                        LightingMatches = FMath::Abs(int32(ActualPacked & 1023) - 256) <= 1 &&
                            FMath::Abs(int32((ActualPacked >> 10) & 1023) - 512) <= 1 &&
                            ((ActualPacked >> 20) & 1023) == 1023 && (ActualPacked >> 30) == 2;
                    }
                    else
                    {
                        const int32 Tolerance = Format == PF_R8 || Format == PF_R8G8 ? 1 : 0;
                        for (int32 Byte = 0; Byte < Expected.Num(); ++Byte)
                            LightingMatches &= FMath::Abs(int32(LightingBytes[Byte]) - int32(Expected[Byte])) <= Tolerance;
                    }
                }
                // UNORM conversions may round half a quantization step in either direction.
                OK &= LightingMatches && MaskBytes.Num() > 0 && FMath::Abs(int32(MaskBytes[0]) - 128) <= 1;
                Cmd.Transition(FRHITransitionInfo(Lighting, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
                RHI.RHIClearUAVFloat(LightingUAV, FVector4f(0, 0, 0, 0));
                const auto ClearedBytes = ReadTexture(Lighting);
                bool ClearMatches = ClearedBytes.Num() >= Expected.Num();
                for (int32 Byte = 0; Byte < Expected.Num() && ClearMatches; ++Byte)
                    ClearMatches &= ClearedBytes[Byte] == 0;
                OK &= ClearMatches;
                auto Case = MakeShared<FJsonObject>();
                Case->SetNumberField(TEXT("format"), Format);
                Case->SetBoolField(TEXT("pass"), OK);
                Case->SetStringField(TEXT("actualBytes"), BytesToHex(LightingBytes.GetData(),
                    FMath::Min(LightingBytes.Num(), Expected.Num())));
                Case->SetStringField(TEXT("expectedBytes"), BytesToHex(Expected.GetData(), Expected.Num()));
                Case->SetNumberField(TEXT("mask"), MaskBytes.Num() ? MaskBytes[0] : -1);
                Case->SetNumberField(TEXT("bufferFirst"), Actual[0].X);
                Case->SetNumberField(TEXT("bufferSecond"), Actual[1].X);
                Case->SetBoolField(TEXT("clearPass"), ClearMatches);
                Cases.Add(MakeShared<FJsonValueObject>(Case));
                Pass &= OK;
            }
            Pass &= RHI.ComputePipelinesCreated == 8 &&
                static_cast<FWebGPUComputePipeline*>(Pipeline.GetReference())->FormatVariants.Num() == 8;
            Data.Resources.Reset();
        }
        {
            TRefCountPtr<FWebGPUComputeShader> Shader = new FWebGPUComputeShader;
            auto& Data = Shader->Data;
            Data.Owner = Shader;
            Data.Frequency = SF_Compute;
            Data.Entry = TEXT("main");
            const char* Source =
                "@group(0) @binding(0) var Output: texture_storage_2d<rg16uint, write>;"
                "@compute @workgroup_size(1) fn main() {"
                "textureStore(Output, vec2i(0), vec4u(1, 32768, 0, 0)); }";
            auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
            WGSL.code = {Source, WGPU_STRLEN};
            auto ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
            ModuleDesc.nextInChain = &WGSL.chain;
            Data.Module = wgpuDeviceCreateShaderModule(RHI.Device, &ModuleDesc);
            Data.Metadata = MakeShared<FJsonObject>();
            Data.Metadata->SetNumberField(TEXT("frequency"), SF_Compute);
            auto Binding = MakeShared<FJsonObject>();
            Binding->SetStringField(TEXT("name"), TEXT("Output"));
            Binding->SetNumberField(TEXT("group"), 0);
            Binding->SetNumberField(TEXT("binding"), 0);
            Binding->SetNumberField(TEXT("descriptorType"), 3);
            Binding->SetNumberField(TEXT("storageImageFormat"), 36);
            Binding->SetStringField(TEXT("storageTextureAccess"), TEXT("write"));
            Binding->SetNumberField(TEXT("textureDimension"), 1);
            Binding->SetBoolField(TEXT("textureArrayed"), false);
            FWebGPUShaderBinding Entry;
            Entry.Metadata = &Binding.Get();
            Entry.Name = TEXT("Output");
            Entry.Descriptor = 3;
            Entry.Reflected = true;
            Entry.TextureDimension = 1;
            Entry.StorageImageFormat = 36;
            Entry.StorageTextureAccess = TEXT("write");
            Entry.RouteInitialized = true;
            Data.Bindings.Add(Entry);
            Data.GroupVersions.Init(1, 1);
            Data.Metadata->SetArrayField(TEXT("spirvBindings"), {MakeShared<FJsonValueObject>(Binding)});
            auto ReflectedBinding = MakeShared<FJsonObject>();
            ReflectedBinding->SetNumberField(TEXT("group"), 0);
            ReflectedBinding->SetNumberField(TEXT("binding"), 0);
            ReflectedBinding->SetStringField(TEXT("resource_type"), TEXT("ReadWriteStorageTexture"));
            auto ReflectedEntry = MakeShared<FJsonObject>();
            ReflectedEntry->SetArrayField(TEXT("bindings"), {MakeShared<FJsonValueObject>(ReflectedBinding)});
            auto Reflection = MakeShared<FJsonObject>();
            Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(ReflectedEntry)});
            Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
            Shader->InitResourceTable();
            auto Texture = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("LumenUIntHistory"), 1, 1, PF_R16G16_UINT)
                .SetFlags(ETextureCreateFlags::UAV | ETextureCreateFlags::ShaderResource).SetInitialState(ERHIAccess::UAVCompute));
            auto UAV = Cmd.CreateUnorderedAccessView(Texture, FRHIViewDesc::CreateTextureUAV()
                .SetDimension(ETextureDimension::Texture2D));
            Data.Resources.Add(0, UAV.GetReference());
            auto Pipeline = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Shader));
            RHI.RHISetComputePipelineState(Pipeline);
            RHI.RHIDispatchComputeShader(1, 1, 1);
            const auto Bytes = ReadTexture(Texture);
            const uint16 Expected[] = {1, 32768};
            bool OK = Bytes.Num() >= sizeof(Expected) &&
                FMemory::Memcmp(Bytes.GetData(), Expected, sizeof(Expected)) == 0;
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
            RHI.RHIClearUAVUint(UAV, FUintVector4(0));
            const auto Cleared = ReadTexture(Texture);
            bool ClearOK = Cleared.Num() >= sizeof(Expected);
            for (uint32 Index = 0; Index < sizeof(Expected) && ClearOK; ++Index)
                ClearOK &= Cleared[Index] == 0;
            OK &= ClearOK && RHI.ComputePipelinesCreated == 9;
            auto Case = MakeShared<FJsonObject>();
            Case->SetNumberField(TEXT("format"), PF_R16G16_UINT);
            Case->SetBoolField(TEXT("pass"), OK);
            Case->SetBoolField(TEXT("clearPass"), ClearOK);
            Case->SetStringField(TEXT("actualBytes"), BytesToHex(Bytes.GetData(), FMath::Min(Bytes.Num(), 4)));
            Cases.Add(MakeShared<FJsonValueObject>(Case));
            Pass &= OK;
            Data.Resources.Reset();
        }
        {
            uint8 Expected[64];
            for (uint32 Index = 0; Index < 64; ++Index) Expected[Index] = uint8(Index * 73 + 17);
            auto Desc = FRHITextureCreateDesc::Create3D(TEXT("LumenUIntVolume"), 4, 4, 4, PF_R8_UINT)
                .SetFlags(ETextureCreateFlags::ShaderResource).SetInitialState(ERHIAccess::SRVCompute)
                .SetInitActionInitializer();
            auto Initializer = Cmd.CreateTextureInitializer(Desc);
            auto Subresource = Initializer.GetTexture3DSubresource(0);
            bool OK = Subresource.Size == sizeof(Expected) && Subresource.Stride == 4;
            Subresource.WriteData(Expected, sizeof(Expected));
            auto Texture = Initializer.Finalize();
            auto SRV = Cmd.CreateShaderResourceView(Texture,
                FRHIViewDesc::CreateTextureSRV().SetDimension(ETextureDimension::Texture3D));
            FJsonObject Binding;
            Binding.SetNumberField(TEXT("textureDimension"), 2);
            Binding.SetBoolField(TEXT("textureArrayed"), false);
            Binding.SetBoolField(TEXT("textureMultisampled"), false);
            Binding.SetStringField(TEXT("textureSampleType"), TEXT("uint"));
            FString Error;
            OK &= RHI.ValidateTextureBinding(Texture, Binding, ERHIAccess::SRVCompute, Error) &&
                RHI.ValidateTextureBinding(SRV, Binding, ERHIAccess::SRVCompute, Error);
            Binding.SetStringField(TEXT("textureSampleType"), TEXT("float"));
            OK &= !RHI.ValidateTextureBinding(SRV, Binding, ERHIAccess::SRVCompute, Error);
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::SRVCompute, ERHIAccess::CopySrc));
            auto Buffer = RHI.CreateBuffer(4096, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
            if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            auto Source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            Source.texture = static_cast<FWebGPUTexture*>(Texture.GetReference())->Handle;
            auto Destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            Destination.buffer = Buffer;
            Destination.layout.bytesPerRow = 256;
            Destination.layout.rowsPerImage = 4;
            const WGPUExtent3D Extent{4, 4, 4};
            wgpuCommandEncoderCopyTextureToBuffer(RHI.Encoder, &Source, &Destination, &Extent);
            RHI.SubmitCurrent();
            const auto Bytes = RHI.MapBuffer(Buffer, 4096);
            wgpuBufferRelease(Buffer);
            OK &= Bytes.Num() == 4096;
            for (uint32 Index = 0; Index < 64 && OK; ++Index)
                OK &= Bytes[(Index / 4) * 256 + Index % 4] == Expected[Index];
            auto Case = MakeShared<FJsonObject>();
            Case->SetNumberField(TEXT("format"), PF_R8_UINT);
            Case->SetNumberField(TEXT("checkedTexels"), 64);
            Case->SetBoolField(TEXT("pass"), OK);
            VolumeCases.Add(MakeShared<FJsonValueObject>(Case));
            Pass &= OK;
        }
        {
            TRefCountPtr<FWebGPUComputeShader> Shader = new FWebGPUComputeShader;
            auto& Data = Shader->Data;
            Data.Owner = Shader;
            Data.Frequency = SF_Compute;
            Data.Entry = TEXT("main");
            const char* Source =
                "@group(0) @binding(0) var<storage, read> Input: array<vec2u>;"
                "@group(0) @binding(1) var<storage, read_write> Output: array<vec2u>;"
                "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {"
                "if (id.x < 64u) { Output[id.x] = Input[id.x].yx ^ vec2u(0x80000000u, 0x12345678u); } }";
            auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
            WGSL.code = {Source, WGPU_STRLEN};
            auto ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
            ModuleDesc.nextInChain = &WGSL.chain;
            Data.Module = wgpuDeviceCreateShaderModule(RHI.Device, &ModuleDesc);
            Data.Metadata = MakeShared<FJsonObject>();
            Data.Metadata->SetNumberField(TEXT("frequency"), SF_Compute);
            TArray<TSharedPtr<FJsonValue>> Bindings, Reflected;
            for (uint32 Index = 0; Index < 2; ++Index)
            {
                auto Binding = MakeShared<FJsonObject>();
                Binding->SetStringField(TEXT("name"), Index ? TEXT("Output") : TEXT("Input"));
                Binding->SetNumberField(TEXT("group"), 0);
                Binding->SetNumberField(TEXT("binding"), Index);
                Binding->SetNumberField(TEXT("descriptorType"), 7);
                Binding->SetBoolField(TEXT("readOnlyStorage"), Index == 0);
                Binding->SetNumberField(TEXT("storageElementStride"), 8);
                Binding->SetNumberField(TEXT("storageElementFormat"), PF_R32G32_UINT);
                Bindings.Add(MakeShared<FJsonValueObject>(Binding));
                FWebGPUShaderBinding Entry;
                Entry.Metadata = &Binding.Get();
                Entry.Name = Binding->GetStringField(TEXT("name"));
                Entry.Descriptor = 7;
                Entry.Index = Index;
                Entry.Reflected = true;
                Entry.StorageContract.ReadOnlyValid = true;
                Entry.StorageContract.ReadOnly = Index == 0;
                Entry.StorageContract.FormatValid = true;
                Entry.StorageContract.Format = PF_R32G32_UINT;
                Entry.StorageContract.StrideValid = true;
                Entry.StorageContract.Stride = 8;
                Entry.RouteInitialized = true;
                Entry.Route.Index = Index;
                Data.Bindings.Add(Entry);
                auto WebBinding = MakeShared<FJsonObject>();
                WebBinding->SetNumberField(TEXT("group"), 0);
                WebBinding->SetNumberField(TEXT("binding"), Index);
                WebBinding->SetStringField(TEXT("resource_type"), Index ? TEXT("StorageBuffer") : TEXT("ReadOnlyStorageBuffer"));
                Reflected.Add(MakeShared<FJsonValueObject>(WebBinding));
            }
            Data.GroupVersions.Init(1, 1);
            Data.Metadata->SetArrayField(TEXT("spirvBindings"), Bindings);
            auto ReflectedEntry = MakeShared<FJsonObject>();
            ReflectedEntry->SetArrayField(TEXT("bindings"), Reflected);
            auto Reflection = MakeShared<FJsonObject>();
            Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(ReflectedEntry)});
            Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
            Shader->InitResourceTable();
            uint32 Input[256], Expected[256];
            for (uint32 Index = 0; Index < 256; ++Index)
            {
                Input[Index] = Index * 2654435761u;
                Expected[Index] = 0xcafebabeu;
            }
            auto InputBuffer = WebGPUProbe::Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(
                TEXT("LumenUInt2Source"), sizeof(Input), 8, BUF_ShaderResource)
                .SetInitialState(ERHIAccess::SRVCompute), Input, sizeof(Input));
            auto OutputBuffer = WebGPUProbe::Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(
                TEXT("LumenUInt2Output"), sizeof(Expected), 8, BUF_UnorderedAccess | BUF_ShaderResource)
                .SetInitialState(ERHIAccess::UAVCompute), Expected, sizeof(Expected));
            auto SRV = Cmd.CreateShaderResourceView(InputBuffer, FRHIViewDesc::CreateBufferSRV()
                .SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32G32_UINT)
                .SetOffsetInBytes(256).SetNumElements(64));
            auto UAV = Cmd.CreateUnorderedAccessView(OutputBuffer, FRHIViewDesc::CreateBufferUAV()
                .SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32G32_UINT)
                .SetOffsetInBytes(256).SetNumElements(64));
            FString Error;
            auto WrongUAV = *Bindings[1]->AsObject(), WrongSRV = *Bindings[0]->AsObject();
            WrongUAV.SetNumberField(TEXT("storageElementFormat"), PF_R32_UINT);
            WrongSRV.SetNumberField(TEXT("storageElementFormat"), PF_R32_UINT);
            bool OK = !RHI.ValidateStorageUAVBinding(UAV, WrongUAV, ERHIAccess::UAVCompute, Error) &&
                !RHI.ValidateStorageSRVBinding(SRV, WrongSRV, ERHIAccess::SRVCompute, Error);
            auto Unaligned = UAV->GetDesc();
            Unaligned.Buffer.UAV.OffsetInBytes = 8;
            OK &= !RHI.ValidateUAV(OutputBuffer, Unaligned, Error);
            const auto Info = UAV->GetDesc().Buffer.UAV.GetViewInfo(OutputBuffer);
            OK &= Info.StrideInBytes == 8 && Info.NumElements == 64 && Info.OffsetInBytes == 256;
            Data.Resources.Add(0, SRV.GetReference());
            Data.Resources.Add(1, UAV.GetReference());
            auto Pipeline = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Shader));
            RHI.RHISetComputePipelineState(Pipeline);
            RHI.RHIDispatchComputeShader(1, 1, 1);
            for (uint32 Index = 64; Index < 192; Index += 2)
            {
                Expected[Index] = Input[Index + 1] ^ 0x80000000u;
                Expected[Index + 1] = Input[Index] ^ 0x12345678u;
            }
            const auto Check = [&] {
                Cmd.Transition(FRHITransitionInfo(OutputBuffer, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
                const auto Bytes = RHI.ReadBuffer(OutputBuffer, sizeof(Expected));
                return Bytes.Num() == sizeof(Expected) &&
                    FMemory::Memcmp(Bytes.GetData(), Expected, sizeof(Expected)) == 0;
            };
            OK &= Check();
            for (const uint32 Value : {11u, 0u})
            {
                Cmd.Transition(FRHITransitionInfo(OutputBuffer, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
                RHI.RHIClearUAVUint(UAV, Value ? FUintVector4(11, 22, 33, 44) : FUintVector4(0));
                for (uint32 Index = 64; Index < 192; Index += 2)
                {
                    Expected[Index] = Value;
                    Expected[Index + 1] = Value ? 22u : 0u;
                }
                OK &= Check();
            }
            auto Case = MakeShared<FJsonObject>();
            Case->SetNumberField(TEXT("format"), PF_R32G32_UINT);
            Case->SetNumberField(TEXT("checkedValues"), 256 * 3);
            Case->SetBoolField(TEXT("pass"), OK);
            BufferCases.Add(MakeShared<FJsonValueObject>(Case));
            Pass &= OK;
            Data.Resources.Reset();
        }
        {
            TRefCountPtr<FWebGPUComputeShader> Shader = new FWebGPUComputeShader;
            auto& Data = Shader->Data;
            Data.Owner = Shader;
            Data.Frequency = SF_Compute;
            Data.Entry = TEXT("main");
            const char* Source =
                "@group(0) @binding(0) var<uniform> Sky: vec4f;"
                "@group(0) @binding(1) var<storage, read_write> Output: array<vec4f>;"
                "@compute @workgroup_size(1) fn main() { Output[0] = Sky * vec4f(2, 3, 4, 5); }";
            auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
            WGSL.code = {Source, WGPU_STRLEN};
            auto ModuleDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
            ModuleDesc.nextInChain = &WGSL.chain;
            Data.Module = wgpuDeviceCreateShaderModule(RHI.Device, &ModuleDesc);
            Data.Metadata = MakeShared<FJsonObject>();
            Data.Metadata->SetNumberField(TEXT("frequency"), SF_Compute);
            TArray<TSharedPtr<FJsonValue>> Bindings, Reflected;
            for (uint32 Index = 0; Index < 2; ++Index)
            {
                auto Binding = MakeShared<FJsonObject>();
                Binding->SetStringField(TEXT("name"), Index ? TEXT("Output") : TEXT("View_DistantSkyLightLutBufferSRV"));
                Binding->SetNumberField(TEXT("group"), 0);
                Binding->SetNumberField(TEXT("binding"), Index);
                Binding->SetNumberField(TEXT("descriptorType"), 7);
                Binding->SetBoolField(TEXT("readOnlyStorage"), Index == 0);
                Binding->SetNumberField(TEXT("storageElementStride"), 16);
                Binding->SetNumberField(TEXT("storageElementFormat"), PF_A32B32G32R32F);
                if (!Index) Binding->SetNumberField(TEXT("storageUniformBytes"), 16);
                Bindings.Add(MakeShared<FJsonValueObject>(Binding));
                FWebGPUShaderBinding Entry;
                Entry.Metadata = &Binding.Get();
                Entry.Name = Binding->GetStringField(TEXT("name"));
                Entry.Descriptor = 7;
                Entry.Index = Index;
                Entry.Reflected = true;
                Entry.SingleVectorUniform = Index == 0;
                Entry.StorageContract.ReadOnlyValid = true;
                Entry.StorageContract.ReadOnly = Index == 0;
                Entry.StorageContract.FormatValid = true;
                Entry.StorageContract.Format = PF_A32B32G32R32F;
                Entry.StorageContract.StrideValid = true;
                Entry.StorageContract.Stride = 16;
                Entry.RouteInitialized = true;
                Entry.Route.Index = Index;
                Data.Bindings.Add(Entry);
                auto WebBinding = MakeShared<FJsonObject>();
                WebBinding->SetNumberField(TEXT("group"), 0);
                WebBinding->SetNumberField(TEXT("binding"), Index);
                WebBinding->SetStringField(TEXT("resource_type"), Index ? TEXT("StorageBuffer") : TEXT("UniformBuffer"));
                Reflected.Add(MakeShared<FJsonValueObject>(WebBinding));
            }
            Data.GroupVersions.Init(1, 1);
            Data.Metadata->SetArrayField(TEXT("spirvBindings"), Bindings);
            auto ReflectedEntry = MakeShared<FJsonObject>();
            ReflectedEntry->SetArrayField(TEXT("bindings"), Reflected);
            auto Reflection = MakeShared<FJsonObject>();
            Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(ReflectedEntry)});
            Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
            Shader->InitResourceTable();
            const float Initial[4]{0.25f, 0.5f, 1.0f, 0.75f};
            auto SkyBuffer = WebGPUProbe::Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(
                TEXT("SkyAtmosphere.DistantSkyLightLutBuffer"), 16, 16, BUF_ShaderResource | BUF_UnorderedAccess | BUF_StructuredBuffer)
                .SetInitialState(ERHIAccess::SRVCompute), Initial, sizeof(Initial));
            auto ResultBuffer = WebGPUProbe::Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(
                TEXT("SkyUniformResult"), 16, 16, BUF_ShaderResource | BUF_UnorderedAccess)
                .SetInitialState(ERHIAccess::UAVCompute), Initial, sizeof(Initial));
            auto SRV = Cmd.CreateShaderResourceView(SkyBuffer, FRHIViewDesc::CreateBufferSRV()
                .SetType(FRHIViewDesc::EBufferType::Structured));
            auto SkyUAV = Cmd.CreateUnorderedAccessView(SkyBuffer, FRHIViewDesc::CreateBufferUAV()
                .SetType(FRHIViewDesc::EBufferType::Structured));
            auto UAV = Cmd.CreateUnorderedAccessView(ResultBuffer, FRHIViewDesc::CreateBufferUAV()
                .SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_A32B32G32R32F));
            Data.Resources.Add(0, SRV.GetReference());
            Data.Resources.Add(1, UAV.GetReference());
            auto Pipeline = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Shader));
            bool OK = true;
            for (uint32 Round = 0; Round < 2; ++Round)
            {
                if (Round)
                {
                    Cmd.Transition(FRHITransitionInfo(ResultBuffer, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
                    Cmd.Transition(FRHITransitionInfo(SkyBuffer, ERHIAccess::SRVCompute, ERHIAccess::UAVCompute));
                    RHI.RHIClearUAVFloat(SkyUAV, FVector4f(3, 5, 7, 9));
                    Cmd.Transition(FRHITransitionInfo(SkyBuffer, ERHIAccess::UAVCompute, ERHIAccess::SRVCompute));
                }
                RHI.RHISetComputePipelineState(Pipeline);
                RHI.RHIDispatchComputeShader(1, 1, 1);
                Cmd.Transition(FRHITransitionInfo(ResultBuffer, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
                const auto Bytes = RHI.ReadBuffer(ResultBuffer, 16);
                const float Updated[4]{3, 5, 7, 9};
                float Expected[4];
                for (uint32 Index = 0; Index < 4; ++Index)
                    Expected[Index] = (Round ? Updated[Index] : Initial[Index]) * float(Index + 2);
                OK &= Bytes.Num() == 16 && FMemory::Memcmp(Bytes.GetData(), Expected, 16) == 0;
            }
            auto Case = MakeShared<FJsonObject>();
            Case->SetNumberField(TEXT("checkedValues"), 8);
            Case->SetBoolField(TEXT("gpuWriteThenUniformRead"), true);
            Case->SetBoolField(TEXT("pass"), OK);
            UniformCases.Add(MakeShared<FJsonValueObject>(Case));
            Pass &= OK;
            Data.Resources.Reset();
        }
        TArray<TSharedPtr<FJsonValue>> RasterCases;
        TArray<TSharedPtr<FJsonValue>> DepthAtlasCases;
        Pass &= RunWebGPUUAVRasterCases(RHI, Cmd, RasterCases, DepthAtlasCases);
        Scope.PrepareShutdown();
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass && RHI.Errors.IsEmpty());
        Report->SetNumberField(TEXT("pipelines"), RHI.ComputePipelinesCreated);
        Report->SetArrayField(TEXT("cases"), Cases);
        Report->SetArrayField(TEXT("volumeCases"), VolumeCases);
        Report->SetArrayField(TEXT("bufferCases"), BufferCases);
        Report->SetArrayField(TEXT("uniformCases"), UniformCases);
        Report->SetArrayField(TEXT("rasterCases"), RasterCases);
        Report->SetArrayField(TEXT("depthAtlasCases"), DepthAtlasCases);
        TArray<TSharedPtr<FJsonValue>> Errors;
        for (const auto& Error : RHI.Errors) Errors.Add(MakeShared<FJsonValueString>(Error));
        Report->SetArrayField(TEXT("errors"), Errors);
        Success = Report->GetBoolField(TEXT("pass"));
        Scope.Restore();
        FString Json;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
        check(FFileHelper::SaveStringToFile(Json, *(Output / TEXT("lumen-storage-rhi.json"))));
    });
    FlushRenderingCommands();
    return Success;
}
