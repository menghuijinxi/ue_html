#include <webgpu/webgpu.h>
#include <emscripten.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>

static WGPUDevice Device;
static WGPUQueue Queue;
static WGPURenderPipeline Pipeline;
static WGPUTexture Texture;
static WGPUTextureView View;
static unsigned Batches;
static int Fault;

static void Step()
{
    WGPUCommandEncoderDescriptor encoderDesc = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
    auto encoder = wgpuDeviceCreateCommandEncoder(Device, &encoderDesc);
    WGPURenderPassColorAttachment attachment = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
    attachment.view = View;
    attachment.loadOp = WGPULoadOp_Clear;
    attachment.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor passDesc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &attachment;
    auto pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    wgpuRenderPassEncoderSetPipeline(pass, Pipeline);
    for (unsigned draw = 0; draw < 512; ++draw)
    {
        WGPUBindGroup groups[4];
        for (unsigned index = 0; index < 4; ++index)
        {
            auto layout = wgpuRenderPipelineGetBindGroupLayout(Pipeline, index);
            WGPUBindGroupDescriptor desc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            desc.layout = layout;
            groups[index] = wgpuDeviceCreateBindGroup(Device, &desc);
            wgpuBindGroupLayoutRelease(layout);
        }
        if (Batches == 2 && draw == 511)
        {
            if (Fault == 1) wgpuBindGroupRelease(groups[2]);
            if (Fault == 2) groups[2] = reinterpret_cast<WGPUBindGroup>(uintptr_t(0x1000000400ULL));
        }
        for (unsigned index = 0; index < 4; ++index)
        {
            wgpuRenderPassEncoderSetBindGroup(pass, index, groups[index], 0, nullptr);
            wgpuBindGroupRelease(groups[index]);
        }
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    }
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);
    auto commands = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuCommandEncoderRelease(encoder);
    wgpuQueueSubmit(Queue, 1, &commands);
    wgpuCommandBufferRelease(commands);
    WGPUQueueWorkDoneCallbackInfo done = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
    done.mode = WGPUCallbackMode_AllowSpontaneous;
    done.callback = [](WGPUQueueWorkDoneStatus status, WGPUStringView, void*, void*) {
        if (status != WGPUQueueWorkDoneStatus_Success)
        {
            std::puts("HANDLE_LIFETIME_FAILED queue");
            return;
        }
        ++Batches;
        EM_ASM({ globalThis.__handleBatches = $0; }, Batches);
        if (Batches < 1000) emscripten_async_call([](void*) { Step(); }, nullptr, 0);
        else std::puts("HANDLE_LIFETIME_OK");
    };
    wgpuQueueOnSubmittedWorkDone(Queue, done);
}

static void Start()
{
    Fault = emscripten_run_script_int("globalThis.__handleFault || 0");
    // Keep handles at offsets comparable to the complete UE runtime.
    void* reserve = std::malloc(300 * 1024 * 1024);
    if (!reserve) std::abort();
    std::memset(reserve, 0xa5, 300 * 1024 * 1024);
    EM_ASM({ globalThis.__handleReserve = Number($0); }, reserve);
    WGPUBindGroupLayoutDescriptor groupDesc = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    auto group = wgpuDeviceCreateBindGroupLayout(Device, &groupDesc);
    WGPUBindGroupLayout groups[] = {group, group, group, group};
    WGPUPipelineLayoutDescriptor layoutDesc = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    layoutDesc.bindGroupLayoutCount = 4;
    layoutDesc.bindGroupLayouts = groups;
    auto layout = wgpuDeviceCreatePipelineLayout(Device, &layoutDesc);
    wgpuBindGroupLayoutRelease(group);
    const char* source = R"(
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
            let p = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
            return vec4f(p[i], 0, 1);
        }
        @fragment fn fs() -> @location(0) vec4f { return vec4f(0.2,0.4,0.8,1); }
    )";
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = {source, WGPU_STRLEN};
    WGPUShaderModuleDescriptor shaderDesc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    shaderDesc.nextInChain = &wgsl.chain;
    auto shader = wgpuDeviceCreateShaderModule(Device, &shaderDesc);
    WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
    target.format = WGPUTextureFormat_RGBA8Unorm;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = shader;
    fragment.entryPoint = {"fs", WGPU_STRLEN};
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPURenderPipelineDescriptor desc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    desc.layout = layout;
    desc.vertex.module = shader;
    desc.vertex.entryPoint = {"vs", WGPU_STRLEN};
    desc.fragment = &fragment;
    Pipeline = wgpuDeviceCreateRenderPipeline(Device, &desc);
    wgpuShaderModuleRelease(shader);
    wgpuPipelineLayoutRelease(layout);
    WGPUTextureDescriptor textureDesc = WGPU_TEXTURE_DESCRIPTOR_INIT;
    textureDesc.size = {4, 4, 1};
    textureDesc.format = target.format;
    textureDesc.usage = WGPUTextureUsage_RenderAttachment;
    Texture = wgpuDeviceCreateTexture(Device, &textureDesc);
    View = wgpuTextureCreateView(Texture, nullptr);
    Queue = wgpuDeviceGetQueue(Device);
    Step();
}

int main()
{
    WGPUInstanceDescriptor instanceDesc = WGPU_INSTANCE_DESCRIPTOR_INIT;
    auto instance = wgpuCreateInstance(&instanceDesc);
    WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    WGPURequestAdapterCallbackInfo adapter = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    adapter.mode = WGPUCallbackMode_AllowSpontaneous;
    adapter.callback = [](WGPURequestAdapterStatus status, WGPUAdapter value, WGPUStringView, void*, void*) {
        if (status != WGPURequestAdapterStatus_Success) std::abort();
        WGPUDeviceDescriptor desc = WGPU_DEVICE_DESCRIPTOR_INIT;
        desc.uncapturedErrorCallbackInfo.callback =
            [](WGPUDevice const*, WGPUErrorType, WGPUStringView message, void*, void*) {
                std::printf("HANDLE_LIFETIME_FAILED %.*s\n", int(message.length), message.data);
            };
        WGPURequestDeviceCallbackInfo device = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        device.mode = WGPUCallbackMode_AllowSpontaneous;
        device.callback = [](WGPURequestDeviceStatus result, WGPUDevice value, WGPUStringView, void*, void*) {
            if (result != WGPURequestDeviceStatus_Success) std::abort();
            Device = value;
            Start();
        };
        wgpuAdapterRequestDevice(value, &desc, device);
        wgpuAdapterRelease(value);
    };
    wgpuInstanceRequestAdapter(instance, &options, adapter);
    wgpuInstanceRelease(instance);
}
