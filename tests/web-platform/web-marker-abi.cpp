#include <webgpu/webgpu.h>
#include <cstdio>

static void TestMarkers(WGPUDevice device)
{
    WGPUCommandEncoderDescriptor encoderDesc = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, &encoderDesc);
    constexpr char utf8[] = "marker/\xE6\xA0\x87\xE8\xAE\xB0";
    const WGPUStringView labels[] = {{"bounded/ignored", 7}, {utf8, sizeof(utf8) - 1}, {"", 0}};
    for (auto label : labels) wgpuCommandEncoderInsertDebugMarker(encoder, label);

    WGPUTextureDescriptor textureDesc = WGPU_TEXTURE_DESCRIPTOR_INIT;
    textureDesc.size = {4, 4, 1};
    textureDesc.format = WGPUTextureFormat_RGBA8Unorm;
    textureDesc.usage = WGPUTextureUsage_RenderAttachment;
    WGPUTexture texture = wgpuDeviceCreateTexture(device, &textureDesc);
    WGPUTextureView view = wgpuTextureCreateView(texture, nullptr);
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = view;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = WGPUStoreOp_Store;
    attachment.clearValue = {0.25, 0.5, 0.75, 1};
    WGPURenderPassDescriptor passDesc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &attachment;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    for (auto label : labels) wgpuRenderPassEncoderInsertDebugMarker(pass, label);
    wgpuRenderPassEncoderEnd(pass);
    WGPUCommandBufferDescriptor bufferDesc = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, &bufferDesc);
    WGPUQueue queue = wgpuDeviceGetQueue(device);
    wgpuQueueSubmit(queue, 1, &commands);
    WGPUQueueWorkDoneCallbackInfo done = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
    done.mode = WGPUCallbackMode_AllowSpontaneous;
    done.callback = [](WGPUQueueWorkDoneStatus status, WGPUStringView, void*, void*) {
        std::puts(status == WGPUQueueWorkDoneStatus_Success ? "P3_MARKER_ABI_OK" : "P3_MARKER_ABI_FAILED queue");
    };
    wgpuQueueOnSubmittedWorkDone(queue, done);
    wgpuQueueRelease(queue);
    wgpuCommandBufferRelease(commands);
    wgpuRenderPassEncoderRelease(pass);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(texture);
    wgpuCommandEncoderRelease(encoder);
}

int main()
{
    WGPUInstanceDescriptor instanceDesc = WGPU_INSTANCE_DESCRIPTOR_INIT;
    WGPUInstance instance = wgpuCreateInstance(&instanceDesc);
    WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    WGPURequestAdapterCallbackInfo adapterCallback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    adapterCallback.mode = WGPUCallbackMode_AllowSpontaneous;
    adapterCallback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter adapter,
                                WGPUStringView, void*, void*) {
        if (status != WGPURequestAdapterStatus_Success) {
            std::puts("P3_MARKER_ABI_FAILED adapter");
            return;
        }
        WGPUDeviceDescriptor desc = WGPU_DEVICE_DESCRIPTOR_INIT;
        desc.uncapturedErrorCallbackInfo.callback =
            [](WGPUDevice const*, WGPUErrorType, WGPUStringView, void*, void*) {
                std::puts("P3_MARKER_ABI_FAILED validation");
            };
        WGPURequestDeviceCallbackInfo deviceCallback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        deviceCallback.mode = WGPUCallbackMode_AllowSpontaneous;
        deviceCallback.callback = [](WGPURequestDeviceStatus result, WGPUDevice device,
                                    WGPUStringView, void*, void*) {
            if (result != WGPURequestDeviceStatus_Success) {
                std::puts("P3_MARKER_ABI_FAILED device");
                return;
            }
            TestMarkers(device);
            wgpuDeviceRelease(device);
        };
        wgpuAdapterRequestDevice(adapter, &desc, deviceCallback);
        wgpuAdapterRelease(adapter);
    };
    wgpuInstanceRequestAdapter(instance, &options, adapterCallback);
    wgpuInstanceRelease(instance);
}
