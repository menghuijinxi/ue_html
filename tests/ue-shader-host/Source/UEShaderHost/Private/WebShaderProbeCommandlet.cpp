#include "WebShaderProbeCommandlet.h"
#include "MaterialShaderProbe.h"
#include "WebShaderWorkerProbe.h"
#include "WebShaderPlatformProbe.h"
#include "WebGPUShaderCode.h"
#include "WebGPURHIProbe.h"
#include "WebBufferShaderProbe.h"
#include "Modules/ModuleManager.h"
#include "RenderUtils.h"
#include "HAL/IConsoleManager.h"

#include "Dom/JsonObject.h"
#include "GlobalShader.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/MemoryReader.h"
#include "ShaderCompiler.h"
#include "ShaderCompilerCommon.h"
#include "ShaderCompilerJobTypes.h"
#include "ShaderConductorContext.h"
#include "ShaderParameterParser.h"
#include "ShaderParameterMetadata.h"
#include "ShaderPreprocessTypes.h"
#include "SpirvReflectCommon.h"
#include "MeshMaterialShader.h"
#include "VertexFactory.h"
#include "VulkanShaderResources.h"

static TSharedRef<FJsonObject> ReflectMember(const SpvReflectBlockVariable &Member)
{
    TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetStringField(TEXT("name"), UTF8_TO_TCHAR(Member.name ? Member.name : ""));
    Json->SetNumberField(TEXT("offset"), Member.offset);
    Json->SetNumberField(TEXT("size"), Member.size);
    Json->SetNumberField(TEXT("paddedSize"), Member.padded_size);
    TArray<TSharedPtr<FJsonValue>> Members;
    for (uint32 Index = 0; Index < Member.member_count; ++Index)
    {
        Members.Add(MakeShared<FJsonValueObject>(ReflectMember(Member.members[Index])));
    }
    Json->SetArrayField(TEXT("members"), Members);
    return Json;
}

bool ExportSpirv(FShaderCompilerOutput &Output, const FString &Directory, const FString &Name,
                 const TSharedRef<FJsonObject> &Json)
{
    const TConstArrayView<uint8> CodeView = Output.ShaderCode.GetReadView();
    TArray<uint8> Code(CodeView.GetData(), Output.ShaderCode.GetShaderCodeSize());
    FMemoryReader Reader(Code, true);
    FVulkanShaderHeader Header;
    FShaderResourceTable ResourceTable;
    Reader << Header;
    Reader << ResourceTable;
    uint32 ByteSize = 0;
    Reader << ByteSize;
    if (Reader.IsError() || ByteSize % sizeof(uint32) != 0 || ByteSize > Code.Num() - Reader.Tell())
    {
        return false;
    }
    TArray<uint32> Spirv;
    Spirv.SetNumUninitialized(ByteSize / sizeof(uint32));
    Reader.Serialize(Spirv.GetData(), ByteSize);
    if (Reader.IsError() || Spirv.IsEmpty() || Spirv[0] != 0x07230203)
    {
        return false;
    }
    FFileHelper::SaveArrayToFile(MakeArrayView(reinterpret_cast<const uint8 *>(Spirv.GetData()), ByteSize),
                                 *(Directory / (Name + TEXT(".native.spv"))));
    Json->SetNumberField(TEXT("packedGlobalsSize"), Header.PackedGlobalsSize);
    Json->SetNumberField(TEXT("nativeSpirvBytes"), ByteSize);
    auto TableValues = [](const TArray<uint32> &Values) {
        TArray<TSharedPtr<FJsonValue>> JsonValues;
        for (uint32 Value : Values)
        {
            JsonValues.Add(MakeShared<FJsonValueNumber>(Value));
        }
        return JsonValues;
    };
    TSharedRef<FJsonObject> Table = MakeShared<FJsonObject>();
    Table->SetNumberField(TEXT("bits"), ResourceTable.ResourceTableBits);
    Table->SetArrayField(TEXT("textures"), TableValues(ResourceTable.TextureMap));
    Table->SetArrayField(TEXT("samplers"), TableValues(ResourceTable.SamplerMap));
    Table->SetArrayField(TEXT("srvs"), TableValues(ResourceTable.ShaderResourceViewMap));
    Table->SetArrayField(TEXT("uavs"), TableValues(ResourceTable.UnorderedAccessViewMap));
    Table->SetArrayField(TEXT("layoutHashes"), TableValues(ResourceTable.ResourceTableLayoutHashes));
    Json->SetObjectField(TEXT("resourceTable"), Table);
    spv_reflect::ShaderModule Reflection(ByteSize, Spirv.GetData());
    if (Reflection.GetResult() != SPV_REFLECT_RESULT_SUCCESS)
    {
        return false;
    }
    Json->SetStringField(TEXT("nativeEntry"), UTF8_TO_TCHAR(Reflection.GetEntryPointName()));
    uint32 BindingCount = 0;
    Reflection.EnumerateDescriptorBindings(&BindingCount, nullptr);
    TArray<SpvReflectDescriptorBinding *> Bindings;
    Bindings.SetNumUninitialized(BindingCount);
    Reflection.EnumerateDescriptorBindings(&BindingCount, Bindings.GetData());
    TArray<TSharedPtr<FJsonValue>> BindingJson;
    for (const SpvReflectDescriptorBinding *Binding : Bindings)
    {
        TSharedRef<FJsonObject> Item = ReflectMember(Binding->block);
        Item->SetStringField(TEXT("name"), UTF8_TO_TCHAR(Binding->name ? Binding->name : ""));
        Item->SetNumberField(TEXT("group"), Binding->set);
        Item->SetNumberField(TEXT("binding"), Binding->binding);
        Item->SetNumberField(TEXT("descriptorType"), Binding->descriptor_type);
        BindingJson.Add(MakeShared<FJsonValueObject>(Item));
    }
    Json->SetArrayField(TEXT("spirvBindings"), BindingJson);
    const ANSICHAR *Passes[] = {"--strip-reflect"};
    CrossCompiler::FShaderConductorContext Context;
    const bool Stripped = Context.OptimizeSpirv(Spirv, Passes, UE_ARRAY_COUNT(Passes));
    Json->SetBoolField(TEXT("reflectionStripped"), Stripped);
    Context.FlushErrors(Output.Errors);
    return Stripped && FFileHelper::SaveArrayToFile(MakeArrayView(reinterpret_cast<const uint8 *>(Spirv.GetData()),
                                                                  Spirv.Num() * sizeof(uint32)),
                                                    *(Directory / (Name + TEXT(".spv"))));
}

