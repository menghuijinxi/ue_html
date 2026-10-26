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
#include "Math/PackedVector.h"
#include "RHIStats.h"

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
        if (FParse::Param(FCommandLine::Get(), TEXT("WebDesktopTextureProbe")))
        {
            auto Desc = FRHITextureCreateDesc::Create2DArray(TEXT("DesktopArrayProbe"), 4, 4, 2, PF_R32_UINT)
                .SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::UAV)
                .SetNumMips(3).SetInitialState(ERHIAccess::UAVCompute).SetInitActionInitializer();
            auto Init = Cmd.CreateTextureInitializer(Desc);
            for (int32 Layer = 0; Layer < 2; ++Layer)
            for (int32 Mip = 0; Mip < 3; ++Mip)
            {
                auto Subresource = Init.GetTexture2DArraySubresource(Layer, Mip);
                auto* Values = static_cast<uint32*>(Subresource.Data);
                for (uint64 Index = 0; Index < Subresource.Size / sizeof(uint32); ++Index)
                    Values[Index] = 0x11223344u + Layer * 0x10000u + Mip;
            }
            auto Array = Init.Finalize();
            const auto ReadArray = [&](bool Cleared) {
                Cmd.Transition(FRHITransitionInfo(Array, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                TArray<uint8> Packed;
                bool Match = true;
                for (uint32 Mip = 0; Mip < 3; ++Mip)
                {
                    const uint32 Size = 4u >> Mip, LayerBytes = 256u * Size;
                    auto Readback = RHI.CreateBuffer(LayerBytes * 2, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
                    auto Encoder = wgpuDeviceCreateCommandEncoder(RHI.Device, nullptr);
                    auto Src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
                    Src.texture = static_cast<FWebGPUTexture*>(Array.GetReference())->Handle;
                    Src.mipLevel = Mip;
                    auto Dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
                    Dst.buffer = Readback;
                    Dst.layout.bytesPerRow = 256;
                    Dst.layout.rowsPerImage = Size;
                    const WGPUExtent3D Extent{Size, Size, 2};
                    wgpuCommandEncoderCopyTextureToBuffer(Encoder, &Src, &Dst, &Extent);
                    auto Commands = wgpuCommandEncoderFinish(Encoder, nullptr);
                    wgpuQueueSubmit(RHI.Queue, 1, &Commands);
                    const auto Bytes = RHI.MapBuffer(Readback, LayerBytes * 2);
                    Match &= Bytes.Num() == LayerBytes * 2;
                    for (uint32 Layer = 0; Bytes.Num() == LayerBytes * 2 && Layer < 2; ++Layer)
                    for (uint32 Y = 0; Y < Size; ++Y)
                    for (uint32 X = 0; X < Size; ++X)
                    {
                        uint32 Value;
                        FMemory::Memcpy(&Value, Bytes.GetData() + Layer * LayerBytes + Y * 256 + X * 4, 4);
                        const uint32 Expected = Cleared && Layer == 1 && Mip == 1 ?
                            0xA1B2C3D4u : 0x11223344u + Layer * 0x10000u + Mip;
                        Match &= Value == Expected;
                        Packed.Append(reinterpret_cast<const uint8*>(&Value), sizeof(Value));
                        ++Checked;
                    }
                    wgpuCommandBufferRelease(Commands);
                    wgpuCommandEncoderRelease(Encoder);
                    wgpuBufferRelease(Readback);
                }
                const FString Name = Cleared ? TEXT("desktop-array-clear-range-isolation") :
                    TEXT("desktop-array-initializer-all-mips-and-layers");
                Record(Name, Match && Packed.Num() == 42 * sizeof(uint32));
                check(FFileHelper::SaveArrayToFile(Packed, *(Output / (Mode + TEXT("-") + Name + TEXT(".bin")))));
                Cmd.Transition(FRHITransitionInfo(Array, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
            };
            ReadArray(false);
            auto UAV = Cmd.CreateUnorderedAccessView(Array, FRHIViewDesc::CreateTextureUAV()
                .SetDimensionFromTexture(Array).SetMipLevel(1).SetArrayRange(1, 1));
            Cmd.ClearUAVUint(UAV, FUintVector4(0xA1B2C3D4u));
            ReadArray(true);
        }
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
        if (FParse::Param(FCommandLine::Get(), TEXT("WebTextureReflectionProbe")))
        {
            const TCHAR* Filters[] = {TEXT("Point"), TEXT("Bilinear"), TEXT("Trilinear")};
            for (uint32 Filter = 0; Filter < UE_ARRAY_COUNT(Filters); ++Filter)
            for (uint32 Wrap = 0; Wrap < 2; ++Wrap)
            {
                FJsonObject Binding;
                const FString Name = FString::Printf(TEXT("VulkanGlobal%s%sSampler"), Filters[Filter],
                    Wrap ? TEXT("Wrapped") : TEXT("Clamped"));
                Binding.SetStringField(TEXT("name"), Name);
                Binding.SetNumberField(TEXT("descriptorType"), 0);
                FRHIResource* Resource = nullptr;
                bool FromTable = false;
                const bool SamplerResolved = RHI.ResolveBinding(RHI.ShaderData(PS), Binding, Resource, FromTable, Error);
                auto* Global = SamplerResolved ? static_cast<FWebGPUSampler*>(Resource) : nullptr;
                const auto Address = Wrap ? AM_Wrap : AM_Clamp;
                Record(TEXT("reflection-global-sampler-") + Name, Global && !FromTable &&
                    Global->Initializer.Filter == ESamplerFilter(Filter) &&
                    Global->Initializer.AddressU == Address && Global->Initializer.AddressV == Address &&
                    Global->Initializer.AddressW == Address && RHI.ResolveSampler(Global));
            }
            auto Desc = FRHITextureCreateDesc::CreateCube(TEXT("ReflectionPackedCube"), 8, PF_FloatR11G11B10)
                .SetNumMips(4).SetFlags(ETextureCreateFlags::ShaderResource)
                .SetInitialState(ERHIAccess::SRVGraphicsPixel).SetInitActionInitializer();
            Record(TEXT("reflection-packed-cube-create-valid"), RHI.ValidateTextureInitialization(Desc, Error));
            auto Invalid = Desc;
            Invalid.Flags |= ETextureCreateFlags::RenderTargetable;
            Record(TEXT("reflection-packed-reject-render-target"), !RHI.ValidateTextureInitialization(Invalid, Error));
            Invalid = Desc;
            Invalid.Flags |= ETextureCreateFlags::SRGB;
            Record(TEXT("reflection-packed-reject-srgb"), !RHI.ValidateTextureInitialization(Invalid, Error));
            const FLinearColor Linear[] = {FLinearColor(1, 0, 0), FLinearColor(0, 0.5f, 0),
                FLinearColor(0, 0, 0.25f), FLinearColor(1, 0.5f, 0.25f)};
            const FColor Expected[] = {FColor(255, 0, 0), FColor(0, 128, 0),
                FColor(0, 0, 64), FColor(255, 128, 64)};
            auto Init = Cmd.CreateTextureInitializer(Desc);
            for (int32 Face = 0; Face < 6; ++Face)
            for (int32 Mip = 0; Mip < 4; ++Mip)
            {
                const auto Data = Init.GetTextureCubeSubresource(Face, Mip);
                const FFloat3Packed Value(Linear[(Face + Mip) % 4]);
                for (uint64 Offset = 0; Offset < Data.Size; Offset += sizeof(Value))
                    FMemory::Memcpy(static_cast<uint8*>(Data.Data) + Offset, &Value, sizeof(Value));
            }
            auto Cube = Init.Finalize();
            for (int32 Face = 0; Face < 6; ++Face)
            for (int32 Mip = 0; Mip < 4; ++Mip)
            {
                auto View = Cmd.CreateShaderResourceView(Cube, FRHIViewDesc::CreateTextureSRV()
                    .SetDimension(ETextureDimension::Texture2D).SetMipRange(Mip, 1).SetArrayRange(Face, 1));
                Draw(View);
                TArray<FColor> Colors;
                Cmd.ReadSurfaceData(Destination, FIntRect(0, 0, 16, 16), Colors, RawReadback());
                const FColor Want = Expected[(Face + Mip) % 4];
                Record(FString::Printf(TEXT("reflection-packed-face%d-mip%d"), Face, Mip),
                    Colors.Num() == 256 && Algo::AllOf(Colors, [&](FColor Value) {
                        return FMath::Abs(int32(Value.R) - Want.R) <= 1 &&
                            FMath::Abs(int32(Value.G) - Want.G) <= 1 &&
                            FMath::Abs(int32(Value.B) - Want.B) <= 1 && Value.A == 255;
                    }));
                Checked += Colors.Num() * 4;
            }
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
        if (FParse::Param(FCommandLine::Get(), TEXT("WebTextureStreamingProbe")))
        {
            // Exercise UE's actual reallocation path, including simultaneous IO destination locks.
            const uint16 Endpoints[] = {0xf800, 0x07e0, 0x001f, 0xffff};
            const FColor Solid[] = {FColor::Red, FColor::Green, FColor::Blue, FColor::White};
            for (const auto Format : {PF_R8G8B8A8, PF_DXT1})
            {
                const FString Prefix = Format == PF_DXT1 ? TEXT("stream-bc1-") : TEXT("stream-rgba8-");
                const auto Fill = [&](void* Data, uint64 Size, uint32 Mip) {
                    FMemory::Memzero(Data, Size);
                    for (uint64 Offset = 0; Offset < Size; Offset += Format == PF_DXT1 ? 8 : 4)
                    {
                        const auto Color = Solid[Mip % 4];
                        const uint8 Pixel[] = {Color.R, Color.G, Color.B, Color.A};
                        FMemory::Memcpy(static_cast<uint8*>(Data) + Offset,
                            Format == PF_DXT1 ? static_cast<const void*>(&Endpoints[Mip % 4]) : Pixel,
                            Format == PF_DXT1 ? 2 : 4);
                    }
                };
                auto Desc = FRHITextureCreateDesc::Create2D(TEXT("StreamingMipProbe"), 64, 64, Format)
                    .SetNumMips(7).SetFlags(ETextureCreateFlags::ShaderResource | ETextureCreateFlags::Streamable)
                    .SetInitialState(ERHIAccess::SRVMask).SetInitActionInitializer();
                auto Init = Cmd.CreateTextureInitializer(Desc);
                for (uint32 Mip = 0; Mip < 7; ++Mip)
                {
                    auto Data = Init.GetTexture2DSubresource(Mip);
                    Fill(Data.Data, Data.Size, Mip);
                }
                auto Full = Init.Finalize();
                const auto CheckMips = [&](FRHITexture* Texture, uint32 FirstMip, const FString& Stage) {
                    for (uint32 Mip = 0; Mip < Texture->GetNumMips(); ++Mip)
                    {
                        auto View = Cmd.CreateShaderResourceView(Texture, FRHIViewDesc::CreateTextureSRV()
                            .SetDimension(ETextureDimension::Texture2D).SetMipRange(Mip, 1));
                        Draw(View);
                        TArray<FColor> Colors;
                        Cmd.ReadSurfaceData(Destination, FIntRect(0, 0, 16, 16), Colors, RawReadback());
                        Record(Prefix + Stage + FString::Printf(TEXT("-mip%u"), Mip),
                            Colors.Num() == 256 && Algo::AllOf(Colors,
                                [&](FColor Color) { return Color == Solid[(FirstMip + Mip) % 4]; }));
                        Checked += Colors.Num() * 4;
                    }
                };
                CheckMips(Full, 0, TEXT("initial"));
                FThreadSafeCounter OutStatus(1);
                auto Small = Cmd.AsyncReallocateTexture2D(Full, 5, 16, 16, &OutStatus);
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                Record(Prefix + TEXT("stream-out-completed"), OutStatus.GetValue() == 0);
                CheckMips(Small, 2, TEXT("out"));
                FThreadSafeCounter InStatus(1);
                auto Large = Cmd.AsyncReallocateTexture2D(Small, 7, 64, 64, &InStatus);
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                Record(Prefix + TEXT("stream-in-reallocated"), InStatus.GetValue() == 0);
                auto Lock0 = FRHILockTextureArgs::Lock2D(Large, 0, RLM_WriteOnly, false);
                auto Lock1 = FRHILockTextureArgs::Lock2D(Large, 1, RLM_WriteOnly, false);
                auto Data0 = Cmd.LockTexture(Lock0);
                auto Data1 = Cmd.LockTexture(Lock1);
                Fill(Data0.Data, Data0.ByteCount, 0);
                Fill(Data1.Data, Data1.ByteCount, 1);
                Record(Prefix + TEXT("reject-sampling-during-multi-mip-io"),
                    !RHI.ValidateAccess(Large, ERHIAccess::SRVGraphicsPixel, Error));
                Cmd.UnlockTexture(Lock1);
                Cmd.UnlockTexture(Lock0);
                CheckMips(Large, 0, TEXT("in"));
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
                FTextureMemoryStats Before, During;
                RHI.RHIGetTextureMemoryStats(Before);
                FThreadSafeCounter CancelStatus(1);
                auto Cancelled = Cmd.AsyncReallocateTexture2D(Large, 5, 16, 16, &CancelStatus);
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                RHI.RHIGetTextureMemoryStats(During);
                Record(Prefix + TEXT("allocation-accounted"), During.StreamingMemorySize ==
                    Before.StreamingMemorySize + Align(Cancelled->GetDesc().CalcMemorySizeEstimate(), uint64(1024)));
                Cancelled.SafeRelease();
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
                RHI.RHIGetTextureMemoryStats(During);
                Record(Prefix + TEXT("cancelled-allocation-released"), During.StreamingMemorySize == Before.StreamingMemorySize);
                CheckMips(Large, 0, TEXT("after-cancel"));
            }
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
