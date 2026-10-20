#include "WebGPUViewportProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"

#include "HAL/FileManager.h"
#include "Containers/ResourceArray.h"
#include "PipelineStateCache.h"
#include "RenderResource.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"
#include "Windows/WindowsHWrapper.h"

namespace
{
class FWindow
{
  public:
    HWND Handle;
    FWindow()
    {
        Handle = CreateWindowExW(0, L"STATIC", L"WebGPU RHI probe", WS_POPUP, 0, 0, 64, 64, nullptr, nullptr,
                                 GetModuleHandleW(nullptr), nullptr);
        check(Handle && !IsWindowVisible(Handle));
    }
    ~FWindow()
    {
        check(DestroyWindow(Handle));
    }
};

class FProbeResource final : public FRenderResource
{
  public:
    FBufferRHIRef Vertex, Index;
    uint32 Inits = 0, Releases = 0;
    float Vertices[16] = {0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1};
    uint16 Indices[6] = {0, 2, 1, 1, 2, 3};
    void InitRHI(FRHICommandListBase &Cmd) override
    {
        auto VertexDesc = FRHIBufferCreateDesc::CreateVertex(TEXT("LifecycleVertices"), sizeof(Vertices))
                              .SetInitActionInitializer()
                              .DetermineInitialState();
        auto VertexInit = Cmd.CreateBufferInitializer(VertexDesc);
        VertexInit.WriteData(Vertices, sizeof(Vertices));
        Vertex = VertexInit.Finalize();
        auto IndexDesc = FRHIBufferCreateDesc::CreateIndex(TEXT("LifecycleIndices"), sizeof(Indices), 2)
                             .SetInitActionInitializer()
                             .DetermineInitialState();
        auto IndexInit = Cmd.CreateBufferInitializer(IndexDesc);
        IndexInit.WriteData(Indices, sizeof(Indices));
        Index = IndexInit.Finalize();
        ++Inits;
    }
    void ReleaseRHI() override
    {
        Vertex.SafeRelease();
        Index.SafeRelease();
        ++Releases;
    }
};

class FDiscardingUpload final : public FResourceArrayUploadInterface
{
  public:
    TArray<uint32> Data{11, 22, 33, 44, 55, 66, 77, 88};
    uint32 Discards = 0;
    const void *GetResourceData() const override
    {
        return Data.GetData();
    }
    uint32 GetResourceDataSize() const override
    {
        return Data.Num() * sizeof(uint32);
    }
    void Discard() override
    {
        Data.Reset();
        ++Discards;
    }
};

TSharedRef<FJsonObject> RunMode(IDynamicRHIModule &Module, const FString &Directory, const FString &Output, bool Bypass)
{
    using namespace WebGPUProbe;
    auto &Cmd = FRHICommandListImmediate::Get();
    FWebGPUGlobalScope Scope(Module);
    auto &RHI = *Scope.RHI;
    GRHIGlobals.NeedsExtraTransitions = true;
    RHI.RHITick(0.0f);
    RHI.RHITick(1.0f / 60.0f);
    if (Bypass)
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                       ERHISubmitFlags::EnableBypass);
    bool Pass = true;
    uint64 Checked = 0;
    TArray<TSharedPtr<FJsonValue>> Checks;
    const FString Mode = Bypass ? TEXT("bypass") : TEXT("recorded");
    const auto Record = [&](const TCHAR *Name, bool OK) {
        auto Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("name"), Name);
        Item->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Item));
        Pass &= OK;
        UE_LOG(LogRHI, Display, TEXT("P2_VIEWPORT %s %s pass=%d"), *Mode, Name, OK);
    };
    TArray<uint32> BytesPerFormat;
    for (uint32 Index = 0; Index < PF_MAX; ++Index)
        BytesPerFormat.Add(GPixelFormats[Index].BlockBytes);
    RHIPostInit(BytesPerFormat);
    Record(TEXT("post-init-through-global-entry"), RHI.PostInitCalls == 1 && !GUsingNullRHI);
    {
        for (auto Format : {PF_R8G8B8A8, PF_B8G8R8A8})
        {
            auto TextureDesc = FRHITextureCreateDesc::Create2D(TEXT("TextureInitializer"), 3, 2, Format)
                                   .SetFlags(ETextureCreateFlags::ShaderResource)
                                   .SetInitialState(ERHIAccess::SRVGraphicsPixel)
                                   .SetInitActionInitializer();
            auto TextureInit = Cmd.CreateTextureInitializer(TextureDesc);
            auto Subresource = TextureInit.GetTexture2DSubresource(0);
            check(Subresource.Size == 24 && Subresource.Stride == 12);
            for (uint32 Index = 0; Index < 6; ++Index)
            {
                uint8 *Pixel = static_cast<uint8 *>(Subresource.Data) + Index * 4;
                Pixel[0] = Index * 17;
                Pixel[1] = Index * 29;
                Pixel[2] = Index * 41;
                Pixel[3] = 255;
            }
            auto Texture = TextureInit.Finalize();
            TArray<FColor> Colors;
            Cmd.ReadSurfaceData(Texture, FIntRect(0, 0, 3, 2), Colors, RawReadback());
            bool OK = Colors.Num() == 6;
            for (int32 Index = 0; Index < Colors.Num(); ++Index)
            {
                OK &= Colors[Index] == FColor(Index * (Format == PF_B8G8R8A8 ? 41 : 17), Index * 29,
                                              Index * (Format == PF_B8G8R8A8 ? 17 : 41), 255);
                Checked += 4;
            }
            Record(Format == PF_B8G8R8A8 ? TEXT("texture-initializer-bgra8") : TEXT("texture-initializer-rgba8"), OK);
        }
        FDiscardingUpload Upload;
        const auto ExpectedUpload = Upload.Data;
        auto UploadDesc = FRHIBufferCreateDesc::CreateVertex(TEXT("ResourceArrayUpload"), Upload.GetResourceDataSize())
                              .SetInitActionResourceArray(&Upload)
                              .DetermineInitialState();
        auto Uploaded = Cmd.CreateBuffer(UploadDesc);
        Record(TEXT("resource-array-discard-after-snapshot"), Upload.Discards == 1 && Upload.Data.IsEmpty());
        const auto UploadedBytes = RHI.ReadBuffer(Uploaded, ExpectedUpload.Num() * sizeof(uint32));
        Record(TEXT("resource-array-upload-survives-discard"),
               UploadedBytes.Num() == ExpectedUpload.Num() * sizeof(uint32) &&
                   FMemory::Memcmp(UploadedBytes.GetData(), ExpectedUpload.GetData(), UploadedBytes.Num()) == 0);
        Checked += UploadedBytes.Num();
        Uploaded.SafeRelease();
        FProbeResource Resource;
        const auto CheckBuffers = [&](const TCHAR *Name) {
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto VertexBytes = RHI.ReadBuffer(Resource.Vertex, sizeof(Resource.Vertices));
            const auto IndexBytes = RHI.ReadBuffer(Resource.Index, sizeof(Resource.Indices));
            const bool OK = VertexBytes.Num() == sizeof(Resource.Vertices) &&
                            IndexBytes.Num() == sizeof(Resource.Indices) &&
                            FMemory::Memcmp(VertexBytes.GetData(), Resource.Vertices, sizeof(Resource.Vertices)) == 0 &&
                            FMemory::Memcmp(IndexBytes.GetData(), Resource.Indices, sizeof(Resource.Indices)) == 0;
            Checked += VertexBytes.Num() + IndexBytes.Num();
            Record(Name, OK);
        };
        Resource.InitResource(Cmd);
        Resource.InitResource(Cmd);
        Record(TEXT("render-resource-init-is-idempotent"), Resource.IsInitialized() && Resource.Inits == 1 &&
                                                               Resource.Releases == 0 && Resource.Vertex &&
                                                               Resource.Index);
        CheckBuffers(TEXT("render-resource-initial-data"));
        auto PreviousVertex = Resource.Vertex;
        Resource.Vertices[0] = 0.125f;
        Resource.Indices[0] = 3;
        Resource.UpdateRHI(Cmd);
        Record(TEXT("render-resource-update-recreates"),
               Resource.Inits == 2 && Resource.Releases == 1 && Resource.Vertex != PreviousVertex);
        CheckBuffers(TEXT("render-resource-updated-data"));
        PreviousVertex.SafeRelease();
        Resource.ReleaseResource();
        Record(TEXT("render-resource-release-clears"),
               !Resource.IsInitialized() && !Resource.Vertex && !Resource.Index && Resource.Releases == 2);
        Resource.InitResource(Cmd);
        Record(TEXT("render-resource-reinitializes"), Resource.IsInitialized() && Resource.Inits == 3);
        CheckBuffers(TEXT("render-resource-reinitialized-data"));
        Resource.ReleaseResource();
        Record(TEXT("render-resource-final-release"), !Resource.IsInitialized() && Resource.Releases == 3);

        FWindow Window;
        FString Error;
        Record(TEXT("reject-null-window"), !RHI.ValidateViewport(nullptr, 64, 64, false, PF_Unknown, Error));
        Record(TEXT("reject-zero-viewport"), !RHI.ValidateViewport(Window.Handle, 0, 64, false, PF_Unknown, Error));
        Record(
            TEXT("reject-oversized-viewport"),
            !RHI.ValidateViewport(Window.Handle, RHI.Limits.maxTextureDimension2D + 1, 64, false, PF_Unknown, Error));
        Record(TEXT("reject-fullscreen-viewport"),
               !RHI.ValidateViewport(Window.Handle, 64, 64, true, PF_Unknown, Error));
        Record(TEXT("reject-unsupported-viewport-format"),
               !RHI.ValidateViewport(Window.Handle, 64, 64, false, PF_FloatRGBA, Error));
        auto Viewport = RHICreateViewport(Window.Handle, 64, 64, false, PF_Unknown);
        auto *NativeViewport = static_cast<FWebGPUViewport *>(Viewport.GetReference());
        Record(TEXT("surface-native-window-and-swapchain"),
               Viewport->GetNativeWindow() == Window.Handle && Viewport->GetNativeSwapChain() &&
                   !IsWindowVisible(Window.Handle) &&
                   (NativeViewport->Format == PF_B8G8R8A8 || NativeViewport->Format == PF_R8G8B8A8));
        auto VS = RHICreateVertexShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementVS"))));
        auto PS = RHICreatePixelShader(FRHICreateShaderDesc(Packet(Directory, TEXT("FClearReplacementPS"))));
        FGraphicsPipelineStateInitializer Pipeline;
        Pipeline.BoundShaderState.VertexShaderRHI = VS;
        Pipeline.BoundShaderState.PixelShaderRHI = PS;
        Pipeline.PrimitiveType = PT_TriangleStrip;
        Pipeline.RenderTargetsEnabled = 1;
        Pipeline.RenderTargetFormats[0] = NativeViewport->Format;
        Pipeline.NumSamples = 1;
        Pipeline.BlendState =
            RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
        Pipeline.RasterizerState = RHICreateRasterizerState(FRasterizerStateInitializerRHI(FM_Solid, CM_None, false));
        Pipeline.DepthStencilState = RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
        const auto DrawFrame = [&](const TCHAR *Name, FRHITexture *Back, FVector4f Value, FColor Expected, bool Save) {
            Cmd.Transition(FRHITransitionInfo(Back, ERHIAccess::Present, ERHIAccess::RTV));
            Cmd.BeginRenderPass(FRHIRenderPassInfo(Back, ERenderTargetActions::Clear_Store), TEXT("SurfaceDraw"));
            SetGraphicsPipelineState(Cmd, Pipeline, 0, EApplyRendertargetOption::DoNothing);
            Cmd.SetViewport(0, 0, 0, Back->GetSizeX(), Back->GetSizeY(), 1);
            const FRHIShaderParameter Parameter(0, 0, 0, sizeof(Value));
            Cmd.SetShaderParameters(PS, MakeArrayView(reinterpret_cast<const uint8 *>(&Value), sizeof(Value)),
                                    MakeArrayView(&Parameter, 1), {}, {});
            Cmd.DrawPrimitive(0, 2, 1);
            Cmd.EndRenderPass();
            Cmd.EnqueueLambda([&RHI, Back](FRHICommandListBase &) {
                FString AccessError;
                check(RHI.ValidateAccess(Back, ERHIAccess::RTV, AccessError));
                check(!RHI.ValidateAccess(Back, ERHIAccess::Present, AccessError));
            });
            // Match Slate's final transition outside RDG, including the unknown source access.
            if (GRHIGlobals.NeedsExtraTransitions)
                Cmd.Transition(FRHITransitionInfo(Back, ERHIAccess::Unknown, ERHIAccess::Present));
            TArray<FColor> Colors;
            Cmd.ReadSurfaceData(Back, FIntRect(0, 0, Back->GetSizeX(), Back->GetSizeY()), Colors, RawReadback());
            bool OK = Colors.Num() == int32(Back->GetSizeX() * Back->GetSizeY());
            TArray<uint8> Pixels;
            for (auto Color : Colors)
            {
                OK &= FMath::Abs(int32(Color.R) - Expected.R) <= 1 && FMath::Abs(int32(Color.G) - Expected.G) <= 1 &&
                      FMath::Abs(int32(Color.B) - Expected.B) <= 1 && Color.A == Expected.A;
                Checked += 4;
                if (Save)
                    Pixels.Append({Color.R, Color.G, Color.B, Color.A});
            }
            if (Save)
                check(FFileHelper::SaveArrayToFile(Pixels, *(Output / (Mode + TEXT("-") + Name + TEXT(".rgba")))));
            Record(Name, OK);
        };
        auto Back = RHIGetViewportBackBuffer(Viewport);
        Record(TEXT("surface-acquire-is-stable"),
               Back == RHIGetViewportBackBuffer(Viewport) && RHI.FramesAcquired == 1 && Back->GetSizeX() == 64);
        DrawFrame(TEXT("surface-first-frame"), Back, FVector4f(0.75f, 0.25f, 0.5f, 1), FColor(191, 64, 128, 255), true);
        Cmd.EndDrawingViewport(Viewport, FRHIPresentArgs(0, true, true));
        Record(TEXT("surface-first-present"), RHI.FramesPresented == 1 && !NativeViewport->BackBuffer);
        Record(TEXT("reject-expired-surface-frame"), !RHI.ValidateAccess(Back, ERHIAccess::RTV, Error));
        Back.SafeRelease();
        check(SetWindowPos(Window.Handle, nullptr, 0, 0, 96, 48, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE));
        RHIResizeViewport(Viewport, 96, 48, false, PF_Unknown);
        Back = RHIGetViewportBackBuffer(Viewport);
        Record(TEXT("surface-resize-reacquires"), RHI.ViewportsResized == 1 && RHI.FramesAcquired == 2 &&
                                                      Back->GetSizeX() == 96 && Back->GetSizeY() == 48);
        DrawFrame(TEXT("surface-resized-frame"), Back, FVector4f(0.125f, 0.75f, 0.25f, 1), FColor(32, 191, 64, 255),
                  true);
        Cmd.EndDrawingViewport(Viewport, FRHIPresentArgs(1, true, true));
        Record(TEXT("surface-second-present"), RHI.FramesPresented == 2 && !NativeViewport->BackBuffer);
        Back.SafeRelease();
        Back = RHIGetViewportBackBuffer(Viewport);
        DrawFrame(TEXT("surface-skipped-frame"), Back, FVector4f(0.125f, 0.25f, 0.75f, 1), FColor(32, 64, 191, 255),
                  true);
        Cmd.EndDrawingViewport(Viewport, FRHIPresentArgs(2, false, true));
        Record(TEXT("surface-skip-does-not-present"), RHI.FramesSkipped == 1 && RHI.FramesPresented == 2 &&
                                                          !NativeViewport->BackBuffer &&
                                                          !RHI.ValidateAccess(Back, ERHIAccess::Present, Error));
        Back.SafeRelease();
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                       ERHISubmitFlags::EnableDrawEvents);
        Back = RHIGetViewportBackBuffer(Viewport);
        DrawFrame(TEXT("surface-resumed-frame"), Back, FVector4f(0.5f, 0.25f, 0.75f, 1), FColor(128, 64, 191, 255),
                  true);
        Cmd.EndDrawingViewport(Viewport, FRHIPresentArgs(3, true, true));
        Record(TEXT("surface-resumes-after-skip"),
               RHI.FramesAcquired == 4 && RHI.FramesPresented == 3 && !NativeViewport->BackBuffer);
        Back.SafeRelease();
        Viewport.SafeRelease();
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
        Record(TEXT("surface-pso-cache-reused"), RHI.GraphicsPipelinesCreated == 1 && RHI.Draws == 4);
    }
    Scope.PrepareShutdown();
    Record(TEXT("surface-transitions-balanced"), RHI.TransitionsCreated == 8 && RHI.TransitionsBegun == 8 &&
                                                     RHI.TransitionsEnded == 8 && RHI.TransitionsReleased == 8 &&
                                                     RHI.Transitions.IsEmpty());
    Record(TEXT("surface-gpu-validation-clean"), RHI.Errors.IsEmpty());
    Record(TEXT("surface-breadcrumbs-balanced"),
           RHI.BreadcrumbsBegun >= 4 && RHI.BreadcrumbsBegun == RHI.BreadcrumbsEnded && RHI.BreadcrumbStack.IsEmpty());
    Record(TEXT("surface-gpu-debug-marker-emitted"), RHI.BreadcrumbMarkersEmitted > 0);
    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("mode"), Mode);
    Report->SetStringField(TEXT("adapter"), RHI.AdapterName);
    Report->SetNumberField(TEXT("checkedValues"), Checked);
    Report->SetNumberField(TEXT("draws"), RHI.Draws);
    Report->SetNumberField(TEXT("graphicsPipelinesCreated"), RHI.GraphicsPipelinesCreated);
    Report->SetNumberField(TEXT("finalizedCommandLists"), RHI.Finalized);
    Report->SetNumberField(TEXT("submittedCommandLists"), RHI.Submitted);
    Report->SetNumberField(TEXT("viewportsCreated"), RHI.ViewportsCreated);
    Report->SetNumberField(TEXT("viewportsResized"), RHI.ViewportsResized);
    Report->SetNumberField(TEXT("framesAcquired"), RHI.FramesAcquired);
    Report->SetNumberField(TEXT("framesPresented"), RHI.FramesPresented);
    Report->SetNumberField(TEXT("framesSkipped"), RHI.FramesSkipped);
    Report->SetNumberField(TEXT("transitionsReleased"), RHI.TransitionsReleased);
    Report->SetNumberField(TEXT("breadcrumbsBegun"), RHI.BreadcrumbsBegun);
    Report->SetNumberField(TEXT("breadcrumbsEnded"), RHI.BreadcrumbsEnded);
    Report->SetNumberField(TEXT("breadcrumbMarkersEmitted"), RHI.BreadcrumbMarkersEmitted);
    TArray<TSharedPtr<FJsonValue>> Errors;
    for (const auto &Error : RHI.Errors)
        Errors.Add(MakeShared<FJsonValueString>(Error));
    Report->SetArrayField(TEXT("errors"), Errors);
    Scope.Restore();
    Record(TEXT("surface-host-rhi-restored"), Scope.IsRestored());
    Report->SetArrayField(TEXT("checks"), Checks);
    Report->SetBoolField(TEXT("pass"), Pass);
    return Report;
}
} // namespace

bool RunWebGPUViewportProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUViewportProbe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("nativeSurfacePresentationVerified"), Pass);
        Report->SetBoolField(TEXT("renderResourceLifecycleVerified"), Pass);
        Report->SetBoolField(TEXT("importedRHIStartupImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetStringField(TEXT("scope"), TEXT("Temporary global RHI; hidden HWND; FIFO; serial RenderThread"));
        Report->SetArrayField(TEXT("modes"), Modes);
        FString Json;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
        check(FFileHelper::SaveStringToFile(Json, *(OutputDirectory / TEXT("viewport-rhi-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
