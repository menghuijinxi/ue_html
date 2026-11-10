#include "CoreMinimal.h"
#include "Engine/Texture2D.h"
#include "Engine/StaticMesh.h"
#include "AssetCompilingManager.h"
#include "MeshDescription.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshResources.h"
#include "Rendering/NaniteResources.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "MaterialShared.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionTextureSampleParameter2D.h"
#include "Materials/MaterialExpressionPreviousFrameSwitch.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionVertexColor.h"
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
    { return !Factory && (FString(Type->GetName()) == TEXT("FWebNaniteProgrammablePS") || FString(Type->GetName()) == TEXT("FWebNaniteProgrammableVS")); }
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
    UMaterial* WPOMaterial = nullptr;
    for (int32 CaseIndex = 0; CaseIndex < 11; ++CaseIndex)
    {
        const FString Name = FString::Printf(TEXT("NaniteProgrammable%d"), CaseIndex);
        UPackage* Package = CreatePackage(*(TEXT("/Game/WebNaniteProgrammable/") + Name)); Package->MarkAsFullyLoaded();
        auto* Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone); Material->AddToRoot();
        Material->SetShadingModel(MSM_DefaultLit);
        Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
        Material->BlendMode = CaseIndex == 1 || (CaseIndex >= 4 && CaseIndex != 5 && CaseIndex != 9) ? BLEND_Opaque : BLEND_Masked;
        Material->TwoSided = CaseIndex != 3 && CaseIndex != 6 && CaseIndex != 10;
        if (CaseIndex >= 8) Material->SetMaterialUsage(MATUSAGE_SplineMesh);
        Material->SetMaterialUsage(MATUSAGE_Nanite); Material->SetMaterialUsage(MATUSAGE_InstancedStaticMeshes);
        auto* Color = NewObject<UMaterialExpressionVectorParameter>(Material);
        Color->ParameterName = TEXT("NaniteColor"); Color->DefaultValue = FLinearColor(.2f, .4f, .7f);
        Material->GetExpressionCollection().AddExpression(Color); Material->GetEditorOnlyData()->BaseColor.Connect(0, Color);
        if (Material->BlendMode == BLEND_Masked)
        {
            auto* Mask = NewObject<UMaterialExpressionTextureSampleParameter2D>(Material);
            Mask->ParameterName = TEXT("NaniteMask"); Mask->Texture = Texture; Mask->SamplerType = SAMPLERTYPE_Masks;
            Material->GetExpressionCollection().AddExpression(Mask);
            Material->GetEditorOnlyData()->OpacityMask.Connect(1, Mask);
        }
        if (CaseIndex == 1 || CaseIndex == 2 || CaseIndex == 5 || CaseIndex == 9)
        {
            auto* Offset = NewObject<UMaterialExpressionScalarParameter>(Material);
            Offset->ParameterName = TEXT("NaniteDepthOffset"); Offset->DefaultValue = 25.0f;
            Material->GetExpressionCollection().AddExpression(Offset); Material->GetEditorOnlyData()->PixelDepthOffset.Connect(0, Offset);
        }
        if ((CaseIndex >= 4 && CaseIndex < 8) || CaseIndex == 9)
        {
            Material->MaxWorldPositionOffsetDisplacement = CaseIndex == 7 ? 0.0f : 120.0f;
            Material->bAlwaysEvaluateWorldPositionOffset = CaseIndex == 7;
            auto* Offset = NewObject<UMaterialExpressionVectorParameter>(Material);
            Offset->ParameterName = TEXT("NaniteWorldOffset"); Offset->DefaultValue = FLinearColor(40, 25, 15);
            auto* Previous = NewObject<UMaterialExpressionVectorParameter>(Material);
            Previous->ParameterName = TEXT("NanitePreviousWorldOffset"); Previous->DefaultValue = Offset->DefaultValue;
            auto* Switch = NewObject<UMaterialExpressionPreviousFrameSwitch>(Material);
            Switch->CurrentFrame.Connect(0, Offset); Switch->PreviousFrame.Connect(0, Previous);
            auto* VertexColor = NewObject<UMaterialExpressionVertexColor>(Material);
            auto* Product = NewObject<UMaterialExpressionMultiply>(Material);
            Product->A.Connect(0, Switch); Product->B.Connect(0, VertexColor);
            const TArray<UMaterialExpression*> Expressions{Offset, Previous, Switch, VertexColor, Product};
            for (UMaterialExpression* Expression : Expressions)
                Material->GetExpressionCollection().AddExpression(Expression);
            Material->GetEditorOnlyData()->WorldPositionOffset.Connect(0, Product);
        }
        Material->UpdateCachedExpressionData();
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
        if (!SaveFixture(Material)) return 1;
        if (CaseIndex == 4) WPOMaterial = Material;
    }
    // A separate colored surface makes WPO a spatial deformation, with an
    // independent source-triangle oracle. The existing rigid fixture is kept.
    if (!FixtureDirectory.IsEmpty())
    {
        check(WPOMaterial);
        FMeshDescription Description; FStaticMeshAttributes Attributes(Description); Attributes.Register();
        auto Positions = Attributes.GetVertexPositions(); auto Normals = Attributes.GetVertexInstanceNormals();
        auto UVs = Attributes.GetVertexInstanceUVs(); UVs.SetNumChannels(1);
        auto Colors = Attributes.GetVertexInstanceColors(); auto Signs = Attributes.GetVertexInstanceBinormalSigns();
        FPolygonGroupID Groups[2] = {Description.CreatePolygonGroup(), Description.CreatePolygonGroup()};
        const FName Slots[2] = {TEXT("Left"), TEXT("Right")};
        for (int I = 0; I < 2; ++I) Attributes.GetPolygonGroupMaterialSlotNames()[Groups[I]] = Slots[I];
        constexpr int Side = 32;
        TArray<FVertexID> Vertices;
        for (int Z = 0; Z <= Side; ++Z) for (int Y = 0; Y <= Side; ++Y)
        {
            const auto V = Description.CreateVertex(); Vertices.Add(V);
            Positions[V] = FVector3f(.75f * FMath::Sin(Y * .9f) * FMath::Sin(Z * .8f),
                Y * 200.0f / Side - 100, Z * 200.0f / Side - 100);
        }
        TArray<float> Source;
        auto Triangle = [&](int A, int B, int C, int Slot)
        {
            const FVector3f N = FVector3f::CrossProduct(Positions[Vertices[C]] - Positions[Vertices[A]],
                Positions[Vertices[B]] - Positions[Vertices[A]]).GetSafeNormal();
            TArray<FVertexInstanceID, TInlineAllocator<3>> Corners;
            for (const int Index : {A, B, C})
            {
                const int Y = Index % (Side + 1), Z = Index / (Side + 1);
                const auto V = Description.CreateVertexInstance(Vertices[Index]); Corners.Add(V);
                const FVector2f UV(float(Y) / Side, float(Z) / Side);
                const FColor Encoded(32 + Y * 6, 32 + Z * 6, 32 + (Y + Z) * 3, 255);
                // StaticMeshBuilder converts authored linear colors to sRGB
                // bytes. Nanite decodes those stored bytes as UNORM attributes.
                const FVector4f Color(float(Encoded.R) / 255, float(Encoded.G) / 255, float(Encoded.B) / 255, 1);
                Normals[V] = N; Signs[V] = 1; UVs.Set(V, 0, UV); Colors[V] = FVector4f(FLinearColor(Encoded));
                const auto P = Positions[Vertices[Index]];
                Source.Append({P.X, P.Y, P.Z, UV.X, UV.Y, Color.X, Color.Y, Color.Z});
            }
            Description.CreateTriangle(Groups[Slot], Corners);
        };
        for (int Z = 0; Z < Side; ++Z) for (int Y = 0; Y < Side; ++Y)
        {
            const int A = Z * (Side + 1) + Y, B = A + Side + 1, Slot = Y < Side / 2 ? 0 : 1;
            Triangle(A, A + 1, B, Slot); Triangle(A + 1, B + 1, B, Slot);
        }
        auto* Package = CreatePackage(TEXT("/Game/WebNaniteProgrammable/NaniteWPOPlane"));
        auto* Mesh = NewObject<UStaticMesh>(Package, TEXT("NaniteWPOPlane"), RF_Public | RF_Standalone);
        Mesh->AddSourceModel(); auto& Build = Mesh->GetSourceModel(0).BuildSettings;
        Build.bRecomputeNormals = false; Build.bRecomputeTangents = true; Build.bGenerateLightmapUVs = false;
        Mesh->CreateMeshDescription(0, Description); Mesh->CommitMeshDescription(0);
        for (int I = 0; I < 2; ++I) Mesh->GetStaticMaterials().Add(FStaticMaterial(WPOMaterial, Slots[I], Slots[I]));
        auto& Settings = Mesh->GetNaniteSettings(); Settings.bEnabled = true;
        Settings.TargetMinimumResidencyInKB = 32768; Settings.PositionPrecision = 10;
        Settings.FallbackPercentTriangles = 1; Settings.FallbackRelativeError = 0;
        Mesh->Build(true); FAssetCompilingManager::Get().FinishAllCompilation();
        const auto* Data = Mesh->GetRenderData(); if (!Data || !Data->NaniteResourcesPtr) return 1;
        const auto& Resource = *Data->NaniteResourcesPtr;
        if (!Resource.NumRootPages || Resource.HasStreamingData() || Resource.NumInputTriangles != Side * Side * 2) return 1;
        if (!SaveFixture(Mesh)) return 1;
        if (!FFileHelper::SaveArrayToFile(TArrayView<const uint8>(reinterpret_cast<const uint8*>(Source.GetData()),
            Source.Num() * sizeof(float)), *(Output / TEXT("wpo-source-triangles.bin")))) return 1;
    }
    auto Report = MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), Passed && Cases.Num() == 44); Report->SetArrayField(TEXT("cases"), Cases);
    FString Json; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    FFileHelper::SaveStringToFile(Json, *(Output / TEXT("verified.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return Passed ? 0 : 1;
}
