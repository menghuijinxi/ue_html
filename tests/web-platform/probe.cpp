#include <webgpu/webgpu.h>

#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#endif

namespace {
#ifdef __EMSCRIPTEN__
constexpr auto kCallbackMode = WGPUCallbackMode_AllowSpontaneous;
#else
constexpr auto kCallbackMode = WGPUCallbackMode_AllowProcessEvents;
#endif
constexpr const char* kShader = R"(
struct Tint { color: vec4f }
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var nearest: sampler;
@group(0) @binding(2) var<uniform> tint: Tint;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOut {
    return VertexOut(vec4f(position, 0.0, 1.0), uv);
}
@fragment fn fs(input: VertexOut) -> @location(0) vec4f {
    return textureSample(image, nearest, input.uv) * tint.color;
}
)";
constexpr const char* kCompute = R"(
@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(8) fn cs(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < 32u) { values[id.x] = id.x * 3u + 7u; }
}
)";

WGPUStringView Text(const char* text) { return {text, std::strlen(text)}; }
std::string Text(WGPUStringView text) {
    if (!text.data) return {};
    return std::string(text.data, text.length == WGPU_STRLEN ? std::strlen(text.data) : text.length);
}
std::string Json(const std::string& text) {
    std::ostringstream out;
    out << '"';
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c == '\n') out << "\\n";
        else if (c == '\r') out << "\\r";
        else if (c >= 32) out << c;
    }
    out << '"';
    return out.str();
}

struct Probe {
    WGPUInstance instance = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPUShaderModule shader = nullptr;
    WGPURenderPipeline pipeline = nullptr;
    WGPUBindGroup bindGroup = nullptr;
    WGPUBuffer vertices = nullptr, indices = nullptr, uniform = nullptr;
    WGPUTexture image = nullptr, target = nullptr;
    WGPUBuffer readback = nullptr;
    WGPUBuffer computeData = nullptr;
    WGPUSurface surface = nullptr;
    WGPUTextureFormat surfaceFormat = WGPUTextureFormat_RGBA8Unorm;
    WGPULimits adapterLimits = WGPU_LIMITS_INIT;
    WGPULimits deviceLimits = WGPU_LIMITS_INIT;
    std::string adapterName;
    std::string featureJson;
    std::vector<std::string> errors;
    std::vector<std::string> checks;
    std::vector<uint64_t> pixelHashes;
    int phase = 0;
    bool adapterReady = false, deviceReady = false, mapped = false, finished = false;
    bool mapSucceeded = false;
    uint32_t width = 64, height = 64, rowPitch = 256;
    std::array<float, 4> tint{0.5f, 1.0f, 1.0f, 1.0f};
    std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
    std::string report;

