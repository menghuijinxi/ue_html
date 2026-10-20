#pragma once

#include "CoreMinimal.h"
#include "DynamicRHI.h"

bool RunWebGPUGlobalProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory);
