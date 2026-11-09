#include "CoreMinimal.h"
#include "Engine/Texture2D.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "MaterialShared.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionTextureSampleParameter2D.h"
#include "MeshMaterialShader.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "ShaderCompilerJobTypes.h"
#include "ShaderPreprocessTypes.h"
#include "VertexFactory.h"
#include "WebGPUShaderCode.h"
#include "Algo/AllOf.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#define WEB_NANITE_MATERIAL_SHADER_ONLY 1
#include "../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebVertexFactory.cpp"
#include "../../../../../reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteWebMaterialPass.cpp"

class FWebNaniteProbeMaterial : public FMaterialResource
{
public:
    virtual bool ShouldCache(const FShaderType* Type, const FVertexFactoryType* Factory) const override
    {
        return Factory && FString(Factory->GetName()) == TEXT("FWebNaniteVertexFactory") &&
            FString(Type->GetName()) == TEXT("TBasePassPSFNoLightMapPolicy");
    }
    FMaterialShaderMap* GetProbeShaderMap() const
    { return FMaterialShaderMap::FindCompilingShaderMap(GetGameThreadCompilingShaderMapId()); }
};

int32 RunWebNaniteMaterialProbe(const FString& Params)
{
    FString Output; if (!FParse::Value(*Params, TEXT("Output="), Output)) return 1;
    FString FixtureDirectory; FParse::Value(*Params, TEXT("FixtureDirectory="), FixtureDirectory);
    auto SaveFixture = [&FixtureDirectory](UObject* Asset)
    {
        if (FixtureDirectory.IsEmpty()) return true;
        IFileManager::Get().MakeDirectory(*FixtureDirectory, true);
        FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone;
        return UPackage::SavePackage(Asset->GetOutermost(), Asset, *(FixtureDirectory / Asset->GetName() + TEXT(".uasset")), Args);
    };
    IFileManager::Get().MakeDirectory(*Output, true);
    const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
    const IShaderFormat* Format = GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    const auto* Factory = FindVertexFactoryType(FHashedName(TEXT("FWebNaniteVertexFactory")));
    if (!Factory || !Format || Platform == SP_NumPlatforms) return 1;
    const FShaderType* Type = nullptr;
    for (TLinkedList<FShaderType*>::TIterator It(FShaderType::GetTypeList()); It; ++It)
        if (FString((*It)->GetName()) == TEXT("TBasePassPSFNoLightMapPolicy")) { Type = *It; break; }
    if (!Type) return 1;
    TArray<TSharedPtr<FJsonValue>> Cases;
    for (int32 CaseIndex = 0; CaseIndex < 3; ++CaseIndex)
    {
        const FString Name = FString::Printf(TEXT("NaniteMaterial%d"), CaseIndex);
        UPackage* Package = CreatePackage(*(TEXT("/Game/WebNaniteMaterials/") + Name)); Package->MarkAsFullyLoaded();
        UMaterial* Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone); Material->AddToRoot();
        Material->SetShadingModel(CaseIndex == 0 ? MSM_Unlit : MSM_DefaultLit);
        Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
        Material->SetMaterialUsage(MATUSAGE_Nanite);
        auto* Color = NewObject<UMaterialExpressionVectorParameter>(Material);
        Color->ParameterName = TEXT("NaniteColor"); Color->DefaultValue = FLinearColor(.2f, .4f, .7f);
        Material->GetExpressionCollection().AddExpression(Color);
        if (CaseIndex == 0) Material->GetEditorOnlyData()->EmissiveColor.Connect(0, Color);
        else Material->GetEditorOnlyData()->BaseColor.Connect(0, Color);
        if (CaseIndex == 2)
        {
            UPackage* TexturePackage = CreatePackage(TEXT("/Game/WebNaniteMaterials/NaniteNormal")); TexturePackage->MarkAsFullyLoaded();
            auto* Texture = NewObject<UTexture2D>(TexturePackage, TEXT("NaniteNormal"), RF_Public | RF_Standalone);
            const uint8 Pixels[] = {255,128,128,255, 255,128,128,255, 255,128,128,255, 255,128,128,255};
            Texture->Source.Init(2, 2, 1, 1, TSF_BGRA8, Pixels); Texture->MipGenSettings = TMGS_NoMipmaps;
            Texture->SRGB = false; Texture->CompressionSettings = TC_Normalmap; Texture->AddToRoot();
            Texture->PostEditChange(); if (!SaveFixture(Texture)) return 1;
            auto* Normal = NewObject<UMaterialExpressionTextureSampleParameter2D>(Material);
            Normal->ParameterName = TEXT("NaniteNormal"); Normal->Texture = Texture; Normal->SamplerType = SAMPLERTYPE_Normal;
            Material->GetExpressionCollection().AddExpression(Normal);
            Material->GetEditorOnlyData()->Normal.Connect(0, Normal);
        }
        Material->UpdateCachedExpressionData();
        TRefCountPtr<FWebNaniteProbeMaterial> Resource = new FWebNaniteProbeMaterial();
        Resource->SetMaterial(Material, nullptr, Platform, EMaterialQualityLevel::High);
        if (!Resource->CacheShaders(EMaterialShaderPrecompileMode::None)) return 1;
        auto* Map = Resource->GetProbeShaderMap(); if (!Map || !Map->GetPendingCompilerEnvironment()) return 1;
        FShaderCompileJob Job;
        Job.Key = FShaderCompileJobKey(Type, Platform, Factory, 0);
        Job.Input.SharedEnvironment = Map->GetPendingCompilerEnvironment();
        const FCompilationShaderParameters MP(Resource.GetReference(), Map->GetCompilationOutput());
        Factory->ModifyCompilationEnvironment(FVertexFactoryShaderPermutationParameters(Platform, MP, Factory, Type,
            EShaderPermutationFlags::HasEditorOnlyData), Job.Input.Environment);
        Type->ModifyCompilationEnvironment(FMeshMaterialShaderPermutationParameters(Platform, MP, Factory, 0,
            EShaderPermutationFlags::HasEditorOnlyData), Job.Input.Environment);
        GlobalBeginCompileShader(Name, Factory, Type, nullptr, 0, Type->GetShaderFilename(), Type->GetFunctionName(),
            FShaderTarget(SF_Pixel, Platform), Job.Input, false);
        Job.Input.ShaderFormat = UE::WebGPUShader::SM5Format;
        Job.Input.ExtraSettings.bExtractShaderSource = true;
        Format->ModifyShaderCompilerInput(Job.Input);
        FShaderCompilerInput Merged = Job.Input; Merged.Environment.Merge(*Job.Input.SharedEnvironment);
        const bool Preprocessed = Format->PreprocessShader(Job.Input, Merged.Environment, Job.PreprocessOutput);
        FFileHelper::SaveStringToFile(FString(Job.PreprocessOutput.GetUnstrippedSourceView()), *(Output / (Name + TEXT(".hlsl"))), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
        if (Preprocessed) Format->CompilePreprocessedShader(Merged, Job.PreprocessOutput, Job.Output);
        auto Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("name"), Name);
        Result->SetBoolField(TEXT("preprocessed"), Preprocessed); Result->SetBoolField(TEXT("compiled"), Job.Output.bSucceeded);
        TArray<TSharedPtr<FJsonValue>> Errors;
        for (const auto& Error : Job.PreprocessOutput.GetErrors()) Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
        for (const auto& Error : Job.Output.Errors) Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
        Result->SetArrayField(TEXT("errors"), Errors); Cases.Add(MakeShared<FJsonValueObject>(Result));
        UE_LOG(LogTemp, Display, TEXT("WEB_NANITE_MATERIAL name=%s preprocessed=%d compiled=%d"), *Name, Preprocessed, Job.Output.bSucceeded);
        if (!SaveFixture(Material)) return 1;
    }
    auto* VertexType = &Nanite::FWebNaniteMaterialTilesVS::GetStaticType();
    FShaderCompileJob VertexJob;
    VertexJob.Key = FShaderCompileJobKey(VertexType, Platform, nullptr, 0);
    GlobalBeginCompileShader(TEXT("WebNaniteMaterialTiles"), nullptr, VertexType, nullptr, 0,
        VertexType->GetShaderFilename(), VertexType->GetFunctionName(), FShaderTarget(SF_Vertex, Platform), VertexJob.Input, false);
    VertexJob.Input.ShaderFormat = UE::WebGPUShader::SM5Format;
    VertexType->SetupCompileEnvironment(Platform, 0, EShaderPermutationFlags::HasEditorOnlyData, VertexJob.Input.Environment);
    Format->ModifyShaderCompilerInput(VertexJob.Input);
    if (!Format->PreprocessShader(VertexJob.Input, VertexJob.Input.Environment, VertexJob.PreprocessOutput)) return 1;
    Format->CompilePreprocessedShader(VertexJob.Input, VertexJob.PreprocessOutput, VertexJob.Output);
    for (const auto& Error : VertexJob.Output.Errors) UE_LOG(LogTemp, Error, TEXT("%s"), *Error.GetErrorString());
    const bool Passed = VertexJob.Output.bSucceeded && Cases.Num() == 3 && Algo::AllOf(Cases, [](const auto& C) { return C->AsObject()->GetBoolField(TEXT("compiled")); });
    auto Report = MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), Passed); Report->SetArrayField(TEXT("cases"), Cases);
    Report->SetBoolField(TEXT("vertexCompiled"), VertexJob.Output.bSucceeded);
    FString Json; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    FFileHelper::SaveStringToFile(Json, *(Output / TEXT("verified.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return Passed ? 0 : 1;
}
