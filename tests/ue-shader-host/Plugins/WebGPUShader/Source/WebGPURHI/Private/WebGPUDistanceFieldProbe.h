#pragma once

#include "CoreMinimal.h"
class IDynamicRHIModule;
bool RunWebGPUDistanceFieldProbe(IDynamicRHIModule&, const FString& Shaders, const FString& Output);
