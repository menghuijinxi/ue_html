#pragma once

#include "WebGPUDynamicRHI.h"
#include "Misc/FileHelper.h"

namespace WebGPUProbe
{
// The host's global PSO cache belongs to NullRHI; keep the probe's shader validation local.
class FCommandList final : public FRHICommandList_RecursiveHazardous
{
  public:
    explicit FCommandList(IRHICommandContext *Context) : FRHICommandList_RecursiveHazardous(Context)
    {
    }
    using FRHICommandList::OnBoundShaderChanged;
    FRHITransition *CreateLocalTransition(FWebGPUDynamicRHI &RHI, TArrayView<const FRHITransitionInfo> Infos,
                                          ERHITransitionCreateFlags Flags = ERHITransitionCreateFlags::None)
    {
        check(GDynamicRHI != &RHI && FString(GDynamicRHI->GetName()) == TEXT("Null"));
        const FRHITransitionCreateInfo Info(ERHIPipeline::Graphics, ERHIPipeline::Graphics, Flags, Infos);
        // UE owns allocation/marker cleanup through NullRHI. Route backend creation/release explicitly.
        auto *Transition = RHICreateTransition(Info);
        RHI.RHICreateTransition(Transition, Info);
        return Transition;
    }
    void ReleaseLocalTransition(FWebGPUDynamicRHI &RHI, FRHITransition *Transition)
    {
        EnqueueLambda([&RHI, Transition](FRHICommandListBase &) { RHI.RHIReleaseTransition(Transition); });
    }
    void TransitionLocal(FWebGPUDynamicRHI &RHI, const FRHITransitionInfo &Info)
    {
        if (GDynamicRHI == &RHI)
        {
            Transition(Info);
            return;
        }
        auto *Transition = CreateLocalTransition(RHI, MakeArrayView(&Info, 1), ERHITransitionCreateFlags::NoSplit);
        BeginTransition(Transition);
        EndTransition(Transition);
        ReleaseLocalTransition(RHI, Transition);
    }
};
inline TArray<uint8> Packet(const FString &Directory, const TCHAR *Name)
{
    TArray<uint8> Bytes;
    checkf(FFileHelper::LoadFileToArray(Bytes, *(Directory / (FString(Name) + TEXT(".webshader")))),
           TEXT("Worker shader packet missing: %s"), Name);
    return Bytes;
}
inline FBufferRHIRef Buffer(FWebGPUDynamicRHI &RHI, FRHICommandListBase &Cmd, FRHIBufferCreateDesc Desc,
                            const void *Bytes, uint32 Size)
{
    Desc.SetInitActionInitializer().DetermineInitialState();
    auto Initializer = RHI.RHICreateBufferInitializer(Cmd, Desc);
    Initializer.WriteData(Bytes, Size);
    return Initializer.Finalize();
}
inline FTextureRHIRef Target(FWebGPUDynamicRHI &RHI, FRHICommandListBase &Cmd, uint32 Width, uint32 Height)
{
    auto Desc = FRHITextureCreateDesc::Create2D(TEXT("WebGPUProbeTarget"), Width, Height, PF_R8G8B8A8)
                    .SetFlags(ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::ShaderResource)
                    .SetClearValue(FClearValueBinding(FLinearColor(0, 0, 0, 0)))
                    .SetInitialState(ERHIAccess::RTV);
    return RHI.RHICreateTextureInitializer(Cmd, Desc).Finalize();
}
inline FReadSurfaceDataFlags RawReadback()
{
    FReadSurfaceDataFlags Flags;
    Flags.SetLinearToGamma(false);
    return Flags;
}
inline void BindPipeline(FWebGPUDynamicRHI &RHI, FCommandList &Cmd,
                         const FGraphicsPipelineStateInitializer &Initializer, FGraphicsPipelineStateRHIRef Pipeline)
{
#if PLATFORM_USE_FALLBACK_PSO
    Cmd.SetGraphicsPipelineState(Initializer, 0, false);
#else
    Cmd.OnBoundShaderChanged(Initializer.BoundShaderState);
    Cmd.EnqueueLambda([&RHI, Pipeline](FRHICommandListBase &) { RHI.RHISetGraphicsPipelineState(Pipeline, 0, false); });
#endif
}
} // namespace WebGPUProbe
