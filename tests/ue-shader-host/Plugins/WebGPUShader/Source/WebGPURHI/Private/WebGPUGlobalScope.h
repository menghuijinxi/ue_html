#pragma once

#include "WebGPUDynamicRHI.h"

class FWebGPUGlobalScope
{
  public:
    TUniquePtr<FWebGPUDynamicRHI> RHI;
    FDynamicRHI *PreviousRHI;
    FRHIGlobals PreviousGlobals;
    EShaderPlatform PreviousMaxPlatform;
    ERHIFeatureLevel::Type PreviousFeatureLevel;
    uint64 PreviousTransitionSize, PreviousTransitionAlign;
    bool PreviousBypass, PreviousDrawEvents;

    explicit FWebGPUGlobalScope(IDynamicRHIModule &Module);
    ~FWebGPUGlobalScope();
    void PrepareShutdown();
    void Restore();
    bool IsRestored() const;

  private:
    bool Restored = false;
    bool Prepared = false;
};
