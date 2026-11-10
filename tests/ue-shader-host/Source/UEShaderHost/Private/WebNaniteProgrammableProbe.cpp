#include "CoreMinimal.h"
#include "Engine/Texture2D.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "MaterialShared.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionTextureSampleParameter2D.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "ShaderCompilerJobTypes.h"
#include "ShaderPreprocessTypes.h"
#include "WebGPUShaderCode.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#define WEB_NANITE_PROGRAMMABLE_SHADER_ONLY 1
#include "../../../../../reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteWebProgrammableRaster.cpp"

class FWebNaniteProgrammableProbeMaterial : public FMaterialResource
{
public:
    virtual bool ShouldCache(const FShaderType* Type, const FVertexFactoryType* Factory) const override
    { return !Factory && FString(Type->GetName()) == TEXT("FWebNaniteProgrammablePS"); }
    FMaterialShaderMap* GetProbeShaderMap() const
    { return FMaterialShaderMap::FindCompilingShaderMap(GetGameThreadCompilingShaderMapId()); }
};

int32 RunWebNaniteProgrammableProbe(const FString& Params)
{
    FString Output, FixtureDirectory;
    if (!FParse::Value(*Params, TEXT("Output="), Output)) return 1;
    FParse::Value(*Params, TEXT("FixtureDirectory="), FixtureDirectory);
    IFileManager::Get().MakeDirectory(*Output, true);
    auto SaveFixture = [&FixtureDirectory](UObject* Asset)
    {
        if (FixtureDirectory.IsEmpty()) return true;
        IFileManager::Get().MakeDirectory(*FixtureDirectory, true);
        FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone;
        return UPackage::SavePackage(Asset->GetOutermost(), Asset, *(FixtureDirectory / Asset->GetName() + TEXT(".uasset")), Args);
    };
    const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
    const IShaderFormat* Format = GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    if (!Format || Platform == SP_NumPlatforms) return 1;
    const auto* Type = &Nanite::FWebNaniteProgrammablePS::GetStaticType();
    UPackage* TexturePackage = CreatePackage(TEXT("/Game/WebNaniteProgrammable/NaniteMask")); TexturePackage->MarkAsFullyLoaded();
    auto* Texture = NewObject<UTexture2D>(TexturePackage, TEXT("NaniteMask"), RF_Public | RF_Standalone);
    TArray<uint8> Pixels; Pixels.SetNumUninitialized(8 * 8 * 4);
    for (int Y = 0; Y < 8; ++Y) for (int X = 0; X < 8; ++X)
    {
        const int I = (Y * 8 + X) * 4;
        Pixels[I] = Pixels[I + 1] = Pixels[I + 2] = ((X / 2 + Y / 2) & 1) ? 255 : 0;
        Pixels[I + 3] = 255;
    }
    Texture->Source.Init(8, 8, 1, 1, TSF_BGRA8, Pixels.GetData());
    Texture->MipGenSettings = TMGS_NoMipmaps; Texture->SRGB = false;
    Texture->CompressionSettings = TC_Masks; Texture->Filter = TF_Nearest;
    Texture->AddToRoot(); Texture->PostEditChange(); if (!SaveFixture(Texture)) return 1;
    TArray<TSharedPtr<FJsonValue>> Cases; bool Passed = true;
    for (int32 CaseIndex = 0; CaseIndex < 4; ++CaseIndex)
    {
        const FString Name = FString::Printf(TEXT("NaniteProgrammable%d"), CaseIndex);
        UPackage* Package = CreatePackage(*(TEXT("/Game/WebNaniteProgrammable/") + Name)); Package->MarkAsFullyLoaded();
        auto* Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone); Material->AddToRoot();
        Material->SetShadingModel(MSM_DefaultLit);
        Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
        Material->BlendMode = CaseIndex == 1 ? BLEND_Opaque : BLEND_Masked;
        Material->TwoSided = CaseIndex != 3;
        Material->SetMaterialUsage(MATUSAGE_Nanite); Material->SetMaterialUsage(MATUSAGE_InstancedStaticMeshes);
        auto* Color = NewObject<UMaterialExpressionVectorParameter>(Material);
        Color->ParameterName = TEXT("NaniteColor"); Color->DefaultValue = FLinearColor(.2f, .4f, .7f);
        Material->GetExpressionCollection().AddExpression(Color); Material->GetEditorOnlyData()->BaseColor.Connect(0, Color);
        if (CaseIndex != 1)
        {
            auto* Mask = NewObject<UMaterialExpressionTextureSampleParameter2D>(Material);
            Mask->ParameterName = TEXT("NaniteMask"); Mask->Texture = Texture; Mask->SamplerType = SAMPLERTYPE_Masks;
            Material->GetExpressionCollection().AddExpression(Mask);
            Material->GetEditorOnlyData()->OpacityMask.Connect(1, Mask);
        }
        if (CaseIndex == 1 || CaseIndex == 2)
        {
            auto* Offset = NewObject<UMaterialExpressionScalarParameter>(Material);
            Offset->ParameterName = TEXT("NaniteDepthOffset"); Offset->DefaultValue = 25.0f;
            Material->GetExpressionCollection().AddExpression(Offset); Material->GetEditorOnlyData()->PixelDepthOffset.Connect(0, Offset);
        }
        Material->UpdateCachedExpressionData();
        TRefCountPtr<FWebNaniteProgrammableProbeMaterial> Resource = new FWebNaniteProgrammableProbeMaterial();
        Resource->SetMaterial(Material, nullptr, Platform, EMaterialQualityLevel::High);
        if (!Resource->CacheShaders(EMaterialShaderPrecompileMode::None)) return 1;
        auto* Map = Resource->GetProbeShaderMap(); if (!Map || !Map->GetPendingCompilerEnvironment()) return 1;
        const FCompilationShaderParameters MP(Resource.GetReference(), Map->GetCompilationOutput());
        for (int32 PermutationId : {0, 1, 3})
        {
            FShaderCompileJob Job; Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, PermutationId);
            Job.Input.SharedEnvironment = Map->GetPendingCompilerEnvironment();
            Type->ModifyCompilationEnvironment(FMaterialShaderPermutationParameters(Platform, MP, PermutationId,
                EShaderPermutationFlags::HasEditorOnlyData), Job.Input.Environment);
            GlobalBeginCompileShader(Name, nullptr, Type, nullptr, PermutationId, Type->GetShaderFilename(), Type->GetFunctionName(),
                FShaderTarget(SF_Pixel, Platform), Job.Input, false);
            Job.Input.ShaderFormat = UE::WebGPUShader::SM5Format; Job.Input.ExtraSettings.bExtractShaderSource = true;
            Format->ModifyShaderCompilerInput(Job.Input);
            FShaderCompilerInput Merged = Job.Input; Merged.Environment.Merge(*Job.Input.SharedEnvironment);
            const bool Preprocessed = Format->PreprocessShader(Job.Input, Merged.Environment, Job.PreprocessOutput);
            const FString Stem = FString::Printf(TEXT("%s-%d"), *Name, PermutationId);
            FFileHelper::SaveStringToFile(FString(Job.PreprocessOutput.GetUnstrippedSourceView()), *(Output / Stem + TEXT(".hlsl")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
            if (Preprocessed) Format->CompilePreprocessedShader(Merged, Job.PreprocessOutput, Job.Output);
            auto Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("name"), Name);
            Result->SetNumberField(TEXT("permutation"), PermutationId); Result->SetBoolField(TEXT("preprocessed"), Preprocessed);
            Result->SetBoolField(TEXT("compiled"), Job.Output.bSucceeded);
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const auto& Error : Job.PreprocessOutput.GetErrors()) Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            for (const auto& Error : Job.Output.Errors) Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            Result->SetArrayField(TEXT("errors"), Errors); Cases.Add(MakeShared<FJsonValueObject>(Result));
            Passed &= Preprocessed && Job.Output.bSucceeded;
            UE_LOG(LogTemp, Display, TEXT("WEB_NANITE_PROGRAMMABLE name=%s permutation=%d compiled=%d"), *Name, PermutationId, Job.Output.bSucceeded);
        }
        if (!SaveFixture(Material)) return 1;
    }
    auto Report = MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), Passed && Cases.Num() == 12); Report->SetArrayField(TEXT("cases"), Cases);
    FString Json; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    FFileHelper::SaveStringToFile(Json, *(Output / TEXT("verified.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return Passed ? 0 : 1;
}
