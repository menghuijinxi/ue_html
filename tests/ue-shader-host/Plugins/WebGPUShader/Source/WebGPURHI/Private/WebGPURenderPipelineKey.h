#pragma once

#include <webgpu/webgpu.h>
#include <cstdint>
#include <cstring>
#include <vector>

// Compare semantic descriptor fields, including empty slots, never C padding.
inline std::vector<uint64_t> WebGPURenderPipelineKey(const WGPURenderPipelineDescriptor& D)
{
    std::vector<uint64_t> Key;
    const auto Add = [&](auto Value) { Key.push_back(uint64_t(Value)); };
    const auto String = [&](WGPUStringView Text) {
        const size_t Length = Text.data ? (Text.length == WGPU_STRLEN ? std::strlen(Text.data) : Text.length) : 0;
        Add(Length);
        for (size_t Index = 0; Index < Length; ++Index) Add(uint8_t(Text.data[Index]));
    };
    const auto Constants = [&](size_t Count, const WGPUConstantEntry* Entries) {
        Add(Count);
        for (size_t Index = 0; Index < Count; ++Index)
        {
            String(Entries[Index].key);
            uint64_t Bits;
            std::memcpy(&Bits, &Entries[Index].value, sizeof(Bits));
            Add(Bits);
        }
    };
    Add(reinterpret_cast<uintptr_t>(D.layout));
    Add(reinterpret_cast<uintptr_t>(D.vertex.module));
    String(D.vertex.entryPoint);
    Constants(D.vertex.constantCount, D.vertex.constants);
    Add(D.vertex.bufferCount);
    for (size_t Index = 0; Index < D.vertex.bufferCount; ++Index)
    {
        const auto& Buffer = D.vertex.buffers[Index];
        Add(Buffer.arrayStride); Add(Buffer.stepMode); Add(Buffer.attributeCount);
        for (size_t Attribute = 0; Attribute < Buffer.attributeCount; ++Attribute)
        {
            const auto& A = Buffer.attributes[Attribute];
            Add(A.format); Add(A.offset); Add(A.shaderLocation);
        }
    }
    Add(D.primitive.topology); Add(D.primitive.stripIndexFormat);
    Add(D.primitive.frontFace); Add(D.primitive.cullMode); Add(D.primitive.unclippedDepth);
    Add(D.multisample.count); Add(D.multisample.mask); Add(D.multisample.alphaToCoverageEnabled);
    Add(D.depthStencil != nullptr);
    if (D.depthStencil)
    {
        const auto& Depth = *D.depthStencil;
        Add(Depth.format); Add(Depth.depthWriteEnabled); Add(Depth.depthCompare);
        const auto Stencil = [&](const WGPUStencilFaceState& Face) {
            Add(Face.compare); Add(Face.failOp); Add(Face.depthFailOp); Add(Face.passOp);
        };
        Stencil(Depth.stencilFront); Stencil(Depth.stencilBack);
        Add(Depth.stencilReadMask); Add(Depth.stencilWriteMask); Add(Depth.depthBias);
        for (float Value : {Depth.depthBiasSlopeScale, Depth.depthBiasClamp})
        {
            uint32_t Bits;
            std::memcpy(&Bits, &Value, sizeof(Bits));
            Add(Bits);
        }
    }
    Add(D.fragment != nullptr);
    if (D.fragment)
    {
        Add(reinterpret_cast<uintptr_t>(D.fragment->module));
        String(D.fragment->entryPoint);
        Constants(D.fragment->constantCount, D.fragment->constants);
        Add(D.fragment->targetCount);
        for (size_t Index = 0; Index < D.fragment->targetCount; ++Index)
        {
            const auto& Target = D.fragment->targets[Index];
            Add(Target.format); Add(Target.writeMask); Add(Target.blend != nullptr);
            if (Target.blend)
                for (const auto& Blend : {Target.blend->color, Target.blend->alpha})
                {
                    Add(Blend.operation); Add(Blend.srcFactor); Add(Blend.dstFactor);
                }
        }
    }
    return Key;
}
