#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class FWebGPUDynamicRHI;
TSharedRef<FJsonObject> RunWebGPUTransitionProbe(FWebGPUDynamicRHI &RHI, const FString &ShaderDirectory,
                                                 const FString &OutputDirectory);
