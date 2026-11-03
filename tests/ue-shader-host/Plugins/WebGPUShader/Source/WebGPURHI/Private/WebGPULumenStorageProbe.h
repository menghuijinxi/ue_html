#pragma once

#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"
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
        TArray<TSharedPtr<FJsonValue>> Cases;
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
                PF_FloatR11G11B10, PF_R16F, PF_R8G8, PF_R8})
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
                else
                {
                    Expected.Add(64);
                    if (Format == PF_R8G8) Expected.Add(128);
                }
                bool LightingMatches = LightingBytes.Num() >= Expected.Num();
                if (LightingMatches)
                {
                    const int32 Tolerance = Format == PF_R8 || Format == PF_R8G8 ? 1 : 0;
                    for (int32 Byte = 0; Byte < Expected.Num(); ++Byte)
                        LightingMatches &= FMath::Abs(int32(LightingBytes[Byte]) - int32(Expected[Byte])) <= Tolerance;
                }
                // UNORM conversions may round half a quantization step in either direction.
                OK &= LightingMatches && MaskBytes.Num() > 0 && FMath::Abs(int32(MaskBytes[0]) - 128) <= 1;
                auto Case = MakeShared<FJsonObject>();
                Case->SetNumberField(TEXT("format"), Format);
                Case->SetBoolField(TEXT("pass"), OK);
                Case->SetStringField(TEXT("actualBytes"), BytesToHex(LightingBytes.GetData(),
                    FMath::Min(LightingBytes.Num(), Expected.Num())));
                Case->SetStringField(TEXT("expectedBytes"), BytesToHex(Expected.GetData(), Expected.Num()));
                Case->SetNumberField(TEXT("mask"), MaskBytes.Num() ? MaskBytes[0] : -1);
                Case->SetNumberField(TEXT("bufferFirst"), Actual[0].X);
                Case->SetNumberField(TEXT("bufferSecond"), Actual[1].X);
                Cases.Add(MakeShared<FJsonValueObject>(Case));
                Pass &= OK;
            }
            Pass &= RHI.ComputePipelinesCreated == 6 &&
                static_cast<FWebGPUComputePipeline*>(Pipeline.GetReference())->FormatVariants.Num() == 6;
            Data.Resources.Reset();
        }
        Scope.PrepareShutdown();
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass && RHI.Errors.IsEmpty());
        Report->SetNumberField(TEXT("pipelines"), RHI.ComputePipelinesCreated);
        Report->SetArrayField(TEXT("cases"), Cases);
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
