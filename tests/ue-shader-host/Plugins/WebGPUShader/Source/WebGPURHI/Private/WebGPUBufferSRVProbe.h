#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

bool RunWebGPUBufferSRVProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory);
