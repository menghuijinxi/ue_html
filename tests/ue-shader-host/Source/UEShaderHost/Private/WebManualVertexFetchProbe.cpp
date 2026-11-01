#include "WebGPUShaderCode.h"
#include "GlobalShader.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "ShaderCompiler.h"
#include "ShaderPreprocessTypes.h"

int32 RunWebManualVertexFetchProbe(const FString& Params)
{
    FString Directory;
    if (!FParse::Value(*Params, TEXT("Output="), Directory)) return 1;
    IFileManager::Get().MakeDirectory(*Directory, true);
    AddShaderSourceDirectoryMapping(TEXT("/WebGPUProbe"),
        FPaths::ConvertRelativePathToFull(FPaths::ProjectDir() / TEXT("Shaders")));
    const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(FName(TEXT("SP_WEBGPU_SM5")));
    const auto* Format = GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    const auto* Type = FindShaderTypeByName(FHashedName(TEXT("FMemcpyCS")));
    check(Format && Type && Platform != SP_NumPlatforms);
    FShaderCompileJob Job;
    Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, 0);
    GlobalBeginCompileShader(TEXT("WebManualVertexFetchProbe"), nullptr, Type, nullptr, 0,
        TEXT("/WebGPUProbe/Private/WebManualVertexFetchProbe.usf"), TEXT("MainCS"),
        FShaderTarget(SF_Compute, Platform), Job.Input, false);
    Job.Input.ShaderFormat = UE::WebGPUShader::SM5Format;
    Format->ModifyShaderCompilerInput(Job.Input);
    if (!Format->PreprocessShader(Job.Input, Job.Input.Environment, Job.PreprocessOutput))
    {
        for (const auto& Error : Job.PreprocessOutput.GetErrors())
            UE_LOG(LogTemp, Error, TEXT("%s"), *Error.StrippedErrorMessage);
        return 1;
    }
    Format->CompilePreprocessedShader(Job.Input, Job.PreprocessOutput, Job.Output);
    for (const auto& Error : Job.Output.Errors) UE_LOG(LogTemp, Display, TEXT("%s"), *Error.StrippedErrorMessage);
    if (!Job.Output.bSucceeded) return 1;
    UE::WebGPUShader::FPayload Payload;
    FString Error;
    if (!UE::WebGPUShader::Decode(Job.Output.ShaderCode.GetReadView().Left(Job.Output.ShaderCode.GetShaderCodeSize()), Payload, Error))
        return 1;
    return FFileHelper::SaveStringToFile(Payload.Wgsl, *(Directory / TEXT("vertex-fetch.wgsl"))) &&
        FFileHelper::SaveStringToFile(Payload.MetadataJson, *(Directory / TEXT("vertex-fetch.json"))) ? 0 : 1;
}
