#include "CoreMinimal.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "MaterialShared.h"
#include "Materials/Material.h"
#include "MeshMaterialShader.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "ShaderCompilerJobTypes.h"
#include "ShaderPreprocessTypes.h"
#include "VertexFactory.h"
#include "WebGPUShaderCode.h"
#include "Algo/AllOf.h"
#include "UObject/Package.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionPreviousFrameSwitch.h"
#include "Materials/MaterialExpressionVertexColor.h"
#include "Materials/MaterialExpressionMultiply.h"
#define WEB_NANITE_MATERIAL_SHADER_ONLY 1
#define WEB_NANITE_PROGRAMMABLE_SHADER_ONLY 1
#include "../../../../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebVertexFactory.cpp"
#include "../../../../../../../../reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite/NaniteWebProgrammableRaster.cpp"
UMaterial* CreateWebCurveMaterial(int32 Index)
{
    if (Index >= 5) {
        const TCHAR* Kind=Index < 7 ? TEXT("Small") : Index < 9 ? TEXT("Streaming") : TEXT("Long256");
        const FString Asset=FString::Printf(TEXT("/Game/WebNaniteCurves/NaniteGroom%sMaterial%d.NaniteGroom%sMaterial%d"),
            Kind, (Index-5)%2, Kind, (Index-5)%2);
        auto* Result=LoadObject<UMaterial>(nullptr,*Asset);check(Result);return Result;
    }
    const FString Name = Index == 0 ? TEXT("NaniteCurveMaterial") : FString::Printf(TEXT("NaniteCurveMaterial%d"), Index);
    auto* Package = CreatePackage(*(TEXT("/Game/WebNaniteCurves/") + Name));
    if (auto* Existing = FindObject<UMaterial>(Package, *Name)) return Existing;
    Package->MarkAsFullyLoaded();
    auto* Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone);
    Material->AddToRoot(); Material->SetShadingModel(MSM_DefaultLit);
    Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
    Material->TwoSided = Index != 3;
    Material->SetMaterialUsage(MATUSAGE_Curves); Material->SetMaterialUsage(MATUSAGE_HairStrands); Material->SetMaterialUsage(MATUSAGE_Nanite);
    auto* Color = NewObject<UMaterialExpressionVectorParameter>(Material);
    Color->ParameterName = TEXT("NaniteColor"); Color->DefaultValue = FLinearColor(.8f, .04f, .03f);
    Material->GetExpressionCollection().AddExpression(Color);
    Material->GetEditorOnlyData()->BaseColor.Connect(0, Color);
    auto* Roughness = NewObject<UMaterialExpressionConstant>(Material); Roughness->R = .7f;
    Material->GetExpressionCollection().AddExpression(Roughness);
    Material->GetEditorOnlyData()->Roughness.Connect(0, Roughness);
    if (Index == 1 || Index == 2)
    {
        Material->BlendMode = BLEND_Masked; Material->OpacityMaskClipValue = .5f;
        auto* UV = NewObject<UMaterialExpressionTextureCoordinate>(Material);
        auto* Mask = NewObject<UMaterialExpressionComponentMask>(Material);
        Mask->Input.Connect(0, UV); Mask->R = true;
        Material->GetExpressionCollection().AddExpression(UV);
        Material->GetExpressionCollection().AddExpression(Mask);
        Material->GetEditorOnlyData()->OpacityMask.Connect(0, Mask);
        auto* Depth = NewObject<UMaterialExpressionScalarParameter>(Material);
        Depth->ParameterName = TEXT("NaniteDepthOffset"); Depth->DefaultValue = 25;
        Material->GetExpressionCollection().AddExpression(Depth);
        Material->GetEditorOnlyData()->PixelDepthOffset.Connect(0, Depth);
    }
    if (Index == 2 || Index == 4)
    {
        Material->MaxWorldPositionOffsetDisplacement = Index == 4 ? 0 : 120;
        Material->bAlwaysEvaluateWorldPositionOffset = Index == 4;
        auto* Offset = NewObject<UMaterialExpressionVectorParameter>(Material);
        Offset->ParameterName = TEXT("NaniteWorldOffset"); Offset->DefaultValue = FLinearColor(40, 25, 15);
        auto* Previous = NewObject<UMaterialExpressionVectorParameter>(Material);
        Previous->ParameterName = TEXT("NanitePreviousWorldOffset"); Previous->DefaultValue = Offset->DefaultValue;
        auto* Switch = NewObject<UMaterialExpressionPreviousFrameSwitch>(Material);
        Switch->CurrentFrame.Connect(0, Offset); Switch->PreviousFrame.Connect(0, Previous);
        auto* VertexColor = NewObject<UMaterialExpressionVertexColor>(Material);
        auto* Product = NewObject<UMaterialExpressionMultiply>(Material);
        Product->A.Connect(0, Switch); Product->B.Connect(0, VertexColor);
        for (UMaterialExpression* Expression : TArray<UMaterialExpression*>{Offset, Previous, Switch, VertexColor, Product})
            Material->GetExpressionCollection().AddExpression(Expression);
        Material->GetEditorOnlyData()->WorldPositionOffset.Connect(0, Product);
    }
    Material->UpdateCachedExpressionData(); Material->PostEditChange();
    return Material;
}

