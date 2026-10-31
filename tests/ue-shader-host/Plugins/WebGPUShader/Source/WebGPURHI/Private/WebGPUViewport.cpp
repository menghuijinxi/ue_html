#include "WebGPUDynamicRHI.h"

#if defined(PLATFORM_WEB) && PLATFORM_WEB
#include <emscripten/html5.h>
#else
#include "Windows/WindowsHWrapper.h"
#endif

FWebGPUViewport::~FWebGPUViewport()
{
    WebGPUOnOwner([&] {
    check(OwnerThread == FPlatformTLS::GetCurrentThreadId());
    InvalidateFrame();
    if (Surface)
    {
        wgpuSurfaceUnconfigure(Surface);
        wgpuSurfaceRelease(Surface);
    }
    });
}

void FWebGPUViewport::InvalidateFrame()
{
    if (BackBuffer)
        BackBuffer->SurfaceFrameActive = false;
    BackBuffer.SafeRelease();
}

bool FWebGPUDynamicRHI::ValidateViewport(void *Window, uint32 Width, uint32 Height, bool Fullscreen,
                                         EPixelFormat Format, FString &Error) const
{
    const bool ValidWindow = Window
#if !defined(PLATFORM_WEB) || !PLATFORM_WEB
        && IsWindow(static_cast<HWND>(Window))
#endif
        ;
    if (!ValidWindow || !Width || !Height || Width > Limits.maxTextureDimension2D ||
        Height > Limits.maxTextureDimension2D)
        Error = TEXT("Viewport requires a valid window and nonzero dimensions within device limits");
    else if (Fullscreen)
        Error = TEXT("WebGPU viewport currently supports windowed presentation only");
    else if (Format != PF_Unknown && Format != PF_R8G8B8A8 && Format != PF_B8G8R8A8)
        Error = TEXT("WebGPU viewport currently supports RGBA8/BGRA8 only");
    else
        return true;
    return false;
}

FViewportRHIRef FWebGPUDynamicRHI::RHICreateViewport(void *Window, uint32 Width, uint32 Height, bool Fullscreen,
                                                     EPixelFormat Format)
{
    WEBGPU_ON_OWNER(RHICreateViewport(Window, Width, Height, Fullscreen, Format));
    RequireOwner();
    FString Error;
    if (StartupProbeMode)
        UE_LOG(LogRHI, Display,
               TEXT("P3_VIEWPORT_REQUEST {\"window\":\"%p\",\"hasWindow\":%s,\"width\":%u,\"height\":%u,\"fullscreen\":%s,\"format\":%u}"),
               Window, Window ? TEXT("true") : TEXT("false"), Width, Height,
               Fullscreen ? TEXT("true") : TEXT("false"), uint32(Format));
    checkf(ValidateViewport(Window, Width, Height, Fullscreen, Format, Error), TEXT("%s"), *Error);
    auto *Viewport = new FWebGPUViewport(Window);
    Viewport->OwnerThread = OwnerThread;
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    WGPUEmscriptenSurfaceSourceCanvasHTMLSelector Source = WGPU_EMSCRIPTEN_SURFACE_SOURCE_CANVAS_HTML_SELECTOR_INIT;
    Source.selector = {"#canvas", WGPU_STRLEN};
#else
    WGPUSurfaceSourceWindowsHWND Source = WGPU_SURFACE_SOURCE_WINDOWS_HWND_INIT;
    Source.hinstance = GetModuleHandleW(nullptr);
    Source.hwnd = Window;
#endif
    WGPUSurfaceDescriptor Descriptor = WGPU_SURFACE_DESCRIPTOR_INIT;
    Descriptor.nextInChain = &Source.chain;
    Viewport->Surface = wgpuInstanceCreateSurface(Instance, &Descriptor);
    check(Viewport->Surface);
    WGPUSurfaceCapabilities Capabilities = WGPU_SURFACE_CAPABILITIES_INIT;
    check(wgpuSurfaceGetCapabilities(Viewport->Surface, Adapter, &Capabilities) == WGPUStatus_Success);
    const auto SupportsFormat = [&](WGPUTextureFormat In) {
        for (size_t Index = 0; Index < Capabilities.formatCount; ++Index)
            if (Capabilities.formats[Index] == In)
                return true;
        return false;
    };
    if (Format == PF_Unknown)
        Format = SupportsFormat(WGPUTextureFormat_BGRA8Unorm) ? PF_B8G8R8A8 : PF_R8G8B8A8;
    const auto NativeFormat = Format == PF_B8G8R8A8 ? WGPUTextureFormat_BGRA8Unorm : WGPUTextureFormat_RGBA8Unorm;
    checkf(SupportsFormat(NativeFormat), TEXT("Requested viewport format is not supported by this surface"));
    bool SupportsFIFO = false;
    for (size_t Index = 0; Index < Capabilities.presentModeCount; ++Index)
        SupportsFIFO |= Capabilities.presentModes[Index] == WGPUPresentMode_Fifo;
    check(SupportsFIFO && Capabilities.alphaModeCount > 0);
#if !defined(PLATFORM_WEB) || !PLATFORM_WEB
    checkf((Capabilities.usages & (WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc)) ==
               (WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc),
           TEXT("Current viewport probe requires render attachment and CopySrc surface usages"));
#else
    // Emdawn leaves capabilities.usages unset; the browser validates configure's actual usage.
    if (StartupProbeMode)
        UE_LOG(LogRHI, Display, TEXT("P3_WEB canvas surface reported usage=%llu"), uint64(Capabilities.usages));
#endif
    Viewport->Format = Format;
    auto &Configuration = Viewport->Configuration;
    Configuration.device = Device;
    Configuration.format = NativeFormat;
    Configuration.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
#if defined(UE_WEB_ENGINE_WORKER) && UE_WEB_ENGINE_WORKER
    Configuration.usage |= WGPUTextureUsage_CopyDst;
#endif
    Configuration.presentMode = WGPUPresentMode_Fifo;
    Configuration.alphaMode = Capabilities.alphaModes[0];
    Configuration.width = Width;
    Configuration.height = Height;
    wgpuSurfaceCapabilitiesFreeMembers(Capabilities);
    wgpuSurfaceConfigure(Viewport->Surface, &Configuration);
    ++ViewportsCreated;
    if (StartupProbeMode)
        UE_LOG(LogRHI, Display,
               TEXT("P3_VIEWPORT_CONFIGURED {\"width\":%u,\"height\":%u,\"format\":%u,\"usage\":%llu}"),
               Width, Height, uint32(Format), uint64(Configuration.usage));
    return Viewport;
}

