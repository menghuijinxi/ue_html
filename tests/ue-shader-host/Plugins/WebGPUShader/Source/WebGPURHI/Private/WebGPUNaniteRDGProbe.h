#pragma once

#include "NaniteWebVisibility.h"
#include "RenderGraphResourcePool.h"
#include "RenderTargetPool.h"

BEGIN_SHADER_PARAMETER_STRUCT(FWebNaniteVisibilityProbeWriteParameters, )
    SHADER_PARAMETER_RDG_BUFFER_SRV(StructuredBuffer<uint4>, Candidates)
    SHADER_PARAMETER_RDG_BUFFER_UAV(RWStructuredBuffer<uint>, WebNaniteAtomicMax_Visibility)
END_SHADER_PARAMETER_STRUCT()

inline bool RunWebGPUNaniteRDGProbe(FWebGPUDynamicRHI& RHI, FRHICommandListImmediate& Cmd, const FString& Directory)
{
    constexpr uint32 Width = 11, Height = 9;
    TArray<uint32> Initial, Expected;
    for (uint32 Index = 0; Index < Width * Height; ++Index)
        Initial.Append({0x100u + Index, Index % 2 ? 0x3f000000u : 0x3f400000u});
    Expected = Initial;
    for (uint32 Y = 1; Y < 7; ++Y)
        for (uint32 X = 2; X < 9; ++X)
            Expected[(Y * Width + X) * 2] = Expected[(Y * Width + X) * 2 + 1] = 0;
    const uint32 Candidates[][4] = {
        {0x200, 0x3f000000u, 3, 2}, {0x300, 0x3f000000u, 3, 2},
        {0x400, 0x3e800000u, 3, 2}, {0x800, 0x3f600000u, 10, 8},
        {MAX_uint32, 0x3f800000u, Width, 0},
    };
    Expected[(2 * Width + 3) * 2] = 0x300;
    Expected[(2 * Width + 3) * 2 + 1] = 0x3f000000u;
    Expected[(8 * Width + 10) * 2] = 0x800;
    Expected[(8 * Width + 10) * 2 + 1] = 0x3f600000u;

    auto Clear = RHICreateComputeShader(FRHICreateShaderDesc(WebGPUProbe::Packet(Directory, TEXT("clear"))));
    auto Writer = RHICreateComputeShader(FRHICreateShaderDesc(WebGPUProbe::Packet(Directory, TEXT("compute"))));
    auto Resolve = RHICreateComputeShader(FRHICreateShaderDesc(WebGPUProbe::Packet(Directory, TEXT("resolve"))));
    const auto Dispatch = [&](FRHIComputeCommandList& List, FRHIComputeShader* Shader,
        TArrayView<const uint8> Globals, TConstArrayView<TPair<const TCHAR*, FRHIShaderParameterResource>> Resources) {
        const auto& Data = RHI.ShaderData(Shader);
        TArray<FRHIShaderParameter> Values;
        TArray<FRHIShaderParameterResource> Bindings;
        for (const auto& Value : Data.Metadata->GetArrayField(TEXT("ueParameterMap")))
        {
            const auto Entry = Value->AsObject();
            const FString Name = Entry->GetStringField(TEXT("name"));
            const uint16 Index = Entry->GetIntegerField(TEXT("baseIndex"));
            if (Entry->GetIntegerField(TEXT("type")) == 0)
                Values.Emplace(Entry->GetIntegerField(TEXT("bufferIndex")), Index, Index,
                    Entry->GetIntegerField(TEXT("size")));
            else
            {
                const auto* Resource = Resources.FindByPredicate([&](const auto& Item) { return Name == Item.Key; });
                check(Resource);
                auto Binding = Resource->Value;
                Binding.Index = Index;
                Bindings.Add(Binding);
            }
        }
        SetComputePipelineState(List, FComputePipelineStateInitializer(Shader));
        List.SetShaderParameters(Shader, Globals, Values, Bindings, {});
        List.DispatchComputeShader(2, Shader == Writer ? 1 : 2, 1);
    };

    TRefCountPtr<IPooledRenderTarget> Texture;
    {
        FRDGBuilder Graph(Cmd, RDG_EVENT_NAME("WebNaniteVisibilityProbe"));
        auto Buffer = Nanite::CreateWebVisibilityBuffer(Graph, FIntPoint(Width, Height));
        auto Output = Nanite::CreateWebVisibilityTexture(Graph, FIntPoint(Width, Height));
        Graph.QueueBufferUpload(Buffer, MakeArrayView(Initial));
        auto* ClearParameters = Graph.AllocParameters<FWebNaniteVisibilityClearParameters>();
        ClearParameters->WebNaniteVisibilitySize = FUint32Vector2(Width, Height);
        ClearParameters->WebNaniteClearRect = FUint32Vector4(2, 1, 9, 7);
        ClearParameters->WebNaniteClearTarget = Graph.CreateUAV(Buffer);
        Graph.AddPass(RDG_EVENT_NAME("WebNaniteClear"), ClearParameters, ERDGPassFlags::Compute,
            [&, ClearParameters](FRHIComputeCommandList& List) {
                const uint32 Globals[]{Width, Height, 0, 0, 2, 1, 9, 7};
                const TPair<const TCHAR*, FRHIShaderParameterResource> Resources[]{
                    {TEXT("WebNaniteClearTarget"), FRHIShaderParameterResource(ClearParameters->WebNaniteClearTarget->GetRHI(), 0)}};
                Dispatch(List, Clear, MakeArrayView(reinterpret_cast<const uint8*>(Globals), sizeof(Globals)), Resources);
            });
        auto Input = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(16, UE_ARRAY_COUNT(Candidates)),
            TEXT("WebNaniteProbeCandidates"));
        Graph.QueueBufferUpload(Input, Candidates, sizeof(Candidates));
        auto* WriteParameters = Graph.AllocParameters<FWebNaniteVisibilityProbeWriteParameters>();
        WriteParameters->Candidates = Graph.CreateSRV(Input);
        WriteParameters->WebNaniteAtomicMax_Visibility = Graph.CreateUAV(Buffer);
        Graph.AddPass(RDG_EVENT_NAME("WebNaniteWrite"), WriteParameters, ERDGPassFlags::Compute,
            [&, WriteParameters](FRHIComputeCommandList& List) {
                const uint32 Globals[]{Width, Height, 0, 0};
                const TPair<const TCHAR*, FRHIShaderParameterResource> Resources[]{
                    {TEXT("Candidates"), FRHIShaderParameterResource(WriteParameters->Candidates->GetRHI(), 0)},
                    {TEXT("WebNaniteAtomicMax_Visibility"), FRHIShaderParameterResource(WriteParameters->WebNaniteAtomicMax_Visibility->GetRHI(), 0)}};
                Dispatch(List, Writer, MakeArrayView(reinterpret_cast<const uint8*>(Globals), sizeof(Globals)), Resources);
            });
        auto* ResolveParameters = Nanite::WebVisibilityResolveParameters(Graph, Buffer, Output);
        Graph.AddPass(RDG_EVENT_NAME("WebNaniteResolve"), ResolveParameters, ERDGPassFlags::Compute,
            [&, ResolveParameters](FRHIComputeCommandList& List) {
                const uint32 Globals[]{Width, Height, 0, 0};
                const TPair<const TCHAR*, FRHIShaderParameterResource> Resources[]{
                    {TEXT("WebNaniteVisibility"), FRHIShaderParameterResource(ResolveParameters->WebNaniteVisibility->GetRHI(), 0)},
                    {TEXT("WebNaniteResolvedVisibility"), FRHIShaderParameterResource(ResolveParameters->WebNaniteResolvedVisibility->GetRHI(), 0)}};
                Dispatch(List, Resolve, MakeArrayView(reinterpret_cast<const uint8*>(Globals), sizeof(Globals)), Resources);
            });
        Graph.QueueTextureExtraction(Output, &Texture, ERHIAccess::CopySrc);
        Graph.Execute();
    }
    Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
    auto Readback = RHI.CreateBuffer(256 * Height, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
    if (!RHI.ContextOpen) RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
    auto Source = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    Source.texture = static_cast<FWebGPUTexture*>(Texture->GetRHI())->Handle;
    auto Destination = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    Destination.buffer = Readback;
    Destination.layout.bytesPerRow = 256;
    Destination.layout.rowsPerImage = Height;
    const WGPUExtent3D Extent{Width, Height, 1};
    RHI.EndComputePass();
    wgpuCommandEncoderCopyTextureToBuffer(RHI.Encoder, &Source, &Destination, &Extent);
    RHI.SubmitCurrent();
    const auto Bytes = RHI.MapBuffer(Readback, 256 * Height);
    wgpuBufferRelease(Readback);
    bool Pass = Bytes.Num() == 256 * Height;
    if (Pass)
        for (uint32 Y = 0; Y < Height; ++Y)
            Pass &= FMemory::Memcmp(Bytes.GetData() + Y * 256, Expected.GetData() + Y * Width * 2, Width * 8) == 0;
    RHI.ShaderData(Clear).Resources.Reset();
    RHI.ShaderData(Writer).Resources.Reset();
    RHI.ShaderData(Resolve).Resources.Reset();
    Texture.SafeRelease();
    RHI.ReleaseBindings();
    // The probe temporarily replaces NullRHI. Pooled WebGPU resources must not
    // survive the device restoration or be reused by the next probe mode.
    GRenderTargetPool.FreeUnusedResources();
    static_cast<FRenderResource&>(GRenderGraphResourcePool).ReleaseRHI();
    Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
    return Pass;
}
