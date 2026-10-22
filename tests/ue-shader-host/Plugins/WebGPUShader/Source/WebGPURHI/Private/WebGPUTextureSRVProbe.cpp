#include "WebGPUTextureSRVProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"

#include "HAL/FileManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderParameterMetadata.h"
#include "ShaderParameterMacros.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Algo/AllOf.h"

namespace
{
const FColor Pattern[] = {FColor(32, 64, 128, 255), FColor(191, 32, 64, 128), FColor(64, 191, 32, 64),
                          FColor(128, 64, 191, 32)};

FRHIViewDesc ViewDesc()
{
    FRHIViewDesc Desc;
    Desc.Common.ViewType = FRHIViewDesc::EViewType::TextureSRV;
    Desc.Texture.SRV.Dimension = FRHIViewDesc::EDimension::Texture2D;
    return Desc;
}

TSharedRef<FJsonObject> RunMode(IDynamicRHIModule &Module, const FString &Directory, const FString &Output, bool Bypass)
{
    using namespace WebGPUProbe;
    auto &Cmd = FRHICommandListImmediate::Get();
    FWebGPUGlobalScope Scope(Module);
    auto &RHI = *Scope.RHI;
    if (Bypass)
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                       ERHISubmitFlags::EnableBypass);
    const FString Mode = Bypass ? TEXT("bypass") : TEXT("recorded");
    bool Pass = true;
    uint64 Checked = 0;
    TArray<TSharedPtr<FJsonValue>> Checks;
    const auto Record = [&](const FString &Name, bool OK) {
        auto Check = MakeShared<FJsonObject>();
        Check->SetStringField(TEXT("name"), Name);
        Check->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Check));
        Pass &= OK;
        UE_LOG(LogRHI, Display, TEXT("P2_TEXTURE_SRV %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    {
        auto VS = RHICreateVertexShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FScreenVS"))));
        auto PS = RHICreatePixelShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FScreenPS"))));
        const float Vertices[] = {0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1};
        const uint16 Indices[] = {0, 2, 1, 1, 2, 3};
        auto VB = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("SRVVertices"), sizeof(Vertices)), Vertices,
                         sizeof(Vertices));
        auto IB = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateIndex(TEXT("SRVIndices"), sizeof(Indices), 2), Indices,
                         sizeof(Indices));
        FVertexDeclarationElementList Elements;
        Elements.Add(FVertexElement(0, 0, VET_Float2, 0, 16));
        Elements.Add(FVertexElement(0, 8, VET_Float2, 1, 16));
        const float Rectangle[] = {1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1};
        const auto *Metadata =
            FindUniformBufferStructByLayoutHash(RHI.ShaderData(VS).ResourceTable.ResourceTableLayoutHashes[0]);
        check(Metadata);
        auto Uniform = RHICreateUniformBuffer(Rectangle, &Metadata->GetLayout(), UniformBuffer_MultiFrame,
                                              EUniformBufferValidation::None);
        auto Sampler = RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Point, AM_Clamp, AM_Clamp));
        auto Blend = RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
        auto Raster = RHICreateRasterizerState(FRasterizerStateInitializerRHI(FM_Solid, CM_None, false));
        auto Depth = RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
        FGraphicsPipelineStateInitializer Pipeline;
        Pipeline.BoundShaderState.VertexDeclarationRHI = PipelineStateCache::GetOrCreateVertexDeclaration(Elements);
        Pipeline.BoundShaderState.VertexShaderRHI = VS;
        Pipeline.BoundShaderState.PixelShaderRHI = PS;
        Pipeline.PrimitiveType = PT_TriangleList;
        Pipeline.RenderTargetsEnabled = 1;
        Pipeline.RenderTargetFormats[0] = PF_R8G8B8A8;
        Pipeline.NumSamples = 1;
        Pipeline.BlendState = Blend;
        Pipeline.RasterizerState = Raster;
        Pipeline.DepthStencilState = Depth;
        auto Destination = Target(RHI, Cmd, 16, 16);
        const auto Draw = [&](FRHIResource *Resource) {
            Cmd.BeginRenderPass(FRHIRenderPassInfo(Destination, ERenderTargetActions::Clear_Store), TEXT("TextureSRV"));
            SetGraphicsPipelineState(Cmd, Pipeline, 0, EApplyRendertargetOption::DoNothing);
            Cmd.SetViewport(0, 0, 0, 16, 16, 1);
            Cmd.SetStreamSource(0, VB, 0);
            const FRHIShaderParameterResource VertexResources[] = {{Uniform, 0}};
            const FRHIShaderParameterResource PixelResources[] = {
                {Resource->GetType() == RRT_Texture ? FRHIShaderParameterResource::EType::Texture
                                                    : FRHIShaderParameterResource::EType::ResourceView,
                 Resource, 0},
                {Sampler, 1}};
            Cmd.SetShaderParameters(VS, {}, {}, VertexResources, {});
            Cmd.SetShaderParameters(PS, {}, {}, PixelResources, {});
            Cmd.DrawIndexedPrimitive(IB, 0, 0, 4, 0, 2, 1);
            Cmd.EndRenderPass();
        };
        const auto CheckImage = [&](const FString &Name) {
            TArray<FColor> Colors;
            Cmd.ReadSurfaceData(Destination, FIntRect(0, 0, 16, 16), Colors, RawReadback());
            bool OK = Colors.Num() == 256;
            TArray<uint8> Pixels;
            for (int32 Index = 0; Index < Colors.Num(); ++Index)
            {
                const auto Expected = Pattern[(Index / 16 >= 8 ? 2 : 0) + (Index % 16 >= 8 ? 1 : 0)];
                const auto Actual = Colors[Index];
                OK &= FMath::Abs(int32(Actual.R) - Expected.R) <= 1 && FMath::Abs(int32(Actual.G) - Expected.G) <= 1 &&
                      FMath::Abs(int32(Actual.B) - Expected.B) <= 1 && Actual.A == Expected.A;
                Pixels.Append({Actual.R, Actual.G, Actual.B, Actual.A});
                Checked += 4;
            }
            check(FFileHelper::SaveArrayToFile(Pixels, *(Output / (Mode + TEXT("-") + Name + TEXT(".rgba")))));
            Record(Name, OK);
        };
        const auto MakeTexture = [&](EPixelFormat Format) {
            auto Desc = FRHITextureCreateDesc::Create2D(TEXT("SRVPattern"), 2, 2, Format)
                            .SetFlags(ETextureCreateFlags::ShaderResource)
                            .SetInitialState(ERHIAccess::SRVGraphicsPixel)
                            .SetInitActionInitializer();
            auto Init = Cmd.CreateTextureInitializer(Desc);
            auto Subresource = Init.GetTexture2DSubresource(0);
            check(Subresource.Size == 16 && Subresource.Stride == 8);
            for (uint32 Index = 0; Index < 4; ++Index)
            {
                const auto Color = Pattern[Index];
                const uint8 Pixel[] = {Format == PF_B8G8R8A8 ? Color.B : Color.R, Color.G,
                                       Format == PF_B8G8R8A8 ? Color.R : Color.B, Color.A};
                FMemory::Memcpy(static_cast<uint8 *>(Subresource.Data) + Index * 4, Pixel, 4);
            }
            return Init.Finalize();
        };
        FString Error;
        auto Source = MakeTexture(PF_R8G8B8A8);
        const auto Default = ViewDesc();
        const auto Reject = [&](const TCHAR *Name, auto Change) {
            auto Desc = Default;
            Change(Desc.Texture.SRV);
            Record(Name, !RHI.ValidateTextureSRV(Source, Desc, Error));
        };
        Record(TEXT("reject-null-resource"), !RHI.ValidateTextureSRV(nullptr, Default, Error));
        Record(TEXT("reject-buffer-srv"), !RHI.ValidateTextureSRV(VB, FRHIViewDesc(), Error));
        auto UAVDesc = Default;
        UAVDesc.Common.ViewType = FRHIViewDesc::EViewType::TextureUAV;
        Record(TEXT("reject-uav-descriptor"), !RHI.ValidateTextureSRV(Source, UAVDesc, Error));
        Reject(TEXT("reject-unspecified-dimension"),
               [](auto &View) { View.Dimension = FRHIViewDesc::EDimension::Unknown; });
        Reject(TEXT("reject-cube-dimension"),
               [](auto &View) { View.Dimension = FRHIViewDesc::EDimension::TextureCube; });
        Reject(TEXT("reject-stencil-plane"), [](auto &View) { View.Plane = ERHITexturePlane::Stencil; });
        Reject(TEXT("reject-format-reinterpretation"), [](auto &View) { View.Format = PF_B8G8R8A8; });
        Reject(TEXT("reject-first-mip"), [](auto &View) {
            View.MipRange.First = 1;
            View.MipRange.Num = 1;
        });
        Reject(TEXT("reject-mip-count"), [](auto &View) { View.MipRange.Num = 2; });
        Reject(TEXT("reject-first-layer"), [](auto &View) {
            View.ArrayRange.First = 1;
            View.ArrayRange.Num = 1;
        });
        Reject(TEXT("reject-layer-count"), [](auto &View) { View.ArrayRange.Num = 2; });
        auto NoSampling = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("NoSRV"), 2, 2, PF_R8G8B8A8)
                                                .SetFlags(ETextureCreateFlags::RenderTargetable)
                                                .SetInitialState(ERHIAccess::RTV));
        Record(TEXT("reject-missing-shader-resource-capability"), !RHI.ValidateTextureSRV(NoSampling, Default, Error));
        auto *Native = static_cast<FWebGPUTexture *>(Source.GetReference());
        Native->SurfaceFrameActive = false;
        Record(TEXT("reject-expired-texture"), !RHI.ValidateTextureSRV(Source, Default, Error));
        Native->SurfaceFrameActive = true;
        auto TestView =
            Cmd.CreateShaderResourceView(Source, FRHIViewDesc::CreateTextureSRV().SetDimensionFromTexture(Source));
        FWebGPUTexture *Resolved;
        WGPUTextureView ResolvedView;
        Record(TEXT("resolve-srv-handle-and-underlying-texture"),
               RHI.ResolveSampledTexture(TestView, Resolved, ResolvedView, ERHIAccess::SRVGraphicsPixel, Error) &&
                   Resolved == Native &&
                   ResolvedView == static_cast<FWebGPUTextureSRV *>(TestView.GetReference())->Handle &&
                   ResolvedView != Native->View);
        Record(TEXT("reject-non-texture-binding"),
               !RHI.ResolveSampledTexture(Sampler, Resolved, ResolvedView, ERHIAccess::SRVGraphicsPixel, Error));
        RHI.Attachments.Add(Native);
        RHI.AttachmentSubresources.Emplace(0, 0);
        Record(TEXT("reject-srv-attachment-feedback"),
               !RHI.ResolveSampledTexture(TestView, Resolved, ResolvedView, ERHIAccess::SRVGraphicsPixel, Error));
        RHI.Attachments.Reset();
        RHI.AttachmentSubresources.Reset();
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::SRVGraphicsPixel, ERHIAccess::CopyDest));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-srv-access-mismatch"),
               !RHI.ResolveSampledTexture(TestView, Resolved, ResolvedView, ERHIAccess::SRVGraphicsPixel, Error));
        const FRHITransitionInfo Info(Source, ERHIAccess::CopyDest, ERHIAccess::SRVGraphicsPixel);
        auto *Transition = RHICreateTransition(FRHITransitionCreateInfo(
            ERHIPipeline::Graphics, ERHIPipeline::Graphics, ERHITransitionCreateFlags::None, MakeArrayView(&Info, 1)));
        Cmd.BeginTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-srv-during-split-transition"),
               !RHI.ResolveSampledTexture(TestView, Resolved, ResolvedView, ERHIAccess::SRVGraphicsPixel, Error));
        Cmd.EndTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("srv-valid-after-transition-end"),
               RHI.ResolveSampledTexture(TestView, Resolved, ResolvedView, ERHIAccess::SRVGraphicsPixel, Error));
        TestView.SafeRelease();
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
        Record(TEXT("released-view-drops-texture-reference"), Source->GetRefCount() == 1);
        Source.SafeRelease();
        for (auto Format : {PF_R8G8B8A8, PF_B8G8R8A8})
        {
            const FString Prefix = Format == PF_R8G8B8A8 ? TEXT("rgba8-") : TEXT("bgra8-");
            auto Texture = MakeTexture(Format);
            auto DefaultView = Cmd.CreateShaderResourceView(
                Texture, FRHIViewDesc::CreateTextureSRV().SetDimensionFromTexture(Texture));
            auto ExplicitView = Cmd.CreateShaderResourceView(Texture, FRHIViewDesc::CreateTextureSRV()
                                                                          .SetDimension(ETextureDimension::Texture2D)
                                                                          .SetFormat(Format)
                                                                          .SetMipRange(0, 1)
                                                                          .SetArrayRange(0, 1)
                                                                          .SetDisableSRGB(true));
            Record(Prefix + TEXT("views-retain-resource"), Texture->GetRefCount() == 3 &&
                                                               DefaultView->GetResource() == Texture &&
                                                               ExplicitView->GetDesc().Texture.SRV.MipRange.Num == 1);
            Draw(DefaultView);
            CheckImage(Prefix + TEXT("default-view"));
            Draw(Texture);
            CheckImage(Prefix + TEXT("direct-texture-rebind"));
            Draw(ExplicitView);
            Record(Prefix + TEXT("commands-obey-recording-mode"),
                   RHI.Draws == (Format == PF_R8G8B8A8 ? (Bypass ? 3u : 2u) : (Bypass ? 6u : 5u)));
            DefaultView.SafeRelease();
            ExplicitView.SafeRelease();
            Texture.SafeRelease();
            CheckImage(Prefix + TEXT("view-survives-caller-release"));
            auto &Data = RHI.ShaderData(PS);
            const auto *Bound = Data.Resources.Find(3u << 16);
            Record(Prefix + TEXT("shader-binding-retains-view"),
                   Bound && Bound->IsValid() && (*Bound)->GetType() == RRT_ShaderResourceView &&
                       static_cast<FRHIShaderResourceView *>(Bound->GetReference())->GetTexture()->GetRefCount() >= 1);
        }
        Record(TEXT("graphics-pso-reused-for-srv-and-texture"), RHI.GraphicsPipelinesCreated == 1 && RHI.Draws == 6);
        if (FParse::Param(FCommandLine::Get(), TEXT("WebTextureIESProbe")))
        {
            auto Desc = FRHITextureCreateDesc::Create2DArray(TEXT("IESArrayProbe"), 4, 4, 2, PF_R16F)
                .SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::RenderTargetable |
                    ETextureCreateFlags::TargetArraySlicesIndependently)
                .SetClearValue(FClearValueBinding(FLinearColor(0.5f, 0, 0, 1)))
                .SetInitialState(ERHIAccess::RTV);
            Record(TEXT("ies-array-create-valid"), RHI.ValidateTextureInitialization(Desc, Error));
            auto Invalid = Desc;
            Invalid.SetInitActionInitializer();
            Record(TEXT("ies-array-reject-cpu-initializer"), !RHI.ValidateTextureInitialization(Invalid, Error));
            Invalid = Desc;
            Invalid.NumMips = 2;
            Record(TEXT("ies-array-reject-multiple-mips"), !RHI.ValidateTextureInitialization(Invalid, Error));
            auto Atlas = Cmd.CreateTextureInitializer(Desc).Finalize();
            auto View = Cmd.CreateShaderResourceView(Atlas, FRHIViewDesc::CreateTextureSRV().SetDimensionFromTexture(Atlas));
            auto BadView = View->GetDesc();
            BadView.Texture.SRV.ArrayRange = {2, 1};
            Record(TEXT("ies-array-reject-slice-overflow"), !RHI.ValidateTextureSRV(Atlas, BadView, Error));
            FRHIRenderPassInfo AtlasPass(Atlas, ERenderTargetActions::Clear_Store);
            AtlasPass.ColorRenderTargets[0].ArraySlice = 1;
            Cmd.BeginRenderPass(AtlasPass, TEXT("IESArrayLayerClear"));
            Cmd.EndRenderPass();
            Cmd.Transition(FRHITransitionInfo(Atlas, ERHIAccess::RTV, ERHIAccess::CopySrc));
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            auto* Texture = static_cast<FWebGPUTexture*>(Atlas.GetReference());
            WGPUBufferDescriptor ReadDesc = WGPU_BUFFER_DESCRIPTOR_INIT;
            ReadDesc.size = 2048;
            ReadDesc.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
            auto Readback = wgpuDeviceCreateBuffer(RHI.Device, &ReadDesc);
            auto Encoder = wgpuDeviceCreateCommandEncoder(RHI.Device, nullptr);
            WGPUTexelCopyTextureInfo Src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            Src.texture = Texture->Handle;
            WGPUTexelCopyBufferInfo Dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            Dst.buffer = Readback;
            Dst.layout.bytesPerRow = 256;
            Dst.layout.rowsPerImage = 4;
            const WGPUExtent3D Size{4, 4, 2};
            wgpuCommandEncoderCopyTextureToBuffer(Encoder, &Src, &Dst, &Size);
            auto Commands = wgpuCommandEncoderFinish(Encoder, nullptr);
            wgpuQueueSubmit(RHI.Queue, 1, &Commands);
            const auto Bytes = RHI.MapBuffer(Readback, ReadDesc.size);
            bool Match = Bytes.Num() == ReadDesc.size;
            for (int32 Layer = 0; Match && Layer < 2; ++Layer)
            for (int32 Y = 0; Y < 4; ++Y)
            for (int32 X = 0; X < 4; ++X)
            {
                uint16 Value = 0;
                FMemory::Memcpy(&Value, Bytes.GetData() + Layer * 1024 + Y * 256 + X * 2, 2);
                Match &= Value == (Layer ? 0x3800 : 0);
            }
            Record(TEXT("ies-array-raster-clear-layer-isolation"), Match);
            wgpuCommandBufferRelease(Commands);
            wgpuCommandEncoderRelease(Encoder);
            wgpuBufferRelease(Readback);
            Cmd.Transition(FRHITransitionInfo(Atlas, ERHIAccess::CopySrc, ERHIAccess::SRVGraphicsPixel));
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            FRHIResource* Resource = View.GetReference();
            WGPUTextureView Handle;
            FWebGPUTexture* ResolvedAtlas;
            Record(TEXT("ies-array-srv-resolves-all-layers"),
                RHI.ResolveSampledTexture(Resource, ResolvedAtlas, Handle, ERHIAccess::SRVGraphicsPixel, Error));
        }
        if (FParse::Param(FCommandLine::Get(), TEXT("WebTextureBCProbe")))
        {
            Record(TEXT("bc-device-feature"), wgpuDeviceHasFeature(RHI.Device, WGPUFeatureName_TextureCompressionBC) != 0);
            auto Invalid = FRHITextureCreateDesc::Create2D(TEXT("InvalidBC"), 6, 8, PF_DXT1)
                .SetFlags(ETextureCreateFlags::ShaderResource);
            Record(TEXT("bc-reject-unaligned-base"), !RHI.ValidateTextureInitialization(Invalid, Error));
            Invalid.Extent.X = 8;
            Invalid.Flags |= ETextureCreateFlags::RenderTargetable;
            Record(TEXT("bc-reject-render-target"), !RHI.ValidateTextureInitialization(Invalid, Error));
            const uint16 Endpoints[] = {0xf800, 0x07e0, 0x001f, 0xffff};
            const FColor Solid[] = {FColor::Red, FColor::Green, FColor::Blue, FColor::White};
            const auto MakeBC = [&](EPixelFormat Format, bool Cube, bool SRGB) {
                auto Desc = Cube ? FRHITextureCreateDesc::CreateCube(TEXT("BCMipCube"), 8, Format) :
                    FRHITextureCreateDesc::Create2D(TEXT("BCMip2D"), 8, 8, Format);
                Desc.SetNumMips(4).SetFlags(ETextureCreateFlags::ShaderResource |
                    (SRGB ? ETextureCreateFlags::SRGB : ETextureCreateFlags::None))
                    .SetInitialState(ERHIAccess::SRVGraphicsPixel).SetInitActionInitializer();
                auto Init = Cmd.CreateTextureInitializer(Desc);
                for (int32 Face = 0; Face < (Cube ? 6 : 1); ++Face)
                for (int32 Mip = 0; Mip < 4; ++Mip)
                {
                    auto Data = Cube ? Init.GetTextureCubeSubresource(Face, Mip) : Init.GetTexture2DSubresource(Mip);
                    FMemory::Memzero(Data.Data, Data.Size);
                    if (Format == PF_DXT1)
                        for (uint64 Offset = 0; Offset < Data.Size; Offset += 8)
                            FMemory::Memcpy(static_cast<uint8*>(Data.Data) + Offset, &Endpoints[(Face + Mip) % 4], 2);
                }
                return Init.Finalize();
            };
            const auto CheckBC = [&](FRHITexture* Texture, bool Cube, const FString& Prefix) {
                for (int32 Face = 0; Face < (Cube ? 6 : 1); ++Face)
                for (int32 Mip = 0; Mip < 4; ++Mip)
                {
                    auto View = Cmd.CreateShaderResourceView(Texture, FRHIViewDesc::CreateTextureSRV()
                        .SetDimension(ETextureDimension::Texture2D).SetMipRange(Mip, 1).SetArrayRange(Face, 1));
                    Draw(View);
                    TArray<FColor> Colors;
                    Cmd.ReadSurfaceData(Destination, FIntRect(0, 0, 16, 16), Colors, RawReadback());
                    const auto Expected = Solid[(Face + Mip) % 4];
                    Record(FString::Printf(TEXT("%s-face%d-mip%d"), *Prefix, Face, Mip),
                        Colors.Num() == 256 && Algo::AllOf(Colors, [&](FColor Value) { return Value == Expected; }));
                    Checked += Colors.Num() * 4;
                }
            };
            for (auto Format : {PF_DXT1, PF_DXT3, PF_DXT5, PF_BC4, PF_BC5, PF_BC6H, PF_BC7})
            {
                auto Texture = MakeBC(Format, false, false);
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                Record(FString::Printf(TEXT("bc-format-%d-four-mip-upload"), int32(Format)), Texture.IsValid());
                if (Format == PF_DXT1)
                {
                    CheckBC(Texture, false, TEXT("bc1"));
                    auto Copy = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("BCMipCopy"), 8, 8, PF_DXT1)
                        .SetNumMips(4).SetFlags(ETextureCreateFlags::ShaderResource)
                        .SetInitialState(ERHIAccess::CopyDest));
                    Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::SRVGraphicsPixel, ERHIAccess::CopySrc));
                    FRHICopyTextureInfo CopyInfo;
                    CopyInfo.NumMips = 4;
                    Cmd.CopyTexture(Texture, Copy, CopyInfo);
                    Cmd.Transition(FRHITransitionInfo(Copy, ERHIAccess::CopyDest, ERHIAccess::SRVGraphicsPixel));
                    CheckBC(Copy, false, TEXT("bc1-copy"));
                }
            }
            auto Cube = MakeBC(PF_DXT1, true, false);
            CheckBC(Cube, true, TEXT("bc1-cube"));
            auto SRGB = MakeBC(PF_DXT1, false, true);
            Draw(SRGB);
            TArray<FColor> Colors;
            Cmd.ReadSurfaceData(Destination, FIntRect(0, 0, 16, 16), Colors, RawReadback());
            Record(TEXT("bc1-srgb-direct-sampling"), Colors.Num() == 256 &&
                Algo::AllOf(Colors, [](FColor Value) { return Value == FColor::Red; }));
        }
        RHI.ShaderData(PS).Resources.Reset();
    }
    Scope.PrepareShutdown();
    Record(TEXT("split-transitions-released"),
           RHI.TransitionsCreated == RHI.TransitionsReleased && RHI.TransitionsCreated >= 2 && RHI.Transitions.IsEmpty());
    Record(TEXT("gpu-validation-clean"), RHI.Errors.IsEmpty());
    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("mode"), Mode);
    Report->SetStringField(TEXT("adapter"), RHI.AdapterName);
    Report->SetNumberField(TEXT("checkedValues"), Checked);
    Report->SetNumberField(TEXT("draws"), RHI.Draws);
    Report->SetNumberField(TEXT("graphicsPipelinesCreated"), RHI.GraphicsPipelinesCreated);
    Report->SetNumberField(TEXT("finalizedCommandLists"), RHI.Finalized);
    Report->SetNumberField(TEXT("submittedCommandLists"), RHI.Submitted);
    Report->SetNumberField(TEXT("boundGroups"), RHI.BoundGroups);
    Report->SetNumberField(TEXT("transitionsReleased"), RHI.TransitionsReleased);
    TArray<TSharedPtr<FJsonValue>> Errors;
    for (const auto &Error : RHI.Errors)
        Errors.Add(MakeShared<FJsonValueString>(Error));
    Report->SetArrayField(TEXT("errors"), Errors);
    Scope.Restore();
    Record(TEXT("host-rhi-restored"), Scope.IsRestored());
    Report->SetArrayField(TEXT("checks"), Checks);
    Report->SetBoolField(TEXT("pass"), Pass);
    return Report;
}
} // namespace

bool RunWebGPUTextureSRVProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUTextureSRVProbe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("textureSRVDirectBindingVerified"), Pass);
        Report->SetBoolField(TEXT("generalBufferSRVImplemented"), false);
        Report->SetBoolField(TEXT("resourceTableSRVImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetArrayField(TEXT("modes"), Modes);
        FString Json;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
        check(FFileHelper::SaveStringToFile(Json, *(OutputDirectory / TEXT("texture-srv-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
