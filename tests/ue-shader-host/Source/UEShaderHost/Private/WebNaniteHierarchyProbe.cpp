#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Interfaces/ITargetPlatform.h"
#include "Misc/FileHelper.h"
#include "Serialization/ArchiveSavePackageDataBuffer.h"
#include "Serialization/MemoryWriter.h"
#include "ShaderCompiler.h"
#include "ShaderPreprocessTypes.h"
#include "WebGPUShaderCode.h"

#define WEB_NANITE_HIERARCHY_SHADER_ONLY 1
#include "../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebHierarchy.cpp"

int32 RunWebNaniteHierarchyProbe(const FString& Params)
{
    FString Directory;
    if (!FParse::Value(*Params, TEXT("Output="), Directory)) return 1;
    IFileManager::Get().MakeDirectory(*Directory, true);
    const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
    const auto* Format = GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    const auto* Target = GetTargetPlatformManagerRef().FindTargetPlatform(TEXT("Web"));
    auto* Type = &Nanite::FWebNaniteHierarchyCull_CS::GetStaticType();
    if (!Format || !Target || Platform == SP_NumPlatforms || !Type->ShouldCompilePermutation(Platform, 0, EShaderPermutationFlags::HasEditorOnlyData)) return 1;
    FShaderCompileJob Job;
    Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, 0);
    GlobalBeginCompileShader(TEXT("WebNaniteHierarchyProbe"), nullptr, Type, nullptr, 0,
        TEXT("/Engine/Private/Nanite/WebNaniteHierarchy.usf"), TEXT("MainCS"), FShaderTarget(SF_Compute, Platform), Job.Input, false);
    Job.Input.ShaderFormat = UE::WebGPUShader::SM5Format;
    Type->SetupCompileEnvironment(Platform, 0, EShaderPermutationFlags::HasEditorOnlyData, Job.Input.Environment);
    Format->ModifyShaderCompilerInput(Job.Input);
    if (!Format->PreprocessShader(Job.Input, Job.Input.Environment, Job.PreprocessOutput)) return 1;
    Format->CompilePreprocessedShader(Job.Input, Job.PreprocessOutput, Job.Output);
    for (const auto& Error : Job.Output.Errors) UE_LOG(LogTemp, Display, TEXT("%s"), *Error.StrippedErrorMessage);
    if (!Job.Output.bSucceeded) return 1;
    Job.Output.GenerateOutputHash();
    FGlobalShaderMap Map(Platform);
    Map.FindOrAddSection(Type)->GetResourceCode()->AddShaderCompilerOutput(Job.Output, Job.Key);
    Map.FindOrAddShader(Type, 0, Type->ConstructCompiled(FGlobalShaderType::CompiledShaderInitializerType(
        Type, nullptr, 0, Job.Output, 0, nullptr, nullptr)));
    Job.Output.ParameterMap.VerifyBindingsAreComplete(Type->GetName(), Job.Output.Target, nullptr);
    Map.FindOrAddSection(Type)->FinalizeContent();
    TArray<uint8> Archive;
    FArchiveSavePackageDataBuffer CookContext(Target);
    FMemoryWriter Writer(Archive, true); Writer.SetSavePackageData(&CookContext); Writer.SetFilterEditorOnly(true);
    Map.SaveToGlobalArchive(Writer);
    return FFileHelper::SaveArrayToFile(Archive, *(Directory / TEXT("hierarchy-global-shaders.bin"))) ? 0 : 1;
}