void FWebGPUDynamicRHI::RHIResizeViewport(FRHIViewport *InViewport, uint32 Width, uint32 Height, bool Fullscreen,
                                          EPixelFormat Format)
{
    WEBGPU_ON_OWNER(RHIResizeViewport(InViewport, Width, Height, Fullscreen, Format));
    RequireOwner();
    auto &Viewport = *static_cast<FWebGPUViewport *>(InViewport);
    FString Error;
    checkf(ValidateViewport(Viewport.Window, Width, Height, Fullscreen, Format, Error), TEXT("%s"), *Error);
    check(!Pass);
    Viewport.InvalidateFrame();
    check(Format == PF_Unknown || Format == Viewport.Format);
    if (ContextOpen)
        SubmitCurrent();
#if !defined(PLATFORM_WEB) || !PLATFORM_WEB
    RHIBlockUntilGPUIdle();
#endif
    // Submitted WebGPU commands retain their resources; reconfigure in queue order.
    Viewport.Configuration.width = Width;
    Viewport.Configuration.height = Height;
    wgpuSurfaceConfigure(Viewport.Surface, &Viewport.Configuration);
    ++ViewportsResized;
}

FTextureRHIRef FWebGPUDynamicRHI::RHIGetViewportBackBuffer(FRHIViewport *InViewport)
{
#if defined(UE_WEB_ENGINE_WORKER) && UE_WEB_ENGINE_WORKER
    // UE flushes rendering before viewport resize. Between resizes this ref is
    // stable, allowing RT to record the next frame while RHI encodes the prior one.
    auto& StableViewport = *static_cast<FWebGPUViewport*>(InViewport);
    if (StableViewport.BackBuffer) return StableViewport.BackBuffer.GetReference();
#endif
    WEBGPU_ON_OWNER(RHIGetViewportBackBuffer(InViewport));
    RequireOwner();
    auto &Viewport = *static_cast<FWebGPUViewport *>(InViewport);
#if defined(UE_WEB_ENGINE_WORKER) && UE_WEB_ENGINE_WORKER
    // A canvas texture expires at the end of a JS task. Keep the UE backbuffer
    // independent of that lifetime; acquire/copy/present together on the RHI Worker.
    if (!Viewport.BackBuffer)
    {
        auto Native = WGPU_TEXTURE_DESCRIPTOR_INIT;
        Native.size = {Viewport.Configuration.width, Viewport.Configuration.height, 1};
        Native.format = Viewport.Configuration.format;
        Native.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
        const auto Desc = FRHITextureCreateDesc::Create2D(TEXT("WebGPUBackBuffer"), Native.size.width,
                Native.size.height, Viewport.Format)
            .SetFlags(ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::Presentable)
            .SetClearValue(FClearValueBinding(FLinearColor(0, 0, 0, 1))).SetInitialState(ERHIAccess::Present);
        Viewport.BackBuffer = new FWebGPUTexture(Desc, wgpuDeviceCreateTexture(Device, &Native));
    }
    return Viewport.BackBuffer.GetReference();
#endif
    if (!Viewport.BackBuffer)
    {
        WGPUSurfaceTexture SurfaceTexture = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(Viewport.Surface, &SurfaceTexture);
        checkf(SurfaceTexture.texture &&
                   (SurfaceTexture.status == WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal ||
                    SurfaceTexture.status == WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal),
               TEXT("WebGPU surface acquire failed, status=%u"), uint32(SurfaceTexture.status));
        const auto Desc = FRHITextureCreateDesc::Create2D(TEXT("WebGPUBackBuffer"), Viewport.Configuration.width,
                                                          Viewport.Configuration.height, Viewport.Format)
                              .SetFlags(ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::Presentable)
                              .SetClearValue(FClearValueBinding(FLinearColor(0, 0, 0, 1)))
                              .SetInitialState(ERHIAccess::Present);
        Viewport.BackBuffer = new FWebGPUTexture(Desc, SurfaceTexture.texture);
        ++FramesAcquired;
    }
    return Viewport.BackBuffer.GetReference();
}

