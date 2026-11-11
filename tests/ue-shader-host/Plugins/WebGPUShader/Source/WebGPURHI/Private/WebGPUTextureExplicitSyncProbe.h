#pragma once

#include "WebGPUProbeUtils.h"

inline bool RunWebGPUTextureExplicitSyncCases(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd,
    TArray<TSharedPtr<FJsonValue>>& Cases)
{
    TRefCountPtr<FWebGPUComputeShader> Shaders[2];
    FComputePipelineStateRHIRef Pipelines[2];
    for (uint32 Direction = 0; Direction < 2; ++Direction)
    {
        Shaders[Direction] = new FWebGPUComputeShader;
        auto& Data = Shaders[Direction]->Data;
        Data.Owner = Shaders[Direction];
        Data.Frequency = SF_Compute;
        Data.Entry = TEXT("main");
        Data.Metadata = MakeShared<FJsonObject>();
        Data.Metadata->SetNumberField(TEXT("frequency"), SF_Compute);
        TArray<TSharedPtr<FJsonValue>> Bindings, Reflected;
        for (uint32 Index = 0; Index < 2; ++Index)
        {
            auto Binding = MakeShared<FJsonObject>();
            Binding->SetStringField(TEXT("name"), Index ? TEXT("WebShadowPoolAtomicBuffer") : TEXT("WebShadowPoolTexture"));
            Binding->SetNumberField(TEXT("group"), 0);
            Binding->SetNumberField(TEXT("binding"), Index);
            Binding->SetNumberField(TEXT("descriptorType"), Index ? 7 : 3);
            Binding->SetBoolField(TEXT("readOnlyStorage"), false);
            Binding->SetNumberField(TEXT("storageElementStride"), 4);
            if (Index) Binding->SetStringField(TEXT("storagePacking"), TEXT("texture-uint-atomic"));
            Binding->SetNumberField(TEXT("textureDimension"), 1);
            Binding->SetBoolField(TEXT("textureArrayed"), true);
            Binding->SetNumberField(TEXT("storageImageFormat"), 33);
            Binding->SetStringField(TEXT("storageTextureAccess"), TEXT("read_write"));
            Bindings.Add(MakeShared<FJsonValueObject>(Binding));
            auto WebBinding = MakeShared<FJsonObject>();
            WebBinding->SetNumberField(TEXT("group"), 0);
            WebBinding->SetNumberField(TEXT("binding"), Index);
            WebBinding->SetStringField(TEXT("resource_type"), Index ? TEXT("StorageBuffer") : TEXT("ReadWriteStorageTexture"));
            Reflected.Add(MakeShared<FJsonValueObject>(WebBinding));
            FWebGPUShaderBinding Native;
            Native.Metadata = &Binding.Get();
            Native.Name = Binding->GetStringField(TEXT("name"));
            Native.Descriptor = Index ? 7 : 3;
            Native.Index = Index;
            Native.Reflected = true;
            Native.TextureDimension = 1;
            Native.TextureArrayed = true;
            Native.StorageImageFormat = 33;
            Native.StorageTextureAccess = TEXT("read_write");
            Native.StorageContract.ReadOnlyValid = true;
            Native.StorageContract.StrideValid = true;
            Native.StorageContract.Stride = 4;
            if (Index) Native.StorageContract.Packing = FWebGPUStorageContract::EPacking::TextureUIntAtomic;
            Native.RouteInitialized = true;
            Native.Route.Index = Index;
            Data.Bindings.Add(Native);
        }
        Data.GroupVersions.Init(1, 1);
        Data.Metadata->SetArrayField(TEXT("spirvBindings"), Bindings);
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Data.Entry);
        Entry->SetArrayField(TEXT("bindings"), Reflected);
        Entry->SetArrayField(TEXT("output_variables"), {});
        auto Reflection = MakeShared<FJsonObject>();
        Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(Entry)});
        Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
        const FString Code = FString(TEXT(
            "@group(0) @binding(0) var image: texture_storage_2d_array<r32uint,read_write>;\n"
            "@group(0) @binding(1) var<storage,read_write> mirror: array<atomic<u32>>;\n"
            "@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) p: vec3u) {\n"
            "let size=textureDimensions(image); if(any(p.xy>=size)||p.z>=textureNumLayers(image)||p.x%2u!=0u){return;}\n"
            "let pitch=(size.x+63u)&~63u; let i=64u+p.x+pitch*(p.y+size.y*p.z);\n")) +
            (Direction ? TEXT("let v=atomicAdd(&mirror[i],8u)+8u; textureStore(image,p.xy,i32(p.z),vec4u(v));\n") :
                TEXT("atomicStore(&mirror[i],textureLoad(image,p.xy,i32(p.z)).x);\n")) + TEXT("}\n");
        const FTCHARToUTF8 UTF8(*Code);
        auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
        WGSL.code = {UTF8.Get(), size_t(UTF8.Length())};
        auto Module = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        Module.nextInChain = &WGSL.chain;
        Data.Module = wgpuDeviceCreateShaderModule(RHI.Device, &Module);
        Shaders[Direction]->InitResourceTable();
        Pipelines[Direction] = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Shaders[Direction]));
    }
    bool Pass = Pipelines[0].IsValid() && Pipelines[1].IsValid();
    for (const FIntVector Size : {FIntVector(5, 3, 2), FIntVector(65, 7, 3)})
    {
        auto Texture = Cmd.CreateTexture(FRHITextureCreateDesc::Create2DArray(
            TEXT("ExplicitAtomicSyncProbe"), Size.X, Size.Y, Size.Z, PF_R32_UINT)
            .SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::UAV | ETextureCreateFlags::AtomicCompatible)
            .SetInitialState(ERHIAccess::UAVCompute));
        auto UAV = Cmd.CreateUnorderedAccessView(Texture,
            FRHIViewDesc::CreateTextureUAV().SetDimension(ETextureDimension::Texture2DArray));
        for (auto& Shader : Shaders)
        {
            Shader->Data.Resources.Add(0, UAV.GetReference());
            Shader->Data.Resources.Add(1, UAV.GetReference());
            Shader->Data.InvalidateGroups(1);
        }
        bool OK = true;
        for (uint32 Round = 0; Round < 3; ++Round)
        {
            if (Round) Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
            const uint32 Clear = 9u + Round;
            RHI.RHIClearUAVUint(UAV, FUintVector4(Clear, Clear, Clear, Clear));
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::UAVCompute));
            RHI.RHISetComputePipelineState(Pipelines[0]);
            RHI.RHIDispatchComputeShader(FMath::DivideAndRoundUp(Size.X, 8), FMath::DivideAndRoundUp(Size.Y, 8), Size.Z);
            OK &= static_cast<FWebGPUTexture*>(Texture.GetReference())->AtomicMips[0].ExplicitSync;
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::UAVGraphics));
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVGraphics, ERHIAccess::UAVCompute));
            RHI.RHISetComputePipelineState(Pipelines[1]);
            RHI.RHIDispatchComputeShader(FMath::DivideAndRoundUp(Size.X, 8), FMath::DivideAndRoundUp(Size.Y, 8), Size.Z);
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
            const uint32 Pitch = Align(uint32(Size.X) * 4u, 256u);
            const uint64 Bytes = uint64(Pitch) * Size.Y * Size.Z;
            auto Readback = RHI.CreateBuffer(Bytes, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
            auto Source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            Source.texture = static_cast<FWebGPUTexture*>(Texture.GetReference())->Handle;
            auto Destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            Destination.buffer = Readback;
            Destination.layout.bytesPerRow = Pitch;
            Destination.layout.rowsPerImage = Size.Y;
            const WGPUExtent3D Extent{uint32(Size.X), uint32(Size.Y), uint32(Size.Z)};
            RHI.EndComputePass();
            wgpuCommandEncoderCopyTextureToBuffer(RHI.Encoder, &Source, &Destination, &Extent);
            RHI.SubmitCurrent();
            const auto Values = RHI.MapBuffer(Readback, Bytes);
            wgpuBufferRelease(Readback);
            OK &= uint64(Values.Num()) == Bytes;
            if (uint64(Values.Num()) == Bytes)
                for (int32 Z = 0; Z < Size.Z; ++Z)
                    for (int32 Y = 0; Y < Size.Y; ++Y)
                        for (int32 X = 0; X < Size.X; ++X)
                        {
                            uint32 Value;
                            FMemory::Memcpy(&Value, Values.GetData() + (Z * Size.Y + Y) * Pitch + X * 4, 4);
                            OK &= Value == Clear + (X % 2 ? 0u : 8u);
                        }
        }
        auto Case = MakeShared<FJsonObject>();
        Case->SetNumberField(TEXT("width"), Size.X);
        Case->SetNumberField(TEXT("height"), Size.Y);
        Case->SetNumberField(TEXT("layers"), Size.Z);
        Case->SetBoolField(TEXT("untouchedTexelsPreserved"), OK);
        Case->SetBoolField(TEXT("pass"), OK);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
        Pass &= OK;
        for (auto& Shader : Shaders) Shader->Data.Resources.Reset();
    }
    return Pass;
}