class FWebNaniteProgrammableProbeMaterial : public FMaterialResource
{
public:
    virtual bool ShouldCache(const FShaderType* Type, const FVertexFactoryType* Factory) const override
    { return !Factory && (FString(Type->GetName()) == TEXT("FWebNaniteProgrammablePS") || FString(Type->GetName()) == TEXT("FWebNaniteProgrammableVS")); }
    FMaterialShaderMap* GetProbeShaderMap() const
    { return FMaterialShaderMap::FindCompilingShaderMap(GetGameThreadCompilingShaderMapId()); }
};

UMaterial* CreateWebCurveMaterial(int32);
int32 RunWebCurveRasterMaterials(const FString& Params){
 const bool Assembly = false;
 FString Output;if(!FParse::Value(*Params,TEXT("Output="),Output))return 1;IFileManager::Get().MakeDirectory(*Output,true);
 const auto Platform=FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
 const IShaderFormat* Format=GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);if(!Format||Platform==SP_NumPlatforms)return 1;
 TArray<TSharedPtr<FJsonValue>> Cases;bool Passed=true;
 for(int32 CaseIndex=0;CaseIndex<11;++CaseIndex){auto* Material=CreateWebCurveMaterial(CaseIndex);Material->bUsedWithSkeletalMesh = false;
        const FString Name = Material->GetName() + (Assembly ? (CaseIndex < 5 ? TEXT("-skinned") : TEXT("-static")) : TEXT(""));
        TRefCountPtr<FWebNaniteProgrammableProbeMaterial> Resource = new FWebNaniteProgrammableProbeMaterial();
        Resource->SetMaterial(Material, nullptr, Platform, EMaterialQualityLevel::High);
        if (!Resource->CacheShaders(EMaterialShaderPrecompileMode::None)) return 1;
        auto* Map = Resource->GetProbeShaderMap(); if (!Map || !Map->GetPendingCompilerEnvironment()) return 1;
        const FCompilationShaderParameters MP(Resource.GetReference(), Map->GetCompilationOutput());
        for (const auto* Type : {&Nanite::FWebNaniteProgrammableVS::GetStaticType(), &Nanite::FWebNaniteProgrammablePS::GetStaticType()})
        for (int32 PermutationId : {0, 1, 3})
        {
            if (Type->GetFrequency() == SF_Vertex && PermutationId != 0) continue;
            FShaderCompileJob Job; Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, PermutationId);
            Job.Input.SharedEnvironment = Map->GetPendingCompilerEnvironment();
            Type->ModifyCompilationEnvironment(FMaterialShaderPermutationParameters(Platform, MP, PermutationId,
                EShaderPermutationFlags::HasEditorOnlyData), Job.Input.Environment);
            GlobalBeginCompileShader(Name, nullptr, Type, nullptr, PermutationId, Type->GetShaderFilename(), Type->GetFunctionName(),
                FShaderTarget(Type->GetFrequency(), Platform), Job.Input, false);
            Job.Input.ShaderFormat = UE::WebGPUShader::SM5Format; Job.Input.ExtraSettings.bExtractShaderSource = true;
            Format->ModifyShaderCompilerInput(Job.Input);
            FShaderCompilerInput Merged = Job.Input; Merged.Environment.Merge(*Job.Input.SharedEnvironment);
            const bool Preprocessed = Format->PreprocessShader(Job.Input, Merged.Environment, Job.PreprocessOutput);
            const FString Stem = FString::Printf(TEXT("%s-%s-%d"), *Name, Type->GetFrequency() == SF_Vertex ? TEXT("vs") : TEXT("ps"), PermutationId);
            FFileHelper::SaveStringToFile(FString(Job.PreprocessOutput.GetUnstrippedSourceView()), *(Output / Stem + TEXT(".hlsl")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
            if (Preprocessed) Format->CompilePreprocessedShader(Merged, Job.PreprocessOutput, Job.Output);
            auto Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("name"), Name);
            Result->SetStringField(TEXT("frequency"), Type->GetFrequency() == SF_Vertex ? TEXT("vertex") : TEXT("pixel"));
            Result->SetNumberField(TEXT("permutation"), PermutationId); Result->SetBoolField(TEXT("preprocessed"), Preprocessed);
            Result->SetBoolField(TEXT("compiled"), Job.Output.bSucceeded);
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const auto& Error : Job.PreprocessOutput.GetErrors()) Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            for (const auto& Error : Job.Output.Errors) Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            Result->SetArrayField(TEXT("errors"), Errors); Cases.Add(MakeShared<FJsonValueObject>(Result));
            Passed &= Preprocessed && Job.Output.bSucceeded;
            UE_LOG(LogTemp, Display, TEXT("WEB_NANITE_PROGRAMMABLE name=%s permutation=%d compiled=%d"), *Name, PermutationId, Job.Output.bSucceeded);
        }
}
 auto Report=MakeShared<FJsonObject>();Report->SetBoolField(TEXT("pass"),Passed);Report->SetArrayField(TEXT("cases"),Cases);FString Json;FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));FFileHelper::SaveStringToFile(Json,*(Output/TEXT("materials.json")),FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);return Passed?0:1;
}

