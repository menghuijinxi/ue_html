#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

class IWebGPURHIProbeModule : public IDynamicRHIModule
{
  public:
    virtual bool RunProbe(const FString &ShaderDirectory, const FString &MaterialDirectory,
                          const FString &OutputDirectory) = 0;
    virtual bool RunGlobalProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunViewportProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunTextureSRVProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunBufferSRVProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunBufferUAVProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunUint4Probe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunStructuredProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunFloat4Probe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunBufferLockProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunTexture3DProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
    virtual bool RunTextureUintProbe(const FString &ShaderDirectory, const FString &OutputDirectory) = 0;
};

// Runs through UE command lists against a separately owned RHI; does not replace the host's GDynamicRHI.
WEBGPURHI_API bool RunWebGPURHIProbe(const FString &ShaderDirectory, const FString &MaterialDirectory,
                                     const FString &OutputDirectory);
