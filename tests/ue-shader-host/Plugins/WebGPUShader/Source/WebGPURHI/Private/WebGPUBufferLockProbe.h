#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

bool RunWebGPUBufferLockProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory,
                              const FString &OutputDirectory);
