#include "GlobalShader.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "RenderUtils.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "ShaderCompilerJobTypes.h"
#include "ShaderPreprocessTypes.h"
#include "WebGPUShaderCode.h"

int32 RunWebLumenShaderProbe(const FString& Params)
{
    FString OutputDirectory, Names;
    if (!FParse::Value(*Params, TEXT("Output="), OutputDirectory))
        return 1;
    FParse::Value(*Params, TEXT("ShaderTypes="), Names, false);
    TArray<FString> Requested;
    Names.ParseIntoArray(Requested, TEXT(","), true);
    int32 SelectedPermutation = INDEX_NONE;
    const bool SelectPermutation = FParse::Value(*Params, TEXT("Permutation="), SelectedPermutation);
    if (SelectPermutation && (SelectedPermutation < 0 || Requested.IsEmpty() ||
        FParse::Param(*Params, TEXT("AllPermutations"))))
        return 1;
    const EShaderPlatform Platform =
        FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
    const IShaderFormat* Format =
        GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    if (Platform == SP_NumPlatforms || !Format || !DoesPlatformSupportLumenGI(Platform))
        return 1;
    TArray<TSharedPtr<FJsonValue>> Cases;
    TArray<FString> Found;
    bool Pass = true;
    const bool AllPermutations = FParse::Param(*Params, TEXT("AllPermutations"));
    for (TLinkedList<FShaderType*>::TIterator It(FShaderType::GetTypeList()); It; ++It)
    {
        const FShaderType* Type = *It;
        const FGlobalShaderType* Global = Type->GetGlobalShaderType();
        const FString Source(Type->GetShaderFilename());
        if (!Global || (!Source.StartsWith(TEXT("/Engine/Private/Lumen/")) &&
            !Source.StartsWith(TEXT("/Engine/Private/StochasticLighting/"))) ||
            (!Requested.IsEmpty() && !Requested.Contains(Type->GetName())))
            continue;
        Found.Add(Type->GetName());
        if (SelectPermutation && SelectedPermutation >= Type->GetPermutationCount())
        {
            Pass = false;
            continue;
        }
        for (int32 Permutation = SelectPermutation ? SelectedPermutation : 0;
            Permutation < (SelectPermutation ? SelectedPermutation + 1 : Type->GetPermutationCount()); ++Permutation)
        {
            if (!Global->ShouldCompilePermutation(Platform, Permutation, EShaderPermutationFlags::None))
            {
                if (SelectPermutation) Pass = false;
                continue;
            }
            FShaderCompileJob Job;
            Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, Permutation);
            Global->SetupCompileEnvironment(Platform, Permutation, EShaderPermutationFlags::None, Job.Input.Environment);
            GlobalBeginCompileShader(TEXT("WebLumenShaderProbe"), nullptr, Type, nullptr, Permutation,
                Type->GetShaderFilename(), Type->GetFunctionName(), FShaderTarget(Type->GetFrequency(), Platform),
                Job.Input, false);
            Job.Input.ShaderFormat = UE::WebGPUShader::SM5Format;
            Format->ModifyShaderCompilerInput(Job.Input);
            const bool Preprocessed = Format->PreprocessShader(Job.Input, Job.Input.Environment, Job.PreprocessOutput);
            if (Preprocessed)
                Format->CompilePreprocessedShader(Job.Input, Job.PreprocessOutput, Job.Output);
            const bool Succeeded = Preprocessed && Job.Output.bSucceeded;
            TSharedRef<FJsonObject> Case = MakeShared<FJsonObject>();
            Case->SetStringField(TEXT("shaderType"), Type->GetName());
            Case->SetStringField(TEXT("shaderFile"), Type->GetShaderFilename());
            Case->SetNumberField(TEXT("permutation"), Permutation);
            Case->SetBoolField(TEXT("pass"), Succeeded);
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const FShaderCompilerError& Error : Job.PreprocessOutput.EditErrors())
                Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            for (const FShaderCompilerError& Error : Job.Output.Errors)
                Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            Case->SetArrayField(TEXT("errors"), Errors);
            Cases.Add(MakeShared<FJsonValueObject>(Case));
            Pass &= Succeeded;
            UE_LOG(LogTemp, Display, TEXT("WEB_LUMEN_SHADER %s permutation=%d pass=%d"),
                Type->GetName(), Permutation, Succeeded);
            if (!AllPermutations)
                break;
        }
    }
    for (const FString& Name : Requested)
        Pass &= Found.Contains(Name);
    Pass &= !Cases.IsEmpty();
    TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), Pass);
    Report->SetBoolField(TEXT("allPermutations"), AllPermutations);
    if (SelectPermutation) Report->SetNumberField(TEXT("selectedPermutation"), SelectedPermutation);
    Report->SetBoolField(TEXT("completeLumenScene"), false);
    Report->SetArrayField(TEXT("cases"), Cases);
    FString Json;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    const bool Saved = FFileHelper::SaveStringToFile(Json, *(OutputDirectory / TEXT("lumen-shader-results.json")),
        FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return Saved && Pass ? 0 : 1;
}
