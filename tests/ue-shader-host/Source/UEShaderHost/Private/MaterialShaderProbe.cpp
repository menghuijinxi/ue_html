#include "MaterialShaderProbe.h"
#include "WebShaderWorkerProbe.h"
#include "WebShaderPlatformProbe.h"
#include "WebGPUShaderCode.h"

#include "Dom/JsonObject.h"
#include "Engine/Texture2D.h"
#include "DynamicRHI.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "MaterialShared.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionTextureSampleParameter2D.h"
#include "Materials/MaterialParameters.h"
#include "Materials/MaterialRenderProxy.h"
#include "MeshMaterialShaderType.h"
#include "MeshMaterialShader.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "RenderingThread.h"
#include "ShaderCompiler.h"
#include "ShaderCompilerJobTypes.h"
#include "ShaderPreprocessTypes.h"
#include "ShaderParameterMetadata.h"
#include "VertexFactory.h"

class FProbeMaterialResource final : public FMaterialResource
{
  public:
    virtual bool ShouldCache(const FShaderType *Type, const FVertexFactoryType *Factory) const override
    {
        return Factory && FString(Factory->GetName()) == TEXT("FLocalVertexFactory") &&
               FString(Type->GetName()).Contains(TEXT("MobileBasePass")) &&
               FString(Type->GetName()).Contains(TEXT("FNoLightMapPolicy"));
    }
    FMaterialShaderMap *GetProbeShaderMap() const
    {
        return FMaterialShaderMap::FindCompilingShaderMap(GetGameThreadCompilingShaderMapId());
    }
};

class FProbeParameterProxy final : public FMaterialRenderProxy
{
  public:
    FProbeParameterProxy(const FMaterial *InMaterial)
        : FMaterialRenderProxy(TEXT("WebProbeOverride")), Material(InMaterial)
    {
    }
    virtual const FMaterial *GetMaterialNoFallback(ERHIFeatureLevel::Type) const override
    {
        return Material;
    }
    virtual const FMaterialRenderProxy *GetFallback(ERHIFeatureLevel::Type) const override
    {
        return nullptr;
    }
    virtual bool GetParameterValue(EMaterialParameterType Type, const FHashedMaterialParameterInfo &Info,
                                   FMaterialParameterValue &Value, const FMaterialRenderContext &) const override
    {
        if (Type == EMaterialParameterType::Vector && Info.GetName() == FName(TEXT("WebColor")))
        {
            Value = FMaterialParameterValue(FLinearColor(0.75f, 0.25f, 0.125f));
            return true;
        }
        return false;
    }

  private:
    const FMaterial *Material;
};

static TSharedRef<FJsonObject> ExportUniformLayout(const FRHIUniformBufferLayout &Layout)
{
    auto Json = MakeShared<FJsonObject>();
    Json->SetStringField(TEXT("name"), Layout.GetDebugName());
    Json->SetNumberField(TEXT("hash"), Layout.GetHash());
    Json->SetNumberField(TEXT("constantBufferSize"), Layout.ConstantBufferSize);
    Json->SetNumberField(TEXT("staticSlot"), Layout.StaticSlot);
    Json->SetNumberField(TEXT("bindingFlags"), uint32(Layout.BindingFlags));
    Json->SetNumberField(TEXT("flags"), uint32(Layout.Flags));
    TArray<TSharedPtr<FJsonValue>> Resources;
    for (const auto &Resource : Layout.Resources)
    {
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetNumberField(TEXT("offset"), Resource.MemberOffset);
        Entry->SetNumberField(TEXT("type"), uint32(Resource.MemberType));
        Resources.Add(MakeShared<FJsonValueObject>(Entry));
    }
    Json->SetArrayField(TEXT("resources"), Resources);
    return Json;
}

