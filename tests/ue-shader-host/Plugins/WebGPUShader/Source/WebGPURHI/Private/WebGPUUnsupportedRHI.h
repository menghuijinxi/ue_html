#pragma once

#include "DynamicRHI.h"
#include "RHI.h"
#include "RHICommandList.h"
#include "RHIContext.h"

class FWebGPUUnsupportedRHI : public FDynamicRHI, public IRHICommandContext
{
  protected:
    static void Unsupported(const TCHAR *Operation)
    {
        UE_LOG(LogRHI, Fatal, TEXT("WebGPURHI operation is not implemented: %s"), Operation);
    }

  public:
#define WEBGPU_UNSUPPORTED(Name)                                                                                       \
    {                                                                                                                  \
        Unsupported(TEXT(#Name));                                                                                      \
    }
#define WEBGPU_UNSUPPORTED_RETURN(Name)                                                                                \
    {                                                                                                                  \
        Unsupported(TEXT(#Name));                                                                                      \
        return {};                                                                                                     \
    }
    void Init() override WEBGPU_UNSUPPORTED(Init) void Shutdown() override
        WEBGPU_UNSUPPORTED(Shutdown) const TCHAR *GetName() override
    {
        return TEXT("WebGPU");
    }
    void RHIEndFrame(const FRHIEndFrameArgs &) override WEBGPU_UNSUPPORTED(RHIEndFrame) FSamplerStateRHIRef
        RHICreateSamplerState(const FSamplerStateInitializerRHI &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateSamplerState) FRasterizerStateRHIRef
        RHICreateRasterizerState(const FRasterizerStateInitializerRHI &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateRasterizerState) FDepthStencilStateRHIRef
        RHICreateDepthStencilState(const FDepthStencilStateInitializerRHI &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateDepthStencilState) FBlendStateRHIRef
        RHICreateBlendState(const FBlendStateInitializerRHI &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateBlendState) FVertexDeclarationRHIRef
        RHICreateVertexDeclaration(const FVertexDeclarationElementList &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateVertexDeclaration) FPixelShaderRHIRef
        RHICreatePixelShader(const FRHICreateShaderDesc &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreatePixelShader) FVertexShaderRHIRef
        RHICreateVertexShader(const FRHICreateShaderDesc &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateVertexShader) FGeometryShaderRHIRef
        RHICreateGeometryShader(const FRHICreateShaderDesc &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateGeometryShader) FComputeShaderRHIRef
        RHICreateComputeShader(const FRHICreateShaderDesc &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateComputeShader) FGPUFenceRHIRef RHICreateGPUFence(const FName &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateGPUFence) FBoundShaderStateRHIRef
        RHICreateBoundShaderState(FRHIVertexDeclaration *, FRHIVertexShader *, FRHIPixelShader *,
                                  FRHIGeometryShader *) override WEBGPU_UNSUPPORTED_RETURN(RHICreateBoundShaderState)
#if PLATFORM_SUPPORTS_MESH_SHADERS && PLATFORM_USE_FALLBACK_PSO
            FBoundShaderStateRHIRef
        RHICreateBoundShaderState(FRHIAmplificationShader *, FRHIMeshShader *, FRHIPixelShader *) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateBoundShaderState)
#endif
            FGraphicsPipelineStateRHIRef
        RHICreateGraphicsPipelineState(const FGraphicsPipelineStateInitializer &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateGraphicsPipelineState) FComputePipelineStateRHIRef
        RHICreateComputePipelineState(const FComputePipelineStateInitializer &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateComputePipelineState) FUniformBufferRHIRef
        RHICreateUniformBuffer(const void *, const FRHIUniformBufferLayout *, EUniformBufferUsage,
                               EUniformBufferValidation) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateUniformBuffer) void RHIUpdateUniformBuffer(FRHICommandListBase &,
                                                                                      FRHIUniformBuffer *,
                                                                                      const void *) override
        WEBGPU_UNSUPPORTED(RHIUpdateUniformBuffer) void RHIReplaceResources(FRHICommandListBase &,
                                                                            TArray<FRHIResourceReplaceInfo> &&) override
        WEBGPU_UNSUPPORTED(RHIReplaceResources) FRHIBufferInitializer
        RHICreateBufferInitializer(FRHICommandListBase &, const FRHIBufferCreateDesc &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateBufferInitializer)
#if ENABLE_LOW_LEVEL_MEM_TRACKER || UE_MEMORY_TRACE_ENABLED
            void RHIUpdateAllocationTags(FRHICommandListBase &, FRHIBuffer *) override
        WEBGPU_UNSUPPORTED(RHIUpdateAllocationTags)
#endif
            FRHICalcTextureSizeResult RHICalcTexturePlatformSize(const FRHITextureDesc &, uint32) override
        WEBGPU_UNSUPPORTED_RETURN(RHICalcTexturePlatformSize) void RHIGetTextureMemoryStats(
            FTextureMemoryStats &) override
        WEBGPU_UNSUPPORTED(RHIGetTextureMemoryStats) bool RHIGetTextureMemoryVisualizeData(FColor *, int32, int32,
                                                                                           int32, int32) override
        WEBGPU_UNSUPPORTED_RETURN(RHIGetTextureMemoryVisualizeData) FRHITextureInitializer
        RHICreateTextureInitializer(FRHICommandListBase &, const FRHITextureCreateDesc &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateTextureInitializer) FTextureRHIRef
        RHIAsyncCreateTexture2D(uint32, uint32, uint8, uint32, ETextureCreateFlags, ERHIAccess, void **, uint32,
                                const TCHAR *, FGraphEventRef &) override
        WEBGPU_UNSUPPORTED_RETURN(RHIAsyncCreateTexture2D) FShaderResourceViewRHIRef
        RHICreateShaderResourceView(FRHICommandListBase &, FRHIViewableResource *, const FRHIViewDesc &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateShaderResourceView) FUnorderedAccessViewRHIRef
        RHICreateUnorderedAccessView(FRHICommandListBase &, FRHIViewableResource *, const FRHIViewDesc &) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateUnorderedAccessView) uint32 RHIComputeMemorySize(FRHITexture *) override
        WEBGPU_UNSUPPORTED_RETURN(RHIComputeMemorySize) FRHILockTextureResult
        RHILockTexture(FRHICommandListImmediate &, const FRHILockTextureArgs &) override
        WEBGPU_UNSUPPORTED_RETURN(RHILockTexture) void RHIUnlockTexture(FRHICommandListImmediate &,
                                                                        const FRHILockTextureArgs &) override
        WEBGPU_UNSUPPORTED(RHIUnlockTexture) void RHIUpdateTexture2D(FRHICommandListBase &, FRHITexture *, uint32,
                                                                     const FUpdateTextureRegion2D &, uint32,
                                                                     const uint8 *) override
        WEBGPU_UNSUPPORTED(RHIUpdateTexture2D) void RHIUpdateTexture3D(FRHICommandListBase &, FRHITexture *, uint32,
                                                                       const FUpdateTextureRegion3D &, uint32, uint32,
                                                                       const uint8 *) override
        WEBGPU_UNSUPPORTED(RHIUpdateTexture3D) void RHIReadSurfaceData(FRHITexture *, FIntRect, TArray<FColor> &,
                                                                       FReadSurfaceDataFlags) override
        WEBGPU_UNSUPPORTED(RHIReadSurfaceData) void RHIMapStagingSurface(FRHITexture *, FRHIGPUFence *, void *&,
                                                                         int32 &, int32 &, uint32) override
        WEBGPU_UNSUPPORTED(RHIMapStagingSurface) void RHIUnmapStagingSurface(FRHITexture *, uint32) override
        WEBGPU_UNSUPPORTED(RHIUnmapStagingSurface) void RHIReadSurfaceFloatData(FRHITexture *, FIntRect,
                                                                                TArray<FFloat16Color> &, ECubeFace,
                                                                                int32, int32) override
        WEBGPU_UNSUPPORTED(RHIReadSurfaceFloatData) void RHIRead3DSurfaceFloatData(FRHITexture *, FIntRect, FIntPoint,
                                                                                   TArray<FFloat16Color> &) override
        WEBGPU_UNSUPPORTED(RHIRead3DSurfaceFloatData) FRenderQueryRHIRef RHICreateRenderQuery(ERenderQueryType) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateRenderQuery) bool RHIGetRenderQueryResult(FRHIRenderQuery *, uint64 &, bool,
                                                                                     uint32) override
        WEBGPU_UNSUPPORTED_RETURN(RHIGetRenderQueryResult) FTextureRHIRef
        RHIGetViewportBackBuffer(FRHIViewport *) override
        WEBGPU_UNSUPPORTED_RETURN(RHIGetViewportBackBuffer) FViewportRHIRef
        RHICreateViewport(void *, uint32, uint32, bool, EPixelFormat) override
        WEBGPU_UNSUPPORTED_RETURN(RHICreateViewport) void RHIResizeViewport(FRHIViewport *, uint32, uint32, bool,
                                                                            EPixelFormat) override
        WEBGPU_UNSUPPORTED(RHIResizeViewport) void RHIEndDrawingViewport(FRHICommandListImmediate &, FRHIViewport *,
                                                                         const FRHIPresentArgs &) override
        WEBGPU_UNSUPPORTED(RHIEndDrawingViewport) void RHITick(float) override
        WEBGPU_UNSUPPORTED(RHITick) void RHIBlockUntilGPUIdle() override
        WEBGPU_UNSUPPORTED(RHIBlockUntilGPUIdle) bool RHIGetAvailableResolutions(FScreenResolutionArray &,
                                                                                 bool) override
        WEBGPU_UNSUPPORTED_RETURN(RHIGetAvailableResolutions) void RHIGetSupportedResolution(uint32 &,
                                                                                             uint32 &) override
        WEBGPU_UNSUPPORTED(RHIGetSupportedResolution) void *RHIGetNativeDevice() override
        WEBGPU_UNSUPPORTED_RETURN(RHIGetNativeDevice) IRHICommandContext *RHIGetDefaultContext() override
        WEBGPU_UNSUPPORTED_RETURN(RHIGetDefaultContext) IRHIComputeContext *RHIGetCommandContext(ERHIPipeline) override
        WEBGPU_UNSUPPORTED_RETURN(RHIGetCommandContext) FRHIFinalizeContextsResult
        RHIFinalizeContexts(FRHIFinalizeContextsArgs &&) override WEBGPU_UNSUPPORTED_RETURN(
            RHIFinalizeContexts) void RHISubmitCommandLists(FRHISubmitCommandListsArgs &&) override
        WEBGPU_UNSUPPORTED(RHISubmitCommandLists) void RHISetComputePipelineState(FRHIComputePipelineState *) override
        WEBGPU_UNSUPPORTED(RHISetComputePipelineState) void RHIDispatchComputeShader(uint32, uint32, uint32) override
        WEBGPU_UNSUPPORTED(RHIDispatchComputeShader) void RHIDispatchIndirectComputeShader(FRHIBuffer *,
                                                                                           uint32) override
        WEBGPU_UNSUPPORTED(RHIDispatchIndirectComputeShader) void RHIBeginTransitions(
            TArrayView<const FRHITransition *>) override
        WEBGPU_UNSUPPORTED(RHIBeginTransitions) void RHIEndTransitions(TArrayView<const FRHITransition *>) override
        WEBGPU_UNSUPPORTED(RHIEndTransitions) void RHICreateTransition(FRHITransition *,
                                                                       const FRHITransitionCreateInfo &) override
        WEBGPU_UNSUPPORTED(RHICreateTransition) void RHIReleaseTransition(FRHITransition *) override
        WEBGPU_UNSUPPORTED(RHIReleaseTransition) void RHIClearUAVFloat(FRHIUnorderedAccessView *,
                                                                       const FVector4f &) override
        WEBGPU_UNSUPPORTED(RHIClearUAVFloat) void RHIClearUAVUint(FRHIUnorderedAccessView *,
                                                                  const FUintVector4 &) override
        WEBGPU_UNSUPPORTED(RHIClearUAVUint) void RHISetShaderParameters(
            FRHIComputeShader *, TConstArrayView<uint8>, TConstArrayView<FRHIShaderParameter>,
            TConstArrayView<FRHIShaderParameterResource>, TConstArrayView<FRHIShaderParameterResource>) override
        WEBGPU_UNSUPPORTED(RHISetShaderParameters) void RHISetShaderParameters(
            FRHIGraphicsShader *, TConstArrayView<uint8>, TConstArrayView<FRHIShaderParameter>,
            TConstArrayView<FRHIShaderParameterResource>, TConstArrayView<FRHIShaderParameterResource>) override
        WEBGPU_UNSUPPORTED(RHISetShaderParameters) void RHISetStaticUniformBuffers(
            const FUniformBufferStaticBindings &) override
        WEBGPU_UNSUPPORTED(RHISetStaticUniformBuffers) void RHISetStaticUniformBuffer(FUniformBufferStaticSlot,
                                                                                      FRHIUniformBuffer *) override
        WEBGPU_UNSUPPORTED(RHISetStaticUniformBuffer)
#if WITH_RHI_BREADCRUMBS
            void RHIBeginBreadcrumbGPU(FRHIBreadcrumbNode *) override
        WEBGPU_UNSUPPORTED(RHIBeginBreadcrumbGPU) void RHIEndBreadcrumbGPU(FRHIBreadcrumbNode *) override
        WEBGPU_UNSUPPORTED(RHIEndBreadcrumbGPU)
#endif
            void RHISetMultipleViewports(uint32, const FViewportBounds *) override
        WEBGPU_UNSUPPORTED(RHISetMultipleViewports) void RHIBeginRenderQuery(FRHIRenderQuery *) override
        WEBGPU_UNSUPPORTED(RHIBeginRenderQuery) void RHIEndRenderQuery(FRHIRenderQuery *) override
        WEBGPU_UNSUPPORTED(RHIEndRenderQuery) void RHISetStreamSource(uint32, FRHIBuffer *, uint32) override
        WEBGPU_UNSUPPORTED(RHISetStreamSource) void RHISetViewport(float, float, float, float, float, float) override
        WEBGPU_UNSUPPORTED(RHISetViewport) void RHISetScissorRect(bool, uint32, uint32, uint32, uint32) override
        WEBGPU_UNSUPPORTED(RHISetScissorRect) void RHISetGraphicsPipelineState(FRHIGraphicsPipelineState *, uint32,
                                                                               bool) override
        WEBGPU_UNSUPPORTED(RHISetGraphicsPipelineState)
#if PLATFORM_USE_FALLBACK_PSO
            void RHISetGraphicsPipelineState(const FGraphicsPipelineStateInitializer &, uint32, bool) override
        WEBGPU_UNSUPPORTED(RHISetGraphicsPipelineState)
#endif
            void RHIDrawPrimitive(uint32, uint32, uint32) override
        WEBGPU_UNSUPPORTED(RHIDrawPrimitive) void RHIDrawPrimitiveIndirect(FRHIBuffer *, uint32) override
        WEBGPU_UNSUPPORTED(RHIDrawPrimitiveIndirect) void RHIDrawIndexedPrimitive(FRHIBuffer *, int32, uint32, uint32,
                                                                                  uint32, uint32, uint32) override
        WEBGPU_UNSUPPORTED(RHIDrawIndexedPrimitive) void RHIDrawIndexedPrimitiveIndirect(FRHIBuffer *, FRHIBuffer *,
                                                                                         uint32) override
        WEBGPU_UNSUPPORTED(RHIDrawIndexedPrimitiveIndirect) void RHISetDepthBounds(float, float) override
        WEBGPU_UNSUPPORTED(RHISetDepthBounds) void RHIBeginRenderPass(const FRHIRenderPassInfo &,
                                                                      const TCHAR *) override
        WEBGPU_UNSUPPORTED(RHIBeginRenderPass) void RHIEndRenderPass() override
        WEBGPU_UNSUPPORTED(RHIEndRenderPass) void RHICopyTexture(FRHITexture *, FRHITexture *,
                                                                 const FRHICopyTextureInfo &) override
        WEBGPU_UNSUPPORTED(RHICopyTexture) void RHICopyBufferRegion(FRHIBuffer *, uint64, FRHIBuffer *, uint64,
                                                                    uint64) override
        WEBGPU_UNSUPPORTED(RHICopyBufferRegion)
#undef WEBGPU_UNSUPPORTED
#undef WEBGPU_UNSUPPORTED_RETURN
};