    void Error(const std::string& text) { errors.push_back(text); }
    WGPUBuffer Buffer(uint64_t size, WGPUBufferUsage usage, const void* data = nullptr) {
        WGPUBufferDescriptor desc = WGPU_BUFFER_DESCRIPTOR_INIT;
        desc.size = size;
        desc.usage = usage | (data ? WGPUBufferUsage_CopyDst : 0);
        WGPUBuffer buffer = wgpuDeviceCreateBuffer(device, &desc);
        if (data) wgpuQueueWriteBuffer(queue, buffer, 0, data, static_cast<size_t>(size));
        return buffer;
    }
    WGPUShaderModule Shader(const char* source) {
        WGPUShaderSourceWGSL code = WGPU_SHADER_SOURCE_WGSL_INIT;
        code.code = Text(source);
        WGPUShaderModuleDescriptor desc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
        desc.nextInChain = &code.chain;
        return wgpuDeviceCreateShaderModule(device, &desc);
    }
    WGPURenderPipeline Pipeline(WGPUTextureFormat format) {
        WGPUVertexAttribute attributes[2] = {WGPU_VERTEX_ATTRIBUTE_INIT, WGPU_VERTEX_ATTRIBUTE_INIT};
        attributes[0].format = attributes[1].format = WGPUVertexFormat_Float32x2;
        attributes[0].shaderLocation = 0;
        attributes[1].shaderLocation = 1;
        attributes[1].offset = 8;
        WGPUVertexBufferLayout layout = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
        layout.arrayStride = 16;
        layout.attributeCount = 2;
        layout.attributes = attributes;
        WGPUColorTargetState color = WGPU_COLOR_TARGET_STATE_INIT;
        color.format = format;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = shader;
        fragment.entryPoint = Text("fs");
        fragment.targetCount = 1;
        fragment.targets = &color;
        WGPURenderPipelineDescriptor desc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        desc.vertex.module = shader;
        desc.vertex.entryPoint = Text("vs");
        desc.vertex.bufferCount = 1;
        desc.vertex.buffers = &layout;
        desc.fragment = &fragment;
        return wgpuDeviceCreateRenderPipeline(device, &desc);
    }
    void Start() {
        WGPUInstanceDescriptor desc = WGPU_INSTANCE_DESCRIPTOR_INIT;
        instance = wgpuCreateInstance(&desc);
        WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
        options.powerPreference = WGPUPowerPreference_HighPerformance;
#ifndef __EMSCRIPTEN__
        options.backendType = WGPUBackendType_D3D12;
#endif
        WGPURequestAdapterCallbackInfo callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
        callback.mode = kCallbackMode;
        callback.userdata1 = this;
        callback.callback = [](WGPURequestAdapterStatus status, WGPUAdapter adapter,
                               WGPUStringView message, void* data, void*) {
            auto& self = *static_cast<Probe*>(data);
            self.adapter = adapter;
            if (status != WGPURequestAdapterStatus_Success) self.Error("Adapter: " + Text(message));
            self.adapterReady = true;
        };
        wgpuInstanceRequestAdapter(instance, &options, callback);
    }
    void RequestDevice() {
        WGPUAdapterInfo info = WGPU_ADAPTER_INFO_INIT;
        wgpuAdapterGetInfo(adapter, &info);
        adapterName = Text(info.description) + " " + Text(info.device);
        wgpuAdapterInfoFreeMembers(info);
        wgpuAdapterGetLimits(adapter, &adapterLimits);
        std::ostringstream features;
        features << '{';
        const std::pair<const char*, WGPUFeatureName> candidates[] = {
            {"shaderF16", WGPUFeatureName_ShaderF16},
            {"textureBC", WGPUFeatureName_TextureCompressionBC},
            {"textureETC2", WGPUFeatureName_TextureCompressionETC2},
            {"textureASTC", WGPUFeatureName_TextureCompressionASTC},
            {"subgroups", WGPUFeatureName_Subgroups},
            {"timestampQuery", WGPUFeatureName_TimestampQuery},
            {"float32Filterable", WGPUFeatureName_Float32Filterable},
        };
        for (size_t i = 0; i < std::size(candidates); ++i) {
            if (i) features << ',';
            features << Json(candidates[i].first) << ':'
                     << (wgpuAdapterHasFeature(adapter, candidates[i].second) ? "true" : "false");
        }
        features << '}';
        featureJson = features.str();
        WGPUDeviceDescriptor desc = WGPU_DEVICE_DESCRIPTOR_INIT;
        desc.uncapturedErrorCallbackInfo.userdata1 = this;
        desc.uncapturedErrorCallbackInfo.callback =
            [](WGPUDevice const*, WGPUErrorType, WGPUStringView message, void* data, void*) {
                static_cast<Probe*>(data)->Error("Validation: " + Text(message));
            };
        WGPURequestDeviceCallbackInfo callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        callback.mode = kCallbackMode;
        callback.userdata1 = this;
        callback.callback = [](WGPURequestDeviceStatus status, WGPUDevice device,
                               WGPUStringView message, void* data, void*) {
            auto& self = *static_cast<Probe*>(data);
            self.device = device;
            if (status != WGPURequestDeviceStatus_Success) self.Error("Device: " + Text(message));
            self.deviceReady = true;
        };
        wgpuAdapterRequestDevice(adapter, &desc, callback);
    }
    void InitResources() {
        queue = wgpuDeviceGetQueue(device);
        wgpuDeviceGetLimits(device, &deviceLimits);
        const float vertexData[] = {-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1};
        const uint16_t indexData[] = {0, 2, 1, 1, 2, 3};
        vertices = Buffer(sizeof(vertexData), WGPUBufferUsage_Vertex, vertexData);
        indices = Buffer(sizeof(indexData), WGPUBufferUsage_Index, indexData);
        uniform = Buffer(16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
        const uint8_t pixels[] = {255, 0, 0, 255, 0, 255, 0, 255,
                                 0, 0, 255, 255, 255, 255, 255, 255};
        WGPUTextureDescriptor texture = WGPU_TEXTURE_DESCRIPTOR_INIT;
        texture.size = {2, 2, 1};
        texture.format = WGPUTextureFormat_RGBA8Unorm;
        texture.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
        image = wgpuDeviceCreateTexture(device, &texture);
        WGPUTexelCopyTextureInfo dest = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        dest.texture = image;
        WGPUTexelCopyBufferLayout dataLayout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
        dataLayout.bytesPerRow = 8;
        dataLayout.rowsPerImage = 2;
        wgpuQueueWriteTexture(queue, &dest, pixels, sizeof(pixels), &dataLayout, &texture.size);
        shader = Shader(kShader);
        pipeline = Pipeline(WGPUTextureFormat_RGBA8Unorm);
        WGPUSamplerDescriptor samplerDesc = WGPU_SAMPLER_DESCRIPTOR_INIT;
        WGPUSampler sampler = wgpuDeviceCreateSampler(device, &samplerDesc);
        WGPUTextureView view = wgpuTextureCreateView(image, nullptr);
        WGPUBindGroupEntry entries[3] = {
            WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
        entries[0].binding = 0;
        entries[0].textureView = view;
        entries[1].binding = 1;
        entries[1].sampler = sampler;
        entries[2].binding = 2;
        entries[2].buffer = uniform;
        entries[2].size = 16;
        WGPUBindGroupLayout layout = wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
        WGPUBindGroupDescriptor desc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        desc.layout = layout;
        desc.entryCount = 3;
        desc.entries = entries;
        bindGroup = wgpuDeviceCreateBindGroup(device, &desc);
        wgpuBindGroupLayoutRelease(layout);
        wgpuTextureViewRelease(view);
        wgpuSamplerRelease(sampler);
    }
    void Draw(WGPUCommandEncoder encoder, WGPUTexture texture, WGPURenderPipeline renderPipeline) {
        WGPUTextureView view = wgpuTextureCreateView(texture, nullptr);
        WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color.view = view;
        color.loadOp = WGPULoadOp_Clear;
        color.storeOp = WGPUStoreOp_Store;
        color.clearValue = {0.1, 0.1, 0.1, 1};
        WGPURenderPassDescriptor desc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        desc.colorAttachmentCount = 1;
        desc.colorAttachments = &color;
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &desc);
        wgpuRenderPassEncoderSetPipeline(pass, renderPipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bindGroup, 0, nullptr);
        wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vertices, 0, 64);
        wgpuRenderPassEncoderSetIndexBuffer(pass, indices, WGPUIndexFormat_Uint16, 0, 12);
        wgpuRenderPassEncoderDrawIndexed(pass, 6, 1, 0, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
        wgpuTextureViewRelease(view);
    }
    void Submit(WGPUCommandEncoder encoder) {
        WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, nullptr);
        wgpuQueueSubmit(queue, 1, &commands);
        wgpuCommandBufferRelease(commands);
        wgpuCommandEncoderRelease(encoder);
    }
    void Map(size_t bytes) {
        mapped = false;
        WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
        callback.mode = kCallbackMode;
        callback.userdata1 = this;
        callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView message, void* data, void*) {
            auto& self = *static_cast<Probe*>(data);
            self.mapSucceeded = status == WGPUMapAsyncStatus_Success;
            if (!self.mapSucceeded) self.Error("Readback: " + Text(message));
            self.mapped = true;
        };
        wgpuBufferMapAsync(readback, WGPUMapMode_Read, 0, bytes, callback);
    }
    void RenderAndRead() {
        wgpuQueueWriteBuffer(queue, uniform, 0, tint.data(), 16);
        WGPUTextureDescriptor desc = WGPU_TEXTURE_DESCRIPTOR_INIT;
        desc.size = {width, height, 1};
        desc.format = WGPUTextureFormat_RGBA8Unorm;
        desc.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
        target = wgpuDeviceCreateTexture(device, &desc);
        rowPitch = (width * 4 + 255) & ~255u;
        readback = Buffer(rowPitch * height, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst);
        WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, nullptr);
        Draw(encoder, target, pipeline);
        WGPUTexelCopyTextureInfo source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        source.texture = target;
        WGPUTexelCopyBufferInfo destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
        destination.buffer = readback;
        destination.layout.bytesPerRow = rowPitch;
        destination.layout.rowsPerImage = height;
        wgpuCommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &desc.size);
        Submit(encoder);
        Map(rowPitch * height);
    }
    void CheckPixels() {
        if (!mapSucceeded) return;
        auto* data = static_cast<const uint8_t*>(wgpuBufferGetConstMappedRange(readback, 0, rowPitch * height));
        bool correct = data != nullptr;
        uint64_t hash = 1469598103934665603ull;
        const uint8_t original[4][4] = {{255, 0, 0, 255}, {0, 255, 0, 255},
                                      {0, 0, 255, 255}, {255, 255, 255, 255}};
        if (data) {
            for (uint32_t y = 0; y < height; ++y) {
                for (uint32_t x = 0; x < width; ++x) {
                    const auto* pixel = data + y * rowPitch + x * 4;
                    const auto& expected = original[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
                    for (int c = 0; c < 4; ++c) {
                        const int value = static_cast<int>(std::lround(expected[c] * tint[c]));
                        if (std::abs(static_cast<int>(pixel[c]) - value) > 1) correct = false;
                        hash = (hash ^ pixel[c]) * 1099511628211ull;
                    }
                }
            }
        }
        if (correct) checks.push_back(phase == 2 ? "indexed-texture-uniform-readback" : "resize-uniform-update-readback");
        else Error("Pixel mismatch at " + std::to_string(width) + "x" + std::to_string(height));
        pixelHashes.push_back(hash);
        wgpuBufferUnmap(readback);
        wgpuBufferRelease(readback);
        wgpuTextureRelease(target);
        readback = nullptr;
        target = nullptr;
    }
    void Compute() {
        computeData = Buffer(128, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc);
        readback = Buffer(128, WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst);
        WGPUShaderModule module = Shader(kCompute);
        WGPUComputePipelineDescriptor desc = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
        desc.compute.module = module;
        desc.compute.entryPoint = Text("cs");
        WGPUComputePipeline compute = wgpuDeviceCreateComputePipeline(device, &desc);
        WGPUBindGroupLayout layout = wgpuComputePipelineGetBindGroupLayout(compute, 0);
        WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
        entry.buffer = computeData;
        entry.size = 128;
        WGPUBindGroupDescriptor groupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        groupDesc.layout = layout;
        groupDesc.entryCount = 1;
        groupDesc.entries = &entry;
        WGPUBindGroup group = wgpuDeviceCreateBindGroup(device, &groupDesc);
        WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, nullptr);
        WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, nullptr);
        wgpuComputePassEncoderSetPipeline(pass, compute);
        wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
        wgpuComputePassEncoderDispatchWorkgroups(pass, 4, 1, 1);
        wgpuComputePassEncoderEnd(pass);
        wgpuCommandEncoderCopyBufferToBuffer(encoder, computeData, 0, readback, 0, 128);
        Submit(encoder);
        wgpuComputePassEncoderRelease(pass);
        wgpuBindGroupRelease(group);
        wgpuBindGroupLayoutRelease(layout);
        wgpuComputePipelineRelease(compute);
        wgpuShaderModuleRelease(module);
        Map(128);
    }
    void CheckCompute() {
        if (!mapSucceeded) return;
        auto* values = static_cast<const uint32_t*>(wgpuBufferGetConstMappedRange(readback, 0, 128));
        bool correct = values != nullptr;
        if (values) for (uint32_t i = 0; i < 32; ++i) correct &= values[i] == i * 3 + 7;
        if (correct) checks.push_back("compute-storage-copy-readback");
        else Error("Compute values mismatch");
        wgpuBufferUnmap(readback);
        wgpuBufferRelease(readback);
        wgpuBufferRelease(computeData);
        readback = nullptr;
        computeData = nullptr;
    }
    void Present() {
#ifdef __EMSCRIPTEN__
        WGPUEmscriptenSurfaceSourceCanvasHTMLSelector source =
            WGPU_EMSCRIPTEN_SURFACE_SOURCE_CANVAS_HTML_SELECTOR_INIT;
        source.selector = Text("#scene");
        WGPUSurfaceDescriptor desc = WGPU_SURFACE_DESCRIPTOR_INIT;
        desc.nextInChain = &source.chain;
        surface = wgpuInstanceCreateSurface(instance, &desc);
        WGPUSurfaceCapabilities capabilities = WGPU_SURFACE_CAPABILITIES_INIT;
        wgpuSurfaceGetCapabilities(surface, adapter, &capabilities);
        surfaceFormat = capabilities.formats[0];
        wgpuSurfaceCapabilitiesFreeMembers(capabilities);
        WGPURenderPipeline visiblePipeline = Pipeline(surfaceFormat);
        // Auto layouts are pipeline-specific even when their WGSL declarations match.
        WGPUBindGroupLayout visibleLayout = wgpuRenderPipelineGetBindGroupLayout(visiblePipeline, 0);
        WGPUTextureView imageView = wgpuTextureCreateView(image, nullptr);
        WGPUSamplerDescriptor samplerDesc = WGPU_SAMPLER_DESCRIPTOR_INIT;
        WGPUSampler sampler = wgpuDeviceCreateSampler(device, &samplerDesc);
        WGPUBindGroupEntry entries[3] = {
            WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT, WGPU_BIND_GROUP_ENTRY_INIT};
        entries[0].textureView = imageView;
        entries[1].binding = 1;
        entries[1].sampler = sampler;
        entries[2].binding = 2;
        entries[2].buffer = uniform;
        entries[2].size = 16;
        WGPUBindGroupDescriptor groupDesc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        groupDesc.layout = visibleLayout;
        groupDesc.entryCount = 3;
        groupDesc.entries = entries;
        WGPUBindGroup visibleGroup = wgpuDeviceCreateBindGroup(device, &groupDesc);
        WGPUBindGroup previous = bindGroup;
        bindGroup = visibleGroup;
        bool correct = true;
        for (auto size : {std::array<uint32_t, 2>{64, 64}, std::array<uint32_t, 2>{96, 72}}) {
            emscripten_set_canvas_element_size("#scene", size[0], size[1]);
            WGPUSurfaceConfiguration configuration = WGPU_SURFACE_CONFIGURATION_INIT;
            configuration.device = device;
            configuration.format = surfaceFormat;
            configuration.width = size[0];
            configuration.height = size[1];
            wgpuSurfaceConfigure(surface, &configuration);
            WGPUSurfaceTexture frame = WGPU_SURFACE_TEXTURE_INIT;
            wgpuSurfaceGetCurrentTexture(surface, &frame);
            if (!frame.texture) { correct = false; break; }
            WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, nullptr);
            Draw(encoder, frame.texture, visiblePipeline);
            Submit(encoder);
            wgpuTextureRelease(frame.texture);
        }
        bindGroup = previous;
        wgpuBindGroupRelease(visibleGroup);
        wgpuBindGroupLayoutRelease(visibleLayout);
        wgpuSamplerRelease(sampler);
        wgpuTextureViewRelease(imageView);
        wgpuRenderPipelineRelease(visiblePipeline);
        if (correct) checks.push_back("canvas-surface-configure-resize");
        else Error("Canvas acquisition failed");
