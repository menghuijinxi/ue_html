#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

bool RunWebGPUViewportProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory);
