#include "WebGPURHIProbe.h"
#include "WebGPUDynamicRHI.h"
#include "WebGPUProbeUtils.h"
#include "WebGPUMaterialProbe.h"
#include "WebGPUTransitionProbe.h"
#include "WebGPUGlobalProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUViewportProbe.h"
#include "WebGPUTextureSRVProbe.h"
#include "WebGPUBufferSRVProbe.h"
#include "WebGPUStructuredProbe.h"
#include "WebGPUBufferUAVProbe.h"
#include "WebGPUUint4Probe.h"
#include "WebGPUFloat4Probe.h"
#include "WebGPUBufferLockProbe.h"
#include "WebGPUTexture3DProbe.h"
#include "WebGPUTextureUintProbe.h"
#include "WebGPUSkyResourceProbe.h"
#include "WebGPUDistanceFieldProbe.h"

#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "RHIUniformBufferLayoutInitializer.h"
#include "Serialization/JsonSerializer.h"
#include "Modules/ModuleManager.h"
#include "RenderingThread.h"
#include "ShaderParameterMetadata.h"
#include "ShaderParameterMacros.h"

namespace
{
using namespace WebGPUProbe;
using FWebGPUProbeCommandList = FCommandList;
void Submit(FWebGPUDynamicRHI &RHI)
{
    RHI.SubmitCurrent();
}
template <typename Shader, typename Value>
void ValueParameter(FRHICommandList &Cmd, Shader *InShader, const Value &InValue)
{
    const FRHIShaderParameter Parameter(0, 0, 0, sizeof(Value));
    Cmd.SetShaderParameters(InShader, MakeArrayView(reinterpret_cast<const uint8 *>(&InValue), sizeof(Value)),
                            MakeArrayView(&Parameter, 1), {}, {});
}
TArray<uint8> ChangeMetadata(const TArray<uint8> &Bytes, const TCHAR *Field, double Value)
{
    uint32 Header[7];
    FMemory::Memcpy(Header, Bytes.GetData(), sizeof(Header));
    const FString Json(FUTF8ToTCHAR(reinterpret_cast<const ANSICHAR *>(Bytes.GetData() + 28), Header[5]));
    TSharedPtr<FJsonObject> Metadata;
    check(FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Metadata));
    Metadata->SetNumberField(Field, Value);
    FString Changed;
    FJsonSerializer::Serialize(Metadata.ToSharedRef(), TJsonWriterFactory<>::Create(&Changed));
    const FTCHARToUTF8 Utf8(*Changed);
    const uint32 Previous = Header[5];
    Header[5] = Utf8.Length();
    TArray<uint8> Result;
    Result.Append(reinterpret_cast<const uint8 *>(Header), sizeof(Header));
    Result.Append(reinterpret_cast<const uint8 *>(Utf8.Get()), Utf8.Length());
    Result.Append(Bytes.GetData() + 28 + Previous, Header[6]);
    return Result;
}
} // namespace

