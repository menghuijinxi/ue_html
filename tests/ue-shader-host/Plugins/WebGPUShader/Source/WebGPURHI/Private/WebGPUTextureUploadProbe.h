#pragma once

#include "WebGPUProbeUtils.h"

inline bool RunWebGPUTextureUploadCases(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd,
    TArray<TSharedPtr<FJsonValue>>& Cases)
{
    bool Pass = true;
    for (EPixelFormat Format : {PF_R8G8B8A8, PF_G8, PF_R32_FLOAT, PF_A32B32G32R32F,
        PF_DXT1, PF_DXT3, PF_DXT5, PF_BC4, PF_BC5, PF_BC6H, PF_BC7})
    for (uint32 Level = 0; Level < 2; ++Level)
    {
        const auto& Pixel = GPixelFormats[Format];
        const uint32 Width = 6 * Pixel.BlockSizeX, Height = 5 * Pixel.BlockSizeY;
        const uint32 SourcePitch = 5 * Pixel.BlockBytes + 16;
        TArray<uint8> SourceBytes, Zero;
        SourceBytes.SetNumUninitialized(SourcePitch * 4);
        for (int32 Index = 0; Index < SourceBytes.Num(); ++Index)
            SourceBytes[Index] = uint8(1 + Index * 17);
        Zero.SetNumZeroed(6 * 5 * Pixel.BlockBytes);
        auto Texture = Cmd.CreateTexture(
            FRHITextureCreateDesc::Create2D(TEXT("VirtualTextureUploadProbe"), Width << Level, Height << Level, Format)
                .SetNumMips(Level + 1).SetFlags(ETextureCreateFlags::ShaderResource).SetInitialState(ERHIAccess::CopyDest));
        if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        RHI.RHIUpdateTexture2D(Cmd, Texture, Level,
            FUpdateTextureRegion2D(0, 0, 0, 0, Width, Height), 6 * Pixel.BlockBytes, Zero.GetData());
        RHI.RHIUpdateTexture2D(Cmd, Texture, Level,
            FUpdateTextureRegion2D(2 * Pixel.BlockSizeX, Pixel.BlockSizeY, Pixel.BlockSizeX, Pixel.BlockSizeY,
                2 * Pixel.BlockSizeX, 2 * Pixel.BlockSizeY), SourcePitch, SourceBytes.GetData());
        Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::CopyDest, ERHIAccess::CopySrc));
        const uint32 ReadPitch = 256, ReadBytes = ReadPitch * 5;
        auto Readback = RHI.CreateBuffer(ReadBytes, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
        auto Source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        Source.texture = static_cast<FWebGPUTexture*>(Texture.GetReference())->Handle;
        Source.mipLevel = Level;
        auto Destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        Destination.buffer = Readback;
        Destination.layout.bytesPerRow = ReadPitch;
        Destination.layout.rowsPerImage = 5;
        const WGPUExtent3D Extent{Width, Height, 1};
        RHI.EndComputePass();
        wgpuCommandEncoderCopyTextureToBuffer(RHI.Encoder, &Source, &Destination, &Extent);
        RHI.SubmitCurrent();
        const auto Result = RHI.MapBuffer(Readback, ReadBytes);
        wgpuBufferRelease(Readback);
        uint32 Mismatches = 0;
        if (Result.Num() == ReadBytes)
            for (uint32 Y = 0; Y < 5; ++Y)
                for (uint32 X = 0; X < 6; ++X)
                    for (uint32 Byte = 0; Byte < uint32(Pixel.BlockBytes); ++Byte)
                    {
                        const uint8 Expected = X >= 2 && X < 4 && Y >= 1 && Y < 3 ?
                            SourceBytes[Y * SourcePitch + (X - 1) * Pixel.BlockBytes + Byte] : 0;
                        Mismatches += Result[Y * ReadPitch + X * Pixel.BlockBytes + Byte] != Expected;
                    }
        const bool OK = Result.Num() == ReadBytes && Mismatches == 0;
        auto Case = MakeShared<FJsonObject>();
        Case->SetStringField(TEXT("format"), Pixel.Name);
        Case->SetNumberField(TEXT("mip"), Level);
        Case->SetNumberField(TEXT("checkedBytes"), 6 * 5 * Pixel.BlockBytes);
        Case->SetNumberField(TEXT("mismatches"), Mismatches);
        Case->SetBoolField(TEXT("pass"), OK);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
        Pass &= OK;
    }
    return Pass;
}
