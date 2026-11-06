#pragma once

#include "WebGPUProbeUtils.h"

inline bool RunWebGPUTextureAtomicCases(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd,
    TArray<TSharedPtr<FJsonValue>>& Cases)
{
    TRefCountPtr<FWebGPUComputeShader> Shader = new FWebGPUComputeShader;
    auto& Data = Shader->Data;
    Data.Owner = Shader;
    Data.Frequency = SF_Compute;
    Data.Entry = TEXT("main");
    Data.Metadata = MakeShared<FJsonObject>();
    Data.Metadata->SetNumberField(TEXT("frequency"), SF_Compute);
    auto Binding = MakeShared<FJsonObject>();
    Binding->SetStringField(TEXT("name"), TEXT("OutPageRequestFlags"));
    Binding->SetNumberField(TEXT("group"), 0);
    Binding->SetNumberField(TEXT("binding"), 0);
    Binding->SetNumberField(TEXT("descriptorType"), 7);
    Binding->SetBoolField(TEXT("readOnlyStorage"), false);
    Binding->SetNumberField(TEXT("storageElementStride"), 4);
    Binding->SetStringField(TEXT("storagePacking"), TEXT("texture-uint-atomic"));
    Data.Metadata->SetArrayField(TEXT("spirvBindings"), {MakeShared<FJsonValueObject>(Binding)});
    FWebGPUShaderBinding Native;
    Native.Metadata = &Binding.Get();
    Native.Name = TEXT("OutPageRequestFlags");
    Native.Descriptor = 7;
    Native.Reflected = true;
    Native.StorageContract.ReadOnlyValid = true;
    Native.StorageContract.StrideValid = true;
    Native.StorageContract.Stride = 4;
    Native.StorageContract.Packing = FWebGPUStorageContract::EPacking::TextureUIntAtomic;
    Native.RouteInitialized = true;
    Native.Route.Index = 0;
    Data.Bindings.Add(Native);
    Data.GroupVersions.Init(1, 1);
    auto WebBinding = MakeShared<FJsonObject>();
    WebBinding->SetNumberField(TEXT("group"), 0);
    WebBinding->SetNumberField(TEXT("binding"), 0);
    WebBinding->SetStringField(TEXT("resource_type"), TEXT("StorageBuffer"));
    auto Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("name"), Data.Entry);
    Entry->SetArrayField(TEXT("bindings"), {MakeShared<FJsonValueObject>(WebBinding)});
    Entry->SetArrayField(TEXT("output_variables"), {});
    auto Reflection = MakeShared<FJsonObject>();
    Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(Entry)});
    Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
    const char* Code =
        "@group(0) @binding(0) var<storage,read_write> pages: array<atomic<u32>>;\n"
        "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {\n"
        "let w=atomicLoad(&pages[0]); let h=atomicLoad(&pages[1]);\n"
        "let pitch=atomicLoad(&pages[2]); let layers=atomicLoad(&pages[3]);\n"
        "let pixels=w*h*layers; if(id.x>=pixels*8u){return;}\n"
        "let p=id.x%pixels; let x=p%w; let row=p/w;\n"
        "atomicAdd(&pages[64u+x+pitch*row],1u);\n"
        "}\n";
    auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
    WGSL.code = {Code, strlen(Code)};
    auto Module = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    Module.nextInChain = &WGSL.chain;
    Data.Module = wgpuDeviceCreateShaderModule(RHI.Device, &Module);
    Shader->InitResourceTable();
    auto Pipeline = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Shader));
    bool Pass = Pipeline.IsValid();
    for (const FIntVector Size : {FIntVector(1, 1, 1), FIntVector(5, 3, 2),
        FIntVector(65, 7, 2), FIntVector(129, 4, 3)})
    for (uint32 Level = 0; Level < 3; ++Level)
    {
        auto Desc = Size.Z == 1 ?
            FRHITextureCreateDesc::Create2D(TEXT("TextureAtomicProbe"), Size.X << Level, Size.Y << Level, PF_R32_UINT) :
            FRHITextureCreateDesc::Create2DArray(TEXT("TextureAtomicProbe"), Size.X << Level, Size.Y << Level, Size.Z, PF_R32_UINT);
        Desc.SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::UAV | ETextureCreateFlags::AtomicCompatible)
            .SetInitialState(ERHIAccess::UAVCompute).SetNumMips(Level + 1);
        auto Texture = Cmd.CreateTexture(Desc);
        auto UAV = Cmd.CreateUnorderedAccessView(Texture,
            FRHIViewDesc::CreateTextureUAV().SetDimension(Desc.Dimension).SetMipLevel(Level));
        Data.Resources.Add(0, UAV.GetReference());
        Data.InvalidateGroups(1);
        FString Error;
        bool OK = RHI.ValidateTextureAtomicBinding(UAV, Native.StorageContract, ERHIAccess::UAVCompute, Error);
        for (uint32 Negative = 0; Negative < 4; ++Negative)
        {
            auto Contract = Native.StorageContract;
            auto JSON = *Binding;
            if (Negative == 0) { Contract.ReadOnlyValid = false; JSON.RemoveField(TEXT("readOnlyStorage")); }
            if (Negative == 1) { Contract.ReadOnly = true; JSON.SetBoolField(TEXT("readOnlyStorage"), true); }
            if (Negative == 2) { Contract.StrideValid = false; JSON.RemoveField(TEXT("storageElementStride")); }
            if (Negative == 3) { Contract.Stride = 8; JSON.SetNumberField(TEXT("storageElementStride"), 8); }
            FString NativeError, JSONError;
            OK &= !RHI.ValidateStorageUAVBinding(UAV, Contract, ERHIAccess::UAVCompute, NativeError) &&
                !RHI.ValidateStorageUAVBinding(UAV, JSON, ERHIAccess::UAVCompute, JSONError) &&
                NativeError == JSONError;
        }
        const uint32 Pitch = Align(uint32(Size.X) * 4u, 256u);
        const uint64 Bytes = uint64(Pitch) * Size.Y * Size.Z;
        for (uint32 Round = 0; Round < 3; ++Round)
        {
            if (Round) Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
            if (Round != 1)
            {
                const uint32 ClearValue = Round ? 2u : 9u;
                RHI.RHIClearUAVUint(UAV, FUintVector4(ClearValue, ClearValue, ClearValue, ClearValue));
                Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::UAVCompute));
            }
            RHI.RHISetComputePipelineState(Pipeline);
            const uint32 Groups = FMath::DivideAndRoundUp(uint32(Size.X * Size.Y * Size.Z) * 8u, 64u);
            RHI.RHIDispatchComputeShader(Groups, 1, 1);
            if (!Round) RHI.RHIDispatchComputeShader(Groups, 1, 1);
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
            if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            auto Readback = RHI.CreateBuffer(Bytes, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
            auto Source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            Source.texture = static_cast<FWebGPUTexture*>(Texture.GetReference())->Handle;
            Source.mipLevel = Level;
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
            const uint32 Expected = Round == 0 ? 25u : Round == 1 ? 33u : 10u;
            if (uint64(Values.Num()) == Bytes)
                for (int32 Z = 0; Z < Size.Z; ++Z)
                    for (int32 Y = 0; Y < Size.Y; ++Y)
                        for (int32 X = 0; X < Size.X; ++X)
                        {
                            uint32 Value;
                            FMemory::Memcpy(&Value, Values.GetData() + (Z * Size.Y + Y) * Pitch + X * 4, 4);
                            OK &= Value == Expected;
                        }
        }
        auto Case = MakeShared<FJsonObject>();
        Case->SetNumberField(TEXT("width"), Size.X);
        Case->SetNumberField(TEXT("height"), Size.Y);
        Case->SetNumberField(TEXT("layers"), Size.Z);
        Case->SetNumberField(TEXT("mip"), Level);
        Case->SetNumberField(TEXT("checkedValues"), Size.X * Size.Y * Size.Z * 3);
        Case->SetBoolField(TEXT("textureBufferRoundTrips"), true);
        Case->SetBoolField(TEXT("pass"), OK);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
        Pass &= OK;
        Data.Resources.Reset();
    }
    return Pass;
}