UWebShaderProbeCommandlet::UWebShaderProbeCommandlet()
{
    IsClient = false;
    IsServer = false;
    IsEditor = true;
    LogToConsole = true;
}

int32 UWebShaderProbeCommandlet::Main(const FString &Params)
{
    if (FParse::Param(*Params, TEXT("MaterialPolicyProbe")))
    {
        FString OutputFile;
        if (!FParse::Value(*Params, TEXT("Output="), OutputFile))
            return 1;
        const EShaderPlatform Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_ES31"));
        if (Platform == SP_NumPlatforms)
            return 1;
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetNumberField(TEXT("platform"), uint32(Platform));
        Json->SetBoolField(TEXT("mobile"), IsMobilePlatform(Platform));
        Json->SetBoolField(TEXT("dbuffer"), IsUsingDBuffers(Platform));
        Json->SetBoolField(TEXT("substrateBlendable"), Substrate::IsSubstrateBlendableGBufferEnabled(Platform));
        Json->SetBoolField(TEXT("mobileDeferred"), IsMobileDeferredShadingEnabled(Platform));
        Json->SetBoolField(TEXT("fullDepthPrepass"), MobileUsesFullDepthPrepass(Platform));
        for (const auto& Setting : {
            TPair<const TCHAR*, const TCHAR*>(TEXT("dbufferSetting"), TEXT("r.DBuffer")),
            TPair<const TCHAR*, const TCHAR*>(TEXT("mobileDBufferSetting"), TEXT("r.Mobile.DBuffer")),
            TPair<const TCHAR*, const TCHAR*>(TEXT("substrateSetting"), TEXT("r.Substrate"))})
        {
            const IConsoleVariable* Variable = IConsoleManager::Get().FindConsoleVariable(Setting.Value);
            Json->SetNumberField(Setting.Key, Variable ? Variable->GetInt() : -1);
        }
        int32 WebSettings = 0;
        for (ITargetPlatformSettings* Settings : GetTargetPlatformManagerRef().GetTargetPlatformSettings())
            WebSettings += Settings->IniPlatformName() == TEXT("Web") ? 1 : 0;
        Json->SetNumberField(TEXT("registeredWebSettings"), WebSettings);
        FString Text;
        FJsonSerializer::Serialize(Json, TJsonWriterFactory<>::Create(&Text));
        return FFileHelper::SaveStringToFile(Text, *OutputFile,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) ? 0 : 1;
    }
    if (FParse::Param(*Params, TEXT("VertexFactoryPolicyProbe")))
    {
        FString OutputFile;
        if (!FParse::Value(*Params, TEXT("Output="), OutputFile))
            return 1;
        FString CookTarget;
        const bool WebCook = FParse::Param(FCommandLine::Get(), TEXT("WebGPUCook")) &&
            FParse::Value(FCommandLine::Get(), TEXT("TargetPlatform="), CookTarget) && CookTarget == TEXT("Web");
        const EShaderPlatform Platform = WebCook ? static_cast<EShaderPlatform>(46) : SP_PCD3D_SM5;
        const FShaderType* Shader = FindShaderTypeByName(FHashedName(TEXT("TMobileBasePassVSFNoLightMapPolicy")));
        FConservativeShaderParameters Material;
        Material.bIsSpecialEngineMaterial = true;
        Material.bIsUsedWithSkeletalMesh = true;
        Material.bIsUsedWithStaticMesh = true;
        TArray<TSharedPtr<FJsonValue>> Cases;
        bool Pass = Shader != nullptr;
        for (const TCHAR* Name : {TEXT("FLocalVertexFactory"),
            TEXT("TGPUSkinVertexFactoryDefault"), TEXT("TGPUSkinVertexFactoryUnlimited"),
            TEXT("TGPUSkinAPEXClothVertexFactoryDefault"), TEXT("TGPUSkinAPEXClothVertexFactoryUnlimited"),
            TEXT("FParticleSpriteVertexFactory"), TEXT("FGPUSpriteVertexFactory"), TEXT("FLandscapeVertexFactory")})
        {
            const FVertexFactoryType* Type = FindVertexFactoryType(FHashedName(Name));
            const bool Allowed = Type && Shader &&
                Type->ShouldCache(FVertexFactoryShaderPermutationParameters(
                    Platform, Material, Type, Shader, EShaderPermutationFlags::None));
            const bool Expected = !WebCook || FCString::Strcmp(Name, TEXT("FLocalVertexFactory")) == 0;
            TSharedRef<FJsonObject> Case = MakeShared<FJsonObject>();
            Case->SetStringField(TEXT("factory"), Name);
            Case->SetBoolField(TEXT("found"), Type != nullptr);
            Case->SetBoolField(TEXT("allowed"), Allowed);
            Case->SetBoolField(TEXT("expected"), Expected);
            Cases.Add(MakeShared<FJsonValueObject>(Case));
            Pass &= Type != nullptr && Allowed == Expected;
        }
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetBoolField(TEXT("pass"), Pass);
        Json->SetBoolField(TEXT("webCook"), WebCook);
        Json->SetArrayField(TEXT("cases"), Cases);
        FString Text;
        FJsonSerializer::Serialize(Json, TJsonWriterFactory<>::Create(&Text));
        return FFileHelper::SaveStringToFile(Text, *OutputFile,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) && Pass ? 0 : 1;
    }
    if (FParse::Param(*Params, TEXT("BindingContractProbe")))
    {
        FString InputFile, ReflectionFile, OutputFile, InputText, ReflectionText;
        TSharedPtr<FJsonObject> Input, Reflection;
        if (!FParse::Value(*Params, TEXT("Input="), InputFile) ||
            !FParse::Value(*Params, TEXT("Reflection="), ReflectionFile) ||
            !FParse::Value(*Params, TEXT("Output="), OutputFile) ||
            !FFileHelper::LoadFileToString(InputText, *InputFile) ||
            !FFileHelper::LoadFileToString(ReflectionText, *ReflectionFile) ||
            !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(InputText), Input) ||
            !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ReflectionText), Reflection))
            return 1;
        FString Error;
        const bool Valid = UE::WebGPUShader::ValidateBindings(
            Input->GetObjectField(TEXT("metadata")).ToSharedRef(), Reflection, Error);
        TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetBoolField(TEXT("accepted"), Valid);
        Result->SetStringField(TEXT("error"), Error);
        FString Text;
        FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Text));
        return FFileHelper::SaveStringToFile(Text, *OutputFile,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) ? 0 : 1;
    }
    if (FParse::Param(*Params, TEXT("ShaderParameterMetadataProbe")))
    {
        FString OutputDirectory;
        if (!FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        const FShaderType* Type = FindShaderTypeByName(FHashedName(TEXT("FGenerateConservativeDepthBufferCS")));
        const FShaderParametersMetadata* Metadata = Type ? Type->GetRootParametersMetadata() : nullptr;
        if (!Metadata)
            return 1;
        TFunction<TArray<TSharedPtr<FJsonValue>>(const FShaderParametersMetadata&)> Members;
        Members = [&Members](const FShaderParametersMetadata& Struct) {
            TArray<TSharedPtr<FJsonValue>> Result;
            for (const FShaderParametersMetadata::FMember& Member : Struct.GetMembers())
            {
                TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
                Item->SetStringField(TEXT("name"), Member.GetName());
                Item->SetStringField(TEXT("shaderType"), Member.GetShaderType());
                Item->SetNumberField(TEXT("offset"), Member.GetOffset());
                Item->SetNumberField(TEXT("baseType"), Member.GetBaseType());
                Item->SetNumberField(TEXT("rows"), Member.GetNumRows());
                Item->SetNumberField(TEXT("columns"), Member.GetNumColumns());
                if (Member.GetStructMetadata())
                {
                    Item->SetStringField(TEXT("struct"), Member.GetStructMetadata()->GetStructTypeName());
                    if (Member.GetBaseType() == UBMT_INCLUDED_STRUCT || Member.GetBaseType() == UBMT_NESTED_STRUCT)
                        Item->SetArrayField(TEXT("members"), Members(*Member.GetStructMetadata()));
                }
                Result.Add(MakeShared<FJsonValueObject>(Item));
            }
            return Result;
        };
        TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("shader"), Type->GetName());
        Json->SetStringField(TEXT("source"), Type->GetShaderFilename());
        Json->SetStringField(TEXT("struct"), Metadata->GetStructTypeName());
        Json->SetNumberField(TEXT("size"), Metadata->GetSize());
        Json->SetNumberField(TEXT("layoutHash"), Metadata->GetLayoutHash());
        Json->SetArrayField(TEXT("members"), Members(*Metadata));
        FString Text;
        FJsonSerializer::Serialize(Json, TJsonWriterFactory<>::Create(&Text));
        IFileManager::Get().MakeDirectory(*OutputDirectory, true);
        return FFileHelper::SaveStringToFile(Text, *(OutputDirectory / TEXT("shader-parameter-metadata.json")),
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) ? 0 : 1;
    }
    if (FParse::Param(*Params, TEXT("WebBufferShaderProbe")) || FParse::Param(*Params, TEXT("WebTextureShaderProbe")) ||
        FParse::Param(*Params, TEXT("WebTextureUintShaderProbe")))
        return RunWebBufferShaderProbe(Params);
    if (FParse::Param(*Params, TEXT("WebTextureUintProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunTextureUintProbe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebTexture3DProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunTexture3DProbe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebBufferLockProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunBufferLockProbe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebFloat4Probe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunFloat4Probe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebStructuredProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunStructuredProbe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebUint4Probe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunUint4Probe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebBufferUAVProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunBufferUAVProbe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebBufferSRVProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunBufferSRVProbe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebTextureSRVProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunTextureSRVProbe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebViewportRHIProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        auto &Module = FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"));
        return Module.RunViewportProbe(ShaderDirectory, OutputDirectory) ? 0 : 1;
    }
    if (FParse::Param(*Params, TEXT("WebGlobalRHIProbe")))
    {
        FString ShaderDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunGlobalProbe(ShaderDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("WebRHIProbe")))
    {
        FString ShaderDirectory, MaterialDirectory, OutputDirectory;
        if (!FParse::Value(*Params, TEXT("WebShaderDirectory="), ShaderDirectory) ||
            !FParse::Value(*Params, TEXT("WebMaterialShaderDirectory="), MaterialDirectory) ||
            !FParse::Value(*Params, TEXT("Output="), OutputDirectory))
            return 1;
        return FModuleManager::LoadModuleChecked<IWebGPURHIProbeModule>(TEXT("WebGPURHI"))
                       .RunProbe(ShaderDirectory, MaterialDirectory, OutputDirectory)
                   ? 0
                   : 1;
    }
    if (FParse::Param(*Params, TEXT("MaterialProbe")))
    {
        return RunMaterialShaderProbe(Params);
    }
    FString OutputDirectory;
    if (!FParse::Value(*Params, TEXT("Output="), OutputDirectory))
    {
        UE_LOG(LogTemp, Error, TEXT("Output directory is required"));
        return 1;
    }
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    const EShaderPlatform Platform = ResolveProbeShaderPlatform(Params, OutputDirectory, false, SP_VULKAN_SM5);
    if (Platform == SP_NumPlatforms)
        return 1;
    const FName FormatName(TEXT("SF_VULKAN_SM5"));
    const IShaderFormat *Format = GetTargetPlatformManagerRef().FindShaderFormat(FormatName);
    if (!Format)
    {
        UE_LOG(LogTemp, Error, TEXT("Vulkan shader format is unavailable"));
        return 1;
    }
    TArray<TSharedPtr<FJsonValue>> Cases;
    int32 Failures = 0;
    FWebShaderWorkerProbe WorkerProbe(Params, OutputDirectory, UE::WebGPUShader::SM5Format);
    for (int32 Mode = 0; Mode < 2; ++Mode)
    {
        for (TLinkedList<FShaderType *>::TIterator Iterator(FShaderType::GetTypeList()); Iterator; ++Iterator)
        {
            const FShaderType *Type = *Iterator;
            const FGlobalShaderType *GlobalType = Type->GetGlobalShaderType();
            if (!GlobalType)
            {
                continue;
            }
            const FString Filename(Type->GetShaderFilename());
            if (!Filename.EndsWith(TEXT("/ScreenVertexShader.usf")) &&
                !Filename.EndsWith(TEXT("/ScreenPixelShader.usf")) &&
                !Filename.EndsWith(TEXT("/ClearReplacementShaders.usf")))
            {
                continue;
            }
            if (!GlobalType->ShouldCompilePermutation(Platform, 0, EShaderPermutationFlags::HasEditorOnlyData))
            {
                continue;
            }
            const FString OriginalName = FString(Type->GetName())
                                             .Replace(TEXT("<"), TEXT("_"))
                                             .Replace(TEXT(">"), TEXT("_"))
                                             .Replace(TEXT(","), TEXT("_"));
            const bool TypedClear = OriginalName.StartsWith(TEXT("FClearReplacementCS_")) &&
                                    OriginalName.Contains(TEXT("Buffer_")) &&
                                    !OriginalName.Contains(TEXT("StructuredBuffer_"));
            if (Mode == 1 && !TypedClear)
            {
                continue;
            }
            FShaderCompileJob Job;
            Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, 0);
            GlobalType->SetupCompileEnvironment(Platform, 0, EShaderPermutationFlags::HasEditorOnlyData,
                                                Job.Input.Environment);
            GlobalBeginCompileShader(TEXT("WebShaderProbe"), nullptr, Type, nullptr, 0, Type->GetShaderFilename(),
                                     Type->GetFunctionName(), FShaderTarget(Type->GetFrequency(), Platform), Job.Input,
                                     false);
            if (Mode == 1)
            {
                Job.Input.Environment.SetDefine(TEXT("RESOURCE_TYPE"), 4);
                Job.Input.Environment.SetDefine(TEXT("THREADGROUPSIZE_X"), 64);
            }
            Job.Input.ExtraSettings.bExtractShaderSource = true;
            Job.Input.ShaderFormat = FormatName;
            Format->ModifyShaderCompilerInput(Job.Input);
            const bool Preprocessed = Format->PreprocessShader(Job.Input, Job.Input.Environment, Job.PreprocessOutput);
            const FString Name = Mode == 1 ? TEXT("WebFallback_") + OriginalName : OriginalName;
            const TSharedRef<FJsonObject> Case = MakeShared<FJsonObject>();
            Case->SetStringField(TEXT("name"), Name);
            if (Mode == 1)
            {
                Case->SetStringField(TEXT("fallbackOf"), OriginalName);
                Case->SetStringField(TEXT("adaptation"),
                                     TEXT("Clear shader only: RESOURCE_TYPE=4, THREADGROUPSIZE_X=64; dispatch must use "
                                          "compiled workgroup metadata"));
            }
            Case->SetStringField(TEXT("source"), Filename);
            Case->SetStringField(TEXT("entry"), Type->GetFunctionName());
            Case->SetNumberField(TEXT("frequency"), Type->GetFrequency());
            Case->SetBoolField(TEXT("preprocessed"), Preprocessed);
            TArray<FString> Includes;
            GetShaderIncludes(Type->GetShaderFilename(), Type->GetShaderFilename(), Includes, Platform);
            Includes.AddUnique(Filename);
            TArray<TSharedPtr<FJsonValue>> IncludeJson;
            for (const FString &Include : Includes)
            {
                IncludeJson.Add(MakeShared<FJsonValueString>(Include));
            }
            Case->SetArrayField(TEXT("includeFiles"), IncludeJson);
            if (Preprocessed)
            {
                FFileHelper::SaveStringToFile(FString(Job.PreprocessOutput.GetUnstrippedSourceView()),
                                              *(OutputDirectory / (Name + TEXT(".preprocessed.hlsl"))),
                                              FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
                Format->CompilePreprocessedShader(Job.Input, Job.PreprocessOutput, Job.Output);
                Case->SetBoolField(TEXT("nativeCompiled"), Job.Output.bSucceeded);
                Case->SetBoolField(TEXT("spirvExported"),
                                   Job.Output.bSucceeded && ExportSpirv(Job.Output, OutputDirectory, Name, Case));
                TArray<FString> ParameterNames;
                Job.Output.ParameterMap.GetAllParameterNames(ParameterNames);
                Case->SetNumberField(TEXT("parameterCount"), ParameterNames.Num());
                const FString Source = Job.Output.ModifiedShaderSource;
                Case->SetBoolField(TEXT("extractedCompilerSource"), !Source.IsEmpty());
                FFileHelper::SaveStringToFile(Source, *(OutputDirectory / (Name + TEXT(".compiler-output.txt"))),
                                              FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
                TArray<TSharedPtr<FJsonValue>> Parameters;
                for (const FString &Parameter : ParameterNames)
                {
                    uint16 BufferIndex = 0, BaseIndex = 0, Size = 0;
                    Job.Output.ParameterMap.FindParameterAllocation(*Parameter, BufferIndex, BaseIndex, Size);
                    TSharedRef<FJsonObject> Binding = MakeShared<FJsonObject>();
                    Binding->SetStringField(TEXT("name"), Parameter);
                    Binding->SetNumberField(TEXT("bufferIndex"), BufferIndex);
                    Binding->SetNumberField(TEXT("baseIndex"), BaseIndex);
                    Binding->SetNumberField(TEXT("size"), Size);
                    Binding->SetNumberField(
                        TEXT("type"),
                        static_cast<uint8>(Job.Output.ParameterMap.GetParameterMap().FindChecked(Parameter).Type));
                    Parameters.Add(MakeShared<FJsonValueObject>(Binding));
                }
                Case->SetArrayField(TEXT("ueParameterMap"), Parameters);
            }
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const FShaderCompilerError &Error : Job.PreprocessOutput.GetErrors())
            {
                Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            }
            for (const FShaderCompilerError &Error : Job.Output.Errors)
            {
                Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            }
            Case->SetArrayField(TEXT("errors"), Errors);
            const bool Succeeded = Preprocessed && Job.Output.bSucceeded && Case->GetBoolField(TEXT("spirvExported"));
            Failures += Succeeded ? 0 : 1;
            UE_LOG(LogTemp, Display, TEXT("P1_SHADER %s preprocess=%d native=%d"), *Name, Preprocessed,
                   Job.Output.bSucceeded);
            Cases.Add(MakeShared<FJsonValueObject>(Case));
            WorkerProbe.Add(Name, Job.Input, Job.Output.ParameterMap, Job.PreprocessOutput);
        }
    }
    TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("hostEngine"), FEngineVersion::Current().ToString());
    Report->SetStringField(TEXT("format"), FormatName.ToString());
    Report->SetStringField(TEXT("shaderPlatform"), FDataDrivenShaderPlatformInfo::GetName(Platform).ToString());
    Report->SetNumberField(TEXT("shaderPlatformEnum"), Platform);
    Report->SetArrayField(TEXT("cases"), Cases);
    Report->SetBoolField(TEXT("pass"), Cases.Num() > 0 && Failures == 0);
    FString Json;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    FFileHelper::SaveStringToFile(Json, *(OutputDirectory / TEXT("ue-host-results.json")),
                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return WorkerProbe.Run() && Cases.Num() > 0 && Failures == 0 ? 0 : 1;
}
