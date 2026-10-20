#include "WebGPUGlobalScope.h"

#include "DataDrivenShaderPlatformInfo.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"

FWebGPUGlobalScope::FWebGPUGlobalScope(IDynamicRHIModule &Module)
{
    auto &Cmd = FRHICommandListImmediate::Get();
    check(GDynamicRHI && FString(GDynamicRHI->GetName()) == TEXT("Null") && !IsRunningRHIInSeparateThread());
    PreviousBypass = Cmd.Bypass();
    PreviousDrawEvents = GetEmitDrawEvents();
    PreviousMaxPlatform = GMaxRHIShaderPlatform;
    PreviousFeatureLevel = GMaxRHIFeatureLevel;
    PreviousTransitionSize = GRHITransitionPrivateData_SizeInBytes;
    PreviousTransitionAlign = GRHITransitionPrivateData_AlignInBytes;
    Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
    GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                   ERHISubmitFlags::DisableBypass | ERHISubmitFlags::DisableDrawEvents);
    PipelineStateCache::Shutdown();
    PreviousGlobals = GRHIGlobals;
    PreviousRHI = GDynamicRHI;
    RHI.Reset(static_cast<FWebGPUDynamicRHI *>(Module.CreateRHI(ERHIFeatureLevel::SM5)));
    RHI->GlobalProbeMode = true;
    GDynamicRHI = RHI.Get();
    GRHITransitionPrivateData_SizeInBytes = sizeof(FWebGPUTransitionPrivateData);
    GRHITransitionPrivateData_AlignInBytes = alignof(FWebGPUTransitionPrivateData);
    RHI->Init();
    GUsingNullRHI = false;
    GIsRHIInitialized = true;
    GRHISupportsRHIThread = false;
    GRHISupportsRHIOnTaskThread = false;
    GRHISupportsParallelRHIExecute = false;
    GRHISupportsMultithreadedResources = false;
    GRHISupportsMultithreadedShaderCreation = false;
    GRHISupportsAsyncPipelinePrecompile = false;
    GRHISupportsPSOPrecaching = false;
    GRHISupportsPipelineFileCache = false;
    GMaxRHIFeatureLevel = ERHIFeatureLevel::SM5;
    GMaxRHIShaderPlatform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
    GShaderPlatformForFeatureLevel[ERHIFeatureLevel::SM5] = GMaxRHIShaderPlatform;
    check(GMaxRHIShaderPlatform != SP_NumPlatforms);
    PipelineStateCache::Init();
}

FWebGPUGlobalScope::~FWebGPUGlobalScope()
{
    if (!Restored)
        Restore();
}

void FWebGPUGlobalScope::PrepareShutdown()
{
    check(!Restored && !Prepared);
    auto &Cmd = FRHICommandListImmediate::Get();
    GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                   ERHISubmitFlags::DisableBypass);
    RHI->ReleaseBindings();
    PipelineStateCache::Shutdown();
    Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
    RHI->RHIBlockUntilGPUIdle();
    Prepared = true;
}

void FWebGPUGlobalScope::Restore()
{
    check(!Restored);
    if (!Prepared)
        PrepareShutdown();
    RHI->Shutdown();
    GDynamicRHI = PreviousRHI;
    GRHIGlobals = PreviousGlobals;
    GMaxRHIShaderPlatform = PreviousMaxPlatform;
    GMaxRHIFeatureLevel = PreviousFeatureLevel;
    GRHITransitionPrivateData_SizeInBytes = PreviousTransitionSize;
    GRHITransitionPrivateData_AlignInBytes = PreviousTransitionAlign;
    PipelineStateCache::Init();
    GRHICommandList.Submit(
        {}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                (PreviousBypass ? ERHISubmitFlags::EnableBypass : ERHISubmitFlags::DisableBypass) |
                (PreviousDrawEvents ? ERHISubmitFlags::EnableDrawEvents : ERHISubmitFlags::DisableDrawEvents));
    Restored = true;
}

bool FWebGPUGlobalScope::IsRestored() const
{
    return Restored && GDynamicRHI == PreviousRHI && GUsingNullRHI == PreviousGlobals.UsingNullRHI &&
           FRHICommandListImmediate::Get().Bypass() == PreviousBypass && GMaxRHIShaderPlatform == PreviousMaxPlatform &&
           GMaxRHIFeatureLevel == PreviousFeatureLevel &&
           GRHITransitionPrivateData_SizeInBytes == PreviousTransitionSize &&
           GRHITransitionPrivateData_AlignInBytes == PreviousTransitionAlign;
}
