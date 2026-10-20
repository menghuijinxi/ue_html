#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

bool RunWebGPUTextureSRVProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory,
                              const FString &OutputDirectory);
