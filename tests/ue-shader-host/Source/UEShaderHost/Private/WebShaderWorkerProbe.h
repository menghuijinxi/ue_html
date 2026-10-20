#pragma once

#include "CoreMinimal.h"
#include "ShaderCompilerJobTypes.h"

class IShaderFormat;

class FWebShaderWorkerProbe
{
  public:
    FWebShaderWorkerProbe(const FString &Params, const FString &OutputDirectory, FName WebFormat);
    bool Add(const FString &Name, const FShaderCompilerInput &Input, const FShaderParameterMap &NativeParameters,
             const FShaderPreprocessOutput &NativePreprocessed);
    bool Run();

  private:
    FString Directory;
    FString Worker;
    FName FormatName;
    const IShaderFormat *Format = nullptr;
    TArray<FShaderCommonCompileJobPtr> Jobs;
    TArray<FString> Names;
    TArray<FShaderHash> ExpectedHashes;
    TArray<bool> ExpectedSuccess;
    TArray<FShaderParameterMap> Parameters;
    bool Enabled = false;
    bool Prepared = true;
    bool Execute(TArray<uint8> &Input, const FString &Batch, TArray<uint8> &Output, int32 &ErrorCode);
    TArray<uint8> MakeInput(int32 VersionDelta = 0, uint32 FormatVersionDelta = 0);
};
