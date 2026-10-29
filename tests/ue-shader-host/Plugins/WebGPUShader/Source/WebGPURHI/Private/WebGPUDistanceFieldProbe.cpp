#include "WebGPUDistanceFieldProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

namespace
{
TSharedRef<FJsonObject> RunMode(IDynamicRHIModule& Module, const FString& Directory, const FString& Output, bool Bypass)
{
    using namespace WebGPUProbe;
    auto& Cmd = FRHICommandListImmediate::Get();
    FWebGPUGlobalScope Scope(Module);
    auto& RHI = *Scope.RHI;
    if (Bypass)
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
            ERHISubmitFlags::EnableBypass);
    TArray<TSharedPtr<FJsonValue>> Checks;
    bool Pass = true;
    const auto Record = [&](const TCHAR* Name, bool OK) {
        auto Check = MakeShared<FJsonObject>();
        Check->SetStringField(TEXT("name"), Name);
        Check->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Check));
        Pass &= OK;
        UE_LOG(LogRHI, Display, TEXT("WEB_DF_RHI %s %s pass=%d"), Bypass ? TEXT("bypass") : TEXT("recorded"), Name, OK);
    };
    {
        auto Load = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebTexture3D_LoadCS"))));
        auto UIntLoad = RHICreateComputeShader(FRHICreateShaderDesc(Packet(
            FPaths::GetPath(Directory) / TEXT("ue-texture-uint-worker"), TEXT("WebTextureUint_LoadCS"))));
        const auto Slot = [&](FRHIComputeShader* Shader, const TCHAR* Name) {
            const auto* Value = RHI.ShaderData(Shader).Metadata->GetArrayField(TEXT("ueParameterMap")).FindByPredicate(
                [&](const auto& Item) { return Item->AsObject()->GetStringField(TEXT("name")) == Name; });
            check(Value);
            return (*Value)->AsObject();
        };
        const FUintVector4 Zero(0);
        auto Arguments = Buffer(RHI, Cmd,
            FRHIBufferCreateDesc::CreateStructured(TEXT("DistanceFieldIndirectProbe"), 32, 16)
                .AddUsage(BUF_UnorderedAccess | BUF_DrawIndirect).SetInitialState(ERHIAccess::UAVCompute),
            &Zero, sizeof(Zero));
        auto ArgsUAV = Cmd.CreateUnorderedAccessView(Arguments,
            FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Arguments).SetNumElements(1));
        Cmd.ClearUAVUint(ArgsUAV, FUintVector4(1, 1, 1, 0));
        Cmd.Transition(FRHITransitionInfo(Arguments, ERHIAccess::UAVCompute, ERHIAccess::IndirectArgs));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        FString Error;
        Record(TEXT("indirect-valid-range"), RHI.ValidateIndirectArguments(Arguments, 0, 12, Error));
        Record(TEXT("indirect-reject-unaligned"), !RHI.ValidateIndirectArguments(Arguments, 2, 12, Error));
        Record(TEXT("indirect-reject-overrun"), !RHI.ValidateIndirectArguments(Arguments, 24, 12, Error));
        const auto ArgBytes = RHI.ReadBuffer(Arguments, 32);
        const uint32 ExpectedArgs[] = {1, 1, 1, 0, 0, 0, 0, 0};
        Record(TEXT("gpu-generated-arguments-preserve-other-range"), ArgBytes.Num() == sizeof(ExpectedArgs) &&
            FMemory::Memcmp(ArgBytes.GetData(), ExpectedArgs, sizeof(ExpectedArgs)) == 0);
        {
            const uint32 Count = 65535u * 256u + 17u;
            auto Large = Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(TEXT("DistanceFieldLargeClearProbe"),
                Count * 4, 4, BUF_UnorderedAccess).SetInitialState(ERHIAccess::UAVCompute), nullptr, 0);
            auto LargeUAV = Cmd.CreateUnorderedAccessView(Large, FRHIViewDesc::CreateBufferUAV()
                .SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32_UINT));
            Cmd.ClearUAVUint(LargeUAV, FUintVector4(0x9e3779b9u));
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(Large, Count * 4);
            bool OK = Bytes.Num() == Count * 4;
            for (uint32 Index = 0; Index < Count && OK; ++Index)
            {
                uint32 Value;
                FMemory::Memcpy(&Value, Bytes.GetData() + Index * 4, 4);
                OK &= Value == 0x9e3779b9u;
            }
            Record(TEXT("large-clear-wraps-workgroup-limit"), OK);
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output /
                (Bypass ? TEXT("bypass-large-clear.bin") : TEXT("recorded-large-clear.bin")))));
        }
        for (const auto Format : {PF_G8, PF_R8, PF_R32_FLOAT, PF_R32_UINT})
        {
            const bool UInt = Format == PF_R32_UINT;
            FRHIComputeShader* Shader = UInt ? UIntLoad.GetReference() : Load.GetReference();
            auto Volume = Cmd.CreateTexture(FRHITextureCreateDesc::Create3D(TEXT("DistanceFieldVolumeProbe"),
                3, 2, 3, Format).SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::UAV)
                .SetInitialState(ERHIAccess::UAVCompute));
            auto VolumeUAV = Cmd.CreateUnorderedAccessView(Volume,
                FRHIViewDesc::CreateTextureUAV().SetDimension(ETextureDimension::Texture3D));
            if (UInt)
                Cmd.ClearUAVUint(VolumeUAV, FUintVector4(0xffffffffu, 0, 0, 0));
            else
                Cmd.ClearUAVFloat(VolumeUAV, FVector4f(0.25f, 0, 0, 0));
            Cmd.Transition(FRHITransitionInfo(Volume, ERHIAccess::UAVCompute, ERHIAccess::SRVCompute));
            auto Sink = Buffer(RHI, Cmd,
                FRHIBufferCreateDesc::CreateStructured(TEXT("DistanceFieldReadback"), (UInt ? 19 : 18) * 16, 16)
                    .AddUsage(BUF_UnorderedAccess).SetInitialState(ERHIAccess::UAVCompute), nullptr, 0);
            auto SinkUAV = Cmd.CreateUnorderedAccessView(Sink, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Sink));
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Shader));
            const auto ExtentSlot = Slot(Shader, TEXT("Extent"));
            const FUintVector3 Extent(3, 2, 3);
            const FRHIShaderParameter Parameter(ExtentSlot->GetIntegerField(TEXT("bufferIndex")),
                ExtentSlot->GetIntegerField(TEXT("baseIndex")), 0, sizeof(Extent));
            const FRHIShaderParameterResource Resources[] = {
                {FRHIShaderParameterResource::EType::Texture, Volume, uint16(Slot(Shader, TEXT("Volume"))->GetIntegerField(TEXT("baseIndex")))},
                {SinkUAV, uint16(Slot(Shader, TEXT("Output"))->GetIntegerField(TEXT("baseIndex")))}};
            Cmd.SetShaderParameters(Shader, MakeArrayView(reinterpret_cast<const uint8*>(&Extent), sizeof(Extent)),
                MakeArrayView(&Parameter, 1), Resources, {});
            Cmd.DispatchIndirectComputeShader(Arguments, 0);
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(Sink, (UInt ? 19 : 18) * 16);
            bool OK = Bytes.Num() == (UInt ? 19 : 18) * 16;
            const uint32 Expected[] = {UInt ? 0xffffffffu : 64u, 0, 0, UInt ? 1u : 255u};
            for (int32 Index = UInt ? 4 : 0; Index < Bytes.Num() / 4; ++Index)
            {
                uint32 Actual = 0;
                FMemory::Memcpy(&Actual, Bytes.GetData() + Index * 4, 4);
                OK &= Actual == Expected[Index % 4];
            }
            Record(Format == PF_G8 ? TEXT("g8-3d-clear-and-indirect-read") :
                Format == PF_R8 ? TEXT("r8-3d-clear-and-indirect-read") :
                UInt ? TEXT("r32uint-3d-sentinel-and-indirect-read") :
                TEXT("r32float-3d-clear-and-indirect-read"), OK);
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / FString::Printf(TEXT("%s-format%d.bin"),
                Bypass ? TEXT("bypass") : TEXT("recorded"), int32(Format)))));
            RHI.ShaderData(Shader).Resources.Reset();
        }
        {
            auto Upload = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Output / TEXT("CookShaders"),
                TEXT("FScatterUploadDistanceFieldAtlasCS"))));
            TArray<uint8> Packed;
            Packed.SetNumUninitialized(3 * 512);
            for (int32 Index = 0; Index < Packed.Num(); ++Index)
                Packed[Index] = (Index * 37 + Index / 7 + 13) % 256;
            const FUintVector4 Coordinates[] = {FUintVector4(0), FUintVector4(1, 0, 0, 0), FUintVector4(0, 1, 1, 0)};
            auto Data = Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(TEXT("DFPackedUpload"), Packed.Num(), 1,
                BUF_ShaderResource).SetInitialState(ERHIAccess::SRVCompute), Packed.GetData(), Packed.Num());
            auto CoordinateBuffer = Buffer(RHI, Cmd, FRHIBufferCreateDesc::Create(TEXT("DFUploadCoordinates"),
                sizeof(Coordinates), 16, BUF_ShaderResource).SetInitialState(ERHIAccess::SRVCompute),
                Coordinates, sizeof(Coordinates));
            auto DataSRV = Cmd.CreateShaderResourceView(Data, FRHIViewDesc::CreateBufferSRV()
                .SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_G8));
            auto CoordinatesSRV = Cmd.CreateShaderResourceView(CoordinateBuffer, FRHIViewDesc::CreateBufferSRV()
                .SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32G32B32A32_UINT));
            auto Atlas = Cmd.CreateTexture(FRHITextureCreateDesc::Create3D(TEXT("DFPackedAtlasProbe"), 16, 16, 16,
                PF_G8).SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::UAV)
                .SetInitialState(ERHIAccess::UAVCompute));
            auto AtlasUAV = Cmd.CreateUnorderedAccessView(Atlas,
                FRHIViewDesc::CreateTextureUAV().SetDimension(ETextureDimension::Texture3D));
            Cmd.ClearUAVFloat(AtlasUAV, FVector4f(1, 0, 0, 0));
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Upload));
            const uint32 Values[] = {1, 2, 8};
            TArray<FRHIShaderParameter> Parameters;
            int32 Index = 0;
            for (const TCHAR* Name : {TEXT("StartBrickIndex"), TEXT("NumBrickUploads"), TEXT("BrickSize")})
            {
                const auto S = Slot(Upload, Name);
                Parameters.Emplace(S->GetIntegerField(TEXT("bufferIndex")), S->GetIntegerField(TEXT("baseIndex")),
                    Index++ * 4, 4);
            }
            const FRHIShaderParameterResource Resources[] = {
                {DataSRV, uint16(Slot(Upload, TEXT("BrickUploadData"))->GetIntegerField(TEXT("baseIndex")))},
                {CoordinatesSRV, uint16(Slot(Upload, TEXT("BrickUploadCoordinates"))->GetIntegerField(TEXT("baseIndex")))},
                {AtlasUAV, uint16(Slot(Upload, TEXT("RWDistanceFieldBrickAtlas"))->GetIntegerField(TEXT("baseIndex")))}};
            Cmd.SetShaderParameters(Upload, MakeArrayView(reinterpret_cast<const uint8*>(Values), sizeof(Values)),
                Parameters, Resources, {});
            Cmd.DispatchComputeShader(2, 2, 4);
            Cmd.Transition(FRHITransitionInfo(Atlas, ERHIAccess::UAVCompute, ERHIAccess::SRVCompute));
            auto Sink = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateStructured(TEXT("DFPackedReadback"), 4096 * 16, 16)
                .AddUsage(BUF_UnorderedAccess).SetInitialState(ERHIAccess::UAVCompute), nullptr, 0);
            auto SinkUAV = Cmd.CreateUnorderedAccessView(Sink, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Sink));
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Load));
            const FUintVector3 Extent(16);
            const auto S = Slot(Load, TEXT("Extent"));
            const FRHIShaderParameter Parameter(S->GetIntegerField(TEXT("bufferIndex")),
                S->GetIntegerField(TEXT("baseIndex")), 0, sizeof(Extent));
            const FRHIShaderParameterResource ReadResources[] = {
                {FRHIShaderParameterResource::EType::Texture, Atlas, uint16(Slot(Load, TEXT("Volume"))->GetIntegerField(TEXT("baseIndex")))},
                {SinkUAV, uint16(Slot(Load, TEXT("Output"))->GetIntegerField(TEXT("baseIndex")))}};
            Cmd.SetShaderParameters(Load, MakeArrayView(reinterpret_cast<const uint8*>(&Extent), sizeof(Extent)),
                MakeArrayView(&Parameter, 1), ReadResources, {});
            Cmd.DispatchComputeShader(4, 4, 4);
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(Sink, 4096 * 16);
            bool OK = Bytes.Num() == 4096 * 16;
            for (uint32 Z = 0; Z < 16; ++Z)
            for (uint32 Y = 0; Y < 16; ++Y)
            for (uint32 X = 0; X < 16; ++X)
            {
                const uint32 Brick = X >= 8 && Y < 8 && Z < 8 ? 1 : X < 8 && Y >= 8 && Z >= 8 ? 2 : 0;
                const uint32 Expected[] = {Brick ? Packed[Brick * 512 + ((Z % 8) * 8 + Y % 8) * 8 + X % 8] : 255u, 0, 0, 255};
                OK &= !FMemory::Memcmp(Bytes.GetData() + ((Z * 16 + Y) * 16 + X) * 16, Expected, sizeof(Expected));
            }
            Record(TEXT("real-cook-packed-g8-brick-upload"), OK);
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / (Bypass ? TEXT("bypass-packed.bin") : TEXT("recorded-packed.bin")))));
            RHI.ShaderData(Upload).Resources.Reset();
            RHI.ShaderData(Load).Resources.Reset();
        }
        const FString GraphicsDirectory = Output / TEXT("CookShaders");
        auto Vertex = RHICreateVertexShader(FRHICreateShaderDesc(Packet(GraphicsDirectory, TEXT("FClearReplacementVS"))));
        auto Pixel = RHICreatePixelShader(FRHICreateShaderDesc(Packet(GraphicsDirectory, TEXT("FClearReplacementPS"))));
        FGraphicsPipelineStateInitializer Pipeline;
        Pipeline.BoundShaderState.VertexShaderRHI = Vertex;
        Pipeline.BoundShaderState.PixelShaderRHI = Pixel;
        Pipeline.PrimitiveType = PT_TriangleStrip;
        Pipeline.RenderTargetsEnabled = 1;
        Pipeline.RenderTargetFormats[0] = PF_R8G8B8A8;
        Pipeline.NumSamples = 1;
        Pipeline.BlendState = RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
        Pipeline.RasterizerState = RHICreateRasterizerState(FRasterizerStateInitializerRHI(FM_Solid, CM_None, false));
        Pipeline.DepthStencilState = RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
        for (uint32 IndexStride : {0u, 2u, 4u})
        {
            Pipeline.PrimitiveType = IndexStride ? PT_TriangleList : PT_TriangleStrip;
            const uint32 DrawArgs[] = {0xdeadbeef, IndexStride ? 6u : 4u, 1, 0, 0, 0};
            auto DrawArguments = Buffer(RHI, Cmd,
                FRHIBufferCreateDesc::Create(TEXT("DistanceFieldDrawArguments"), sizeof(DrawArgs), 4, BUF_DrawIndirect)
                    .SetInitialState(ERHIAccess::IndirectArgs), DrawArgs, sizeof(DrawArgs));
            FBufferRHIRef Indices;
            const uint16 Indices16[] = {0, 1, 2, 1, 3, 2};
            const uint32 Indices32[] = {0, 1, 2, 1, 3, 2};
            if (IndexStride)
                Indices = Buffer(RHI, Cmd,
                    FRHIBufferCreateDesc::CreateIndex(TEXT("DistanceFieldIndirectIndex"), IndexStride * 6, IndexStride)
                        .SetInitialState(ERHIAccess::VertexOrIndexBuffer),
                    IndexStride == 2 ? static_cast<const void*>(Indices16) : Indices32, IndexStride * 6);
            auto Image = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("DistanceFieldIndirectDraw"), 32, 32,
                PF_R8G8B8A8).SetFlags(ETextureCreateFlags::RenderTargetable)
                .SetClearValue(FClearValueBinding::Black).SetInitialState(ERHIAccess::RTV));
            Cmd.BeginRenderPass(FRHIRenderPassInfo(Image, ERenderTargetActions::Clear_Store), TEXT("DFIndirectDraw"));
            SetGraphicsPipelineState(Cmd, Pipeline, 0, EApplyRendertargetOption::DoNothing);
            Cmd.SetStreamSource(0, nullptr, 0);
            Cmd.SetViewport(0, 0, 0, 32, 32, 1);
            const FVector4f Color(1, 0.25f, 0, 1);
            const FRHIShaderParameter ColorParameter(0, 0, 0, sizeof(Color));
            Cmd.SetShaderParameters(Pixel, MakeArrayView(reinterpret_cast<const uint8*>(&Color), sizeof(Color)),
                MakeArrayView(&ColorParameter, 1), {}, {});
            if (IndexStride)
                Cmd.DrawIndexedPrimitiveIndirect(Indices, DrawArguments, 4);
            else
                Cmd.DrawPrimitiveIndirect(DrawArguments, 4);
            Cmd.EndRenderPass();
            TArray<FColor> Colors;
            Cmd.ReadSurfaceData(Image, FIntRect(0, 0, 32, 32), Colors, RawReadback());
            bool OK = Colors.Num() == 1024;
            for (const FColor& Actual : Colors)
                OK &= Actual.R == 255 && FMath::Abs(int32(Actual.G) - 64) <= 1 && Actual.B == 0 && Actual.A == 255;
            Record(IndexStride == 2 ? TEXT("indexed16-indirect-draw-offset") :
                IndexStride == 4 ? TEXT("indexed32-indirect-draw-offset") : TEXT("indirect-draw-offset"), OK);
        }
        Cmd.Transition(FRHITransitionInfo(Arguments, ERHIAccess::IndirectArgs, ERHIAccess::UAVCompute));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("indirect-reject-uav-state"), !RHI.ValidateIndirectArguments(Arguments, 0, 12, Error));
        Cmd.ClearUAVUint(ArgsUAV, FUintVector4(0));
    }
    Scope.PrepareShutdown();
    Record(TEXT("gpu-validation-clean"), RHI.Errors.IsEmpty());
    auto Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), Pass);
    Report->SetBoolField(TEXT("bypass"), Bypass);
    Report->SetArrayField(TEXT("checks"), Checks);
    TArray<TSharedPtr<FJsonValue>> Errors;
    for (const FString& Error : RHI.Errors)
    {
        Errors.Add(MakeShared<FJsonValueString>(Error));
        UE_LOG(LogRHI, Display, TEXT("WEB_DF_RHI validation: %s"), *Error);
    }
    Report->SetArrayField(TEXT("errors"), Errors);
    Scope.Restore();
    return Report;
}
}

bool RunWebGPUDistanceFieldProbe(IDynamicRHIModule& Module, const FString& Shaders, const FString& Output)
{
    IFileManager::Get().MakeDirectory(*Output, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebDistanceFieldProbe)([&](FRHICommandListImmediate&) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, Shaders, Output, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetArrayField(TEXT("modes"), Modes);
        FString JSON;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
        check(FFileHelper::SaveStringToFile(JSON, *(Output / TEXT("distance-field-rhi-results.json")),
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
