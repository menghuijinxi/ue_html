#include "WebGPUShaderCode.h"
#include "WebGPUNaniteAtomics.h"
#include "GlobalShader.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "ShaderCompiler.h"
#include "ShaderPreprocessTypes.h"
#include "Serialization/JsonSerializer.h"

int32 RunWebNaniteVisibilityProbe(const FString& Params)
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
    TArray<TSharedPtr<FJsonValue>> Cases;
    const FString Prefix =
        TEXT("struct S { data: array<atomic<u32>>, }\n")
        TEXT("@group(0) @binding(0) var<storage, read_write> WebNaniteAtomicMax_Test: S;\n");
    const TArray<FString> InvalidBodies = {
        TEXT("let x = WebNaniteAtomicMax_Test.data[0];"),
        TEXT("WebNaniteAtomicMax_Test.data[0].x = 3u;"),
        TEXT("let p = &WebNaniteAtomicMax_Test;"),
        TEXT("WebNaniteAtomicMax_Test.data[0] = WebNaniteAtomicMax_Test.data[1];"),
        TEXT("_ = atomicAdd(&(WebNaniteAtomicMax_Test.data[0]), 1u);"),
        TEXT("let x = atomicCompareExchangeWeak(&(WebNaniteAtomicMax_Test.data[0]), 1u, 2u).old_value;"),
        TEXT("atomicStore(&(WebNaniteAtomicMax_Test.data[0]), 1u);"),
    };
    for (const FString& Body : InvalidBodies)
    {
        FString Source = Prefix + TEXT("@compute @workgroup_size(1) fn main() { ") + Body + TEXT(" }");
        FString Error;
        const bool Rejected = !UE::WebGPUShader::LowerNaniteAtomicMax(Source, 1, Error);
        if (!Rejected || Error.IsEmpty()) return 1;
        auto Case = MakeShared<FJsonObject>();
        Case->SetStringField(TEXT("input"), Body);
        Case->SetBoolField(TEXT("rejected"), Rejected);
        Case->SetStringField(TEXT("error"), Error);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
    }
    const FString Store = TEXT("@compute @workgroup_size(1) fn main() { ")
        TEXT("_ = atomicCompareExchangeWeak(&(WebNaniteAtomicMax_Test.data[0u]), 1u, 2u).old_value; }");
    for (int32 Count : {0, 2})
    {
        FString Source = Prefix + Store, Error;
        if (UE::WebGPUShader::LowerNaniteAtomicMax(Source, Count, Error) || Error.IsEmpty()) return 1;
        auto Case = MakeShared<FJsonObject>();
        Case->SetStringField(TEXT("input"), FString::Printf(TEXT("expected-binding-count=%d"), Count));
        Case->SetBoolField(TEXT("rejected"), true);
        Case->SetStringField(TEXT("error"), Error);
        Cases.Add(MakeShared<FJsonValueObject>(Case));
    }
    {
        FString Source = TEXT("diagnostic(off, derivative_uniformity);\n/* nested /* comment */ ok */\n") + Prefix +
            TEXT("@group(0) @binding(1) var<storage, read_write> Other: S;\n") +
            TEXT("@compute @workgroup_size(1) fn main() { let n = arrayLength(&(WebNaniteAtomicMax_Test.data)); ")
            TEXT("atomicStore(&(Other.data[0]), 5u); ")
            TEXT("_ = atomicCompareExchangeWeak(&(WebNaniteAtomicMax_Test.data[n - 1u]), max(1u, 2u), 3u).old_value; }");
        FString Error;
        if (!UE::WebGPUShader::LowerNaniteAtomicMax(Source, 1, Error) ||
            !Source.Contains(TEXT("atomicStoreMax")) || !Source.Contains(TEXT("Other: S;")) ||
            !Source.Contains(TEXT("struct S { data: array<atomic<u32>>, }")) ||
            Source.Contains(TEXT("atomicCompareExchangeWeak"))) return 1;
        FString Ordinary = TEXT("@compute @workgroup_size(1) fn main() {}");
        const FString Original = Ordinary;
        if (!UE::WebGPUShader::LowerNaniteAtomicMax(Ordinary, 0, Error) || Ordinary != Original) return 1;
    }
    struct FStage { EShaderFrequency Frequency; const TCHAR* Entry; const TCHAR* Name; };
    for (const FStage& Stage : {FStage{SF_Compute, TEXT("MainCS"), TEXT("compute")},
        FStage{SF_Vertex, TEXT("MainVS"), TEXT("vertex")}, FStage{SF_Pixel, TEXT("MainPS"), TEXT("fragment")},
        FStage{SF_Compute, TEXT("MainCS"), TEXT("consumer")}})
    {
        FShaderCompileJob Job;
        Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, 0);
        GlobalBeginCompileShader(TEXT("WebNaniteVisibilityProbe"), nullptr, Type, nullptr, 0,
            FString(Stage.Name) == TEXT("consumer") ? TEXT("/WebGPUProbe/Private/WebNaniteVisibilityReadProbe.usf") :
                TEXT("/WebGPUProbe/Private/WebNaniteVisibilityProbe.usf"), Stage.Entry,
            FShaderTarget(Stage.Frequency, Platform), Job.Input, false);
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
        const auto Bytes = Job.Output.ShaderCode.GetReadView().Left(Job.Output.ShaderCode.GetShaderCodeSize());
        if (!UE::WebGPUShader::Decode(Bytes, Payload, Error)) return 1;
        const FString Base = Directory / Stage.Name;
        if (!FFileHelper::SaveStringToFile(Payload.Wgsl, *(Base + TEXT(".wgsl"))) ||
            !FFileHelper::SaveStringToFile(Payload.MetadataJson, *(Base + TEXT(".json"))) ||
            !FFileHelper::SaveArrayToFile(Bytes, *(Base + TEXT(".webshader")))) return 1;
    }
    auto Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), true);
    Report->SetBoolField(TEXT("sharedTypeAndOrdinaryShaderPreserved"), true);
    Report->SetArrayField(TEXT("negativeCases"), Cases);
    FString Json;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json, *(Directory / TEXT("compiler-tests.json"))) ? 0 : 1;
}
