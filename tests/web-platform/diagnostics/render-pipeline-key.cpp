#include "../../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPURenderPipelineKey.h"
#include <cassert>
#include <cstdio>

int main()
{
    auto D = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    auto Depth = WGPU_DEPTH_STENCIL_STATE_INIT;
    auto Fragment = WGPU_FRAGMENT_STATE_INIT;
    auto Target = WGPU_COLOR_TARGET_STATE_INIT;
    auto Blend = WGPU_BLEND_STATE_INIT;
    auto Buffer = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
    auto Attribute = WGPU_VERTEX_ATTRIBUTE_INIT;
    D.primitive.cullMode = WGPUCullMode_None;
    Blend.alpha.srcFactor = WGPUBlendFactor_One;
    D.vertex.module = reinterpret_cast<WGPUShaderModule>(1);
    D.vertex.entryPoint = {"vertex", WGPU_STRLEN};
    Fragment.module = reinterpret_cast<WGPUShaderModule>(2);
    Fragment.entryPoint = {"pixel", WGPU_STRLEN};
    Attribute.format = WGPUVertexFormat_Float32x3;
    Buffer.arrayStride = 12;
    Buffer.attributeCount = 1; Buffer.attributes = &Attribute;
    D.vertex.bufferCount = 1; D.vertex.buffers = &Buffer;
    Target.format = WGPUTextureFormat_RGBA16Float;
    Target.blend = &Blend;
    Fragment.targetCount = 1; Fragment.targets = &Target;
    D.fragment = &Fragment; D.depthStencil = &Depth;
    const auto Baseline = WebGPURenderPipelineKey(D);
    int Checks = 0;
    const auto Changed = [&] { assert(WebGPURenderPipelineKey(D) != Baseline); ++Checks; };
    D.label = {"ignored", WGPU_STRLEN};
    char Entry[] = "vertex";
    D.vertex.entryPoint = {Entry, 6};
    assert(WebGPURenderPipelineKey(D) == Baseline); ++Checks;
    D.layout = reinterpret_cast<WGPUPipelineLayout>(3); Changed(); D.layout = nullptr;
    D.vertex.module = reinterpret_cast<WGPUShaderModule>(4); Changed();
    D.vertex.module = reinterpret_cast<WGPUShaderModule>(1);
    D.vertex.entryPoint = {"another", WGPU_STRLEN}; Changed(); D.vertex.entryPoint = {Entry, 6};
    Buffer.arrayStride = 16; Changed(); Buffer.arrayStride = 12;
    Attribute.offset = 4; Changed(); Attribute.offset = 0;
    Attribute.shaderLocation = 3; Changed(); Attribute.shaderLocation = 0;
    D.primitive.cullMode = WGPUCullMode_Front; Changed(); D.primitive.cullMode = WGPUCullMode_None;
    Depth.depthCompare = WGPUCompareFunction_Always; Changed(); Depth.depthCompare = WGPUCompareFunction_Undefined;
    Depth.stencilWriteMask = 0; Changed(); Depth.stencilWriteMask = 0xffffffff;
    Depth.depthBiasSlopeScale = 1; Changed(); Depth.depthBiasSlopeScale = 0;
    D.multisample.count = 4; Changed(); D.multisample.count = 1;
    Target.format = WGPUTextureFormat_BGRA8Unorm; Changed(); Target.format = WGPUTextureFormat_RGBA16Float;
    Target.writeMask = 0; Changed(); Target.writeMask = WGPUColorWriteMask_All;
    Blend.alpha.srcFactor = WGPUBlendFactor_SrcAlpha; Changed(); Blend.alpha.srcFactor = WGPUBlendFactor_One;
    Fragment.module = reinterpret_cast<WGPUShaderModule>(5); Changed();
    Fragment.module = reinterpret_cast<WGPUShaderModule>(2);
    auto Constant = WGPU_CONSTANT_ENTRY_INIT;
    Constant.key = {"test", WGPU_STRLEN}; Constant.value = 1;
    Fragment.constantCount = 1; Fragment.constants = &Constant; Changed();
    Constant.value = 2;
    const auto Constants2 = WebGPURenderPipelineKey(D);
    Constant.value = 3; assert(WebGPURenderPipelineKey(D) != Constants2); ++Checks;
    Fragment.constantCount = 0;
    D.depthStencil = nullptr; Changed(); D.depthStencil = &Depth;
    assert(WebGPURenderPipelineKey(D) == Baseline); ++Checks;
    std::printf("{\"pass\":true,\"checks\":%d}\n", Checks);
}
