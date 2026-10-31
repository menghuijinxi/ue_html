#include "WebGPUDynamicRHI.h"
#include "RHIBreadcrumbs.h"

#if WITH_RHI_BREADCRUMBS
void FWebGPUDynamicRHI::RHIBeginBreadcrumbGPU(FRHIBreadcrumbNode *Node)
{
    WEBGPU_COMMAND_ON_OWNER(RHIBeginBreadcrumbGPU(Node));
    RequireOwner();
    check(Node);
    BreadcrumbStack.Add(Node);
    ++BreadcrumbsBegun;
    if (EmitDebugMarkers && ShouldEmitBreadcrumbs())
    {
        if (GlobalProbeMode && !ContextOpen)
            RHIGetCommandContext(ERHIPipeline::Graphics);
        const FTCHARToUTF8 Label(*Node->GetFullPath());
        WGPUStringView Text{Label.Get(), size_t(Label.Length())};
        if (Pass)
        {
            wgpuRenderPassEncoderInsertDebugMarker(Pass, Text);
            ++BreadcrumbMarkersEmitted;
        }
        else if (Encoder)
        {
            wgpuCommandEncoderInsertDebugMarker(Encoder, Text);
            ++BreadcrumbMarkersEmitted;
        }
    }
}

void FWebGPUDynamicRHI::RHIEndBreadcrumbGPU(FRHIBreadcrumbNode *Node)
{
    WEBGPU_COMMAND_ON_OWNER(RHIEndBreadcrumbGPU(Node));
    RequireOwner();
    check(!BreadcrumbStack.IsEmpty() && BreadcrumbStack.Last() == Node);
    BreadcrumbStack.Pop(EAllowShrinking::No);
    ++BreadcrumbsEnded;
}
#endif