class FWebNaniteProbeMaterial : public FMaterialResource
{
public:
    virtual bool ShouldCache(const FShaderType* Type, const FVertexFactoryType* Factory) const override
    {
        return Factory && FString(Factory->GetName()) == TEXT("FWebNaniteVertexFactory") &&
            FString(Type->GetName()).StartsWith(TEXT("TBasePassPSFNoLightMapPolicy"));
    }
    FMaterialShaderMap* GetProbeShaderMap() const
    { return FMaterialShaderMap::FindCompilingShaderMap(GetGameThreadCompilingShaderMapId()); }
};

UMaterial* CreateWebCurveMaterial(int32);
int32 RunWebCurveBasePass(const FString& Params)
{
 const bool Assembly = false;
    FString Output; if (!FParse::Value(*Params, TEXT("Output="), Output)) return 1;
    IFileManager::Get().MakeDirectory(*Output, true);
    const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
    const IShaderFormat* Format = GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    const auto* Factory = FindVertexFactoryType(FHashedName(TEXT("FWebNaniteVertexFactory")));
    if (!Factory || !Format || Platform == SP_NumPlatforms) return 1;
    TArray<const FShaderType*> Types;
    for (TLinkedList<FShaderType*>::TIterator It(FShaderType::GetTypeList()); It; ++It)
        if (FString((*It)->GetName()).StartsWith(TEXT("TBasePassPSFNoLightMapPolicy"))) Types.Add(*It);
    if (Types.IsEmpty()) return 1;
    TArray<TSharedPtr<FJsonValue>> Cases;
    for (int32 CaseIndex = 0; CaseIndex < 11; ++CaseIndex)
    for (const FShaderType* Type : Types)
    {
        auto* Material = CreateWebCurveMaterial(CaseIndex); Material->bUsedWithSkeletalMesh = false;
        const FString Name = Material->GetName() + (Assembly ? (CaseIndex < 5 ? TEXT("-skinned") : TEXT("-static")) : TEXT(""));
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
        FFileHelper::SaveStringToFile(FString(Job.PreprocessOutput.GetUnstrippedSourceView()), *(Output / (Name + TEXT("-") + Type->GetName() + TEXT(".hlsl"))), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
        if (Preprocessed) Format->CompilePreprocessedShader(Merged, Job.PreprocessOutput, Job.Output);
        auto Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("shader"), Type->GetName()); Result->SetStringField(TEXT("name"), Name);
        Result->SetBoolField(TEXT("preprocessed"), Preprocessed); Result->SetBoolField(TEXT("compiled"), Job.Output.bSucceeded);
        TArray<TSharedPtr<FJsonValue>> Errors;
        for (const auto& Error : Job.PreprocessOutput.GetErrors()) Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
        for (const auto& Error : Job.Output.Errors) Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
        Result->SetArrayField(TEXT("errors"), Errors); Cases.Add(MakeShared<FJsonValueObject>(Result));
        UE_LOG(LogTemp, Display, TEXT("WEB_NANITE_MATERIAL name=%s preprocessed=%d compiled=%d"), *Name, Preprocessed, Job.Output.bSucceeded);
    }
    const bool Passed = Algo::AllOf(Cases, [](const TSharedPtr<FJsonValue>& V) { return V->AsObject()->GetBoolField(TEXT("compiled")); });
    auto Report=MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), Passed); Report->SetArrayField(TEXT("cases"), Cases);
    FString Json; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    FFileHelper::SaveStringToFile(Json, *(Output / TEXT("basepass.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return Passed ? 0 : 1;
}


int32 RunWebCurveMaterialShaders(const FString& Params) {
 FString Output;if(!FParse::Value(*Params,TEXT("Output="),Output))return 1;
 if(RunWebCurveRasterMaterials(TEXT("-Output=")+Output/TEXT("raster")))return 1;
 return RunWebCurveBasePass(TEXT("-Output=")+Output/TEXT("basepass"));
}
