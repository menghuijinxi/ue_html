#pragma once
#include <webgpu/webgpu.h>

// GPU objects belong to the main WASM runtime Worker. The game and rendering
// threads are pthreads; RHI command translation runs directly on this Worker.
#if defined(UE_WEB_ENGINE_WORKER) && UE_WEB_ENGINE_WORKER
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <atomic>
#include <optional>
#include <type_traits>

inline std::atomic<uint64_t> WebGPUResourceProxyCount{0};

template <typename Function> auto WebGPUOnOwner(Function&& FunctionToRun) -> decltype(FunctionToRun())
{
    using Result = decltype(FunctionToRun());
    if (emscripten_is_main_runtime_thread()) return FunctionToRun();
    WebGPUResourceProxyCount.fetch_add(1, std::memory_order_relaxed);
    if constexpr (std::is_void_v<Result>)
    {
        auto Invoke = [&] { FunctionToRun(); };
        verify(emscripten_proxy_sync(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(),
            [](void* Data) { (*static_cast<decltype(Invoke)*>(Data))(); }, &Invoke));
    }
    else
    {
        std::optional<Result> Value;
        auto Invoke = [&] { Value.emplace(FunctionToRun()); };
        verify(emscripten_proxy_sync(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(),
            [](void* Data) { (*static_cast<decltype(Invoke)*>(Data))(); }, &Invoke));
        return MoveTemp(*Value);
    }
}
#define WEBGPU_ON_OWNER(Call) \
    if (!emscripten_is_main_runtime_thread()) return WebGPUOnOwner([&]() { return Call; })
#define WEBGPU_COMMAND_ON_OWNER(Call) \
    if (!emscripten_is_main_runtime_thread()) { \
        checkf(!IsRunningRHIInSeparateThread(), TEXT("RHI commands must execute directly on the GPU Worker")); \
        return WebGPUOnOwner([&]() { return Call; }); \
    }
#else
template <typename Function> auto WebGPUOnOwner(Function&& FunctionToRun) -> decltype(FunctionToRun())
{
    return FunctionToRun();
}
#define WEBGPU_ON_OWNER(Call)
#define WEBGPU_COMMAND_ON_OWNER(Call)
#endif

