#include "WebGPUGlobalProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUDynamicRHI.h"
#include "WebGPUProbeUtils.h"

#include "DataDrivenShaderPlatformInfo.h"
#include "HAL/FileManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderParameterMetadata.h"
#include "ShaderParameterMacros.h"
#include "ShaderCore.h"
#include "RHIUniformBufferLayoutInitializer.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

namespace
{
template <typename Shader, typename Value>
void ValueParameter(FRHICommandList &Cmd, Shader *InShader, const Value &InValue)
{
    const FRHIShaderParameter Parameter(0, 0, 0, sizeof(Value));
    Cmd.SetShaderParameters(InShader, MakeArrayView(reinterpret_cast<const uint8 *>(&InValue), sizeof(Value)),
                            MakeArrayView(&Parameter, 1), {}, {});
}
TSharedRef<FJsonObject> RunMode(IDynamicRHIModule &Module, const FString &Directory, const FString &Output, bool Bypass)
{
    using namespace WebGPUProbe;
    auto &Cmd = FRHICommandListImmediate::Get();
    const auto HostDepthFormat = GPixelFormats[PF_DepthStencil];
    const auto HostStencilFormat = GPixelFormats[PF_X24_G8];
    FWebGPUGlobalScope Scope(Module);
    auto &RHI = Scope.RHI;
    if (Bypass)
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                       ERHISubmitFlags::EnableBypass);
    TArray<TSharedPtr<FJsonValue>> Checks;
    bool Pass = true;
    uint64 Checked = 0;
    const FString Mode = Bypass ? TEXT("bypass") : TEXT("recorded");
    const auto Record = [&](const TCHAR *Name, bool OK) {
        auto Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("name"), Name);
        Item->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Item));
        Pass &= OK;
        UE_LOG(LogRHI, Display, TEXT("P2_GLOBAL %s %s pass=%d"), *Mode, Name, OK);
    };
    Record(TEXT("module-global-device-and-mode"), GDynamicRHI == RHI.Get() && RHIGetNativeDevice() == RHI->Device &&
                                                      FString(GDynamicRHI->GetName()) == TEXT("WebGPU") &&
                                                      !GUsingNullRHI && Cmd.Bypass() == Bypass);
    Record(TEXT("web-platform-and-serial-capabilities"),
           uint32(GMaxRHIShaderPlatform) == 47 &&
               GetFeatureLevelShaderPlatform(ERHIFeatureLevel::SM5) == GMaxRHIShaderPlatform &&
               !GRHISupportsRHIThread && !GRHISupportsParallelRHIExecute && !GRHISupportsAsyncPipelinePrecompile &&
               GRHIMaxDispatchThreadGroupsPerDimension == FIntVector(RHI->Limits.maxComputeWorkgroupsPerDimension));
    {
        FRHIUniformBufferLayoutInitializer Initializer(TEXT("WebEmptyUniform"));
        Initializer.ConstantBufferSize = sizeof(FVector4f);
        Initializer.ComputeHash();
        TRefCountPtr<FRHIUniformBufferLayout> Layout = new FRHIUniformBufferLayout(Initializer);
        auto Uniform = RHICreateUniformBuffer(nullptr, Layout, UniformBuffer_MultiFrame,
            EUniformBufferValidation::ValidateResources);
        auto* Backend = static_cast<FWebGPUUniform*>(Uniform.GetReference());
        Record(TEXT("empty-uniform-has-no-invented-constants"),
            Backend->Bytes.IsEmpty() && Backend->GetResourceTable().IsEmpty());
        FVector4f Value(1, 2, 3, 4);
        const FVector4f Expected = Value;
        Cmd.UpdateUniformBuffer(Uniform, &Value);
        Value = FVector4f(5, 6, 7, 8);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("empty-uniform-update-snapshots-queued-data"),
            Backend->Bytes.Num() == sizeof(Expected) &&
            FMemory::Memcmp(Backend->Bytes.GetData(), &Expected, sizeof(Expected)) == 0);
        Cmd.UpdateUniformBuffer(Uniform, &Value);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("empty-uniform-supports-subsequent-updates"),
            Backend->Bytes.Num() == sizeof(Value) &&
            FMemory::Memcmp(Backend->Bytes.GetData(), &Value, sizeof(Value)) == 0);
        const auto* Primitive = FShaderParametersMetadata::GetNameStructMap().FindChecked(FHashedName(TEXT("Primitive")));
        auto PrimitiveUniform = RHICreateUniformBuffer(nullptr, &Primitive->GetLayout(),
            UniformBuffer_MultiFrame, EUniformBufferValidation::ValidateResources);
        const auto& Resources = PrimitiveUniform->GetResourceTable();
        bool EmptyResources = Resources.Num() == Primitive->GetLayout().Resources.Num();
        for (const auto& Resource : Resources)
            EmptyResources &= !Resource;
        Record(TEXT("empty-primitive-uniform-keeps-null-resource-slots"),
            EmptyResources && static_cast<FWebGPUUniform*>(PrimitiveUniform.GetReference())->Bytes.IsEmpty());
    }
    const bool StaticProbe = FParse::Param(FCommandLine::Get(), TEXT("WebStaticUniformProbe"));
    if (StaticProbe)
    {
        const auto *View = FShaderParametersMetadata::GetNameStructMap().FindChecked(FHashedName(TEXT("View")));
        const auto &Layout = View->GetLayout();
        const auto Slot = Layout.StaticSlot;
        TArray<uint8> Bytes;
        Bytes.SetNumZeroed(Layout.ConstantBufferSize);
        auto First = RHICreateUniformBuffer(Bytes.GetData(), &Layout, UniformBuffer_MultiFrame,
                                            EUniformBufferValidation::None);
        auto Second = RHICreateUniformBuffer(Bytes.GetData(), &Layout, UniformBuffer_MultiFrame,
                                             EUniformBufferValidation::None);
        FWebGPUShaderData Shader;
        Shader.ResourceTable.ResourceTableLayoutHashes.Add(Layout.GetHash());
        FRHIUniformBuffer *Resolved = nullptr;
        FString Error;
        const auto Flush = [&] { Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread); };
        const auto Resolve = [&] {
            Error.Reset();
            return RHI->ResolveUniform(Shader, 0, Resolved, Error);
        };
        Record(TEXT("static-view-layout-supports-both-binding-models"),
               Layout.BindingFlags == EUniformBufferBindingFlags::StaticAndShader &&
                   RHI->ValidateStaticUniform(Slot, First, Error));
        Record(TEXT("static-unbound-uniform-rejected"), !Resolve() && !Error.IsEmpty());
        Cmd.SetStaticUniformBuffers(FUniformBufferStaticBindings(First.GetReference()));
        Flush();
        Record(TEXT("static-batch-resolves-runtime-slot"), Resolve() && Resolved == First.GetReference());
        Record(TEXT("static-context-retains-uniform"), First->GetRefCount() == 2);
        Cmd.SetStaticUniformBuffer(Slot, Second);
        Flush();
        Record(TEXT("static-single-slot-replaces-binding"), Resolve() && Resolved == Second.GetReference());
        Record(TEXT("static-replacement-releases-old-reference"), First->GetRefCount() == 1);
        Cmd.SetStaticUniformBuffer(Slot, nullptr);
        Flush();
        Record(TEXT("static-single-null-clears-binding"), !Resolve() && Second->GetRefCount() == 1);
        Cmd.SetStaticUniformBuffers(FUniformBufferStaticBindings(First.GetReference()));
        Cmd.SetStaticUniformBuffers(FUniformBufferStaticBindings());
        Flush();
        Record(TEXT("static-empty-batch-clears-all-bindings"), !Resolve() && First->GetRefCount() == 1);
        Shader.Resources.Add(1u << 16, First.GetReference());
        Record(TEXT("static-and-shader-allows-direct-fallback"), Resolve() && Resolved == First.GetReference());
        Cmd.SetStaticUniformBuffer(Slot, Second);
        Flush();
        Record(TEXT("static-and-direct-double-binding-rejected"), !Resolve() && Error.Contains(TEXT("both")));
        Shader.Resources.Reset();
        Record(TEXT("static-previous-shader-resource-is-not-cached"), Resolve() && Resolved == Second.GetReference());
        Record(TEXT("static-invalid-slot-rejected"),
               !RHI->ValidateStaticUniform(FUniformBufferStaticSlot(MAX_UNIFORM_BUFFER_STATIC_SLOTS), First, Error));
        Record(TEXT("static-wrong-registered-slot-rejected"),
               !RHI->ValidateStaticUniform(FUniformBufferStaticSlot(Slot == 0 ? 1 : 0), First, Error));
        FRHIUniformBufferLayoutInitializer WrongInitializer(TEXT("WebStaticWrongLayout"));
        WrongInitializer.ConstantBufferSize = Layout.ConstantBufferSize + 16;
        WrongInitializer.StaticSlot = Slot;
        WrongInitializer.BindingFlags = EUniformBufferBindingFlags::StaticAndShader;
        WrongInitializer.ComputeHash();
        TRefCountPtr<FRHIUniformBufferLayout> WrongLayout = new FRHIUniformBufferLayout(WrongInitializer);
        FUniformBufferRHIRef Wrong = new FWebGPUUniform(WrongLayout);
        Cmd.SetStaticUniformBuffer(Slot, Wrong);
        Flush();
        Record(TEXT("static-runtime-layout-hash-mismatch-rejected"),
               !Resolve() && Error.Contains(TEXT("hash mismatch")));
        WrongInitializer.StaticSlot = FUniformBufferStaticSlot(MAX_UNIFORM_BUFFER_STATIC_SLOTS);
        WrongInitializer.BindingFlags = EUniformBufferBindingFlags::Shader;
        WrongInitializer.ComputeHash();
        TRefCountPtr<FRHIUniformBufferLayout> DirectLayout = new FRHIUniformBufferLayout(WrongInitializer);
        FUniformBufferRHIRef DirectOnly = new FWebGPUUniform(DirectLayout);
        Record(TEXT("static-shader-only-layout-rejected"), !RHI->ValidateStaticUniform(Slot, DirectOnly, Error));
        Cmd.SetStaticUniformBuffers(FUniformBufferStaticBindings());
        Flush();
        Record(TEXT("static-final-clear-releases-context-references"),
               First->GetRefCount() == 1 && Second->GetRefCount() == 1 && Wrong->GetRefCount() == 1);
        const FShaderParametersMetadata *StaticOnly = nullptr;
        for (const auto &Item : FShaderParametersMetadata::GetNameStructMap())
            if (Item.Value->GetLayout().BindingFlags == EUniformBufferBindingFlags::Static)
            {
                StaticOnly = Item.Value;
                break;
            }
        check(StaticOnly);
        Shader.ResourceTable.ResourceTableLayoutHashes[0] = StaticOnly->GetLayout().GetHash();
        Record(TEXT("static-only-missing-binding-rejected"),
               !Resolve() && Error.Contains(TEXT("Required static")));
        FUniformBufferRHIRef Required = new FWebGPUUniform(&StaticOnly->GetLayout());
        Cmd.SetStaticUniformBuffers(FUniformBufferStaticBindings(Required.GetReference()));
        Flush();
        Record(TEXT("static-only-registered-layout-resolves"), Resolve() && Resolved == Required.GetReference());
        Cmd.SetStaticUniformBuffers(FUniformBufferStaticBindings());
        Flush();
        Record(TEXT("static-only-clear-releases-reference"), Required->GetRefCount() == 1);
    }
    const auto CheckImage = [&](const TCHAR *Name, FRHITexture *Texture, FColor Expected, bool Save) {
        TArray<FColor> Colors;
        Cmd.ReadSurfaceData(Texture, FIntRect(0, 0, 64, 64), Colors, RawReadback());
        bool OK = Colors.Num() == 4096;
        for (auto Color : Colors)
        {
            OK &= FMath::Abs(int32(Color.R) - Expected.R) <= 1 && FMath::Abs(int32(Color.G) - Expected.G) <= 1 &&
                  FMath::Abs(int32(Color.B) - Expected.B) <= 1 && Color.A == Expected.A;
            Checked += 4;
        }
        Record(Name, OK);
        if (Save)
        {
            TArray<uint8> Bytes;
            for (auto Color : Colors)
            {
                Bytes.Add(Color.R);
                Bytes.Add(Color.G);
                Bytes.Add(Color.B);
                Bytes.Add(Color.A);
            }
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / (Mode + TEXT("-64x64.rgba")))));
        }
    };
    {
        const auto Raw = Packet(Directory, TEXT("FClearReplacementVS"));
        FShaderCode Cooked;
        Cooked.GetWriteAccess() = Raw;
        Cooked.AddOptionalData(FShaderCodePackedResourceCounts{});
        Cooked.FinalizeShaderCode();
        const auto Wrapped = Cooked.GetReadView();
        {
            FWebGPUShaderData Shader;
            FString Error;
            Record(TEXT("shader-packet-ue-attachments-accepted"),
                   RHI->LoadShader(FRHICreateShaderDesc(Wrapped), SF_Vertex, Shader, Error) && Shader.Module);
        }
        const auto Reject = [&](const TCHAR *Name, TArray<uint8> Bytes, EShaderFrequency Frequency) {
            FWebGPUShaderData Shader;
            FString Error;
            Record(Name, !RHI->LoadShader(FRHICreateShaderDesc(Bytes), Frequency, Shader, Error) &&
                             !Error.IsEmpty() && !Shader.Module);
        };
        TArray<uint8> Invalid(Wrapped.GetData(), Wrapped.Num());
        Invalid.Last() = 0x80;
        Reject(TEXT("shader-packet-negative-footer-rejected"), Invalid, SF_Vertex);
        Invalid = TArray<uint8>(Wrapped.GetData(), Wrapped.Num());
        Invalid.Last() = 1;
        Reject(TEXT("shader-packet-oversize-footer-rejected"), Invalid, SF_Vertex);
        Invalid = TArray<uint8>(Wrapped.GetData(), Wrapped.Num());
        FMemory::Memset(Invalid.GetData() + Raw.Num() + 1, 0xff, sizeof(uint32));
        Reject(TEXT("shader-packet-attachment-overrun-rejected"), Invalid, SF_Vertex);
        Reject(TEXT("shader-packet-wrapped-frequency-rejected"),
               TArray<uint8>(Wrapped.GetData(), Wrapped.Num()), SF_Pixel);
        Invalid = Raw;
        Invalid.Add(0);
        Reject(TEXT("shader-packet-trailing-byte-rejected"), Invalid, SF_Vertex);
        Invalid = Raw;
        Invalid.SetNum(Raw.Num() - 1);
        Reject(TEXT("shader-packet-payload-truncation-rejected"), Invalid, SF_Vertex);
        FShaderCode WithoutAttachments;
        WithoutAttachments.GetWriteAccess() = Raw;
        WithoutAttachments.FinalizeShaderCode();
        {
            FWebGPUShaderData Shader;
            FString Error;
            Record(TEXT("shader-packet-empty-attachments-accepted"),
                   RHI->LoadShader(FRHICreateShaderDesc(WithoutAttachments.GetReadView()),
                                   SF_Vertex, Shader, Error) && Shader.Module);
        }
        auto ClearVS = RHICreateVertexShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementVS"))));
        auto ClearPS = RHICreatePixelShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementPS"))));
        auto VS = RHICreateVertexShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FScreenVS"))));
        auto PS = RHICreatePixelShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FScreenPS"))));
        auto Compute = RHICreateComputeShader(
            FRHICreateShaderDesc(Packet(Directory, TEXT("WebFallback_FClearReplacementCS_Buffer_Uint"))));
        Record(TEXT("global-shader-bytecode-hashes"),
               ClearVS->GetHash() != VS->GetHash() && ClearPS->GetHash() != PS->GetHash());
        auto Blend = RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
        FRasterizerStateInitializerRHI DefaultRaster(FM_Solid, CM_None, true);
        auto Raster = RHICreateRasterizerState(DefaultRaster);
        auto Depth = RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
        auto Sampler = RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Point, AM_Clamp, AM_Clamp));
        FGraphicsPipelineStateInitializer Clear;
        Clear.BoundShaderState.VertexShaderRHI = ClearVS;
        Clear.BoundShaderState.PixelShaderRHI = ClearPS;
        Clear.PrimitiveType = PT_TriangleStrip;
        Clear.RenderTargetsEnabled = 1;
        Clear.RenderTargetFormats[0] = PF_R8G8B8A8;
        Clear.NumSamples = 1;
        Clear.BlendState = Blend;
        Clear.RasterizerState = Raster;
        Clear.DepthStencilState = Depth;
        Record(TEXT("global-default-rasterizer-permission-keeps-single-sample"),
               DefaultRaster.bAllowMSAA && Clear.NumSamples == 1);
        const auto TargetDesc =
            FRHITextureCreateDesc::Create2D(TEXT("GlobalTarget"), 64, 64, PF_R8G8B8A8)
                .SetFlags(ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::ShaderResource)
                .SetClearValue(FClearValueBinding(FLinearColor(0, 0, 0, 0)))
                .SetInitialState(ERHIAccess::RTV);
        auto Source = Cmd.CreateTexture(TargetDesc), Destination = Cmd.CreateTexture(TargetDesc),
             Copy = Cmd.CreateTexture(TargetDesc);
        const auto ClearTarget = [&](FRHITexture *Target, const FVector4f &Color) {
            Cmd.BeginRenderPass(FRHIRenderPassInfo(Target, ERenderTargetActions::Clear_Store), TEXT("GlobalClear"));
            SetGraphicsPipelineState(Cmd, Clear, 0, EApplyRendertargetOption::DoNothing);
            for (uint32 Index = 0; Index < 3; ++Index)
                Cmd.SetStreamSource(Index, nullptr, 0);
            Cmd.SetViewport(0, 0, 0, 64, 64, 1);
            ValueParameter(Cmd, ClearPS.GetReference(), Color);
            Cmd.DrawPrimitive(0, 2, 1);
            Cmd.EndRenderPass();
        };
        const uint32 BeforePipelines = RHI->GraphicsPipelinesCreated;
        ClearTarget(Source, FVector4f(0.25f, 0.5f, 0.75f, 1));
        ClearTarget(Destination, FVector4f(1, 0, 0, 1));
        Record(TEXT("global-graphics-cache-reuses-pso"), RHI->GraphicsPipelinesCreated == BeforePipelines + 1);
        Record(TEXT("commands-obey-recording-mode"), RHI->Draws == (Bypass ? 2u : 0u));
        const FRHITransitionInfo SplitInfo(Source, ERHIAccess::RTV, ERHIAccess::SRVGraphicsPixel);
        auto *Split = RHICreateTransition(FRHITransitionCreateInfo(ERHIPipeline::Graphics, ERHIPipeline::Graphics,
                                                                   ERHITransitionCreateFlags::None,
                                                                   MakeArrayView(&SplitInfo, 1)));
        Record(TEXT("global-transition-private-data"),
               Split->GetPrivateData<FWebGPUTransitionPrivateData>()->Data == RHI->Transitions.FindChecked(Split));
        Cmd.BeginTransition(Split);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("executor-submits-draws-and-keeps-split"), RHI->Draws == 2 && RHI->Submitted > 0 &&
                                                                   RHI->Finalized == RHI->Submitted &&
                                                                   RHI->ResourceState(Source).Pending == Split);
        Cmd.EndTransition(Split);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("global-marker-releases-transition"),
               RHI->Transitions.IsEmpty() && RHI->TransitionsReleased == 1 &&
                   RHI->ResourceState(Source).Access == ERHIAccess::SRVGraphicsPixel);
        const float Vertices[] = {0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1};
        const uint16 Indices[] = {0, 2, 1, 1, 2, 3};
        const auto MakeBuffer = [&](FRHIBufferCreateDesc Desc, const void *Bytes, uint32 Size) {
            Desc.SetInitActionInitializer().DetermineInitialState();
            auto Init = Cmd.CreateBufferInitializer(Desc);
            Init.WriteData(Bytes, Size);
            return Init.Finalize();
        };
        auto VB = MakeBuffer(FRHIBufferCreateDesc::CreateVertex(TEXT("GlobalVertices"), sizeof(Vertices)), Vertices,
                             sizeof(Vertices));
        auto IB = MakeBuffer(FRHIBufferCreateDesc::CreateIndex(TEXT("GlobalIndices"), sizeof(Indices), 2), Indices,
                             sizeof(Indices));
        FVertexDeclarationElementList Elements;
        Elements.Add(FVertexElement(0, 0, VET_Float2, 0, 16));
        Elements.Add(FVertexElement(0, 8, VET_Float2, 1, 16));
        auto *Declaration = PipelineStateCache::GetOrCreateVertexDeclaration(Elements);
        Record(TEXT("global-vertex-declaration-cache"),
               Declaration == PipelineStateCache::GetOrCreateVertexDeclaration(Elements) &&
                   RHI->VertexDeclarationsCreated == 1);
        const float Rectangle[] = {1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1};
        const auto *Metadata =
            FindUniformBufferStructByLayoutHash(RHI->ShaderData(VS).ResourceTable.ResourceTableLayoutHashes[0]);
        check(Metadata);
        auto Uniform = RHICreateUniformBuffer(Rectangle, &Metadata->GetLayout(), UniformBuffer_MultiFrame,
                                              EUniformBufferValidation::None);
        auto Screen = Clear;
        Screen.BoundShaderState.VertexDeclarationRHI = Declaration;
        Screen.BoundShaderState.VertexShaderRHI = VS;
        Screen.BoundShaderState.PixelShaderRHI = PS;
        Screen.PrimitiveType = PT_TriangleList;
        Cmd.BeginRenderPass(FRHIRenderPassInfo(Destination, ERenderTargetActions::Clear_Store), TEXT("GlobalSample"));
        SetGraphicsPipelineState(Cmd, Screen, 0, EApplyRendertargetOption::DoNothing);
        Cmd.SetViewport(0, 0, 0, 64, 64, 1);
        Cmd.SetStreamSource(0, VB, 0);
        const FRHIShaderParameterResource VertexResources[] = {{Uniform, 0}};
        const FRHIShaderParameterResource PixelResources[] = {{Source, 0}, {Sampler, 1}};
        Cmd.SetShaderParameters(VS, {}, {}, VertexResources, {});
        Cmd.SetShaderParameters(PS, {}, {}, PixelResources, {});
        Cmd.DrawIndexedPrimitive(IB, 0, 0, 4, 0, 2, 1);
        Cmd.EndRenderPass();
        Cmd.Transition(FRHITransitionInfo(Destination, ERHIAccess::RTV, ERHIAccess::CopySrc));
        Cmd.Transition(FRHITransitionInfo(Copy, ERHIAccess::RTV, ERHIAccess::CopyDest));
        Cmd.CopyTexture(Destination, Copy, FRHICopyTextureInfo());
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        CheckImage(TEXT("global-indexed-sampling-readback"), Destination, FColor(64, 128, 191, 255), true);
        CheckImage(TEXT("global-copy-readback"), Copy, FColor(64, 128, 191, 255), false);
        Cmd.Transition(FRHITransitionInfo(Destination, ERHIAccess::CopySrc, ERHIAccess::RTV));
        ClearTarget(Destination, FVector4f(0, 1, 0, 1));
        CheckImage(TEXT("continue-drawing-after-readback"), Destination, FColor::Green, false);
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                       ERHISubmitFlags::DisableBypass);
        const uint32 BeforeQueuedDraws = RHI->Draws;
        FRHICommandListImmediate::FQueuedCommandList Queued[2];
        for (uint32 Index = 0; Index < 2; ++Index)
        {
            auto *Part = new FRHICommandList();
            Part->SwitchPipeline(ERHIPipeline::Graphics);
            Part->BeginRenderPass(FRHIRenderPassInfo(Destination, ERenderTargetActions::Clear_Store),
                                  TEXT("GlobalQueuedClear"));
            SetGraphicsPipelineState(*Part, Clear, 0, EApplyRendertargetOption::DoNothing);
            for (uint32 Stream = 0; Stream < 3; ++Stream)
                Part->SetStreamSource(Stream, nullptr, 0);
            Part->SetViewport(0, 0, 0, 64, 64, 1);
            ValueParameter(*Part, ClearPS.GetReference(), Index ? FVector4f(1, 1, 0, 1) : FVector4f(0, 0, 1, 1));
            Part->DrawPrimitive(0, 2, 1);
            Part->EndRenderPass();
            check(!Part->IsRecursive() && !Part->IsImmediate() && !Part->Bypass());
            Part->FinishRecording();
            Queued[Index] = FRHICommandListImmediate::FQueuedCommandList(Part);
        }
        Record(TEXT("ordinary-command-lists-record-before-submit"), RHI->Draws == BeforeQueuedDraws);
        Cmd.QueueAsyncCommandListSubmit(Queued);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("queued-command-lists-reuse-global-cache"),
               RHI->Draws == BeforeQueuedDraws + 2 && RHI->GraphicsPipelinesCreated == 2);
        CheckImage(TEXT("queued-command-lists-execute-in-order"), Destination, FColor(255, 255, 0, 255), false);
        if (Bypass)
            GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                           ERHISubmitFlags::EnableBypass);
        TArray<uint32> Sentinel;
        Sentinel.Init(0xa5a5a5a5, 256);
        auto Storage = MakeBuffer(
            FRHIBufferCreateDesc::Create(TEXT("GlobalCompute"), 1024, 4, BUF_StructuredBuffer | BUF_UnorderedAccess)
                .SetInitialState(ERHIAccess::UAVCompute),
            Sentinel.GetData(), 1024);
        auto Copied = MakeBuffer(FRHIBufferCreateDesc::CreateStructured(TEXT("GlobalComputeCopy"), 1024, 4)
                                     .SetInitialState(ERHIAccess::CopyDest),
                                 Sentinel.GetData(), 1024);
        FRHIViewDesc View;
        View.Common.ViewType = FRHIViewDesc::EViewType::BufferUAV;
        View.Buffer.UAV.BufferType = FRHIViewDesc::EBufferType::Structured;
        View.Buffer.UAV.OffsetInBytes = 256;
        View.Buffer.UAV.Stride = 4;
        View.Buffer.UAV.NumElements = 128;
        auto UAV = GDynamicRHI->RHICreateUnorderedAccessView(Cmd, Storage, View);
        SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Compute));
        auto *CachedCompute =
            PipelineStateCache::GetAndOrCreateComputePipelineState(Cmd, FComputePipelineStateInitializer(Compute));
        Record(TEXT("global-compute-cache-reuses-pso"),
               CachedCompute == PipelineStateCache::GetAndOrCreateComputePipelineState(
                                    Cmd, FComputePipelineStateInitializer(Compute)) &&
                   RHI->ComputePipelinesCreated == 1);
        const FRHIShaderParameterResource ComputeResources[] = {{UAV, 1}};
        Cmd.SetShaderParameters(Compute, {}, {}, ComputeResources, {});
        ValueParameter(Cmd, Compute.GetReference(), uint32(17));
        Cmd.DispatchComputeShader(2, 1, 1);
        Cmd.Transition(FRHITransitionInfo(UAV, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
        Cmd.CopyBufferRegion(Copied, 0, Storage, 0, 1024);
        Cmd.Transition(FRHITransitionInfo(UAV, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
        ValueParameter(Cmd, Compute.GetReference(), uint32(31));
        Cmd.DispatchComputeShader(2, 1, 1);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        const auto CurrentBytes = RHI->ReadBuffer(Storage, 1024), CopiedBytes = RHI->ReadBuffer(Copied, 1024);
        bool ComputeOK = CurrentBytes.Num() == 1024 && CopiedBytes.Num() == 1024;
        if (ComputeOK)
            for (uint32 Index = 0; Index < 256; ++Index)
            {
                const bool Inside = Index >= 64 && Index < 192;
                ComputeOK &=
                    reinterpret_cast<const uint32 *>(CurrentBytes.GetData())[Index] == (Inside ? 31u : 0xa5a5a5a5) &&
                    reinterpret_cast<const uint32 *>(CopiedBytes.GetData())[Index] == (Inside ? 17u : 0xa5a5a5a5);
                Checked += 2;
            }
        Record(TEXT("global-dispatch-copy-and-uav-reuse"), ComputeOK);
        Cmd.EndFrame();
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("executor-end-frame"), RHI->EndFrames == 1);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("empty-flush-preserves-order"), RHI->Finalized == RHI->Submitted);
    }
    const bool DepthSupported = GPixelFormats[PF_DepthStencil].Supported && GPixelFormats[PF_X24_G8].Supported;
    Record(TEXT("scene-depth-and-stencil-formats-registered"), DepthSupported);
    if (DepthSupported)
    {
        auto DepthVS = RHICreateVertexShader(
            FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementVS_Depth"))));
        auto ClearPS = RHICreatePixelShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementPS"))));
        FGraphicsPipelineStateInitializer Pipeline;
        Pipeline.BoundShaderState.VertexShaderRHI = DepthVS;
        Pipeline.BoundShaderState.PixelShaderRHI = ClearPS;
        Pipeline.BlendState = RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
        Pipeline.RasterizerState = RHICreateRasterizerState(FRasterizerStateInitializerRHI(FM_Solid, CM_None, false));
        Pipeline.DepthStencilState = RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(true, CF_Greater));
        Pipeline.PrimitiveType = PT_TriangleStrip;
        Pipeline.NumSamples = 1;
        Pipeline.RenderTargetsEnabled = 1;
        Pipeline.RenderTargetFormats[0] = PF_R8G8B8A8;
        Pipeline.DepthStencilTargetFormat = PF_DepthStencil;
        auto Color = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("SceneDepthColor"), 64, 64, PF_R8G8B8A8)
            .SetFlags(ETextureCreateFlags::RenderTargetable).SetClearValue(FClearValueBinding::Black)
            .SetInitialState(ERHIAccess::RTV));
        auto Depth = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("SceneDepthZ"), 64, 64, PF_DepthStencil)
            .SetFlags(ETextureCreateFlags::DepthStencilTargetable | ETextureCreateFlags::ShaderResource)
            .SetClearValue(FClearValueBinding(0.f, 37)).SetInitialState(ERHIAccess::DSVWrite));
        FRHIViewDesc DepthDesc, StencilDesc;
        DepthDesc.Common.ViewType = StencilDesc.Common.ViewType = FRHIViewDesc::EViewType::TextureSRV;
        DepthDesc.Texture.SRV.Dimension = StencilDesc.Texture.SRV.Dimension = FRHIViewDesc::EDimension::Texture2D;
        StencilDesc.Texture.SRV.Format = PF_X24_G8;
        auto DepthSRV = RHI->RHICreateShaderResourceView(Cmd, Depth, DepthDesc);
        auto StencilSRV = RHI->RHICreateShaderResourceView(Cmd, Depth, StencilDesc);
        FString Error;
        auto Invalid = StencilDesc;
        Invalid.Texture.SRV.Format = PF_R32_UINT;
        Record(TEXT("scene-depth-rejects-unrelated-view-format"), !RHI->ValidateTextureSRV(Depth, Invalid, Error));
        auto InvalidTexture = FRHITextureCreateDesc::Create2D(TEXT("UnsupportedDepth"), 64, 64, PF_DepthStencil)
            .SetFlags(ETextureCreateFlags::ShaderResource);
        Record(TEXT("scene-depth-rejects-missing-attachment-capability"),
            !RHI->ValidateTextureInitialization(InvalidTexture, Error));
        InvalidTexture.SetFlags(ETextureCreateFlags::DepthStencilTargetable).SetNumSamples(4);
        Record(TEXT("scene-depth-rejects-multisampling"), !RHI->ValidateTextureInitialization(InvalidTexture, Error));
        Cmd.BeginRenderPass(FRHIRenderPassInfo(Color, ERenderTargetActions::Clear_Store, Depth,
            EDepthStencilTargetActions::ClearDepthStencil_StoreDepthStencil,
            FExclusiveDepthStencil::DepthWrite_StencilWrite), TEXT("SceneDepthReversedZ"));
        Cmd.ApplyCachedRenderTargets(Pipeline);
        SetGraphicsPipelineState(Cmd, Pipeline, 0);
        Cmd.SetViewport(0, 0, 0, 64, 64, 1);
        for (const auto& Draw : {FVector4f(0.25f, 1, 0, 0), FVector4f(0.75f, 0, 1, 0), FVector4f(0.5f, 0, 0, 1)})
        {
            ValueParameter(Cmd, DepthVS.GetReference(), Draw.X);
            ValueParameter(Cmd, ClearPS.GetReference(), FVector4f(Draw.Y, Draw.Z, Draw.W, 1));
            Cmd.DrawPrimitive(0, 2, 1);
        }
        Cmd.EndRenderPass();
        Cmd.Transition(FRHITransitionInfo(Depth, ERHIAccess::DSVWrite, ERHIAccess::DSVRead));
        Cmd.BeginRenderPass(FRHIRenderPassInfo(Color, ERenderTargetActions::Load_Store, Depth,
            EDepthStencilTargetActions::LoadDepthStencil_StoreDepthStencil,
            FExclusiveDepthStencil::DepthRead_StencilRead), TEXT("SceneDepthReadOnly"));
        Pipeline.DepthStencilState = RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Greater));
        Cmd.ApplyCachedRenderTargets(Pipeline);
        SetGraphicsPipelineState(Cmd, Pipeline, 0);
        Cmd.SetViewport(0, 0, 0, 64, 64, 1);
        ValueParameter(Cmd, DepthVS.GetReference(), .5f);
        ValueParameter(Cmd, ClearPS.GetReference(), FVector4f(1, 0, 0, 1));
        Cmd.DrawPrimitive(0, 2, 1);
        Cmd.EndRenderPass();
        Cmd.Transition(FRHITransitionInfo(Depth, ERHIAccess::DSVRead, ERHIAccess::SRVCompute));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        FJsonObject Binding;
        Binding.SetNumberField(TEXT("textureDimension"), 1);
        Binding.SetBoolField(TEXT("textureArrayed"), false);
        Binding.SetBoolField(TEXT("textureMultisampled"), false);
        Binding.SetStringField(TEXT("textureSampleType"), TEXT("float"));
        bool BindingOK = RHI->ValidateTextureBinding(Depth, Binding, ERHIAccess::SRVCompute, Error) &&
            RHI->ValidateTextureBinding(DepthSRV, Binding, ERHIAccess::SRVCompute, Error) &&
            !RHI->ValidateTextureBinding(StencilSRV, Binding, ERHIAccess::SRVCompute, Error);
        Binding.SetStringField(TEXT("textureSampleType"), TEXT("uint"));
        BindingOK &= RHI->ValidateTextureBinding(StencilSRV, Binding, ERHIAccess::SRVCompute, Error) &&
            !RHI->ValidateTextureBinding(DepthSRV, Binding, ERHIAccess::SRVCompute, Error);
        Record(TEXT("scene-depth-reflected-bindings-validate-scalar-types"), BindingOK);
        CheckImage(TEXT("scene-depth-reversed-z-occludes-farther-draws"), Color, FColor::Green, false);
        // Load both real aspect views; this diagnostic shader does not replace UE's rendering shaders.
        const char* Code =
            "@group(0) @binding(0) var d: texture_depth_2d;\n"
            "@group(0) @binding(1) var s: texture_2d<u32>;\n"
            "@group(0) @binding(2) var<storage, read_write> o: array<u32>;\n"
            "@compute @workgroup_size(1) fn main() {\n"
            "o[0]=bitcast<u32>(textureLoad(d,vec2i(32,32),0));\n"
            "o[1]=textureLoad(s,vec2i(32,32),0).x; }\n";
        WGPUShaderSourceWGSL WGSL = WGPU_SHADER_SOURCE_WGSL_INIT;
        WGSL.code = {Code, size_t(FCStringAnsi::Strlen(Code))};
        WGPUShaderModuleDescriptor ShaderDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        ShaderDesc.nextInChain = &WGSL.chain;
        auto Shader = wgpuDeviceCreateShaderModule(RHI->Device, &ShaderDesc);
        WGPUComputePipelineDescriptor ComputeDesc = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
        ComputeDesc.compute.module = Shader;
        ComputeDesc.compute.entryPoint = {"main", 4};
        auto Compute = wgpuDeviceCreateComputePipeline(RHI->Device, &ComputeDesc);
        auto Layout = wgpuComputePipelineGetBindGroupLayout(Compute, 0);
        auto AspectOutput = Cmd.CreateBuffer(FRHIBufferCreateDesc::CreateStructured(TEXT("DepthAspectReadback"), 8, 4)
            .AddUsage(BUF_UnorderedAccess).SetInitialState(ERHIAccess::UAVCompute));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        WGPUBindGroupEntry Entries[3] = {WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT,
            WGPU_BIND_GROUP_ENTRY_INIT};
        Entries[0].binding = 0;
        Entries[0].textureView = static_cast<FWebGPUTextureSRV*>(DepthSRV.GetReference())->Handle;
        Entries[1].binding = 1;
        Entries[1].textureView = static_cast<FWebGPUTextureSRV*>(StencilSRV.GetReference())->Handle;
        Entries[2].binding = 2;
        Entries[2].buffer = static_cast<FWebGPUBuffer*>(AspectOutput.GetReference())->Handle;
        Entries[2].size = 8;
        WGPUBindGroupDescriptor GroupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        GroupDesc.layout = Layout;
        GroupDesc.entryCount = 3;
        GroupDesc.entries = Entries;
        auto Group = wgpuDeviceCreateBindGroup(RHI->Device, &GroupDesc);
        RHI->RHIGetDefaultContext();
        auto ComputePass = wgpuCommandEncoderBeginComputePass(RHI->Encoder, nullptr);
        wgpuComputePassEncoderSetPipeline(ComputePass, Compute);
        wgpuComputePassEncoderSetBindGroup(ComputePass, 0, Group, 0, nullptr);
        wgpuComputePassEncoderDispatchWorkgroups(ComputePass, 1, 1, 1);
        wgpuComputePassEncoderEnd(ComputePass);
        wgpuComputePassEncoderRelease(ComputePass);
        RHI->SubmitCurrent();
        auto Bytes = RHI->ReadBuffer(AspectOutput, 8);
        float DepthValue = 0;
        uint32 StencilValue = 0;
        if (Bytes.Num() == 8)
        {
            FMemory::Memcpy(&DepthValue, Bytes.GetData(), 4);
            FMemory::Memcpy(&StencilValue, Bytes.GetData() + 4, 4);
        }
        Record(TEXT("scene-depth-aspect-loads-written-depth"), Bytes.Num() == 8 && FMath::IsNearlyEqual(DepthValue, .75f));
        Record(TEXT("scene-stencil-aspect-loads-clear-value"), Bytes.Num() == 8 && StencilValue == 37);
        Checked += 2;
        wgpuBindGroupRelease(Group);
        wgpuBindGroupLayoutRelease(Layout);
        wgpuComputePipelineRelease(Compute);
        wgpuShaderModuleRelease(Shader);
    }
    Scope.PrepareShutdown();
    Record(TEXT("all-global-transitions-auto-released"),
           RHI->TransitionsCreated == (DepthSupported ? 8u : 6u) &&
               RHI->TransitionsBegun == RHI->TransitionsCreated && RHI->TransitionsEnded == RHI->TransitionsCreated &&
               RHI->TransitionsReleased == RHI->TransitionsCreated && RHI->Transitions.IsEmpty());
    Record(TEXT("global-gpu-validation-clean"), RHI->Errors.IsEmpty());
    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("mode"), Mode);
    Report->SetStringField(TEXT("adapter"), RHI->AdapterName);
    Report->SetNumberField(TEXT("draws"), RHI->Draws);
    Report->SetNumberField(TEXT("dispatches"), RHI->Dispatches);
    Report->SetNumberField(TEXT("finalizedCommandLists"), RHI->Finalized);
    Report->SetNumberField(TEXT("submittedCommandLists"), RHI->Submitted);
    Report->SetNumberField(TEXT("bindGroups"), RHI->BoundGroups);
    Report->SetNumberField(TEXT("graphicsPipelinesCreated"), RHI->GraphicsPipelinesCreated);
    Report->SetNumberField(TEXT("computePipelinesCreated"), RHI->ComputePipelinesCreated);
    Report->SetNumberField(TEXT("transitionsCreated"), RHI->TransitionsCreated);
    Report->SetNumberField(TEXT("transitionsBegun"), RHI->TransitionsBegun);
    Report->SetNumberField(TEXT("transitionsEnded"), RHI->TransitionsEnded);
    Report->SetNumberField(TEXT("transitionsReleased"), RHI->TransitionsReleased);
    Report->SetNumberField(TEXT("checkedValues"), Checked);
    Report->SetNumberField(TEXT("privateDataSize"), sizeof(FWebGPUTransitionPrivateData));
    Report->SetBoolField(TEXT("staticUniformProbe"), StaticProbe);
    Report->SetNumberField(TEXT("staticUniformBatches"), RHI->StaticUniformBatches);
    Report->SetNumberField(TEXT("staticUniformUpdates"), RHI->StaticUniformUpdates);
    Report->SetNumberField(TEXT("staticUniformResolutions"), RHI->StaticUniformResolutions);
    TArray<TSharedPtr<FJsonValue>> Errors;
    for (const auto &Error : RHI->Errors)
        Errors.Add(MakeShared<FJsonValueString>(Error));
    Report->SetArrayField(TEXT("errors"), Errors);
    Scope.Restore();
    const auto RestoredFormat = [](const FPixelFormatInfo& Current, const FPixelFormatInfo& Previous) {
        return Current.Supported == Previous.Supported && Current.PlatformFormat == Previous.PlatformFormat &&
            Current.Capabilities == Previous.Capabilities && Current.BlockBytes == Previous.BlockBytes &&
            Current.bIs24BitUnormDepthStencil == Previous.bIs24BitUnormDepthStencil;
    };
    Record(TEXT("scene-depth-host-format-registration-restored"),
        RestoredFormat(GPixelFormats[PF_DepthStencil], HostDepthFormat) &&
        RestoredFormat(GPixelFormats[PF_X24_G8], HostStencilFormat));
    Record(TEXT("host-rhi-globals-and-mode-restored"), Scope.IsRestored());
    Report->SetArrayField(TEXT("checks"), Checks);
    Report->SetBoolField(TEXT("pass"), Pass);
    return Report;
}
} // namespace

bool RunWebGPUGlobalProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUGlobalProbe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("temporaryGlobalDispatchVerified"), true);
        Report->SetBoolField(TEXT("importedRHIStartupImplemented"), false);
        Report->SetBoolField(TEXT("completeUERendererImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetStringField(
            TEXT("scope"),
            TEXT("Temporary module-created global RHI; serial render thread; host initialized as NullRHI"));
        Report->SetArrayField(TEXT("modes"), Modes);
        FString Json;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
        check(FFileHelper::SaveStringToFile(Json, *(OutputDirectory / TEXT("global-rhi-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
