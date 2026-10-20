#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

bool RunWebGPUStructuredProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory);
