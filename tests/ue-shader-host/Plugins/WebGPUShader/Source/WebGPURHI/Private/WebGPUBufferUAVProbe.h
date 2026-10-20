#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

bool RunWebGPUBufferUAVProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory);
