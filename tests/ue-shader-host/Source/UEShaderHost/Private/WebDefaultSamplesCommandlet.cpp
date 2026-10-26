#include "WebDefaultSamplesCommandlet.h"

#include "AssetCompilingManager.h"
#include "Dom/JsonObject.h"
#include "DynamicMeshToMeshDescription.h"
#include "Engine/StaticMesh.h"
#include "Generators/SphereGenerator.h"
#include "HAL/FileManager.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshResources.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

UWebDefaultSamplesCommandlet::UWebDefaultSamplesCommandlet()
{
    IsClient = false;
    IsServer = false;
    IsEditor = true;
    LogToConsole = true;
}

int32 UWebDefaultSamplesCommandlet::Main(const FString& Params)
{
    FString Output;
    if (!FParse::Value(*Params, TEXT("Output="), Output))
        return 1;
    // Dense geometry avoids the coarse shadow terminator of Engine/BasicShapes/Sphere.
    UE::Geometry::FSphereGenerator Generator;
    Generator.Radius = 50;
    Generator.NumTheta = 128;
    Generator.NumPhi = 65;
    Generator.Generate();
    UE::Geometry::FDynamicMesh3 DynamicMesh(&Generator);
    FMeshDescription Description;
    FStaticMeshAttributes(Description).Register();
    FDynamicMeshToMeshDescription().Convert(&DynamicMesh, Description);
    UPackage* SpherePackage = CreatePackage(TEXT("/Game/DefaultTemplateSamples/SM_TestSphere"));
    SpherePackage->MarkAsFullyLoaded();
    auto* Sphere = NewObject<UStaticMesh>(SpherePackage, TEXT("SM_TestSphere"), RF_Public | RF_Standalone);
    Sphere->GetStaticMaterials().Add(FStaticMaterial());
    Sphere->SetNumSourceModels(1);
    auto& Build = Sphere->GetSourceModel(0).BuildSettings;
    Build.bRecomputeNormals = false;
    Build.bRecomputeTangents = true;
    Build.bGenerateLightmapUVs = false;
    UStaticMesh::FBuildMeshDescriptionsParams BuildParams;
    BuildParams.bFastBuild = false;
    if (!Sphere->BuildFromMeshDescriptions({&Description}, BuildParams))
        return 1;
    const FString SphereFilename = FPackageName::LongPackageNameToFilename(
        SpherePackage->GetName(), FPackageName::GetAssetPackageExtension());
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(SphereFilename), true);
    FSavePackageArgs SphereSave;
    SphereSave.TopLevelFlags = RF_Public | RF_Standalone;
    if (!UPackage::SavePackage(SpherePackage, Sphere, *SphereFilename, SphereSave))
        return 1;
    const float Roughness[] = {0.05f, 0.25f, 0.6f, 1.0f};
    TArray<TSharedPtr<FJsonValue>> Samples;
    for (int32 Row = 0; Row < 2; ++Row)
        for (int32 Column = 0; Column < 4; ++Column)
        {
            const FString Name = FString::Printf(TEXT("M_Default_%d_%d"), Row, Column);
            UPackage* Package = CreatePackage(*(TEXT("/Game/DefaultTemplateSamples/") + Name));
            Package->MarkAsFullyLoaded();
            auto* Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone);
            Material->SetShadingModel(MSM_DefaultLit);
            Material->BlendMode = BLEND_Opaque;
            Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
            auto* Base = NewObject<UMaterialExpressionConstant3Vector>(Material);
            Base->Constant = FLinearColor(0.5f, 0.5f, 0.5f);
            Material->GetExpressionCollection().AddExpression(Base);
            Material->GetEditorOnlyData()->BaseColor.Connect(0, Base);
            const auto Scalar = [Material](FExpressionInput& Input, float Value) {
                auto* Node = NewObject<UMaterialExpressionConstant>(Material);
                Node->R = Value;
                Material->GetExpressionCollection().AddExpression(Node);
                Input.Connect(0, Node);
            };
            Scalar(Material->GetEditorOnlyData()->Metallic, float(Row));
            Scalar(Material->GetEditorOnlyData()->Roughness, Roughness[Column]);
            Scalar(Material->GetEditorOnlyData()->Specular, 0.5f);
            Material->PostEditChange();
            const FString Filename = FPackageName::LongPackageNameToFilename(
                Package->GetName(), FPackageName::GetAssetPackageExtension());
            IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
            FSavePackageArgs Save;
            Save.TopLevelFlags = RF_Public | RF_Standalone;
            if (!UPackage::SavePackage(Package, Material, *Filename, Save))
                return 1;
            auto Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("package"), Package->GetName());
            Item->SetStringField(TEXT("material"), Material->GetPathName());
            Item->SetNumberField(TEXT("row"), Row);
            Item->SetNumberField(TEXT("column"), Column);
            Item->SetNumberField(TEXT("metallic"), Row);
            Item->SetNumberField(TEXT("roughness"), Roughness[Column]);
            Item->SetNumberField(TEXT("specular"), 0.5);
            Samples.Add(MakeShared<FJsonValueObject>(Item));
        }
    FAssetCompilingManager::Get().FinishAllCompilation();
    auto Manifest = MakeShared<FJsonObject>();
    Manifest->SetArrayField(TEXT("samples"), Samples);
    // Generate additive assets only; never load, duplicate or save the source world.
    Manifest->SetBoolField(TEXT("worldUnmodified"), true);
    Manifest->SetStringField(TEXT("meshPackage"), SpherePackage->GetName());
    Manifest->SetStringField(TEXT("mesh"), Sphere->GetPathName());
    Manifest->SetNumberField(TEXT("meshTriangles"), Sphere->GetRenderData()->LODResources[0].GetNumTriangles());
    FString JSON;
    FJsonSerializer::Serialize(Manifest, TJsonWriterFactory<>::Create(&JSON));
    return FFileHelper::SaveStringToFile(JSON, *Output) ? 0 : 1;
}