void FWebGPUDynamicRHI::RHIEndDrawingViewport(FRHICommandListImmediate &Cmd, FRHIViewport *InViewport,
                                              const FRHIPresentArgs &Args)
{
#if defined(UE_WEB_ENGINE_WORKER) && UE_WEB_ENGINE_WORKER
    Cmd.EnqueueLambda([this, Viewport = TRefCountPtr<FWebGPUViewport>(static_cast<FWebGPUViewport*>(InViewport)), Args]
        (FRHICommandListBase&) { PresentBrowserViewport(*Viewport, Args); });
    return;
#endif
    RequireOwner();
    auto &Viewport = *static_cast<FWebGPUViewport *>(InViewport);
#if !defined(PLATFORM_WEB) || !PLATFORM_WEB
    checkf(Args.bLockToVsync, TEXT("Current WebGPU viewport supports FIFO/vsync presentation only"));
#else
    // Canvas presentation is controlled by the browser; UE cannot select an immediate present mode.
    check(Viewport.Configuration.presentMode == WGPUPresentMode_Fifo);
#endif
    check(!Pass && Viewport.BackBuffer);
    Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
    if (ContextOpen)
        SubmitCurrent();
    RequireAccess(Viewport.BackBuffer, ERHIAccess::Present);
    if (Args.bPresent)
    {
#if !defined(PLATFORM_WEB) || !PLATFORM_WEB
        check(wgpuSurfacePresent(Viewport.Surface) == WGPUStatus_Success);
#endif
        ++FramesPresented;
        Viewport.InvalidateFrame();
    }
    else
    {
#if !defined(PLATFORM_WEB) || !PLATFORM_WEB
        RHIBlockUntilGPUIdle();
#endif
        Viewport.InvalidateFrame();
        wgpuSurfaceUnconfigure(Viewport.Surface);
        wgpuSurfaceConfigure(Viewport.Surface, &Viewport.Configuration);
        ++FramesSkipped;
    }
#if defined(PLATFORM_WEB) && PLATFORM_WEB
    if (StartupProbeMode && FramesPresented + FramesSkipped <= 4)
        UE_LOG(LogRHI, Display,
               TEXT("P3_VIEWPORT_END {\"requestedVSync\":%s,\"present\":%s,\"effectiveMode\":\"browser-fifo\","
                    "\"acquired\":%u,\"ended\":%u,\"skipped\":%u,\"submitted\":%u,\"backbufferReleased\":%s}"),
               Args.bLockToVsync ? TEXT("true") : TEXT("false"), Args.bPresent ? TEXT("true") : TEXT("false"),
               FramesAcquired, FramesPresented, FramesSkipped, Submitted,
               Viewport.BackBuffer ? TEXT("false") : TEXT("true"));
#endif
}

void FWebGPUDynamicRHI::PresentBrowserViewport(FWebGPUViewport& Viewport, const FRHIPresentArgs& Args)
{
    RequireOwner();
    check(!Pass && Viewport.BackBuffer);
    if (ContextOpen) SubmitCurrent();
    RequireAccess(Viewport.BackBuffer, ERHIAccess::Present);
    if (!Args.bPresent) { ++FramesSkipped; return; }
    auto Surface = WGPU_SURFACE_TEXTURE_INIT;
    wgpuSurfaceGetCurrentTexture(Viewport.Surface, &Surface);
    check(Surface.texture);
    auto Copy = wgpuDeviceCreateCommandEncoder(Device, nullptr);
    auto Source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    auto Destination = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    Source.texture = Viewport.BackBuffer->Handle;
    Destination.texture = Surface.texture;
    const WGPUExtent3D Extent{Viewport.Configuration.width, Viewport.Configuration.height, 1};
    wgpuCommandEncoderCopyTextureToTexture(Copy, &Source, &Destination, &Extent);
    auto Commands = wgpuCommandEncoderFinish(Copy, nullptr);
    wgpuQueueSubmit(Queue, 1, &Commands);
    wgpuCommandBufferRelease(Commands);
    wgpuCommandEncoderRelease(Copy);
    wgpuTextureRelease(Surface.texture);
    ++FramesAcquired;
    ++FramesPresented;
}
