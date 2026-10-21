#pragma once

#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

inline bool RunWebGPUSkyResourceProbe(IDynamicRHIModule& Module, const FString& Output)
{
    bool Passed = false;
    ENQUEUE_RENDER_COMMAND(WebSkyResourceProbe)([&](FRHICommandListImmediate& Cmd)
    {
        FWebGPUGlobalScope Scope(Module);
        auto& RHI = *Scope.RHI;
        TArray<TSharedPtr<FJsonValue>> Checks;
        bool AllPassed = true;
        const auto Record = [&](const FString& Name, bool OK)
        {
            auto Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("name"), Name);
            Item->SetBoolField(TEXT("pass"), OK);
            Checks.Add(MakeShared<FJsonValueObject>(Item));
            AllPassed &= OK;
        };
        {
            const auto Expected = [](uint32 Face, uint32 Mip)
            {
                return FColor(21 + Face * 31, 37 + Mip * 67, 43 + Face * 17 + Mip * 13, 255);
            };
            auto Desc = FRHITextureCreateDesc::CreateCube(TEXT("SkyCubeRegression"), 4, PF_R8G8B8A8)
                .SetNumMips(3).SetFlags(ETextureCreateFlags::ShaderResource)
                .SetInitialState(ERHIAccess::CopySrc).SetInitActionInitializer();
            auto Init = Cmd.CreateTextureInitializer(Desc);
            for (uint32 Face = 0; Face < 6; ++Face)
            for (uint32 Mip = 0; Mip < 3; ++Mip)
            {
                auto Subresource = Init.GetTextureCubeSubresource(ECubeFace(Face), Mip);
                const auto Color = Expected(Face, Mip);
                const uint8 Pixel[] = {Color.R, Color.G, Color.B, Color.A};
                for (uint64 Offset = 0; Offset < Subresource.Size; Offset += 4)
                    FMemory::Memcpy(static_cast<uint8*>(Subresource.Data) + Offset, Pixel, 4);
            }
            auto Cube = Init.Finalize();
            for (uint32 Face = 0; Face < 6; ++Face)
            for (uint32 Mip = 0; Mip < 3; ++Mip)
            {
                const uint32 Extent = 4 >> Mip;
                auto Destination = Cmd.CreateTexture(
                    FRHITextureCreateDesc::Create2D(TEXT("SkyCubeReadback"), Extent, Extent, PF_R8G8B8A8)
                    .SetFlags(ETextureCreateFlags::ShaderResource).SetInitialState(ERHIAccess::CopyDest));
                FRHICopyTextureInfo Copy;
                Copy.SourceSliceIndex = Face;
                Copy.SourceMipIndex = Mip;
                Copy.Size = FIntVector(Extent, Extent, 1);
                Cmd.CopyTexture(Cube, Destination, Copy);
                Cmd.Transition(FRHITransitionInfo(Destination, ERHIAccess::CopyDest, ERHIAccess::CopySrc));
                TArray<FColor> Colors;
                Cmd.ReadSurfaceData(Destination, FIntRect(0, 0, Extent, Extent),
                    Colors, WebGPUProbe::RawReadback());
                Record(FString::Printf(TEXT("cube-face-%u-mip-%u"), Face, Mip),
                    Colors.Num() == int32(Extent * Extent) &&
                    !Colors.ContainsByPredicate([&](FColor Color) { return Color != Expected(Face, Mip); }));
            }
            const uint32 Values[] = {13, 29, 47, 83};
            auto Buffer = WebGPUProbe::Buffer(RHI, Cmd,
                FRHIBufferCreateDesc::Create(TEXT("SkyAsyncReadback"), sizeof(Values), 4, BUF_ShaderResource)
                    .SetInitialState(ERHIAccess::CopySrc),
                Values, sizeof(Values));
            auto Staging = RHICreateStagingBuffer();
            auto Fence = RHICreateGPUFence(TEXT("SkyAsyncFence"));
            Cmd.CopyToStagingBuffer(Buffer, Staging, 0, sizeof(Values));
            Cmd.WriteGPUFence(Fence);
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            if (RHI.ContextOpen)
                RHI.SubmitCurrent();
            const bool Ready = RHI.Wait([&] { return Fence->Poll(); });
            void* Data = Ready ? RHI.RHILockStagingBuffer(Staging, Fence, 0, sizeof(Values)) : nullptr;
            Record(TEXT("asynchronous-buffer-readback"), Data && FMemory::Memcmp(Data, Values, sizeof(Values)) == 0);
            if (Data)
                Staging->Unlock();
        }
        RHI.ReleaseBindings();
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
        if (RHI.ContextOpen)
            RHI.SubmitCurrent();
        RHI.RHIBlockUntilGPUIdle();
        Passed = AllPassed && RHI.Errors.IsEmpty();
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Passed);
        Report->SetStringField(TEXT("adapter"), RHI.AdapterName);
        Report->SetArrayField(TEXT("checks"), Checks);
        TArray<TSharedPtr<FJsonValue>> Errors;
        for (const auto& Error : RHI.Errors)
            Errors.Add(MakeShared<FJsonValueString>(Error));
        Report->SetArrayField(TEXT("errors"), Errors);
        FString Json;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
        FFileHelper::SaveStringToFile(Json, *(Output / TEXT("sky-resources-results.json")),
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    });
    FlushRenderingCommands();
    return Passed;
}