static bool RunProbeOnRenderThread(const FString &ShaderDirectory, const FString &MaterialDirectory,
                                   const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    FWebGPUDynamicRHI RHI;
    RHI.Init();
    TArray<TSharedPtr<FJsonValue>> Checks;
    uint64 Checked = 0;
    bool Pass = true;
    auto Record = [&](const FString &Name, bool OK) {
        auto Check = MakeShared<FJsonObject>();
        Check->SetStringField(TEXT("name"), Name);
        Check->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Check));
        UE_LOG(LogRHI, Display, TEXT("P2_RHI %s pass=%d"), *Name, OK);
        Pass &= OK;
    };
    {
        const auto VertexBytes = Packet(ShaderDirectory, TEXT("FScreenVS"));
        const auto PixelBytes = Packet(ShaderDirectory, TEXT("FScreenPS"));
        const auto ClearVertexBytes = Packet(ShaderDirectory, TEXT("FClearReplacementVS"));
        const auto ClearPixelBytes = Packet(ShaderDirectory, TEXT("FClearReplacementPS"));
        auto Vertex = RHI.RHICreateVertexShader(FRHICreateShaderDesc(VertexBytes));
        auto Pixel = RHI.RHICreatePixelShader(FRHICreateShaderDesc(PixelBytes));
        auto ClearVertex = RHI.RHICreateVertexShader(FRHICreateShaderDesc(ClearVertexBytes));
        auto ClearPixel = RHI.RHICreatePixelShader(FRHICreateShaderDesc(ClearPixelBytes));
        auto DepthVertex =
            RHI.RHICreateVertexShader(FRHICreateShaderDesc(Packet(ShaderDirectory, TEXT("FClearReplacementVS_Depth"))));
        auto Blend = RHI.RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
        const bool RejectRasterizer = FParse::Param(FCommandLine::Get(), TEXT("WebRejectDeferredRasterizer"));
        const bool RejectSampler = FParse::Param(FCommandLine::Get(), TEXT("WebRejectDeferredSampler"));
        check(!(RejectRasterizer && RejectSampler));
        auto Rasterizer = RHI.RHICreateRasterizerState(
            FRasterizerStateInitializerRHI(RejectRasterizer ? FM_Wireframe : FM_Solid, CM_None, false));
        if (RejectRasterizer)
            UE_LOG(LogRHI, Display, TEXT("P2_DEFERRED_STATE rasterizer descriptor retained; testing PSO rejection"));
        auto NoDepth = RHI.RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
        FVertexDeclarationElementList Elements;
        Elements.Add(FVertexElement(0, 0, VET_Float2, 0, 16));
        Elements.Add(FVertexElement(0, 8, VET_Float2, 1, 16));
        auto Declaration = RHI.RHICreateVertexDeclaration(Elements);
        FGraphicsPipelineStateInitializer Pipeline;
        Pipeline.BoundShaderState.VertexDeclarationRHI = Declaration;
        Pipeline.BoundShaderState.VertexShaderRHI = Vertex;
        Pipeline.BoundShaderState.PixelShaderRHI = Pixel;
        Pipeline.PrimitiveType = PT_TriangleList;
        Pipeline.RenderTargetsEnabled = 1;
        Pipeline.RenderTargetFormats[0] = PF_R8G8B8A8;
        Pipeline.NumSamples = 1;
        Pipeline.BlendState = Blend;
        Pipeline.RasterizerState = Rasterizer;
        Pipeline.DepthStencilState = NoDepth;
        auto NativePipeline = RHI.RHICreateGraphicsPipelineState(Pipeline);
        const float Vertices[] = {0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1};
        const uint16 Indices16[] = {0, 2, 1, 1, 2, 3};
        const uint32 Indices32[] = {0, 2, 1, 1, 2, 3};
        FBufferRHIRef VB, IB16, IB32;
        FTextureRHIRef Image;
        auto Sampler = RHI.RHICreateSamplerState(
            FSamplerStateInitializerRHI(RejectSampler ? SF_Bilinear : SF_Point, AM_Clamp, AM_Clamp));
        if (RejectSampler)
        {
            check(static_cast<FWebGPUSampler *>(Sampler.GetReference())->Handle == nullptr);
            UE_LOG(LogRHI, Display, TEXT("P2_DEFERRED_STATE sampler descriptor retained; testing binding rejection"));
        }
        const float Rectangle[] = {1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1};
        const auto *RectangleMetadata =
            FindUniformBufferStructByLayoutHash(RHI.ShaderData(Vertex).ResourceTable.ResourceTableLayoutHashes[0]);
        check(RectangleMetadata && RectangleMetadata->GetLayout().ConstantBufferSize == sizeof(Rectangle));
        const auto *Layout = &RectangleMetadata->GetLayout();
        auto Uniform =
            RHI.RHICreateUniformBuffer(Rectangle, Layout, UniformBuffer_MultiFrame, EUniformBufferValidation::None);
        const uint8 Palette[] = {32, 64, 96, 255, 96, 128, 160, 255, 160, 192, 224, 255, 224, 64, 128, 255};
        RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        {
            FWebGPUProbeCommandList Cmd(&RHI);
            VB = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("WebGPUVertices"), sizeof(Vertices)),
                        Vertices, sizeof(Vertices));
            IB16 = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateIndex(TEXT("WebGPUIndices16"), sizeof(Indices16), 2),
                          Indices16, sizeof(Indices16));
            IB32 = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateIndex(TEXT("WebGPUIndices32"), sizeof(Indices32), 4),
                          Indices32, sizeof(Indices32));
            Image = Target(RHI, Cmd, 2, 2);
            RHI.RHIUpdateTexture2D(Cmd, Image, 0, FUpdateTextureRegion2D(0, 0, 0, 0, 2, 2), 8, Palette);
            Cmd.TransitionLocal(RHI, FRHITransitionInfo(Image, ERHIAccess::RTV, ERHIAccess::SRVGraphicsPixel));
        }
        Submit(RHI);
        for (const auto Dimensions : {FIntPoint(64, 64), FIntPoint(96, 48)})
        {
            for (int32 IndexKind = 0; IndexKind < 2; ++IndexKind)
            {
                FTextureRHIRef Output;
                RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
                {
                    FWebGPUProbeCommandList Cmd(&RHI);
                    Output = Target(RHI, Cmd, Dimensions.X, Dimensions.Y);
                    Cmd.BeginRenderPass(FRHIRenderPassInfo(Output, ERenderTargetActions::Clear_Store),
                                        TEXT("WebGPUIndexed"));
                    BindPipeline(RHI, Cmd, Pipeline, NativePipeline);
                    Cmd.SetViewport(0, 0, 0, Dimensions.X, Dimensions.Y, 1);
                    Cmd.SetStreamSource(0, VB, 0);
                    const FRHIShaderParameterResource VertexResources[] = {{Uniform, 0}};
                    const FRHIShaderParameterResource PixelResources[] = {{Image, 0}, {Sampler, 1}};
                    Cmd.SetShaderParameters(Vertex, {}, {}, VertexResources, {});
                    Cmd.SetShaderParameters(Pixel, {}, {}, PixelResources, {});
                    Cmd.DrawIndexedPrimitive(IndexKind ? IB32.GetReference() : IB16.GetReference(), 0, 0, 4, 0, 2, 1);
                    Cmd.EndRenderPass();
                }
                Submit(RHI);
                TArray<FColor> Colors;
                RHI.RHIReadSurfaceData(Output, FIntRect(0, 0, Dimensions.X, Dimensions.Y), Colors, RawReadback());
                bool OK = Colors.Num() == Dimensions.X * Dimensions.Y;
                for (int32 Y = 0; Y < Dimensions.Y && OK; ++Y)
                    for (int32 X = 0; X < Dimensions.X && OK; ++X)
                    {
                        const uint8 *Expected =
                            Palette + ((Y >= Dimensions.Y / 2 ? 2 : 0) + (X >= Dimensions.X / 2 ? 1 : 0)) * 4;
                        const auto &Color = Colors[Y * Dimensions.X + X];
                        OK &= Color.R == Expected[0] && Color.G == Expected[1] && Color.B == Expected[2] &&
                              Color.A == Expected[3];
                        Checked += 4;
                    }
                Record(FString::Printf(TEXT("indexed%d-%dx%d"), IndexKind ? 32 : 16, Dimensions.X, Dimensions.Y), OK);
                if (OK && Dimensions.X == 64 && !IndexKind)
                {
                    TArray<uint8> Pixels;
                    for (const auto &Color : Colors)
                    {
                        Pixels.Add(Color.R);
                        Pixels.Add(Color.G);
                        Pixels.Add(Color.B);
                        Pixels.Add(Color.A);
                    }
                    FFileHelper::SaveArrayToFile(Pixels, *(OutputDirectory / TEXT("indexed-64x64.rgba")));
                }
            }
        }
        auto CheckPixels = [&](const FString &Name, FRHITexture *Texture, TFunctionRef<FColor(int32, int32)> Expected,
                               uint8 Tolerance = 0) {
            TArray<FColor> Colors;
            const int32 Width = Texture->GetSizeX(), Height = Texture->GetSizeY();
            RHI.RHIReadSurfaceData(Texture, FIntRect(0, 0, Width, Height), Colors, RawReadback());
            bool OK = Colors.Num() == Width * Height;
            for (int32 Y = 0; Y < Height && OK; ++Y)
                for (int32 X = 0; X < Width; ++X)
                {
                    const auto Want = Expected(X, Y), Have = Colors[Y * Width + X];
                    OK &= FMath::Abs(int32(Want.R) - Have.R) <= Tolerance &&
                          FMath::Abs(int32(Want.G) - Have.G) <= Tolerance &&
                          FMath::Abs(int32(Want.B) - Have.B) <= Tolerance &&
                          FMath::Abs(int32(Want.A) - Have.A) <= Tolerance;
                    Checked += 4;
                }
            Record(Name, OK);
        };
        {
            FTextureRHIRef Output, Copy;
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FWebGPUProbeCommandList Cmd(&RHI);
                Output = Target(RHI, Cmd, 64, 64);
                Copy = Target(RHI, Cmd, 64, 64);
                Cmd.BeginRenderPass(FRHIRenderPassInfo(Output, ERenderTargetActions::Clear_Store),
                                    TEXT("UniformSnapshot"));
                BindPipeline(RHI, Cmd, Pipeline, NativePipeline);
                Cmd.SetViewport(0, 0, 0, 64, 64, 1);
                Cmd.SetStreamSource(0, VB, 0);
                const FRHIShaderParameterResource VertexResources[] = {{Uniform, 0}};
                const FRHIShaderParameterResource PixelResources[] = {{Image, 0}, {Sampler, 1}};
                Cmd.SetShaderParameters(Vertex, {}, {}, VertexResources, {});
                Cmd.SetShaderParameters(Pixel, {}, {}, PixelResources, {});
                float Left[12];
                FMemory::Memcpy(Left, Rectangle, sizeof(Left));
                Left[0] = 0.5f;
                float Right[12];
                FMemory::Memcpy(Right, Left, sizeof(Right));
                Right[2] = 0.5f;
                RHI.RHIUpdateUniformBuffer(Cmd, Uniform, Left);
                Cmd.DrawIndexedPrimitive(IB16, 0, 0, 4, 0, 2, 1);
                RHI.RHIUpdateUniformBuffer(Cmd, Uniform, Right);
                Cmd.DrawIndexedPrimitive(IB16, 0, 0, 4, 0, 2, 1);
                Cmd.EndRenderPass();
                Cmd.TransitionLocal(RHI, FRHITransitionInfo(Output, ERHIAccess::RTV, ERHIAccess::CopySrc));
                Cmd.TransitionLocal(RHI, FRHITransitionInfo(Copy, ERHIAccess::RTV, ERHIAccess::CopyDest));
                Cmd.CopyTexture(Output, Copy, FRHICopyTextureInfo());
            }
            Submit(RHI);
            CheckPixels(TEXT("uniform-update-per-draw-and-texture-copy"), Copy, [&](int32 X, int32 Y) {
                const uint8 *P = Palette + ((Y >= 32 ? 2 : 0) + ((X % 32) >= 16 ? 1 : 0)) * 4;
                return FColor(P[0], P[1], P[2], P[3]);
            });
        }
        FGraphicsPipelineStateInitializer ClearPipeline;
        ClearPipeline.BoundShaderState.VertexShaderRHI = ClearVertex;
        ClearPipeline.BoundShaderState.PixelShaderRHI = ClearPixel;
        ClearPipeline.PrimitiveType = PT_TriangleStrip;
        ClearPipeline.RenderTargetsEnabled = 1;
        ClearPipeline.RenderTargetFormats[0] = PF_R8G8B8A8;
        ClearPipeline.NumSamples = 1;
        ClearPipeline.BlendState = Blend;
        ClearPipeline.RasterizerState = Rasterizer;
        ClearPipeline.DepthStencilState = NoDepth;
        auto ClearNative = RHI.RHICreateGraphicsPipelineState(ClearPipeline);
        {
            FTextureRHIRef Outputs[2];
            uint8 Inverted[16];
            for (uint32 Index = 0; Index < 16; ++Index)
                Inverted[Index] = Index % 4 == 3 ? 255 : 255 - Palette[Index];
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FWebGPUProbeCommandList Cmd(&RHI);
                RHI.RHIUpdateUniformBuffer(Cmd, Uniform, Rectangle);
                for (uint32 Index = 0; Index < 2; ++Index)
                {
                    if (Index)
                        RHI.RHIUpdateTexture2D(Cmd, Image, 0, FUpdateTextureRegion2D(0, 0, 0, 0, 2, 2), 8, Inverted);
                    Outputs[Index] = Target(RHI, Cmd, 64, 64);
                    Cmd.BeginRenderPass(FRHIRenderPassInfo(Outputs[Index], ERenderTargetActions::Clear_Store),
                                        TEXT("UploadOrdering"));
                    BindPipeline(RHI, Cmd, Pipeline, NativePipeline);
                    Cmd.SetViewport(0, 0, 0, 64, 64, 1);
                    Cmd.SetStreamSource(0, VB, 0);
                    const FRHIShaderParameterResource VertexResources[] = {{Uniform, 0}};
                    const FRHIShaderParameterResource PixelResources[] = {{Image, 0}, {Sampler, 1}};
                    Cmd.SetShaderParameters(Vertex, {}, {}, VertexResources, {});
                    Cmd.SetShaderParameters(Pixel, {}, {}, PixelResources, {});
                    Cmd.DrawIndexedPrimitive(IB16, 0, 0, 4, 0, 2, 1);
                    Cmd.EndRenderPass();
                }
            }
            Submit(RHI);
            for (uint32 Index = 0; Index < 2; ++Index)
                CheckPixels(Index ? TEXT("texture-update-after-draw") : TEXT("texture-update-preserves-earlier-draw"),
                            Outputs[Index], [&, Index](int32 X, int32 Y) {
                                const uint8 *P =
                                    (Index ? Inverted : Palette) + ((Y >= 32 ? 2 : 0) + (X >= 32 ? 1 : 0)) * 4;
                                return FColor(P[0], P[1], P[2], P[3]);
                            });
        }
        {
            FTextureRHIRef Output;
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FWebGPUProbeCommandList Cmd(&RHI);
                Output = Target(RHI, Cmd, 64, 64);
                Cmd.BeginRenderPass(FRHIRenderPassInfo(Output, ERenderTargetActions::Clear_Store),
                                    TEXT("ScissorSnapshots"));
                BindPipeline(RHI, Cmd, ClearPipeline, ClearNative);
                Cmd.SetStreamSource(0, nullptr, 0);
                Cmd.SetViewport(0, 0, 0, 64, 64, 1);
                ValueParameter(Cmd, ClearPixel.GetReference(), FVector4f(1, 0, 0, 1));
                Cmd.DrawPrimitive(0, 2, 1);
                Cmd.SetScissorRect(true, 0, 0, 32, 64);
                ValueParameter(Cmd, ClearPixel.GetReference(), FVector4f(0, 1, 0, 1));
                Cmd.DrawPrimitive(0, 2, 1);
                Cmd.SetScissorRect(true, 32, 32, 64, 64);
                ValueParameter(Cmd, ClearPixel.GetReference(), FVector4f(0, 0, 1, 1));
                Cmd.DrawPrimitive(0, 2, 1);
                Cmd.SetScissorRect(false, 0, 0, 0, 0);
                Cmd.EndRenderPass();
            }
            Submit(RHI);
            CheckPixels(TEXT("loose-parameter-snapshots-and-scissor"), Output, [](int32 X, int32 Y) {
                return X < 32 ? FColor::Green : Y < 32 ? FColor::Red : FColor::Blue;
            });
        }
        {
            auto DepthPipeline = ClearPipeline;
            DepthPipeline.BoundShaderState.VertexShaderRHI = DepthVertex;
            DepthPipeline.DepthStencilTargetFormat = PF_DepthStencil;
            auto DepthState = RHI.RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(true, CF_Greater));
            DepthPipeline.DepthStencilState = DepthState;
            auto Native = RHI.RHICreateGraphicsPipelineState(DepthPipeline);
            FTextureRHIRef Output, Depth;
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FWebGPUProbeCommandList Cmd(&RHI);
                Output = Target(RHI, Cmd, 64, 64);
                Depth = RHI.RHICreateTextureInitializer(
                               Cmd, FRHITextureCreateDesc::Create2D(TEXT("WebGPUDepth"), 64, 64, PF_DepthStencil)
                                        .SetFlags(ETextureCreateFlags::DepthStencilTargetable)
                                        .SetClearValue(FClearValueBinding(0.0f, 0))
                                        .SetInitialState(ERHIAccess::DSVWrite))
                            .Finalize();
                Cmd.BeginRenderPass(
                    FRHIRenderPassInfo(Output, ERenderTargetActions::Clear_Store, Depth,
                                       EDepthStencilTargetActions::ClearDepthStencil_StoreDepthNotStencil,
                                       FExclusiveDepthStencil::DepthWrite_StencilNop),
                    TEXT("ReversedZ"));
                BindPipeline(RHI, Cmd, DepthPipeline, Native);
                Cmd.SetViewport(0, 0, 0, 64, 64, 1);
                ValueParameter(Cmd, DepthVertex.GetReference(), 0.25f);
                ValueParameter(Cmd, ClearPixel.GetReference(), FVector4f(1, 0, 0, 1));
                Cmd.DrawPrimitive(0, 2, 1);
                ValueParameter(Cmd, DepthVertex.GetReference(), 0.75f);
                ValueParameter(Cmd, ClearPixel.GetReference(), FVector4f(0, 1, 0, 1));
                Cmd.DrawPrimitive(0, 2, 1);
                ValueParameter(Cmd, DepthVertex.GetReference(), 0.5f);
                ValueParameter(Cmd, ClearPixel.GetReference(), FVector4f(0, 0, 1, 1));
                Cmd.DrawPrimitive(0, 2, 1);
                Cmd.EndRenderPass();
            }
            Submit(RHI);
            CheckPixels(TEXT("reversed-z-depth-occlusion"), Output, [](int32, int32) { return FColor::Green; });
        }
        for (bool MaskOnly : {false, true})
        {
            auto StatePipeline = ClearPipeline;
            FBlendStateInitializerRHI::FRenderTarget TargetBlend;
            if (MaskOnly)
                TargetBlend.ColorWriteMask = EColorWriteMask(CW_RED | CW_GREEN);
            else
            {
                TargetBlend.ColorSrcBlend = BF_SourceAlpha;
                TargetBlend.ColorDestBlend = BF_InverseSourceAlpha;
            }
            auto State = RHI.RHICreateBlendState(FBlendStateInitializerRHI(TargetBlend));
            StatePipeline.BlendState = State;
            auto Native = RHI.RHICreateGraphicsPipelineState(StatePipeline);
            FTextureRHIRef Output;
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FWebGPUProbeCommandList Cmd(&RHI);
                Output = Target(RHI, Cmd, 32, 32);
                Cmd.BeginRenderPass(FRHIRenderPassInfo(Output, ERenderTargetActions::Clear_Store), TEXT("BlendState"));
                Cmd.SetViewport(0, 0, 0, 32, 32, 1);
                if (!MaskOnly)
                {
                    BindPipeline(RHI, Cmd, ClearPipeline, ClearNative);
                    ValueParameter(Cmd, ClearPixel.GetReference(), FVector4f(0, 0, 1, 1));
                    Cmd.DrawPrimitive(0, 2, 1);
                }
                BindPipeline(RHI, Cmd, StatePipeline, Native);
                ValueParameter(Cmd, ClearPixel.GetReference(),
                               MaskOnly ? FVector4f(1, 1, 1, 1) : FVector4f(1, 0, 0, 0.5f));
                Cmd.DrawPrimitive(0, 2, 1);
                Cmd.EndRenderPass();
            }
            Submit(RHI);
            CheckPixels(
                MaskOnly ? TEXT("color-write-mask") : TEXT("alpha-blend"), Output,
                [MaskOnly](int32, int32) { return MaskOnly ? FColor(255, 255, 0, 0) : FColor(128, 0, 128, 128); },
                MaskOnly ? 0 : 1);
        }
        {
            auto Compute = RHI.RHICreateComputeShader(
                FRHICreateShaderDesc(Packet(ShaderDirectory, TEXT("WebFallback_FClearReplacementCS_Buffer_Uint"))));
            auto ComputePSO = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Compute));
            FBufferRHIRef Storage, Copy;
            FUnorderedAccessViewRHIRef UAV;
            TArray<uint32> Sentinel;
            Sentinel.Init(0xa5a5a5a5, 256);
            FRHIViewDesc View;
            View.Common.ViewType = FRHIViewDesc::EViewType::BufferUAV;
            View.Buffer.UAV.BufferType = FRHIViewDesc::EBufferType::Structured;
            View.Buffer.UAV.OffsetInBytes = 256;
            View.Buffer.UAV.Stride = 4;
            View.Buffer.UAV.NumElements = 128;
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FWebGPUProbeCommandList Cmd(&RHI);
                Storage = Buffer(RHI, Cmd,
                                 FRHIBufferCreateDesc::Create(TEXT("WebGPUStorage"), 1024, 4,
                                                              BUF_StructuredBuffer | BUF_UnorderedAccess),
                                 Sentinel.GetData(), 1024);
                Copy = Buffer(RHI, Cmd,
                              FRHIBufferCreateDesc::CreateStructured(TEXT("WebGPUCopy"), 1024, 4)
                                  .SetInitialState(ERHIAccess::CopyDest),
                              Sentinel.GetData(), 1024);
                UAV = RHI.RHICreateUnorderedAccessView(Cmd, Storage, View);
                Cmd.OnBoundShaderChanged(Compute);
                Cmd.EnqueueLambda(
                    [&RHI, ComputePSO](FRHICommandListBase &) { RHI.RHISetComputePipelineState(ComputePSO); });
                const FRHIShaderParameterResource Resources[] = {{UAV, 1}};
                Cmd.SetShaderParameters(Compute, {}, {}, Resources, {});
                ValueParameter(Cmd, Compute.GetReference(), uint32(7));
                Cmd.DispatchComputeShader(2, 1, 1);
                Cmd.TransitionLocal(RHI, FRHITransitionInfo(UAV, ERHIAccess::UAVMask, ERHIAccess::CopySrc));
                Cmd.CopyBufferRegion(Copy, 128, Storage, 256, 256);
                Cmd.TransitionLocal(RHI, FRHITransitionInfo(Storage, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
                ValueParameter(Cmd, Compute.GetReference(), uint32(19));
                Cmd.DispatchComputeShader(2, 1, 1);
                Cmd.TransitionLocal(RHI, FRHITransitionInfo(UAV, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
                Cmd.CopyBufferRegion(Copy, 640, Storage, 512, 256);
            }
            Submit(RHI);
            const auto StorageBytes = RHI.ReadBuffer(Storage, 1024);
            const auto CopyBytes = RHI.ReadBuffer(Copy, 1024);
            bool StorageOK = StorageBytes.Num() == 1024, CopyOK = CopyBytes.Num() == 1024;
            for (int32 Index = 0; Index < 256; ++Index)
            {
                if (StorageOK)
                    StorageOK &= reinterpret_cast<const uint32 *>(StorageBytes.GetData())[Index] ==
                                 (Index >= 64 && Index < 192 ? 19u : 0xa5a5a5a5);
                if (CopyOK)
                    CopyOK &= reinterpret_cast<const uint32 *>(CopyBytes.GetData())[Index] ==
                              (Index >= 32 && Index < 96     ? 7u
                               : Index >= 160 && Index < 224 ? 19u
                                                             : 0xa5a5a5a5);
                Checked += 2;
            }
            Record(TEXT("compute-uav-subrange-and-dispatch-order"), StorageOK);
            Record(TEXT("buffer-copy-offsets-and-sentinels"), CopyOK);
            FString Error;
            auto Invalid = View;
            Invalid.Buffer.UAV.OffsetInBytes = 4;
            Record(TEXT("reject-uav-offset-alignment"), !RHI.ValidateUAV(Storage, Invalid, Error));
            Invalid = View;
            Invalid.Buffer.UAV.NumElements = 256;
            Record(TEXT("reject-uav-out-of-range"), !RHI.ValidateUAV(Storage, Invalid, Error));
            Invalid = View;
            Invalid.Buffer.UAV.BufferType = FRHIViewDesc::EBufferType::Typed;
            Record(TEXT("reject-unsupported-typed-uav"), !RHI.ValidateUAV(Storage, Invalid, Error));
        }
        {
            FTextureRHIRef Output;
            FDynamicRHI::FRHISubmitCommandListsArgs Batch;
            for (uint32 Index = 0; Index < 2; ++Index)
            {
                RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
                {
                    FWebGPUProbeCommandList Cmd(&RHI);
                    if (!Output)
                        Output = Target(RHI, Cmd, 32, 32);
                    Cmd.BeginRenderPass(FRHIRenderPassInfo(Output, ERenderTargetActions::Clear_Store),
                                        TEXT("BatchOrdering"));
                    BindPipeline(RHI, Cmd, ClearPipeline, ClearNative);
                    Cmd.SetViewport(0, 0, 0, 32, 32, 1);
                    ValueParameter(Cmd, ClearPixel.GetReference(),
                                   Index ? FVector4f(0, 1, 0, 1) : FVector4f(1, 0, 0, 1));
                    Cmd.DrawPrimitive(0, 2, 1);
                    Cmd.EndRenderPass();
                }
                FDynamicRHI::FRHIFinalizeContextsArgs Args;
                Args.Contexts[ERHIPipeline::Graphics] = &RHI;
                auto Finished = RHI.RHIFinalizeContexts(MoveTemp(Args));
                Batch.CommandLists.Add(Finished.CommandLists[ERHIPipeline::Graphics]);
            }
            RHI.RHISubmitCommandLists(MoveTemp(Batch));
            CheckPixels(TEXT("batched-finalize-submit-order"), Output, [](int32, int32) { return FColor::Green; });
        }
        {
            FWebGPUShaderData Rejected;
            FString Error;
            Record(TEXT("reject-wrong-shader-frequency"),
                   !RHI.LoadShader(FRHICreateShaderDesc(PixelBytes), SF_Vertex, Rejected, Error));
            auto Truncated = PixelBytes;
            Truncated.SetNum(27);
            Record(TEXT("reject-truncated-bytecode"),
                   !RHI.LoadShader(FRHICreateShaderDesc(Truncated), SF_Pixel, Rejected, Error));
            auto Corrupt = PixelBytes;
            reinterpret_cast<uint32 *>(Corrupt.GetData())[0] = 0;
            Record(TEXT("reject-bad-magic"), !RHI.LoadShader(FRHICreateShaderDesc(Corrupt), SF_Pixel, Rejected, Error));
            for (const auto &Case : {TPair<const TCHAR *, double>(TEXT("shaderPlatformPropertiesHash"), 1),
                                     {TEXT("shaderPlatformEnum"), 0},
                                     {TEXT("formatVersion"), 1},
                                     {TEXT("schema"), 2}})
            {
                const auto Invalid = ChangeMetadata(PixelBytes, Case.Key, Case.Value);
                Record(FString(TEXT("reject-metadata-")) + Case.Key,
                       !RHI.LoadShader(FRHICreateShaderDesc(Invalid), SF_Pixel, Rejected, Error));
            }
        }
        {
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            FTextureRHIRef Output;
            {
                FWebGPUProbeCommandList Cmd(&RHI);
                Output = Target(RHI, Cmd, 16, 16);
                Cmd.BeginRenderPass(FRHIRenderPassInfo(Output, ERenderTargetActions::Clear_Store),
                                    TEXT("AttachmentHazard"));
                Cmd.EnqueueLambda([&RHI, &Record, Output](FRHICommandListBase &) {
                    FString Error;
                    Record(TEXT("reject-sampling-active-render-attachment"),
                           !RHI.ValidateSampledTexture(Output, Error));
                });
                Cmd.EndRenderPass();
            }
            Submit(RHI);
        }
    }
    auto CoreCounters = MakeShared<FJsonObject>();
    CoreCounters->SetNumberField(TEXT("draws"), RHI.Draws);
    CoreCounters->SetNumberField(TEXT("dispatches"), RHI.Dispatches);
    CoreCounters->SetNumberField(TEXT("finalizedCommandLists"), RHI.Finalized);
    CoreCounters->SetNumberField(TEXT("submittedCommandLists"), RHI.Submitted);
    CoreCounters->SetNumberField(TEXT("bindGroups"), RHI.BoundGroups);
    CoreCounters->SetNumberField(TEXT("checkedValues"), Checked);
    const auto MaterialReport = RunWebGPUMaterialProbe(RHI, MaterialDirectory, OutputDirectory);
    Pass &= MaterialReport->GetBoolField(TEXT("pass"));
    const auto TransitionReport = RunWebGPUTransitionProbe(RHI, ShaderDirectory, OutputDirectory);
    Pass &= TransitionReport->GetBoolField(TEXT("pass"));
    RHI.GraphicsPipeline.SafeRelease();
    RHI.ComputePipeline.SafeRelease();
    for (uint32 Stream = 0; Stream < RHI.Limits.maxVertexBuffers; ++Stream)
        RHI.RHISetStreamSource(Stream, nullptr, 0);
    FRHICommandListExecutor::GetImmediateCommandList().ImmediateFlush(
        EImmediateFlushType::FlushRHIThreadFlushResources);
    RHI.RHIBlockUntilGPUIdle();
    wgpuInstanceProcessEvents(RHI.Instance);
    TArray<TSharedPtr<FJsonValue>> Errors;
    for (const auto &Error : RHI.Errors)
        Errors.Add(MakeShared<FJsonValueString>(Error));
    auto Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), Pass && RHI.Errors.IsEmpty());
    Report->SetStringField(TEXT("adapter"), RHI.AdapterName);
    Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
    Report->SetStringField(TEXT("probeRHI"), RHI.GetName());
    Report->SetBoolField(TEXT("globalRHIReplaced"), false);
    Report->SetBoolField(TEXT("completeUEScene"), false);
    Report->SetBoolField(TEXT("fullRHITransitionsImplemented"), false);
    Report->SetBoolField(TEXT("singleQueueTransitionsImplemented"), true);
    Report->SetBoolField(TEXT("materialResourceTableImplemented"), true);
    Report->SetBoolField(TEXT("fullLocalVertexFactoryImplemented"), false);
    Report->SetBoolField(TEXT("uniformViewImplemented"), false);
    Report->SetObjectField(TEXT("coreCounters"), CoreCounters);
    Report->SetObjectField(TEXT("material"), MaterialReport);
    Report->SetObjectField(TEXT("transitions"), TransitionReport);
    Report->SetNumberField(TEXT("transitionsCreated"), RHI.TransitionsCreated);
    Report->SetNumberField(TEXT("transitionsBegun"), RHI.TransitionsBegun);
    Report->SetNumberField(TEXT("transitionsEnded"), RHI.TransitionsEnded);
    Report->SetNumberField(TEXT("transitionsReleased"), RHI.TransitionsReleased);
    Report->SetNumberField(TEXT("pendingTransitionCount"), RHI.Transitions.Num());
    Report->SetNumberField(TEXT("resourceAccessChecks"), RHI.AccessChecks);
    Report->SetNumberField(TEXT("resourceTableBindings"), RHI.ResourceTableBindings);
    Report->SetStringField(TEXT("execution"), TEXT("Win64 native Dawn D3D12; browser engine execution is pending"));
    Report->SetStringField(TEXT("commandRecording"), TEXT("FRHICommandList_RecursiveHazardous -> IRHICommandContext"));
    Report->SetNumberField(TEXT("draws"), RHI.Draws);
    Report->SetNumberField(TEXT("dispatches"), RHI.Dispatches);
    Report->SetNumberField(TEXT("finalizedCommandLists"), RHI.Finalized);
    Report->SetNumberField(TEXT("submittedCommandLists"), RHI.Submitted);
    Report->SetNumberField(TEXT("bindGroups"), RHI.BoundGroups);
    Report->SetNumberField(TEXT("checkedValues"), Checked +
                                                      uint64(MaterialReport->GetNumberField(TEXT("checkedValues"))) +
                                                      uint64(TransitionReport->GetNumberField(TEXT("checkedValues"))));
    Report->SetArrayField(TEXT("checks"), Checks);
    Report->SetArrayField(TEXT("errors"), Errors);
    FString Json;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    FFileHelper::SaveStringToFile(Json, *(OutputDirectory / TEXT("rhi-results.json")),
                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    const bool Result = Pass && RHI.Errors.IsEmpty();
    RHI.Shutdown();
    return Result;
}

