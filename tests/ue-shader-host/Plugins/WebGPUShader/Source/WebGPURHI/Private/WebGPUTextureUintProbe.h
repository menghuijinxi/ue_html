#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

bool RunWebGPUTextureUintProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory,
                               const FString &OutputDirectory);