int32 RunMaterialShaderProbe(const FString &Params)
{
    FString OutputDirectory, Snapshot;
    if (!FParse::Value(*Params, TEXT("Output="), OutputDirectory) ||
        !FParse::Value(*Params, TEXT("ShaderSnapshot="), Snapshot))
    {
        UE_LOG(LogTemp, Error, TEXT("MaterialProbe requires Output and ShaderSnapshot"));
        return 1;
    }
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    const TMap<FString, FString> Mappings = AllShaderSourceDirectoryMappings();
    ResetAllShaderSourceDirectoryMappings();
    for (const auto &Mapping : Mappings)
    {
        AddShaderSourceDirectoryMapping(Mapping.Key, Mapping.Key == TEXT("/Engine") ? Snapshot : Mapping.Value);
    }
    FlushShaderFileCache();
    const EShaderPlatform Platform = ResolveProbeShaderPlatform(Params, OutputDirectory, true, SP_VULKAN_PCES3_1);
    if (Platform == SP_NumPlatforms)
        return 1;
    const FName FormatName(TEXT("SF_VULKAN_ES31"));
    const IShaderFormat *Format = GetTargetPlatformManagerRef().FindShaderFormat(FormatName);
    if (!Format)
    {
        UE_LOG(LogTemp, Error, TEXT("Mobile Vulkan shader format missing"));
        return 1;
    }
    TArray<TSharedPtr<FJsonValue>> Cases;
    TMap<FString, TSharedPtr<FJsonObject>> RuntimeLayouts;
    int32 Failures = 0;
    FWebShaderWorkerProbe WorkerProbe(Params, OutputDirectory, UE::WebGPUShader::ES31Format);
    for (int32 MaterialIndex = 0; MaterialIndex < 2; ++MaterialIndex)
    {
        const FString MaterialName = MaterialIndex == 0 ? TEXT("UnlitColor") : TEXT("UnlitTexture");
        UMaterial *Material = NewObject<UMaterial>(GetTransientPackage(), *MaterialName);
        Material->AddToRoot();
        Material->SetShadingModel(MSM_Unlit);
        Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
        Material->SetMaterialUsage(MATUSAGE_StaticMesh);
        if (MaterialIndex == 0)
        {
            UMaterialExpressionVectorParameter *Color = NewObject<UMaterialExpressionVectorParameter>(Material);
            Color->ParameterName = TEXT("WebColor");
            Color->DefaultValue = FLinearColor(0.125f, 0.5f, 0.75f);
            Material->GetExpressionCollection().AddExpression(Color);
            Material->GetEditorOnlyData()->EmissiveColor.Connect(0, Color);
        }
        else
        {
            UTexture2D *Texture = UTexture2D::CreateTransient(2, 2, PF_R8G8B8A8);
            Texture->AddToRoot();
            Texture->SRGB = false;
            UMaterialExpressionTextureSampleParameter2D *Sample =
                NewObject<UMaterialExpressionTextureSampleParameter2D>(Material);
            Sample->Texture = Texture;
            Sample->ParameterName = TEXT("WebAlbedo");
            Sample->SamplerType = SAMPLERTYPE_LinearColor;
            Material->GetExpressionCollection().AddExpression(Sample);
            Material->GetEditorOnlyData()->EmissiveColor.Connect(0, Sample);
        }
        Material->UpdateCachedExpressionData();
        TRefCountPtr<FProbeMaterialResource> Resource = new FProbeMaterialResource();
        Resource->SetMaterial(Material, nullptr, Platform, EMaterialQualityLevel::Low);
        UE_LOG(LogTemp, Display, TEXT("P1_MATERIAL translating unlit material"));
        const bool Translated = Resource->CacheShaders(EMaterialShaderPrecompileMode::None);
        FMaterialShaderMap *Map = Resource->GetProbeShaderMap();
        FSharedShaderCompilerEnvironment *Environment =
            Map ? Map->GetPendingCompilerEnvironment().GetReference() : nullptr;
        if (!Translated || !Environment || !Map)
        {
            UE_LOG(LogTemp, Error, TEXT("Material translation unavailable success=%d environment=%d map=%d"),
                   Translated, Environment != nullptr, Map != nullptr);
            for (const FString &Error : Resource->GetCompileErrors())
            {
                UE_LOG(LogTemp, Error, TEXT("%s"), *Error);
            }
            return 1;
        }
        for (const auto &Include : Environment->IncludeVirtualPathToContentsMap)
        {
            if (Include.Key.EndsWith(TEXT("/Material.ush")))
            {
                FFileHelper::SaveStringToFile(Include.Value,
                                              *(OutputDirectory / (MaterialName + TEXT(".generated-material.ush"))),
                                              FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
            }
        }
        TArray<uint8> MaterialUniform, OverrideUniform;
        const FUniformExpressionSet &Uniforms = Map->GetCompilationOutput().UniformExpressionSet;
        const FRHIUniformBufferLayoutInitializer &UniformLayout = Uniforms.GetUniformBufferLayoutInitializer();
        const FUniformBufferLayoutRHIRef MaterialLayout = new FRHIUniformBufferLayout(UniformLayout);
        RuntimeLayouts.Add(MaterialName + TEXT(":Material"), ExportUniformLayout(*MaterialLayout));
        // Only numeric constants cross the host/browser boundary; RHI resource pointers stay on the host.
        MaterialUniform.SetNumZeroed(Uniforms.GetUniformBufferSize() * sizeof(FVector4f));
        OverrideUniform.SetNumZeroed(MaterialUniform.Num());
        ENQUEUE_RENDER_COMMAND(EvaluateProbeMaterial)(
            [Resource, &Uniforms, &UniformLayout, &MaterialUniform, &OverrideUniform](FRHICommandListImmediate &) {
                const FUniformBufferLayoutRHIRef Layout = RHICreateUniformBufferLayout(UniformLayout);
                TArray<uint8> Temporary;
                Temporary.SetNumZeroed(UniformLayout.ConstantBufferSize + UniformLayout.Resources.Num() * 16 + 1024 +
                                       Uniforms.GetTemporaryBufferSize() * sizeof(FVector4f));
                const FMaterialRenderContext Context(nullptr, *Resource, false);
                Uniforms.FillUniformBuffer(Context, TConstArrayView<IAllocatedVirtualTexture *>(), Layout,
                                           Temporary.GetData(), Temporary.Num());
                FMemory::Memcpy(MaterialUniform.GetData(), Temporary.GetData(), MaterialUniform.Num());
                FProbeParameterProxy Proxy(Resource.GetReference());
                const FMaterialRenderContext OverrideContext(&Proxy, *Resource, false);
                Uniforms.FillUniformBuffer(OverrideContext, TConstArrayView<IAllocatedVirtualTexture *>(), Layout,
                                           Temporary.GetData(), Temporary.Num());
                FMemory::Memcpy(OverrideUniform.GetData(), Temporary.GetData(), OverrideUniform.Num());
            });
        FlushRenderingCommands();
        FFileHelper::SaveArrayToFile(MaterialUniform, *(OutputDirectory / (MaterialName + TEXT(".uniform.bin"))));
        FFileHelper::SaveArrayToFile(OverrideUniform,
                                     *(OutputDirectory / (MaterialName + TEXT(".override.uniform.bin"))));
        const FVertexFactoryType *Factory = nullptr;
        for (TLinkedList<FVertexFactoryType *>::TIterator Iterator(FVertexFactoryType::GetTypeList()); Iterator;
             ++Iterator)
        {
            if (FString((*Iterator)->GetName()) == TEXT("FLocalVertexFactory"))
            {
                Factory = *Iterator;
                break;
            }
        }
        if (!Factory)
        {
            UE_LOG(LogTemp, Error, TEXT("FLocalVertexFactory missing"));
            return 1;
        }
        const FCompilationShaderParameters MaterialParameters(Resource.GetReference(), Map->GetCompilationOutput());
        for (TLinkedList<FShaderType *>::TIterator Iterator(FShaderType::GetTypeList()); Iterator; ++Iterator)
        {
            const FShaderType *Type = *Iterator;
            if (!Type->GetMeshMaterialShaderType() || !Resource->ShouldCache(Type, Factory) ||
                (FString(Type->GetName()) != TEXT("TMobileBasePassVSFNoLightMapPolicy") &&
                 FString(Type->GetName()) != TEXT("TMobileBasePassPSFNoLightMapPolicy")))
            {
                continue;
            }
            for (int32 Profile = 0; Profile < 2; ++Profile)
            {
                FShaderCompileJob Job;
                Job.Key = FShaderCompileJobKey(Type, Platform, Factory, 0);
                Job.Input.SharedEnvironment = Environment;
                Factory->ModifyCompilationEnvironment(
                    FVertexFactoryShaderPermutationParameters(Platform, MaterialParameters, Factory, Type,
                                                              EShaderPermutationFlags::HasEditorOnlyData),
                    Job.Input.Environment);
                Type->ModifyCompilationEnvironment(
                    FMeshMaterialShaderPermutationParameters(Platform, MaterialParameters, Factory, 0,
                                                             EShaderPermutationFlags::HasEditorOnlyData),
                    Job.Input.Environment);
                GlobalBeginCompileShader(TEXT("WebMaterialProbe"), Factory, Type, nullptr, 0, Type->GetShaderFilename(),
                                         Type->GetFunctionName(), FShaderTarget(Type->GetFrequency(), Platform),
                                         Job.Input, false);
                if (Profile == 1)
                {
                    Job.Input.Environment.SetDefine(TEXT("MANUAL_VERTEX_FETCH"), 0);
                    Job.Input.Environment.SetDefine(TEXT("VF_SUPPORTS_PRIMITIVE_SCENE_DATA"), 0);
                    Job.Input.Environment.SetDefine(TEXT("USE_INSTANCE_CULLING"), 0);
                    Job.Input.Environment.SetDefine(TEXT("VF_SUPPORTS_SPEEDTREE_WIND"), 0);
                    Job.Input.Environment.SetDefine(TEXT("SUPPORT_GPUSKIN_PASSTHROUGH"), 0);
                }
                Job.Input.ExtraSettings.bExtractShaderSource = true;
                Job.Input.ShaderFormat = FormatName;
                Format->ModifyShaderCompilerInput(Job.Input);
                FShaderCompilerInput MergedInput = Job.Input;
                MergedInput.Environment.Merge(*Environment);
                const bool Preprocessed =
                    Format->PreprocessShader(Job.Input, MergedInput.Environment, Job.PreprocessOutput);
                const FString Name = MaterialName + TEXT("_") +
                                     (Profile == 0 ? TEXT("Native_") : TEXT("WebVertexInput_")) + Type->GetName();
                const TSharedRef<FJsonObject> Case = MakeShared<FJsonObject>();
                Case->SetStringField(TEXT("name"), Name);
                Case->SetStringField(TEXT("material"), MaterialName);
                Case->SetNumberField(TEXT("materialConstantBytes"), MaterialUniform.Num());
                TArray<TSharedPtr<FJsonValue>> Resources;
                for (const FUniformResourceEntry &Entry : MergedInput.Environment.ResourceTableMap.Resources)
                {
                    if (Entry.GetUniformBufferName() == TEXT("Material"))
                    {
                        TSharedRef<FJsonObject> ResourceEntry = MakeShared<FJsonObject>();
                        ResourceEntry->SetStringField(TEXT("name"), Entry.UniformBufferMemberName);
                        ResourceEntry->SetStringField(TEXT("uniformBuffer"), FString(Entry.GetUniformBufferName()));
                        ResourceEntry->SetNumberField(TEXT("resourceIndex"), Entry.ResourceIndex);
                        ResourceEntry->SetNumberField(TEXT("type"), Entry.Type);
                        Resources.Add(MakeShared<FJsonValueObject>(ResourceEntry));
                    }
                }
                Case->SetArrayField(TEXT("uniformResourceEntries"), Resources);
                Case->SetStringField(TEXT("shaderType"), Type->GetName());
                Case->SetStringField(TEXT("source"), Type->GetShaderFilename());
                Case->SetStringField(TEXT("entry"), Type->GetFunctionName());
                Case->SetStringField(TEXT("vertexFactory"), Factory->GetName());
                Case->SetStringField(TEXT("profile"), Profile == 0 ? TEXT("native-mobile") : TEXT("web-vertex-input"));
                Case->SetNumberField(TEXT("frequency"), Type->GetFrequency());
                Case->SetBoolField(TEXT("preprocessed"), Preprocessed);
                TArray<FString> Includes;
                GetShaderIncludes(Type->GetShaderFilename(), Type->GetShaderFilename(), Includes, Platform);
                GetShaderIncludes(Factory->GetShaderFilename(), Factory->GetShaderFilename(), Includes, Platform);
                for (const auto &Include : MergedInput.Environment.IncludeVirtualPathToContentsMap)
                {
                    if (Include.Key.EndsWith(TEXT("/Material.ush")))
                    {
                        GetShaderIncludes(Type->GetShaderFilename(), *Include.Key, Include.Value, Includes, Platform);
                    }
                }
                Includes.AddUnique(Type->GetShaderFilename());
                Includes.AddUnique(Factory->GetShaderFilename());
                TArray<TSharedPtr<FJsonValue>> IncludeJson;
                for (const FString &Include : Includes)
                {
                    IncludeJson.Add(MakeShared<FJsonValueString>(Include));
                }
                Case->SetArrayField(TEXT("includeFiles"), IncludeJson);
                bool Exported = false;
                if (Preprocessed)
                {
                    FFileHelper::SaveStringToFile(FString(Job.PreprocessOutput.GetUnstrippedSourceView()),
                                                  *(OutputDirectory / (Name + TEXT(".preprocessed.hlsl"))),
                                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
                    Format->CompilePreprocessedShader(MergedInput, Job.PreprocessOutput, Job.Output);
                    if (Job.Output.bSucceeded)
                    {
                        Exported = ExportSpirv(Job.Output, OutputDirectory, Name, Case);
                    }
                    FFileHelper::SaveStringToFile(Job.Output.ModifiedShaderSource,
                                                  *(OutputDirectory / (Name + TEXT(".compiler-output.txt"))),
                                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
                }
                Case->SetBoolField(TEXT("nativeCompiled"), Job.Output.bSucceeded);
                Case->SetBoolField(TEXT("spirvExported"), Exported);
                TArray<TSharedPtr<FJsonValue>> Parameters;
                for (const auto &Allocation : Job.Output.ParameterMap.GetParameterMap())
                {
                    TSharedRef<FJsonObject> Binding = MakeShared<FJsonObject>();
                    Binding->SetStringField(TEXT("name"), Allocation.Key);
                    Binding->SetNumberField(TEXT("bufferIndex"), Allocation.Value.BufferIndex);
                    Binding->SetNumberField(TEXT("baseIndex"), Allocation.Value.BaseIndex);
                    Binding->SetNumberField(TEXT("size"), Allocation.Value.Size);
                    Binding->SetNumberField(TEXT("type"), static_cast<uint8>(Allocation.Value.Type));
                    Parameters.Add(MakeShared<FJsonValueObject>(Binding));
                }
                Case->SetArrayField(TEXT("ueParameterMap"), Parameters);
                if (Exported)
                {
                    const auto &Hashes = Case->GetObjectField(TEXT("resourceTable"))->GetArrayField(TEXT("layoutHashes"));
                    for (const auto &Allocation : Job.Output.ParameterMap.GetParameterMap())
                    {
                        if (Allocation.Value.Type != EShaderParameterType::UniformBuffer)
                            continue;
                        const uint32 Hash = uint32(Hashes[Allocation.Value.BufferIndex]->AsNumber());
                        const FString Key = MaterialName + TEXT(":") + Allocation.Key;
                        if (Allocation.Key == TEXT("Material"))
                        {
                            check(MaterialLayout->GetHash() == Hash);
                        }
                        else
                        {
                            const auto *Metadata = FindUniformBufferStructByLayoutHash(Hash);
                            checkf(Metadata && Metadata->GetLayout().GetHash() == Hash,
                                   TEXT("Runtime uniform layout missing: %s"), *Key);
                            RuntimeLayouts.Add(Key, ExportUniformLayout(Metadata->GetLayout()));
                        }
                    }
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
                Failures += Preprocessed && Job.Output.bSucceeded && Exported ? 0 : 1;
                UE_LOG(LogTemp, Display, TEXT("P1_MATERIAL %s preprocess=%d native=%d export=%d"), *Name, Preprocessed,
                       Job.Output.bSucceeded, Exported);
                Cases.Add(MakeShared<FJsonValueObject>(Case));
                WorkerProbe.Add(Name, Job.Input, Job.Output.ParameterMap, Job.PreprocessOutput);
            }
        }
    }
    TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("hostEngine"), FEngineVersion::Current().ToString());
    Report->SetStringField(TEXT("format"), FormatName.ToString());
    Report->SetStringField(TEXT("shaderPlatform"), FDataDrivenShaderPlatformInfo::GetName(Platform).ToString());
    Report->SetNumberField(TEXT("shaderPlatformEnum"), Platform);
    Report->SetStringField(TEXT("shaderSnapshot"), Snapshot);
    Report->SetBoolField(TEXT("materialTranslated"), Cases.Num() == 8);
    Report->SetArrayField(TEXT("cases"), Cases);
    auto LayoutReport = MakeShared<FJsonObject>();
    LayoutReport->SetStringField(TEXT("source"), TEXT("UE runtime FRHIUniformBufferLayout"));
    TArray<FString> LayoutKeys;
    RuntimeLayouts.GetKeys(LayoutKeys);
    LayoutKeys.Sort();
    for (const auto &Key : LayoutKeys)
        LayoutReport->SetObjectField(Key, RuntimeLayouts[Key]);
    FString LayoutJson;
    FJsonSerializer::Serialize(LayoutReport, TJsonWriterFactory<>::Create(&LayoutJson));
    FFileHelper::SaveStringToFile(LayoutJson, *(OutputDirectory / TEXT("uniform-layouts.json")),
                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    Report->SetBoolField(TEXT("pass"), Cases.Num() == 8 && Failures == 0);
    FString Json;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    FFileHelper::SaveStringToFile(Json, *(OutputDirectory / TEXT("ue-material-results.json")),
                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return WorkerProbe.Run() && Cases.Num() == 8 && Failures == 0 ? 0 : 1;
}
