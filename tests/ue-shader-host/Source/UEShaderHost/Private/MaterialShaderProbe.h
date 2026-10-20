#pragma once

#include "CoreMinimal.h"

struct FShaderCompilerOutput;
class FJsonObject;

bool ExportSpirv(FShaderCompilerOutput& Output, const FString& Directory, const FString& Name,
    const TSharedRef<FJsonObject>& Json);
int32 RunMaterialShaderProbe(const FString& Params);