#endif
    }
    void Finish() {
        std::ostringstream json;
        json << "{\"kind\":\"webgpu\",\"pass\":" << (errors.empty() ? "true" : "false")
             << ",\"pointerBytes\":" << sizeof(void*) << ",\"adapter\":" << Json(adapterName)
             << ",\"adapterFeatures\":" << (featureJson.empty() ? "{}" : featureJson)
             << ",\"adapterLimits\":{\"maxTextureDimension2D\":" << adapterLimits.maxTextureDimension2D
             << ",\"maxBufferSize\":" << adapterLimits.maxBufferSize
             << ",\"maxStorageBuffersPerShaderStage\":" << adapterLimits.maxStorageBuffersPerShaderStage
             << ",\"maxSampledTexturesPerShaderStage\":" << adapterLimits.maxSampledTexturesPerShaderStage
             << ",\"maxBindGroups\":" << adapterLimits.maxBindGroups
             << "},\"deviceLimits\":{\"maxTextureDimension2D\":" << deviceLimits.maxTextureDimension2D
             << ",\"maxBufferSize\":" << deviceLimits.maxBufferSize
             << ",\"minUniformBufferOffsetAlignment\":" << deviceLimits.minUniformBufferOffsetAlignment
             << "},\"checks\":[";
        for (size_t i = 0; i < checks.size(); ++i) { if (i) json << ','; json << Json(checks[i]); }
        json << "],\"pixelHashes\":[";
        for (size_t i = 0; i < pixelHashes.size(); ++i) { if (i) json << ','; json << Json(std::to_string(pixelHashes[i])); }
        json << "],\"errors\":[";
        for (size_t i = 0; i < errors.size(); ++i) { if (i) json << ','; json << Json(errors[i]); }
        json << "]}";
        report = json.str();
        std::cout << "P0_RESULT " << report << std::endl;
#ifdef __EMSCRIPTEN__
        MAIN_THREAD_ASYNC_EM_ASM({
            globalThis.__p0Report = JSON.parse(UTF8ToString($0));
            globalThis.dispatchEvent(new CustomEvent('p0-result', {detail: globalThis.__p0Report}));
        }, report.c_str());
        emscripten_cancel_main_loop();
#endif
        finished = true;
    }
    void Tick() {
#ifndef __EMSCRIPTEN__
        wgpuInstanceProcessEvents(instance);
#endif
        if (finished) return;
        if (std::chrono::steady_clock::now() - started > std::chrono::seconds(35)) {
            Error("Async operation timed out at phase " + std::to_string(phase));
            Finish();
            return;
        }
        if (!errors.empty()) { Finish(); return; }
        if (phase == 0 && adapterReady) { RequestDevice(); phase = 1; }
        else if (phase == 1 && deviceReady) { InitResources(); phase = 2; RenderAndRead(); }
        else if (phase == 2 && mapped) {
            CheckPixels();
            tint = {1.0f, 0.5f, 1.0f, 1.0f};
            width = 80; height = 48; phase = 3; RenderAndRead();
        }
        else if (phase == 3 && mapped) { CheckPixels(); phase = 4; Compute(); }
        else if (phase == 4 && mapped) { CheckCompute(); Present(); phase = 5; }
        else if (phase == 5) Finish();
    }
};
Probe probe;
}

int main() {
    probe.Start();
#ifdef __EMSCRIPTEN__
    emscripten_set_main_loop([] { probe.Tick(); }, 0, false);
#else
    while (!probe.finished) {
        probe.Tick();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return probe.errors.empty() ? 0 : 1;
#endif
}