bool RunWebGPURHIProbe(const FString &ShaderDirectory, const FString &MaterialDirectory, const FString &OutputDirectory)
{
    bool Result = false;
    ENQUEUE_RENDER_COMMAND(WebGPURHIProbe)([&](FRHICommandListImmediate &) {
        Result = RunProbeOnRenderThread(ShaderDirectory, MaterialDirectory, OutputDirectory);
    });
    FlushRenderingCommands();
    return Result;
}

class FWebGPURHIModule final : public IWebGPURHIProbeModule
{
  public:
    bool IsSupported() override
    {
        return FParse::Param(FCommandLine::Get(), TEXT("WebRHIStartupProbe"));
    }
    bool IsSupported(ERHIFeatureLevel::Type Level) override
    {
        return Level == ERHIFeatureLevel::SM5 && IsSupported();
    }
    FDynamicRHI *CreateRHI(ERHIFeatureLevel::Type Level) override
    {
        const bool Startup = FParse::Param(FCommandLine::Get(), TEXT("WebRHIStartupProbe"));
        check(!Startup || Level == ERHIFeatureLevel::SM5);
        return new FWebGPUDynamicRHI(Startup);
    }
    bool RunProbe(const FString &Shaders, const FString &Materials, const FString &Output) override
    {
        if (FParse::Param(FCommandLine::Get(), TEXT("WebDistanceFieldRHIProbe")))
            return RunWebGPUDistanceFieldProbe(*this, Shaders, Output);
        if (FParse::Param(FCommandLine::Get(), TEXT("WebSkyResourceProbe")))
        {
            IFileManager::Get().MakeDirectory(*Output, true);
            return RunWebGPUSkyResourceProbe(*this, Output);
        }
        if (FParse::Param(FCommandLine::Get(), TEXT("WebMaterialOnlyProbe")))
        {
            bool Result = false;
            IFileManager::Get().MakeDirectory(*Output, true);
            ENQUEUE_RENDER_COMMAND(WebGPUMaterialOnlyProbe)([&](FRHICommandListImmediate &) {
                FWebGPUGlobalScope Scope(*this);
                auto Material = RunWebGPUMaterialProbe(*Scope.RHI, Materials, Output);
                Scope.PrepareShutdown();
                Result = Material->GetBoolField(TEXT("pass")) && Scope.RHI->Errors.IsEmpty();
                auto Report = MakeShared<FJsonObject>();
                Report->SetBoolField(TEXT("pass"), Result);
                Report->SetBoolField(TEXT("materialOnlyProbe"), true);
                Report->SetObjectField(TEXT("material"), Material);
                TArray<TSharedPtr<FJsonValue>> Errors;
                for (const auto &Error : Scope.RHI->Errors)
                    Errors.Add(MakeShared<FJsonValueString>(Error));
                Report->SetArrayField(TEXT("errors"), Errors);
                Scope.Restore();
                Report->SetBoolField(TEXT("hostRestored"), Scope.IsRestored());
                FString Json;
                FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
                check(FFileHelper::SaveStringToFile(Json, *(Output / TEXT("rhi-results.json")),
                                                   FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
            });
            FlushRenderingCommands();
            return Result;
        }
        return RunWebGPURHIProbe(Shaders, Materials, Output);
    }
    bool RunGlobalProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUGlobalProbe(*this, Shaders, Output);
    }
    bool RunViewportProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUViewportProbe(*this, Shaders, Output);
    }
    bool RunTextureSRVProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUTextureSRVProbe(*this, Shaders, Output);
    }
    bool RunBufferSRVProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUBufferSRVProbe(*this, Shaders, Output);
    }
    bool RunBufferUAVProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUBufferUAVProbe(*this, Shaders, Output);
    }
    bool RunUint4Probe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUUint4Probe(*this, Shaders, Output);
    }
    bool RunStructuredProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUStructuredProbe(*this, Shaders, Output);
    }
    bool RunFloat4Probe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUFloat4Probe(*this, Shaders, Output);
    }
    bool RunBufferLockProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUBufferLockProbe(*this, Shaders, Output);
    }
    bool RunTexture3DProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUTexture3DProbe(*this, Shaders, Output);
    }
    bool RunTextureUintProbe(const FString &Shaders, const FString &Output) override
    {
        return RunWebGPUTextureUintProbe(*this, Shaders, Output);
    }
};
IMPLEMENT_MODULE(FWebGPURHIModule, WebGPURHI);
