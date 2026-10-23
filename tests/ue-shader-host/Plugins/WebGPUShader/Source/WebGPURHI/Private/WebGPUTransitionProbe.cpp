#include "WebGPUTransitionProbe.h"
#include "WebGPUProbeUtils.h"
#include "ShaderParameterMetadata.h"
#include "ShaderParameterMacros.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

namespace
{
using namespace WebGPUProbe;
template <typename Shader, typename Value>
void ValueParameter(FRHICommandList &Cmd, Shader *InShader, const Value &InValue)
{
    const FRHIShaderParameter Parameter(0, 0, 0, sizeof(Value));
    Cmd.SetShaderParameters(InShader, MakeArrayView(reinterpret_cast<const uint8 *>(&InValue), sizeof(Value)),
                            MakeArrayView(&Parameter, 1), {}, {});
}
} // namespace

TSharedRef<FJsonObject> RunWebGPUTransitionProbe(FWebGPUDynamicRHI &RHI, const FString &Directory,
                                                 const FString &OutputDirectory)
{
    const uint32 StartDraws = RHI.Draws, StartDispatches = RHI.Dispatches, StartGroups = RHI.BoundGroups;
    const uint32 StartCreated = RHI.TransitionsCreated, StartBegun = RHI.TransitionsBegun,
                 StartEnded = RHI.TransitionsEnded, StartReleased = RHI.TransitionsReleased,
                 StartAccessChecks = RHI.AccessChecks;
    TArray<TSharedPtr<FJsonValue>> Checks;
    uint64 Checked = 0;
    bool Pass = true;
    const auto Record = [&](const FString &Name, bool OK) {
        auto Check = MakeShared<FJsonObject>();
        Check->SetStringField(TEXT("name"), Name);
        Check->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Check));
        UE_LOG(LogRHI, Display, TEXT("P2_TRANSITION %s pass=%d"), *Name, OK);
        Pass &= OK;
    };
    const auto CheckAccess = [&](FRHIViewableResource *Resource, ERHIAccess Access) {
        FString Error;
        return RHI.ValidateAccess(Resource, Access, Error);
    };
    const auto RejectUse = [&](const TCHAR *Name, FRHIViewableResource *Resource, ERHIAccess Access,
                               bool Internal = false) {
        FString Error;
        Record(Name, !RHI.ValidateAccess(Resource, Access, Error, Internal) && !Error.IsEmpty());
    };
    auto VS = RHI.RHICreateVertexShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FScreenVS"))));
    auto PS = RHI.RHICreatePixelShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FScreenPS"))));
    auto ClearVS = RHI.RHICreateVertexShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementVS"))));
    auto ClearPS = RHI.RHICreatePixelShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementPS"))));
    auto Sampler = RHI.RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Point, AM_Clamp, AM_Clamp));
    auto Blend = RHI.RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
    auto Rasterizer = RHI.RHICreateRasterizerState(FRasterizerStateInitializerRHI(FM_Solid, CM_None, false));
    auto Depth = RHI.RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
    FGraphicsPipelineStateInitializer Screen;
    FVertexDeclarationElementList Elements;
    Elements.Add(FVertexElement(0, 0, VET_Float2, 0, 16));
    Elements.Add(FVertexElement(0, 8, VET_Float2, 1, 16));
    auto Declaration = RHI.RHICreateVertexDeclaration(Elements);
    Screen.BoundShaderState.VertexDeclarationRHI = Declaration;
    Screen.BoundShaderState.VertexShaderRHI = VS;
    Screen.BoundShaderState.PixelShaderRHI = PS;
    Screen.PrimitiveType = PT_TriangleList;
    Screen.RenderTargetsEnabled = 1;
    Screen.RenderTargetFormats[0] = PF_R8G8B8A8;
    Screen.NumSamples = 1;
    Screen.BlendState = Blend;
    Screen.RasterizerState = Rasterizer;
    Screen.DepthStencilState = Depth;
    auto ScreenPSO = RHI.RHICreateGraphicsPipelineState(Screen);
    auto Clear = Screen;
    Clear.BoundShaderState.VertexDeclarationRHI = nullptr;
    Clear.BoundShaderState.VertexShaderRHI = ClearVS;
    Clear.BoundShaderState.PixelShaderRHI = ClearPS;
    Clear.PrimitiveType = PT_TriangleStrip;
    auto ClearPSO = RHI.RHICreateGraphicsPipelineState(Clear);
    const float Vertices[] = {0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1};
    const uint16 Indices[] = {0, 2, 1, 1, 2, 3};
    const float Rectangle[] = {1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1};
    const auto *Metadata =
        FindUniformBufferStructByLayoutHash(RHI.ShaderData(VS).ResourceTable.ResourceTableLayoutHashes[0]);
    check(Metadata && Metadata->GetLayout().ConstantBufferSize == sizeof(Rectangle));
    auto Uniform = RHI.RHICreateUniformBuffer(Rectangle, &Metadata->GetLayout(), UniformBuffer_MultiFrame,
                                              EUniformBufferValidation::None);
    FBufferRHIRef VB, IB;
    FTextureRHIRef Source, Sampled, Copy, Other;
    const auto ClearTarget = [&](FCommandList &Cmd, FRHITexture *Texture, const FVector4f &Color) {
        Cmd.BeginRenderPass(FRHIRenderPassInfo(Texture, ERenderTargetActions::Clear_Store), TEXT("TransitionClear"));
        BindPipeline(RHI, Cmd, Clear, ClearPSO);
        for (uint32 Index = 0; Index < 3; ++Index)
            Cmd.SetStreamSource(Index, nullptr, 0);
        Cmd.SetViewport(0, 0, 0, 64, 64, 1);
        ValueParameter(Cmd, ClearPS.GetReference(), Color);
        Cmd.DrawPrimitive(0, 2, 1);
        Cmd.EndRenderPass();
    };
    FRHITransition *Split = nullptr, *Competing = nullptr;
    RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
    {
        FCommandList Cmd(&RHI);
        VB = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("TransitionVertices"), sizeof(Vertices)),
                    Vertices, sizeof(Vertices));
        IB = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateIndex(TEXT("TransitionIndices"), sizeof(Indices), 2), Indices,
                    sizeof(Indices));
        Source = Target(RHI, Cmd, 64, 64);
        Sampled = Target(RHI, Cmd, 64, 64);
        Copy = Target(RHI, Cmd, 64, 64);
        Other = Target(RHI, Cmd, 16, 16);
        ClearTarget(Cmd, Source, FVector4f(0.25f, 0.5f, 0.75f, 1));
        Cmd.EnqueueLambda([&](FRHICommandListBase &) {
            RejectUse(TEXT("reject-sampling-without-transition"), Source, ERHIAccess::SRVGraphicsPixel);
            RejectUse(TEXT("reject-copy-source-without-transition"), Source, ERHIAccess::CopySrc);
        });
        const FRHITransitionInfo Info(Source, ERHIAccess::RTV, ERHIAccess::SRVGraphicsPixel);
        Split = Cmd.CreateLocalTransition(RHI, MakeArrayView(&Info, 1));
        const FRHITransitionInfo CompetingInfo(Source, ERHIAccess::Unknown, ERHIAccess::SRVGraphicsPixel);
        Competing = Cmd.CreateLocalTransition(RHI, MakeArrayView(&CompetingInfo, 1));
        Cmd.EnqueueLambda([&](FRHICommandListBase &) {
            FString Error;
            const FRHITransition *Batch[] = {Split};
            Record(TEXT("reject-end-before-begin"), !RHI.ValidateTransitionBatch(Batch, false, Error));
            Record(TEXT("reject-release-before-end"), !RHI.ValidateTransitionRelease(Split, Error));
        });
        Cmd.BeginTransition(Split);
        Cmd.EnqueueLambda([&](FRHICommandListBase &) {
            FString Error;
            const FRHITransition *Batch[] = {Split};
            Record(TEXT("reject-double-begin"), !RHI.ValidateTransitionBatch(Batch, true, Error));
            const FRHITransition *CompetingBatch[] = {Competing};
            Record(TEXT("reject-overlapping-transition"), !RHI.ValidateTransitionBatch(CompetingBatch, true, Error));
            RejectUse(TEXT("reject-resource-use-during-split"), Source, ERHIAccess::RTV);
            RejectUse(TEXT("reject-readback-during-split"), Source, ERHIAccess::CopySrc, true);
            Record(TEXT("split-begin-keeps-old-state"),
                   RHI.ResourceState(Source).Access == ERHIAccess::RTV && RHI.ResourceState(Source).Pending == Split);
        });
    }
    RHI.SubmitCurrent();
    Record(TEXT("split-pending-survives-submit"), RHI.ResourceState(Source).Pending == Split);
    RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
    {
        FCommandList Cmd(&RHI);
        Cmd.EndTransition(Split);
        Cmd.EnqueueLambda([&](FRHICommandListBase &) {
            FString Error;
            const FRHITransition *Batch[] = {Split};
            Record(TEXT("reject-double-end"), !RHI.ValidateTransitionBatch(Batch, false, Error));
            Record(TEXT("split-end-enables-sampling"), CheckAccess(Source, ERHIAccess::SRVGraphicsPixel));
        });
        Cmd.ReleaseLocalTransition(RHI, Split);
        Cmd.BeginTransition(Competing);
        Cmd.EndTransition(Competing);
        Cmd.ReleaseLocalTransition(RHI, Competing);
        const FRHITransitionInfo PassInfo(Other, ERHIAccess::RTV, ERHIAccess::RTV);
        auto *PassTransition = Cmd.CreateLocalTransition(RHI, MakeArrayView(&PassInfo, 1));
        Cmd.BeginRenderPass(FRHIRenderPassInfo(Sampled, ERenderTargetActions::Clear_Store), TEXT("TransitionSampling"));
        BindPipeline(RHI, Cmd, Screen, ScreenPSO);
        Cmd.SetViewport(0, 0, 0, 64, 64, 1);
        Cmd.SetStreamSource(0, VB, 0);
        const FRHIShaderParameterResource VertexResources[] = {{Uniform, 0}};
        const FRHIShaderParameterResource PixelResources[] = {{Source, 0}, {Sampler, 1}};
        Cmd.SetShaderParameters(VS, {}, {}, VertexResources, {});
        Cmd.SetShaderParameters(PS, {}, {}, PixelResources, {});
        Cmd.DrawIndexedPrimitive(IB, 0, 0, 4, 0, 2, 1);
        Cmd.EnqueueLambda([&, PassTransition](FRHICommandListBase &) {
            FString Error;
            const FRHITransition *PassBatch[] = {PassTransition};
            Record(TEXT("reject-transition-inside-render-pass"), !RHI.ValidateTransitionBatch(PassBatch, true, Error));
            RejectUse(TEXT("reject-internal-copy-inside-render-pass"), Source, ERHIAccess::CopySrc, true);
            RejectUse(TEXT("reject-active-attachment-sampling"), Sampled, ERHIAccess::SRVGraphicsPixel);
        });
        Cmd.EndRenderPass();
        Cmd.BeginTransition(PassTransition);
        Cmd.EndTransition(PassTransition);
        Cmd.ReleaseLocalTransition(RHI, PassTransition);
        const FRHITransitionInfo Infos[] = {
            {Source, ERHIAccess::SRVGraphicsPixel, ERHIAccess::CopySrc},
            {Copy, ERHIAccess::RTV, ERHIAccess::CopyDest},
        };
        auto *Batch = Cmd.CreateLocalTransition(RHI, Infos);
        Cmd.BeginTransition(Batch);
        Cmd.EndTransition(Batch);
        Cmd.ReleaseLocalTransition(RHI, Batch);
        Cmd.CopyTexture(Source, Copy, FRHICopyTextureInfo());
        Cmd.TransitionLocal(
            RHI, FRHITransitionInfo(Source, ERHIAccess::CopySrc, ERHIAccess::CopySrc | ERHIAccess::SRVGraphicsPixel));
        Cmd.EnqueueLambda([&](FRHICommandListBase &) {
            Record(TEXT("combined-read-states"),
                   CheckAccess(Source, ERHIAccess::CopySrc) && CheckAccess(Source, ERHIAccess::SRVGraphicsPixel));
        });
        Cmd.TransitionLocal(RHI, FRHITransitionInfo(Copy, ERHIAccess::Unknown, ERHIAccess::SRVGraphicsPixel));
        Cmd.EnqueueLambda([&](FRHICommandListBase &) {
            Record(TEXT("unknown-before-resolves-current-state"), CheckAccess(Copy, ERHIAccess::SRVGraphicsPixel));
        });
        Cmd.TransitionLocal(
            RHI, FRHITransitionInfo(Source, ERHIAccess::CopySrc | ERHIAccess::SRVGraphicsPixel, ERHIAccess::RTV));
        ClearTarget(Cmd, Source, FVector4f(1, 0.25f, 0, 1));
    }
    RHI.SubmitCurrent();
    const auto CheckImage = [&](const TCHAR *Name, FRHITexture *Texture, FColor Expected, bool Save) {
        const auto Previous = RHI.ResourceState(Texture).Access;
        TArray<FColor> Colors;
        RHI.RHIReadSurfaceData(Texture, FIntRect(0, 0, 64, 64), Colors, RawReadback());
        bool OK = Colors.Num() == 4096;
        for (const auto &Color : Colors)
        {
            OK &= FMath::Abs(int32(Color.R) - Expected.R) <= 1 && FMath::Abs(int32(Color.G) - Expected.G) <= 1 &&
                  FMath::Abs(int32(Color.B) - Expected.B) <= 1 && Color.A == Expected.A;
            Checked += 4;
        }
        Record(Name, OK && RHI.ResourceState(Texture).Access == Previous);
        if (Save)
        {
            TArray<uint8> Bytes;
            for (const auto &Color : Colors)
            {
                Bytes.Add(Color.R);
                Bytes.Add(Color.G);
                Bytes.Add(Color.B);
                Bytes.Add(Color.A);
            }
            check(FFileHelper::SaveArrayToFile(Bytes, *(OutputDirectory / TEXT("transition-sampled-64x64.rgba"))));
        }
    };
    CheckImage(TEXT("rtv-to-srv-sampled-pixels"), Sampled, FColor(64, 128, 191, 255), true);
    CheckImage(TEXT("copy-preserves-earlier-render"), Copy, FColor(64, 128, 191, 255), false);
    CheckImage(TEXT("return-to-rtv-reuses-target"), Source, FColor(255, 64, 0, 255), false);
    {
        auto DepthVS =
            RHI.RHICreateVertexShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementVS_Depth"))));
        auto WriteState = RHI.RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(true, CF_Greater));
        auto ReadState = RHI.RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Greater));
        auto WritePipeline = Clear;
        WritePipeline.BoundShaderState.VertexShaderRHI = DepthVS;
        WritePipeline.DepthStencilTargetFormat = PF_DepthStencil;
        WritePipeline.DepthStencilState = WriteState;
        auto ReadPipeline = WritePipeline;
        ReadPipeline.DepthStencilState = ReadState;
        auto WritePSO = RHI.RHICreateGraphicsPipelineState(WritePipeline);
        auto ReadPSO = RHI.RHICreateGraphicsPipelineState(ReadPipeline);
        const bool TestOcclusion = FParse::Param(FCommandLine::Get(), TEXT("WebOcclusionProbe"));
        auto HiddenQuery = TestOcclusion ? RHI.RHICreateRenderQuery(RQT_Occlusion) : FRenderQueryRHIRef();
        auto VisibleQuery = TestOcclusion ? RHI.RHICreateRenderQuery(RQT_Occlusion) : FRenderQueryRHIRef();
        FTextureRHIRef Color, DepthTexture;
        RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        {
            FCommandList Cmd(&RHI);
            Color = Target(RHI, Cmd, 64, 64);
            DepthTexture = RHI.RHICreateTextureInitializer(
                                  Cmd, FRHITextureCreateDesc::Create2D(TEXT("TransitionDepth"), 64, 64, PF_DepthStencil)
                                           .SetFlags(ETextureCreateFlags::DepthStencilTargetable)
                                           .SetClearValue(FClearValueBinding(0.f, 0))
                                           .SetInitialState(ERHIAccess::DSVWrite))
                               .Finalize();
            Cmd.BeginRenderPass(FRHIRenderPassInfo(Color, ERenderTargetActions::Clear_Store, DepthTexture,
                                                   EDepthStencilTargetActions::ClearDepthStencil_StoreDepthNotStencil,
                                                   FExclusiveDepthStencil::DepthWrite_StencilNop),
                                TEXT("TransitionDepthWrite"));
            BindPipeline(RHI, Cmd, WritePipeline, WritePSO);
            for (uint32 Stream = 0; Stream < 3; ++Stream)
                Cmd.SetStreamSource(Stream, nullptr, 0);
            Cmd.SetViewport(0, 0, 0, 64, 64, 1);
            ValueParameter(Cmd, DepthVS.GetReference(), 0.75f);
            ValueParameter(Cmd, ClearPS.GetReference(), FVector4f(0, 1, 0, 1));
            Cmd.DrawPrimitive(0, 2, 1);
            Cmd.EndRenderPass();
            Cmd.TransitionLocal(RHI, FRHITransitionInfo(DepthTexture, ERHIAccess::DSVWrite, ERHIAccess::DSVRead));
            const auto DepthLoad = MakeDepthStencilTargetActions(ERenderTargetActions::Load_Store,
                                                                 ERenderTargetActions::DontLoad_DontStore);
            FRHIRenderPassInfo ReadPass(Color, ERenderTargetActions::Load_Store, DepthTexture, DepthLoad,
                FExclusiveDepthStencil::DepthRead_StencilNop);
            ReadPass.NumOcclusionQueries = TestOcclusion ? 2 : 0;
            Cmd.BeginRenderPass(ReadPass, TEXT("TransitionDepthRead"));
            Cmd.EnqueueLambda([&](FRHICommandListBase &) {
                FString Error;
                Record(TEXT("reject-depth-write-in-read-only-pass"), !RHI.ValidatePipelineDepth(WritePipeline, Error));
            });
            BindPipeline(RHI, Cmd, ReadPipeline, ReadPSO);
            Cmd.SetViewport(0, 0, 0, 64, 64, 1);
            ValueParameter(Cmd, DepthVS.GetReference(), 0.5f);
            ValueParameter(Cmd, ClearPS.GetReference(), FVector4f(1, 0, 0, 1));
            if (TestOcclusion) Cmd.BeginRenderQuery(HiddenQuery);
            Cmd.DrawPrimitive(0, 2, 1);
            if (TestOcclusion)
            {
                Cmd.EndRenderQuery(HiddenQuery);
                ValueParameter(Cmd, DepthVS.GetReference(), 0.9f);
                ValueParameter(Cmd, ClearPS.GetReference(), FVector4f(0, 1, 0, 1));
                Cmd.BeginRenderQuery(VisibleQuery);
                Cmd.DrawPrimitive(0, 2, 1);
                Cmd.EndRenderQuery(VisibleQuery);
            }
            Cmd.EndRenderPass();
            FRHITransitionInfo Planes[] = {
                FRHITransitionInfo(DepthTexture, ERHIAccess::DSVRead, ERHIAccess::DSVWrite),
                FRHITransitionInfo(DepthTexture, ERHIAccess::DSVRead, ERHIAccess::DSVRead)
            };
            Planes[0].PlaneSlice = 0;
            Planes[1].PlaneSlice = 1;
            auto *SplitPlanes = Cmd.CreateLocalTransition(RHI, Planes,
                ERHITransitionCreateFlags::NoFence | ERHITransitionCreateFlags::AllowDecayPipelines);
            Cmd.BeginTransition(SplitPlanes);
            Cmd.EnqueueLambda([&](FRHICommandListBase &) {
                FString Error;
                Record(TEXT("depth-stencil-split-pending"),
                    !RHI.ValidateAccess(DepthTexture, ERHIAccess::DSVRead, Error, false, 0) &&
                    !RHI.ValidateAccess(DepthTexture, ERHIAccess::DSVRead, Error, false, 1));
            });
            Cmd.EndTransition(SplitPlanes);
            Cmd.ReleaseLocalTransition(RHI, SplitPlanes);
            Cmd.EnqueueLambda([&](FRHICommandListBase &) {
                Record(TEXT("depth-stencil-independent-states"),
                    RHI.ResourceState(DepthTexture, 0).Access == ERHIAccess::DSVWrite &&
                    RHI.ResourceState(DepthTexture, 1).Access == ERHIAccess::DSVRead &&
                    !RHI.ResourceState(DepthTexture, 0).Pending &&
                    !RHI.ResourceState(DepthTexture, 1).Pending);
            });
            Cmd.TransitionLocal(RHI, FRHITransitionInfo(DepthTexture, ERHIAccess::Unknown, ERHIAccess::DSVRead));
            Cmd.EnqueueLambda([&](FRHICommandListBase &) {
                Record(TEXT("depth-stencil-whole-resource-transition"),
                    RHI.ResourceState(DepthTexture, 0).Access == ERHIAccess::DSVRead &&
                    RHI.ResourceState(DepthTexture, 1).Access == ERHIAccess::DSVRead);
            });
        }
        if (TestOcclusion)
        {
            uint64 Samples = MAX_uint64;
            Record(TEXT("occlusion-unsubmitted-is-unavailable"),
                !RHI.RHIGetRenderQueryResult(HiddenQuery, Samples, false, 0) && Samples == MAX_uint64);
        }
        RHI.SubmitCurrent();
        if (TestOcclusion)
        {
            uint64 Hidden = MAX_uint64, Visible = 0;
            Record(TEXT("occlusion-depth-rejects-hidden"),
                RHI.RHIGetRenderQueryResult(HiddenQuery, Hidden, true, 0) && Hidden == 0);
            Record(TEXT("occlusion-depth-passes-visible"),
                RHI.RHIGetRenderQueryResult(VisibleQuery, Visible, true, 0) && Visible > 0);
            uint64 Again = 0;
            Record(TEXT("occlusion-result-can-be-read-again"),
                RHI.RHIGetRenderQueryResult(VisibleQuery, Again, false, 0) && Again == Visible);
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FCommandList Cmd(&RHI);
                const auto DepthLoad = MakeDepthStencilTargetActions(ERenderTargetActions::Load_Store,
                    ERenderTargetActions::DontLoad_DontStore);
                FRHIRenderPassInfo ReusePass(Color, ERenderTargetActions::Load_Store, DepthTexture, DepthLoad,
                    FExclusiveDepthStencil::DepthRead_StencilNop);
                ReusePass.NumOcclusionQueries = 2;
                Cmd.BeginRenderPass(ReusePass, TEXT("TransitionOcclusionReuse"));
                BindPipeline(RHI, Cmd, ReadPipeline, ReadPSO);
                Cmd.SetViewport(0, 0, 0, 64, 64, 1);
                ValueParameter(Cmd, DepthVS.GetReference(), 0.9f);
                ValueParameter(Cmd, ClearPS.GetReference(), FVector4f(0, 1, 0, 1));
                Cmd.BeginRenderQuery(HiddenQuery);
                Cmd.DrawPrimitive(0, 2, 1);
                Cmd.EndRenderQuery(HiddenQuery);
                ValueParameter(Cmd, DepthVS.GetReference(), 0.5f);
                ValueParameter(Cmd, ClearPS.GetReference(), FVector4f(1, 0, 0, 1));
                Cmd.BeginRenderQuery(VisibleQuery);
                Cmd.DrawPrimitive(0, 2, 1);
                Cmd.EndRenderQuery(VisibleQuery);
                Cmd.EndRenderPass();
            }
            Again = MAX_uint64;
            Record(TEXT("occlusion-reuse-does-not-return-stale-result"),
                !RHI.RHIGetRenderQueryResult(HiddenQuery, Again, false, 0) && Again == MAX_uint64);
            RHI.SubmitCurrent();
            Record(TEXT("occlusion-reused-hidden-query-now-visible"),
                RHI.RHIGetRenderQueryResult(HiddenQuery, Again, true, 0) && Again > 0);
            Record(TEXT("occlusion-reused-visible-query-now-hidden"),
                RHI.RHIGetRenderQueryResult(VisibleQuery, Again, true, 0) && Again == 0);
        }
        CheckImage(TEXT("depth-write-to-read-only-preserves-occlusion"), Color, FColor::Green, false);
    }
    RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
    {
        FCommandList Cmd(&RHI);
        const FRHITransitionInfo Wrong(Source, ERHIAccess::CopyDest, ERHIAccess::CopySrc);
        auto *WrongBefore = Cmd.CreateLocalTransition(RHI, MakeArrayView(&Wrong, 1));
        const FRHITransitionInfo Valid(Other, ERHIAccess::RTV, ERHIAccess::CopySrc);
        auto *ValidTransition = Cmd.CreateLocalTransition(RHI, MakeArrayView(&Valid, 1));
        Cmd.EnqueueLambda([&, WrongBefore, ValidTransition](FRHICommandListBase &) {
            FString Error;
            const FRHITransition *Single[] = {WrongBefore}, *Batch[] = {ValidTransition, WrongBefore};
            Record(TEXT("reject-wrong-access-before"), !RHI.ValidateTransitionBatch(Single, true, Error));
            Record(TEXT("reject-invalid-batch-atomically"), !RHI.ValidateTransitionBatch(Batch, true, Error) &&
                                                                RHI.ResourceState(Other).Pending == nullptr &&
                                                                RHI.ResourceState(Source).Pending == nullptr &&
                                                                RHI.ResourceState(Other).Access == ERHIAccess::RTV &&
                                                                RHI.ResourceState(Source).Access == ERHIAccess::RTV);
        });
        Cmd.TransitionLocal(RHI, FRHITransitionInfo(Source, ERHIAccess::RTV, ERHIAccess::CopyDest));
        const FRHITransition *Batch[] = {ValidTransition, WrongBefore};
        Cmd.BeginTransitions(Batch);
        Cmd.EndTransitions(Batch);
        Cmd.ReleaseLocalTransition(RHI, ValidTransition);
        Cmd.ReleaseLocalTransition(RHI, WrongBefore);
    }
    RHI.SubmitCurrent();
    {
        FString Error;
        const auto RejectCreate = [&](const TCHAR *Name, FRHITransitionInfo Entry,
                                      ERHITransitionCreateFlags Flags = ERHITransitionCreateFlags::None,
                                      ERHIPipeline Dst = ERHIPipeline::Graphics) {
            const FRHITransitionCreateInfo Info(ERHIPipeline::Graphics, Dst, Flags, MakeArrayView(&Entry, 1));
            Record(Name, !RHI.ValidateTransitionCreate(Info, Error) && !Error.IsEmpty());
        };
        const FRHITransitionInfo Valid(Source, ERHIAccess::CopySrc, ERHIAccess::RTV);
        const FRHITransitionCreateInfo DecayInfo(ERHIPipeline::Graphics, ERHIPipeline::Graphics,
            ERHITransitionCreateFlags::NoFence | ERHITransitionCreateFlags::AllowDecayPipelines,
            MakeArrayView(&Valid, 1));
        Record(TEXT("accept-graphics-pipeline-decay"), RHI.ValidateTransitionCreate(DecayInfo, Error));
        RejectCreate(TEXT("reject-async-compute-transition"), Valid, ERHITransitionCreateFlags::None,
                     ERHIPipeline::AsyncCompute);
        RejectCreate(TEXT("reject-allow-during-pass-flag"), Valid, ERHITransitionCreateFlags::AllowDuringRenderPass);
        RejectCreate(TEXT("reject-unknown-after-state"),
                     FRHITransitionInfo(Source, ERHIAccess::CopySrc, ERHIAccess::Unknown));
        RejectCreate(TEXT("reject-read-write-access-combination"),
                     FRHITransitionInfo(Source, ERHIAccess::CopySrc, ERHIAccess::RTV | ERHIAccess::SRVGraphicsPixel));
        RejectCreate(TEXT("reject-multiple-write-access-combination"),
                     FRHITransitionInfo(Source, ERHIAccess::CopySrc, ERHIAccess::RTV | ERHIAccess::CopyDest));
        RejectCreate(TEXT("reject-texture-uav-capability"),
                     FRHITransitionInfo(Source, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
        RejectCreate(TEXT("reject-buffer-rtv-capability"),
                     FRHITransitionInfo(VB, ERHIAccess::Unknown, ERHIAccess::RTV));
        auto Invalid = Valid;
        Invalid.MipIndex = 1;
        RejectCreate(TEXT("reject-mip-out-of-range"), Invalid);
        Invalid = Valid;
        Invalid.ArraySlice = 1;
        RejectCreate(TEXT("reject-array-slice-out-of-range"), Invalid);
        Invalid = Valid;
        Invalid.PlaneSlice = 1;
        RejectCreate(TEXT("reject-stencil-plane"), Invalid);
        Invalid = Valid;
        Invalid.Flags = EResourceTransitionFlags::IgnoreAfterState;
        RejectCreate(TEXT("reject-ignore-after-state"), Invalid);
        Invalid = FRHITransitionInfo(VB, ERHIAccess::Unknown, ERHIAccess::CopySrc, FRHICommitResourceInfo(16));
        RejectCreate(TEXT("reject-reserved-resource-commit"), Invalid);
        RejectCreate(TEXT("reject-null-transition-resource"),
                     FRHITransitionInfo(static_cast<FRHITexture *>(nullptr), ERHIAccess::RTV));
        const FRHITransitionInfo Duplicate[] = {Valid, Valid};
        const FRHITransitionCreateInfo DuplicateInfo(ERHIPipeline::Graphics, ERHIPipeline::Graphics,
                                                     ERHITransitionCreateFlags::None, Duplicate);
        Record(TEXT("reject-duplicate-resource-transition"), !RHI.ValidateTransitionCreate(DuplicateInfo, Error));
        FRHITransientAliasingInfo Aliasing;
        Aliasing.Texture = Source;
        Aliasing.Type = FRHITransientAliasingInfo::EType::Texture;
        Aliasing.Action = FRHITransientAliasingInfo::EAction::Discard;
        const FRHITransitionCreateInfo AliasingInfo(ERHIPipeline::Graphics, ERHIPipeline::Graphics,
                                                    ERHITransitionCreateFlags::None, MakeArrayView(&Valid, 1),
                                                    MakeArrayView(&Aliasing, 1));
        Record(TEXT("reject-transient-aliasing"), !RHI.ValidateTransitionCreate(AliasingInfo, Error));
    }
    {
        auto Compute = RHI.RHICreateComputeShader(
            FRHICreateShaderDesc(Packet(Directory, TEXT("WebFallback_FClearReplacementCS_Buffer_Uint"))));
        auto PSO = RHI.RHICreateComputePipelineState(FComputePipelineStateInitializer(Compute));
        FBufferRHIRef Storage, BufferCopy;
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
            FCommandList Cmd(&RHI);
            Storage = Buffer(
                RHI, Cmd,
                FRHIBufferCreateDesc::Create(TEXT("TransitionUAV"), 1024, 4, BUF_StructuredBuffer | BUF_UnorderedAccess)
                    .SetInitialState(ERHIAccess::UAVCompute),
                Sentinel.GetData(), 1024);
            BufferCopy = Buffer(RHI, Cmd,
                                FRHIBufferCreateDesc::CreateStructured(TEXT("TransitionCopy"), 1024, 4)
                                    .SetInitialState(ERHIAccess::CopyDest),
                                Sentinel.GetData(), 1024);
            UAV = RHI.RHICreateUnorderedAccessView(Cmd, Storage, View);
            Cmd.OnBoundShaderChanged(Compute);
            Cmd.EnqueueLambda([&RHI, PSO](FRHICommandListBase &) { RHI.RHISetComputePipelineState(PSO); });
            const FRHIShaderParameterResource Resources[] = {{UAV, 1}};
            Cmd.SetShaderParameters(Compute, {}, {}, Resources, {});
            ValueParameter(Cmd, Compute.GetReference(), uint32(11));
            Cmd.DispatchComputeShader(2, 1, 1);
            Cmd.TransitionLocal(RHI, FRHITransitionInfo(UAV, ERHIAccess::UAVCompute, ERHIAccess::UAVCompute));
            ValueParameter(Cmd, Compute.GetReference(), uint32(23));
            Cmd.DispatchComputeShader(2, 1, 1);
            Cmd.EnqueueLambda([&](FRHICommandListBase &) {
                RejectUse(TEXT("reject-uav-copy-without-transition"), Storage, ERHIAccess::CopySrc);
            });
            Cmd.TransitionLocal(RHI, FRHITransitionInfo(UAV, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
            Cmd.CopyBufferRegion(BufferCopy, 0, Storage, 0, 1024);
            Cmd.EnqueueLambda([&](FRHICommandListBase &) {
                RejectUse(TEXT("reject-dispatch-in-copy-state"), Storage, ERHIAccess::UAVCompute);
            });
            Cmd.TransitionLocal(RHI, FRHITransitionInfo(Storage, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
            ValueParameter(Cmd, Compute.GetReference(), uint32(29));
            Cmd.DispatchComputeShader(2, 1, 1);
        }
        RHI.SubmitCurrent();
        const auto StorageBytes = RHI.ReadBuffer(Storage, 1024), CopyBytes = RHI.ReadBuffer(BufferCopy, 1024);
        bool StorageOK = StorageBytes.Num() == 1024, CopyOK = CopyBytes.Num() == 1024;
        for (uint32 Index = 0; Index < 256; ++Index)
        {
            if (StorageOK)
                StorageOK &= reinterpret_cast<const uint32 *>(StorageBytes.GetData())[Index] ==
                             (Index >= 64 && Index < 192 ? 29u : 0xa5a5a5a5);
            if (CopyOK)
                CopyOK &= reinterpret_cast<const uint32 *>(CopyBytes.GetData())[Index] ==
                          (Index >= 64 && Index < 192 ? 23u : 0xa5a5a5a5);
            Checked += 2;
        }
        Record(TEXT("uav-same-state-and-reuse-order"), StorageOK);
        Record(TEXT("uav-to-copy-preserves-previous-write"), CopyOK);
        Record(TEXT("internal-buffer-readback-preserves-state"),
               RHI.ResourceState(Storage).Access == ERHIAccess::UAVCompute &&
                   RHI.ResourceState(BufferCopy).Access == ERHIAccess::CopyDest);
    }
    {
        const uint32 Values[] = {3, 5, 7, 11, 13, 17, 19, 23};
        FBufferRHIRef Owned, Destination;
        RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        {
            FCommandList Cmd(&RHI);
            Owned = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("TransitionOwned"), sizeof(Values)),
                           Values, sizeof(Values));
            Destination =
                Buffer(RHI, Cmd,
                       FRHIBufferCreateDesc::CreateStructured(TEXT("TransitionLifetimeCopy"), sizeof(Values), 4)
                           .SetInitialState(ERHIAccess::CopyDest),
                       Values, sizeof(Values));
            auto *Pointer = Owned.GetReference();
            const FRHITransitionInfo Info(Pointer, ERHIAccess::Unknown, ERHIAccess::CopySrc);
            auto *Transition = Cmd.CreateLocalTransition(RHI, MakeArrayView(&Info, 1));
            Owned.SafeRelease();
            Record(TEXT("transition-owns-resource-after-caller-release"),
                   RHI.Transitions.FindChecked(Transition)->References[0] == Pointer && Pointer->GetRefCount() > 0);
            Cmd.BeginTransition(Transition);
            Cmd.EndTransition(Transition);
            Cmd.CopyBufferRegion(Destination, 0, Pointer, 0, sizeof(Values));
            Cmd.ReleaseLocalTransition(RHI, Transition);
        }
        RHI.SubmitCurrent();
        const auto Readback = RHI.ReadBuffer(Destination, sizeof(Values));
        Record(TEXT("transition-resource-lifetime-copy"),
               Readback.Num() == sizeof(Values) && FMemory::Memcmp(Readback.GetData(), Values, sizeof(Values)) == 0);
        Checked += UE_ARRAY_COUNT(Values);
    }
    {
        FDynamicRHI::FRHISubmitCommandListsArgs Batch;
        for (uint32 Index = 0; Index < 2; ++Index)
        {
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            FDynamicRHI::FRHIFinalizeContextsArgs Finalize;
            Finalize.Contexts[ERHIPipeline::Graphics] = &RHI;
            auto Finished = RHI.RHIFinalizeContexts(MoveTemp(Finalize));
            Batch.CommandLists.Add(Finished.CommandLists[ERHIPipeline::Graphics]);
        }
        IRHIPlatformCommandList *Reversed[] = {Batch.CommandLists[1], Batch.CommandLists[0]};
        FString Error;
        Record(TEXT("reject-out-of-order-command-submission"), !RHI.ValidateSubmissionOrder(Reversed, Error));
        RHI.RHISubmitCommandLists(MoveTemp(Batch));
        Record(TEXT("ordered-submission-after-rejection"), RHI.Finalized == RHI.Submitted);
    }
    {
        const uint32 Initial[] = {0, 0, 0, 0};
        const uint32 Values[] = {11, 23, 37, 53};
        FBufferRHIRef Uploads[2];
        RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        {
            FCommandList Cmd(&RHI);
            FRHITransitionInfo Before[2], After[2];
            for (uint32 Index = 0; Index < 2; ++Index)
            {
                Uploads[Index] = Buffer(RHI, Cmd,
                    FRHIBufferCreateDesc::CreateStructured(TEXT("RDGBatchedUpload"), sizeof(Values), 4)
                        .AddUsage(BUF_ShaderResource).SetInitialState(ERHIAccess::SRVCompute),
                    Initial, sizeof(Initial));
                void* Bytes = RHI.LockBuffer_BottomOfPipe(Cmd, Uploads[Index], 0, sizeof(Values), RLM_WriteOnly);
                FMemory::Memcpy(Bytes, Values, sizeof(Values));
                Before[Index] = FRHITransitionInfo(Uploads[Index], ERHIAccess::Unknown, ERHIAccess::CopyDest,
                    EResourceTransitionFlags::IgnoreAfterState);
                After[Index] = FRHITransitionInfo(Uploads[Index], ERHIAccess::CopyDest, ERHIAccess::Unknown,
                    EResourceTransitionFlags::IgnoreAfterState);
            }
            const auto TransitionUploads = [&](TArrayView<const FRHITransitionInfo> Infos) {
                auto* Transition = Cmd.CreateLocalTransition(RHI, Infos,
                    ERHITransitionCreateFlags::NoSplit | ERHITransitionCreateFlags::AllowDuringRenderPass);
                Cmd.BeginTransition(Transition);
                Cmd.EndTransition(Transition);
                Cmd.ReleaseLocalTransition(RHI, Transition);
            };
            TransitionUploads(Before);
            for (auto& Upload : Uploads)
                RHI.UnlockBuffer_BottomOfPipe(Cmd, Upload);
            TransitionUploads(After);
        }
        RHI.SubmitCurrent();
        for (uint32 Index = 0; Index < 2; ++Index)
        {
            const auto Bytes = RHI.ReadBuffer(Uploads[Index], sizeof(Values));
            Record(FString::Printf(TEXT("rdg-batched-upload-%u-data"), Index),
                Bytes.Num() == sizeof(Values) && FMemory::Memcmp(Bytes.GetData(), Values, sizeof(Values)) == 0);
            Record(FString::Printf(TEXT("rdg-batched-upload-%u-preserves-access"), Index),
                RHI.ResourceState(Uploads[Index]).Access == ERHIAccess::SRVCompute);
            Checked += UE_ARRAY_COUNT(Values);
        }
    }
    {
        TArray<uint32> Sentinel;
        Sentinel.Init(0xa5a5a5a5, 256);
        FBufferRHIRef Buffers[2];
        RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        {
            FCommandList Cmd(&RHI);
            for (uint32 Index = 0; Index < 2; ++Index)
            {
                const bool Structured = Index == 1;
                Buffers[Index] = Buffer(RHI, Cmd,
                    FRHIBufferCreateDesc::Create(TEXT("HistogramClear"), 1024, 4,
                        BUF_UnorderedAccess | (Structured ? BUF_StructuredBuffer : BUF_None))
                        .SetInitialState(ERHIAccess::UAVCompute), Sentinel.GetData(), 1024);
                FRHIViewDesc Desc;
                Desc.Common.ViewType = FRHIViewDesc::EViewType::BufferUAV;
                Desc.Buffer.UAV.BufferType = Structured ? FRHIViewDesc::EBufferType::Structured :
                    FRHIViewDesc::EBufferType::Typed;
                Desc.Buffer.UAV.Format = Structured ? PF_Unknown : PF_R32_UINT;
                Desc.Buffer.UAV.Stride = Structured ? 4 : 0;
                Desc.Buffer.UAV.OffsetInBytes = Structured ? 256 : 0;
                Desc.Buffer.UAV.NumElements = Structured ? 128 : 256;
                const auto View = RHI.RHICreateUnorderedAccessView(Cmd, Buffers[Index], Desc);
                Cmd.EnqueueLambda([&RHI, View](FRHICommandListBase&) {
                    RHI.RHIClearUAVUint(View, FUintVector4(0));
                });
            }
        }
        RHI.SubmitCurrent();
        for (uint32 Index = 0; Index < 2; ++Index)
        {
            const auto Bytes = RHI.ReadBuffer(Buffers[Index], 1024);
            bool OK = Bytes.Num() == 1024;
            for (uint32 Element = 0; Element < 256 && OK; ++Element)
                OK &= reinterpret_cast<const uint32*>(Bytes.GetData())[Element] ==
                    (Index == 0 || (Element >= 64 && Element < 192) ? 0u : 0xa5a5a5a5);
            Record(Index == 0 ? TEXT("typed-uav-zero-clear") : TEXT("structured-uav-range-zero-clear"), OK);
            Record(FString::Printf(TEXT("uav-clear-%u-preserves-access"), Index),
                RHI.ResourceState(Buffers[Index]).Access == ERHIAccess::UAVCompute);
            Checked += 256;
        }
    }
    Record(TEXT("transition-lifecycle-balanced"),
           RHI.Transitions.IsEmpty() && RHI.TransitionsCreated - StartCreated == RHI.TransitionsBegun - StartBegun &&
               RHI.TransitionsCreated - StartCreated == RHI.TransitionsEnded - StartEnded &&
               RHI.TransitionsCreated - StartCreated == RHI.TransitionsReleased - StartReleased);
    auto Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), Pass);
    Report->SetStringField(TEXT("scope"), TEXT("Single owner, Graphics queue, whole resource/mip0/array0/plane0"));
    Report->SetStringField(
        TEXT("lifecycle"),
        TEXT("UE transition allocation and markers use NullRHI; probe routes backend creation/release explicitly"));
    Report->SetBoolField(TEXT("globalTransitionDispatchImplemented"), false);
    Report->SetBoolField(TEXT("asyncComputeImplemented"), false);
    Report->SetBoolField(TEXT("transientAliasingImplemented"), false);
    Report->SetNumberField(TEXT("created"), RHI.TransitionsCreated - StartCreated);
    Report->SetNumberField(TEXT("begun"), RHI.TransitionsBegun - StartBegun);
    Report->SetNumberField(TEXT("ended"), RHI.TransitionsEnded - StartEnded);
    Report->SetNumberField(TEXT("released"), RHI.TransitionsReleased - StartReleased);
    Report->SetNumberField(TEXT("accessChecks"), RHI.AccessChecks - StartAccessChecks);
    Report->SetNumberField(TEXT("draws"), RHI.Draws - StartDraws);
    Report->SetNumberField(TEXT("dispatches"), RHI.Dispatches - StartDispatches);
    Report->SetNumberField(TEXT("bindGroups"), RHI.BoundGroups - StartGroups);
    Report->SetNumberField(TEXT("checkedValues"), Checked);
    Report->SetArrayField(TEXT("checks"), Checks);
    return Report;
}
