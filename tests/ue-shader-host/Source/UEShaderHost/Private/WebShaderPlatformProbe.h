#pragma once

#include "CoreMinimal.h"
#include "RHIShaderPlatform.h"

EShaderPlatform ResolveProbeShaderPlatform(const FString& Params, const FString& OutputDirectory,
                                          bool Mobile, EShaderPlatform NativePlatform);
