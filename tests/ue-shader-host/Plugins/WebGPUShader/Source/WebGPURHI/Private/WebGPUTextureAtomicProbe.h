#pragma once

#include "WebGPUProbeUtils.h"
#include "WebGPUTextureAtomicHeaders.h"

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
    auto AlternateBinding = MakeShared<FJsonObject>(*Binding);
    AlternateBinding->SetStringField(TEXT("name"), TEXT("InOutPageRequestFlags"));
    AlternateBinding->SetNumberField(TEXT("binding"), 1);
    auto Alternate = Native;
    Alternate.Name = TEXT("InOutPageRequestFlags");
    Alternate.Index = 1;
    Alternate.Route.Index = 1;
    Alternate.Metadata = &AlternateBinding.Get();
    Data.Bindings.Add(Alternate);
    Data.Metadata->SetArrayField(TEXT("spirvBindings"), {
        MakeShared<FJsonValueObject>(Binding), MakeShared<FJsonValueObject>(AlternateBinding)});
    Data.GroupVersions.Init(1, 1);
    auto WebBinding = MakeShared<FJsonObject>();
    WebBinding->SetNumberField(TEXT("group"), 0);
    WebBinding->SetNumberField(TEXT("binding"), 0);
    WebBinding->SetStringField(TEXT("resource_type"), TEXT("StorageBuffer"));
    auto AlternateWebBinding = MakeShared<FJsonObject>(*WebBinding);
    AlternateWebBinding->SetNumberField(TEXT("binding"), 1);
    auto Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("name"), Data.Entry);
    Entry->SetArrayField(TEXT("bindings"), {MakeShared<FJsonValueObject>(WebBinding),
        MakeShared<FJsonValueObject>(AlternateWebBinding)});
    Entry->SetArrayField(TEXT("output_variables"), {});
    auto Reflection = MakeShared<FJsonObject>();
    Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(Entry)});
    Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
    FString Code = TEXT(
        "struct Pages { values: array<atomic<u32>>, }\n"
        "@group(0) @binding(0) var<storage,read_write> pages: Pages;\n"
        "@group(0) @binding(1) var<storage,read_write> alternate: Pages;\n"
        "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {\n"
        "let w=atomicLoad(&pages.values[0u]); let h=atomicLoad(&(pages.values[1u]));\n"
        "let pitch=atomicLoad(&(pages.values[2u])); let layers=atomicLoad(&pages.values[3u]);\n"
        "let pixels=w*h*layers; if(id.x>=pixels*8u){return;}\n"
        "let p=id.x%pixels; let x=p%w; let row=p/w;\n"
        "let other=atomicLoad(&(alternate.values[0u]))+atomicLoad(&(alternate.values[1u]))+\n"
        "atomicLoad(&(alternate.values[2u]))+atomicLoad(&(alternate.values[3u]));\n"
        "atomicAdd(&pages.values[64u+x+pitch*row],select(1000u,1u,other==81u));\n"
        "}\n");
    FWebGPUShaderData AtLimit;
    AtLimit.Bindings = Data.Bindings;
    for (uint32 Index = 0; Index < 12; ++Index)
    {
        FWebGPUShaderBinding Uniform;
        Uniform.Descriptor = 6;
        AtLimit.Bindings.Add(Uniform);
    }
    FString Unchanged = Code;
    if (LowerWebGPUTextureAtomicHeaders(Unchanged, AtLimit) || Unchanged != Code) return false;
    const uint32 Headers = LowerWebGPUTextureAtomicHeaders(Code, Data);
    if (Headers != 2 || Code.Contains(TEXT("atomicLoad(")) || Data.Bindings.Num() != 3) return false;
    const FTCHARToUTF8 UTF8(*Code);
    auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
    WGSL.code = {UTF8.Get(), size_t(UTF8.Length())};
    auto Module = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    Module.nextInChain = &WGSL.chain;
    Data.Module = wgpuDeviceCreateShaderModule(RHI.Device, &Module);
    Shader->InitResourceTable();
    auto Pipeline = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Shader));
    bool Pass = Pipeline.IsValid();
    auto OtherTexture = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("OtherAtomicDimensions"), 7, 9, PF_R32_UINT)
        .SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::UAV | ETextureCreateFlags::AtomicCompatible)
        .SetInitialState(ERHIAccess::UAVCompute));
    auto OtherUAV = Cmd.CreateUnorderedAccessView(OtherTexture,
        FRHIViewDesc::CreateTextureUAV().SetDimension(ETextureDimension::Texture2D));
    TRefCountPtr<FWebGPUComputeShader> Writer = new FWebGPUComputeShader;
    auto& WriteData = Writer->Data;
    WriteData.Owner = Writer;
    WriteData.Entry = TEXT("store_pixels");
    WriteData.Frequency = SF_Compute;
    WriteData.GroupVersions.Init(1, 1);
    FWebGPUShaderBinding WriteBinding;
    WriteBinding.Name = TEXT("image");
    WriteBinding.Descriptor = 3;
    WriteBinding.Reflected = true;
    WriteBinding.TextureDimension = 1;
    WriteBinding.TextureArrayed = true;
    WriteBinding.StorageImageFormat = 33;
    WriteBinding.StorageTextureAccess = TEXT("write");
    WriteBinding.RouteInitialized = true;
    WriteData.Bindings.Add(WriteBinding);
    const char* WriteCode =
        "@group(0) @binding(0) var image: texture_storage_2d_array<r32uint,write>;\n"
        "@compute @workgroup_size(1) fn store_pixels(@builtin(global_invocation_id) p: vec3u) {\n"
        "textureStore(image,p.xy,i32(p.z),vec4u(4u)); }\n";
    WGSL.code = {WriteCode, strlen(WriteCode)};
    WriteData.Module = wgpuDeviceCreateShaderModule(RHI.Device, &Module);
    Writer->InitResourceTable();
    auto WriterPipeline = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Writer));
    Pass &= WriterPipeline.IsValid();
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
        Data.Resources.Add(1, OtherUAV.GetReference());
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
        const auto CopiesBefore = RHI.AtomicCopiesToTexture;
        for (uint32 Round = 0; Round < 4; ++Round)
        {
            if (Round) Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
            if (Round != 1 && Round != 3)
            {
                const uint32 ClearValue = Round ? 2u : 9u;
                RHI.RHIClearUAVUint(UAV, FUintVector4(ClearValue, ClearValue, ClearValue, ClearValue));
                Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::UAVCompute));
            }
            RHI.RHISetComputePipelineState(Pipeline);
            const uint32 Groups = FMath::DivideAndRoundUp(uint32(Size.X * Size.Y * Size.Z) * 8u, 64u);
            RHI.RHIDispatchComputeShader(Groups, 1, 1);
            if (!Round)
            {
                Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::UAVCompute));
                RHI.RHIDispatchComputeShader(Groups, 1, 1);
            }
            if (Round == 3)
            {
                // A real texture clear consumes the pending mirror before it
                // overwrites texels. The next atomic pass must refresh it.
                if (Size.Z == 1) RHI.RHIClearUAVUint(UAV, FUintVector4(4, 4, 4, 4));
                else
                {
                    WriteData.Resources.Add(0, UAV.GetReference());
                    WriteData.InvalidateGroups(1);
                    RHI.RHISetComputePipelineState(WriterPipeline);
                    RHI.RHIDispatchComputeShader(Size.X, Size.Y, Size.Z);
                    // Reuse the writer's cached groups after a different
                    // pipeline has dirtied the same texture's atomic mirror.
                    RHI.RHISetComputePipelineState(Pipeline);
                    RHI.RHIDispatchComputeShader(Groups, 1, 1);
                    RHI.RHISetComputePipelineState(WriterPipeline);
                    RHI.RHIDispatchComputeShader(Size.X, Size.Y, Size.Z);
                }
                Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::UAVCompute, ERHIAccess::UAVCompute));
                RHI.RHISetComputePipelineState(Pipeline);
                RHI.RHIDispatchComputeShader(Groups, 1, 1);
            }
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
            const uint32 Expected = Round == 0 ? 25u : Round == 1 ? 33u : Round == 2 ? 10u : 12u;
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
        Case->SetNumberField(TEXT("checkedValues"), Size.X * Size.Y * Size.Z * 4);
        Case->SetBoolField(TEXT("immutableHeaderUniform"), true);
        Case->SetBoolField(TEXT("packedDifferentResourceHeaders"), true);
        Case->SetBoolField(TEXT("uniformLimitFallback"), true);
        Case->SetBoolField(TEXT("deferredComputeUAVBarrier"), true);
        Case->SetBoolField(TEXT("cachedTextureWriter"), Size.Z != 1);
        const uint64 Copies = RHI.AtomicCopiesToTexture - CopiesBefore;
        Case->SetNumberField(TEXT("mirrorToTextureCopies"), double(Copies));
        OK &= Copies == uint64(Size.Z) * (Size.Z == 1 ? 5 : 6);
        Case->SetBoolField(TEXT("textureBufferRoundTrips"), true);
        Case->SetBoolField(TEXT("pass"), OK);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
        Pass &= OK;
        Data.Resources.Reset();
        WriteData.Resources.Reset();
    }
    return Pass;
}