#if defined(UE_WEB_ENGINE_WORKER) && UE_WEB_ENGINE_WORKER
template <auto Function, typename... Args> auto WebGPUForward(Args... Values) -> decltype(Function(Values...))
{
    return WebGPUOnOwner([&] { return Function(Values...); });
}
#define wgpuAdapterGetInfo(...) WebGPUForward<&::wgpuAdapterGetInfo>(__VA_ARGS__)
#define wgpuAdapterGetLimits(...) WebGPUForward<&::wgpuAdapterGetLimits>(__VA_ARGS__)
#define wgpuAdapterHasFeature(...) WebGPUForward<&::wgpuAdapterHasFeature>(__VA_ARGS__)
#define wgpuAdapterInfoFreeMembers(...) WebGPUForward<&::wgpuAdapterInfoFreeMembers>(__VA_ARGS__)
#define wgpuAdapterRelease(...) WebGPUForward<&::wgpuAdapterRelease>(__VA_ARGS__)
#define wgpuAdapterRequestDevice(...) WebGPUForward<&::wgpuAdapterRequestDevice>(__VA_ARGS__)
#define wgpuBindGroupAddRef(...) WebGPUForward<&::wgpuBindGroupAddRef>(__VA_ARGS__)
#define wgpuBindGroupLayoutRelease(...) WebGPUForward<&::wgpuBindGroupLayoutRelease>(__VA_ARGS__)
#define wgpuBindGroupRelease(...) WebGPUForward<&::wgpuBindGroupRelease>(__VA_ARGS__)
#define wgpuBufferAddRef(...) WebGPUForward<&::wgpuBufferAddRef>(__VA_ARGS__)
#define wgpuBufferGetConstMappedRange(...) WebGPUForward<&::wgpuBufferGetConstMappedRange>(__VA_ARGS__)
#define wgpuBufferMapAsync(...) WebGPUForward<&::wgpuBufferMapAsync>(__VA_ARGS__)
#define wgpuBufferRelease(...) WebGPUForward<&::wgpuBufferRelease>(__VA_ARGS__)
#define wgpuBufferUnmap(...) WebGPUForward<&::wgpuBufferUnmap>(__VA_ARGS__)
#define wgpuCommandBufferRelease(...) WebGPUForward<&::wgpuCommandBufferRelease>(__VA_ARGS__)
#define wgpuCommandEncoderBeginComputePass(...) WebGPUForward<&::wgpuCommandEncoderBeginComputePass>(__VA_ARGS__)
#define wgpuCommandEncoderBeginRenderPass(...) WebGPUForward<&::wgpuCommandEncoderBeginRenderPass>(__VA_ARGS__)
#define wgpuCommandEncoderClearBuffer(...) WebGPUForward<&::wgpuCommandEncoderClearBuffer>(__VA_ARGS__)
#define wgpuCommandEncoderCopyBufferToBuffer(...) WebGPUForward<&::wgpuCommandEncoderCopyBufferToBuffer>(__VA_ARGS__)
#define wgpuCommandEncoderCopyBufferToTexture(...) WebGPUForward<&::wgpuCommandEncoderCopyBufferToTexture>(__VA_ARGS__)
#define wgpuCommandEncoderCopyTextureToBuffer(...) WebGPUForward<&::wgpuCommandEncoderCopyTextureToBuffer>(__VA_ARGS__)
#define wgpuCommandEncoderCopyTextureToTexture(...) WebGPUForward<&::wgpuCommandEncoderCopyTextureToTexture>(__VA_ARGS__)
#define wgpuCommandEncoderFinish(...) WebGPUForward<&::wgpuCommandEncoderFinish>(__VA_ARGS__)
#define wgpuCommandEncoderInsertDebugMarker(...) WebGPUForward<&::wgpuCommandEncoderInsertDebugMarker>(__VA_ARGS__)
#define wgpuCommandEncoderRelease(...) WebGPUForward<&::wgpuCommandEncoderRelease>(__VA_ARGS__)
#define wgpuCommandEncoderResolveQuerySet(...) WebGPUForward<&::wgpuCommandEncoderResolveQuerySet>(__VA_ARGS__)
#define wgpuComputePassEncoderDispatchWorkgroups(...) WebGPUForward<&::wgpuComputePassEncoderDispatchWorkgroups>(__VA_ARGS__)
#define wgpuComputePassEncoderDispatchWorkgroupsIndirect(...) WebGPUForward<&::wgpuComputePassEncoderDispatchWorkgroupsIndirect>(__VA_ARGS__)
#define wgpuComputePassEncoderEnd(...) WebGPUForward<&::wgpuComputePassEncoderEnd>(__VA_ARGS__)
#define wgpuComputePassEncoderRelease(...) WebGPUForward<&::wgpuComputePassEncoderRelease>(__VA_ARGS__)
#define wgpuComputePassEncoderSetBindGroup(...) WebGPUForward<&::wgpuComputePassEncoderSetBindGroup>(__VA_ARGS__)
#define wgpuComputePassEncoderSetPipeline(...) WebGPUForward<&::wgpuComputePassEncoderSetPipeline>(__VA_ARGS__)
#define wgpuComputePipelineAddRef(...) WebGPUForward<&::wgpuComputePipelineAddRef>(__VA_ARGS__)
#define wgpuComputePipelineGetBindGroupLayout(...) WebGPUForward<&::wgpuComputePipelineGetBindGroupLayout>(__VA_ARGS__)
#define wgpuComputePipelineRelease(...) WebGPUForward<&::wgpuComputePipelineRelease>(__VA_ARGS__)
#define wgpuCreateInstance(...) WebGPUForward<&::wgpuCreateInstance>(__VA_ARGS__)
#define wgpuDeviceCreateBindGroup(...) WebGPUForward<&::wgpuDeviceCreateBindGroup>(__VA_ARGS__)
#define wgpuDeviceCreateBindGroupLayout(...) WebGPUForward<&::wgpuDeviceCreateBindGroupLayout>(__VA_ARGS__)
#define wgpuDeviceCreateBuffer(...) WebGPUForward<&::wgpuDeviceCreateBuffer>(__VA_ARGS__)
#define wgpuDeviceCreateCommandEncoder(...) WebGPUForward<&::wgpuDeviceCreateCommandEncoder>(__VA_ARGS__)
#define wgpuDeviceCreateComputePipeline(...) WebGPUForward<&::wgpuDeviceCreateComputePipeline>(__VA_ARGS__)
#define wgpuDeviceCreatePipelineLayout(...) WebGPUForward<&::wgpuDeviceCreatePipelineLayout>(__VA_ARGS__)
#define wgpuDeviceCreateQuerySet(...) WebGPUForward<&::wgpuDeviceCreateQuerySet>(__VA_ARGS__)
#define wgpuDeviceCreateRenderPipeline(...) WebGPUForward<&::wgpuDeviceCreateRenderPipeline>(__VA_ARGS__)
#define wgpuDeviceCreateSampler(...) WebGPUForward<&::wgpuDeviceCreateSampler>(__VA_ARGS__)
#define wgpuDeviceCreateShaderModule(...) WebGPUForward<&::wgpuDeviceCreateShaderModule>(__VA_ARGS__)
#define wgpuDeviceCreateTexture(...) WebGPUForward<&::wgpuDeviceCreateTexture>(__VA_ARGS__)
#define wgpuDeviceGetLimits(...) WebGPUForward<&::wgpuDeviceGetLimits>(__VA_ARGS__)
#define wgpuDeviceGetQueue(...) WebGPUForward<&::wgpuDeviceGetQueue>(__VA_ARGS__)
#define wgpuDeviceHasFeature(...) WebGPUForward<&::wgpuDeviceHasFeature>(__VA_ARGS__)
#define wgpuDeviceRelease(...) WebGPUForward<&::wgpuDeviceRelease>(__VA_ARGS__)
#define wgpuInstanceCreateSurface(...) WebGPUForward<&::wgpuInstanceCreateSurface>(__VA_ARGS__)
#define wgpuInstanceProcessEvents(...) WebGPUForward<&::wgpuInstanceProcessEvents>(__VA_ARGS__)
#define wgpuInstanceRelease(...) WebGPUForward<&::wgpuInstanceRelease>(__VA_ARGS__)
#define wgpuInstanceRequestAdapter(...) WebGPUForward<&::wgpuInstanceRequestAdapter>(__VA_ARGS__)
#define wgpuPipelineLayoutRelease(...) WebGPUForward<&::wgpuPipelineLayoutRelease>(__VA_ARGS__)
#define wgpuQuerySetRelease(...) WebGPUForward<&::wgpuQuerySetRelease>(__VA_ARGS__)
#define wgpuQueueOnSubmittedWorkDone(...) WebGPUForward<&::wgpuQueueOnSubmittedWorkDone>(__VA_ARGS__)
#define wgpuQueueRelease(...) WebGPUForward<&::wgpuQueueRelease>(__VA_ARGS__)
#define wgpuQueueSubmit(...) WebGPUForward<&::wgpuQueueSubmit>(__VA_ARGS__)
#define wgpuQueueWriteBuffer(...) WebGPUForward<&::wgpuQueueWriteBuffer>(__VA_ARGS__)
#define wgpuQueueWriteTexture(...) WebGPUForward<&::wgpuQueueWriteTexture>(__VA_ARGS__)
#define wgpuRenderPassEncoderBeginOcclusionQuery(...) WebGPUForward<&::wgpuRenderPassEncoderBeginOcclusionQuery>(__VA_ARGS__)
#define wgpuRenderPassEncoderDraw(...) WebGPUForward<&::wgpuRenderPassEncoderDraw>(__VA_ARGS__)
#define wgpuRenderPassEncoderDrawIndexed(...) WebGPUForward<&::wgpuRenderPassEncoderDrawIndexed>(__VA_ARGS__)
#define wgpuRenderPassEncoderDrawIndexedIndirect(...) WebGPUForward<&::wgpuRenderPassEncoderDrawIndexedIndirect>(__VA_ARGS__)
#define wgpuRenderPassEncoderDrawIndirect(...) WebGPUForward<&::wgpuRenderPassEncoderDrawIndirect>(__VA_ARGS__)
#define wgpuRenderPassEncoderEnd(...) WebGPUForward<&::wgpuRenderPassEncoderEnd>(__VA_ARGS__)
#define wgpuRenderPassEncoderEndOcclusionQuery(...) WebGPUForward<&::wgpuRenderPassEncoderEndOcclusionQuery>(__VA_ARGS__)
#define wgpuRenderPassEncoderInsertDebugMarker(...) WebGPUForward<&::wgpuRenderPassEncoderInsertDebugMarker>(__VA_ARGS__)
#define wgpuRenderPassEncoderRelease(...) WebGPUForward<&::wgpuRenderPassEncoderRelease>(__VA_ARGS__)
#define wgpuRenderPassEncoderSetBindGroup(...) WebGPUForward<&::wgpuRenderPassEncoderSetBindGroup>(__VA_ARGS__)
#define wgpuRenderPassEncoderSetIndexBuffer(...) WebGPUForward<&::wgpuRenderPassEncoderSetIndexBuffer>(__VA_ARGS__)
#define wgpuRenderPassEncoderSetPipeline(...) WebGPUForward<&::wgpuRenderPassEncoderSetPipeline>(__VA_ARGS__)
#define wgpuRenderPassEncoderSetScissorRect(...) WebGPUForward<&::wgpuRenderPassEncoderSetScissorRect>(__VA_ARGS__)
#define wgpuRenderPassEncoderSetStencilReference(...) WebGPUForward<&::wgpuRenderPassEncoderSetStencilReference>(__VA_ARGS__)
#define wgpuRenderPassEncoderSetVertexBuffer(...) WebGPUForward<&::wgpuRenderPassEncoderSetVertexBuffer>(__VA_ARGS__)
#define wgpuRenderPassEncoderSetViewport(...) WebGPUForward<&::wgpuRenderPassEncoderSetViewport>(__VA_ARGS__)
#define wgpuRenderPipelineAddRef(...) WebGPUForward<&::wgpuRenderPipelineAddRef>(__VA_ARGS__)
#define wgpuRenderPipelineGetBindGroupLayout(...) WebGPUForward<&::wgpuRenderPipelineGetBindGroupLayout>(__VA_ARGS__)
#define wgpuRenderPipelineRelease(...) WebGPUForward<&::wgpuRenderPipelineRelease>(__VA_ARGS__)
#define wgpuSamplerAddRef(...) WebGPUForward<&::wgpuSamplerAddRef>(__VA_ARGS__)
#define wgpuSamplerRelease(...) WebGPUForward<&::wgpuSamplerRelease>(__VA_ARGS__)
#define wgpuShaderModuleRelease(...) WebGPUForward<&::wgpuShaderModuleRelease>(__VA_ARGS__)
#define wgpuSurfaceCapabilitiesFreeMembers(...) WebGPUForward<&::wgpuSurfaceCapabilitiesFreeMembers>(__VA_ARGS__)
#define wgpuSurfaceConfigure(...) WebGPUForward<&::wgpuSurfaceConfigure>(__VA_ARGS__)
#define wgpuSurfaceGetCapabilities(...) WebGPUForward<&::wgpuSurfaceGetCapabilities>(__VA_ARGS__)
#define wgpuSurfaceGetCurrentTexture(...) WebGPUForward<&::wgpuSurfaceGetCurrentTexture>(__VA_ARGS__)
#define wgpuSurfacePresent(...) WebGPUForward<&::wgpuSurfacePresent>(__VA_ARGS__)
#define wgpuSurfaceRelease(...) WebGPUForward<&::wgpuSurfaceRelease>(__VA_ARGS__)
#define wgpuSurfaceUnconfigure(...) WebGPUForward<&::wgpuSurfaceUnconfigure>(__VA_ARGS__)
#define wgpuTextureCreateView(...) WebGPUForward<&::wgpuTextureCreateView>(__VA_ARGS__)
#define wgpuTextureRelease(...) WebGPUForward<&::wgpuTextureRelease>(__VA_ARGS__)
#define wgpuTextureViewAddRef(...) WebGPUForward<&::wgpuTextureViewAddRef>(__VA_ARGS__)
#define wgpuTextureViewRelease(...) WebGPUForward<&::wgpuTextureViewRelease>(__VA_ARGS__)
#endif
