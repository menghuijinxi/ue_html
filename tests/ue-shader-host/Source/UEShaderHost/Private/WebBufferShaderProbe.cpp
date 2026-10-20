#include "WebBufferShaderProbe.h"
#include "WebShaderPlatformProbe.h"
#include "WebShaderWorkerProbe.h"
#include "WebGPUShaderCode.h"

#include "Dom/JsonObject.h"
#include "GlobalShader.h"
#include "HAL/FileManager.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "ShaderPreprocessTypes.h"

bool ExportSpirv(FShaderCompilerOutput &, const FString &, const FString &, const TSharedRef<FJsonObject> &);

int32 RunWebBufferShaderProbe(const FString &Params)
{
    const bool Volume = FParse::Param(*Params, TEXT("WebTextureShaderProbe"));
    const bool IntegerVolume = FParse::Param(*Params, TEXT("WebTextureUintShaderProbe"));
    FString Directory;
    if (!FParse::Value(*Params, TEXT("Output="), Directory))
        return 1;
    IFileManager::Get().MakeDirectory(*Directory, true);
    const auto Platform = ResolveProbeShaderPlatform(Params, Directory, false, SP_VULKAN_SM5);
    if (Platform == SP_NumPlatforms)
        return 1;
    const auto *NativeFormat = GetTargetPlatformManagerRef().FindShaderFormat(FName(TEXT("SF_VULKAN_SM5")));
    check(NativeFormat);
    FWebShaderWorkerProbe Worker(Params, Directory, UE::WebGPUShader::SM5Format);
    TArray<TSharedPtr<FJsonValue>> Cases;
    bool Pass = true;
    AddShaderSourceDirectoryMapping(TEXT("/WebGPUProbe"),
                                    FPaths::ConvertRelativePathToFull(FPaths::ProjectDir() / TEXT("Shaders")));
    for (TLinkedList<FShaderType *>::TIterator It(FShaderType::GetTypeList()); It; ++It)
    {
        const FShaderType *Type = *It;
        const FString TypeName(Type->GetName());
        if (TypeName != TEXT("FMemcpyCS") && TypeName != TEXT("FMemsetBufferCS"))
            continue;
        auto *GlobalType = Type->GetGlobalShaderType();
        check(GlobalType);
        for (int32 ElementSize : {0, 2, 4})
        {
            if ((Volume || IntegerVolume) && ElementSize != 4)
                continue;
            const bool Float4 = ElementSize == 4;
            const TCHAR *Source = IntegerVolume ? TEXT("/WebGPUProbe/Private/WebTextureUintProbe.usf")
                                  : Volume      ? TEXT("/WebGPUProbe/Private/WebTexture3DProbe.usf")
                                  : Float4      ? TEXT("/WebGPUProbe/Private/WebFloat4Probe.usf")
                                                : Type->GetShaderFilename();
            const TCHAR *Entry = IntegerVolume ? (TypeName == TEXT("FMemcpyCS") ? TEXT("LoadCS") : TEXT("InspectCS"))
                                 : Volume      ? (TypeName == TEXT("FMemcpyCS") ? TEXT("LoadCS") : TEXT("SampleCS"))
                                 : Float4      ? (TypeName == TEXT("FMemcpyCS") ? TEXT("TransformCS") : TEXT("FillCS"))
                                               : Type->GetFunctionName();
            FShaderCompileJob Job;
            Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, 0);
            GlobalType->SetupCompileEnvironment(Platform, 0, EShaderPermutationFlags::HasEditorOnlyData,
                                                Job.Input.Environment);
            // Reuse the registered compute compile environment for the probe's own source and entry.
            GlobalBeginCompileShader(TEXT("WebBufferShaderProbe"), nullptr, Type, nullptr, 0, Source, Entry,
                                     FShaderTarget(SF_Compute, Platform), Job.Input, false);
            Job.Input.Environment.SetDefine(TEXT("RESOURCE_TYPE"), 1);
            Job.Input.Environment.SetDefine(TEXT("STRUCTURED_ELEMENT_SIZE"), ElementSize);
            Job.Input.ShaderFormat = FName(TEXT("SF_VULKAN_SM5"));
            Job.Input.ExtraSettings.bExtractShaderSource = true;
            NativeFormat->ModifyShaderCompilerInput(Job.Input);
            const bool Preprocessed =
                NativeFormat->PreprocessShader(Job.Input, Job.Input.Environment, Job.PreprocessOutput);
            const FString Name = IntegerVolume ? FString(TEXT("WebTextureUint_")) + Entry
                                 : Volume      ? FString(TEXT("WebTexture3D_")) + Entry
                                 : Float4
                                     ? FString(TEXT("WebFloat4_")) + Entry
                                     : FString(ElementSize == 0 ? TEXT("WebR32Uint_") : TEXT("WebR32Uint4_")) +
                                           (TypeName == TEXT("FMemcpyCS") ? TEXT("MemcpyCS") : TEXT("MemsetBufferCS"));
            auto Case = MakeShared<FJsonObject>();
            Case->SetStringField(TEXT("name"), Name);
            Case->SetStringField(TEXT("source"), Source);
            Case->SetStringField(TEXT("entry"), Entry);
            Case->SetBoolField(TEXT("probeOnlySource"), Float4);
            Case->SetStringField(
                TEXT("adaptation"),
                IntegerVolume
                    ? TEXT("Probe-only Texture3D<uint4> Load/GetDimensions and guarded uint4 storage readback.")
                : Volume ? TEXT("Probe-only Texture3D<float4> Load/SampleLevel and uint4 storage readback.")
                : Float4
                    ? TEXT("Probe-only StructuredBuffer<float4>/RWStructuredBuffer<float4> arithmetic and fill. "
                           "Typed RHI views use an explicit float4 storage representation; no Buffer<T> lowering.")
                    : FString::Printf(
                          TEXT("Existing ByteBuffer.usf storage branch: RESOURCE_TYPE=1, STRUCTURED_ELEMENT_SIZE=%d. "
                               "RHI Typed uint32/uint4 views bind reflected storage arrays with matching access. "
                               "Unchanged Buffer<T> texel-buffer shaders are not lowered by this test."),
                          ElementSize));
            Case->SetNumberField(TEXT("elementFormat"), (Volume || IntegerVolume) ? PF_R32G32B32A32_UINT
                                                        : Float4                  ? PF_A32B32G32R32F
                                                        : ElementSize == 0        ? PF_R32_UINT
                                                                                  : PF_R32G32B32A32_UINT);
            TArray<FString> Includes;
            GetShaderIncludes(Source, Source, Includes, Platform);
            Includes.AddUnique(Source);
            TArray<TSharedPtr<FJsonValue>> IncludeJSON;
            for (const auto &Include : Includes)
                IncludeJSON.Add(MakeShared<FJsonValueString>(Include));
            Case->SetArrayField(TEXT("includeFiles"), IncludeJSON);
            Case->SetBoolField(TEXT("preprocessed"), Preprocessed);
            if (Preprocessed)
            {
                FFileHelper::SaveStringToFile(FString(Job.PreprocessOutput.GetUnstrippedSourceView()),
                                              *(Directory / (Name + TEXT(".preprocessed.hlsl"))),
                                              FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
                NativeFormat->CompilePreprocessedShader(Job.Input, Job.PreprocessOutput, Job.Output);
            }
            const bool Compiled =
                Preprocessed && Job.Output.bSucceeded && ExportSpirv(Job.Output, Directory, Name, Case);
            Case->SetBoolField(TEXT("nativeCompiled"), Compiled);
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const auto &Error : Job.Output.Errors)
                Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            Case->SetArrayField(TEXT("errors"), Errors);
            Pass &= Compiled && Worker.Add(Name, Job.Input, Job.Output.ParameterMap, Job.PreprocessOutput);
            Case->SetBoolField(TEXT("pass"), Pass);
            Cases.Add(MakeShared<FJsonValueObject>(Case));
            UE_LOG(LogTemp, Display, TEXT("P2_BUFFER_SHADER %s compiled=%d"), *Name, Compiled);
        }
    }
    Pass &= Cases.Num() == (Volume || IntegerVolume ? 2 : 6) && Worker.Run();
    auto Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), Pass);
    Report->SetArrayField(TEXT("cases"), Cases);
    FString JSON;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
    FFileHelper::SaveStringToFile(JSON,
                                  *(Directory / (IntegerVolume ? TEXT("texture-uint-shader-results.json")
                                                 : Volume      ? TEXT("texture-shader-results.json")
                                                               : TEXT("buffer-shader-results.json"))),
                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return Pass ? 0 : 1;
}
