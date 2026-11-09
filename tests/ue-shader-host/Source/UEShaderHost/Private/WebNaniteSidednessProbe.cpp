#include "CoreMinimal.h"
#include "AssetCompilingManager.h"
#include "Engine/StaticMesh.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "Rendering/NaniteResources.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshResources.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

// An open surface with different sidedness in adjacent material slots. Closed
// solids cannot expose a missing backface test: their front shell hides it.
int32 RunWebNaniteSidednessProbe(const FString& Params)
{
    FString Directory, Output;
    if (!FParse::Value(*Params, TEXT("FixtureDirectory="), Directory) ||
        !FParse::Value(*Params, TEXT("Output="), Output)) return 1;
    IFileManager::Get().MakeDirectory(*Directory, true);
    IFileManager::Get().MakeDirectory(*Output, true);
    auto Save = [&Directory](UObject* Asset)
    {
        FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone;
        return UPackage::SavePackage(Asset->GetOutermost(), Asset,
            *(Directory / (Asset->GetName() + TEXT(".uasset"))), Args);
    };
    UMaterial* Materials[2];
    for (int32 I = 0; I < 2; ++I)
    {
        const FString Name = I ? TEXT("NaniteTwoSided") : TEXT("NaniteOneSided");
        auto* Package = CreatePackage(*(TEXT("/Game/WebNaniteSidedness/") + Name));
        auto*& Material = Materials[I];
        Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone);
        Material->AddToRoot(); Material->SetShadingModel(MSM_DefaultLit);
        Material->TwoSided = I != 0; Material->SetMaterialUsage(MATUSAGE_Nanite);
        Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
        auto* Color = NewObject<UMaterialExpressionVectorParameter>(Material);
        Color->ParameterName = TEXT("SurfaceColor");
        Color->DefaultValue = I ? FLinearColor(.1f, .7f, .2f) : FLinearColor(.7f, .1f, .2f);
        Material->GetExpressionCollection().AddExpression(Color);
        Material->GetEditorOnlyData()->BaseColor.Connect(0, Color);
        Material->UpdateCachedExpressionData();
        if (!Save(Material)) return 1;
    }
    FMeshDescription Description; FStaticMeshAttributes Attributes(Description); Attributes.Register();
    auto Positions = Attributes.GetVertexPositions(); auto Normals = Attributes.GetVertexInstanceNormals();
    auto UVs = Attributes.GetVertexInstanceUVs(); UVs.SetNumChannels(1);
    auto Colors = Attributes.GetVertexInstanceColors(); auto Signs = Attributes.GetVertexInstanceBinormalSigns();
    FPolygonGroupID Groups[2] = {Description.CreatePolygonGroup(), Description.CreatePolygonGroup()};
    const FName Slots[2] = {TEXT("OneSided"), TEXT("TwoSided")};
    for (int32 I = 0; I < 2; ++I) Attributes.GetPolygonGroupMaterialSlotNames()[Groups[I]] = Slots[I];
    constexpr int32 Side = 32;
    TArray<FVertexID> Vertices;
    for (int32 Z = 0; Z <= Side; ++Z) for (int32 Y = 0; Y <= Side; ++Y)
    {
        const auto V = Description.CreateVertex(); Vertices.Add(V);
        // A small corrugation retains fine triangles for compute raster tests.
        const float X = .75f * FMath::Sin(float(Y) * .9f) * FMath::Sin(float(Z) * .8f);
        Positions[V] = FVector3f(X, float(Y) * 200 / Side - 100, float(Z) * 200 / Side - 100);
    }
    TArray<float> SourceTriangles;
    auto Triangle = [&](int32 A, int32 B, int32 C, int32 Slot)
    {
        // Match StaticMeshOperations' left-handed mesh winding convention.
        const FVector3f Normal = FVector3f::CrossProduct(Positions[Vertices[C]] - Positions[Vertices[A]],
            Positions[Vertices[B]] - Positions[Vertices[A]]).GetSafeNormal();
        TArray<FVertexInstanceID, TInlineAllocator<3>> Corners;
        for (const int32 Index : {A, B, C})
        {
            const auto V = Description.CreateVertexInstance(Vertices[Index]); Corners.Add(V);
            Normals[V] = Normal; Colors[V] = FVector4f(1, 1, 1, 1); Signs[V] = 1;
            UVs.Set(V, 0, FVector2f(float(Index % (Side + 1)) / Side, float(Index / (Side + 1)) / Side));
            const auto P = Positions[Vertices[Index]];
            SourceTriangles.Append({P.X, P.Y, P.Z, float(Slot)});
        }
        Description.CreateTriangle(Groups[Slot], Corners);
    };
    for (int32 Z = 0; Z < Side; ++Z) for (int32 Y = 0; Y < Side; ++Y)
    {
        const int32 A = Z * (Side + 1) + Y, B = A + Side + 1, Slot = Y < Side / 2 ? 0 : 1;
        Triangle(A, A + 1, B, Slot); Triangle(A + 1, B + 1, B, Slot);
    }
    auto* Package = CreatePackage(TEXT("/Game/WebNaniteSidedness/NaniteMixedSidedPlane"));
    auto* Mesh = NewObject<UStaticMesh>(Package, TEXT("NaniteMixedSidedPlane"), RF_Public | RF_Standalone);
    Mesh->AddSourceModel(); auto& Build = Mesh->GetSourceModel(0).BuildSettings;
    Build.bRecomputeNormals = false; Build.bRecomputeTangents = true; Build.bGenerateLightmapUVs = false;
    Mesh->CreateMeshDescription(0, Description); Mesh->CommitMeshDescription(0);
    for (int32 I = 0; I < 2; ++I) Mesh->GetStaticMaterials().Add(FStaticMaterial(Materials[I], Slots[I], Slots[I]));
    auto& Settings = Mesh->GetNaniteSettings(); Settings.bEnabled = true;
    Settings.TargetMinimumResidencyInKB = 32768; Settings.PositionPrecision = 10;
    Settings.FallbackPercentTriangles = 0; Settings.FallbackRelativeError = 1;
    Mesh->Build(true); FAssetCompilingManager::Get().FinishAllCompilation();
    const auto* Data = Mesh->GetRenderData(); if (!Data || !Data->NaniteResourcesPtr) return 1;
    const auto& Resource = *Data->NaniteResourcesPtr;
    if (!Resource.NumRootPages || Resource.HasStreamingData() || Resource.NumInputTriangles != Side * Side * 2) return 1;
    if (!Save(Mesh)) return 1;
    if (!FFileHelper::SaveArrayToFile(TArrayView<const uint8>(reinterpret_cast<const uint8*>(SourceTriangles.GetData()),
        SourceTriangles.Num() * sizeof(float)), *(Output / TEXT("source-triangles.bin")))) return 1;
    auto Report = MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), true);
    Report->SetStringField(TEXT("asset"), Mesh->GetPathName());
    Report->SetNumberField(TEXT("triangles"), Resource.NumInputTriangles);
    Report->SetNumberField(TEXT("clusters"), Resource.NumClusters);
    Report->SetNumberField(TEXT("roots"), Resource.NumRootPages);
    Report->SetNumberField(TEXT("slots"), 2);
    FString Json; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json, *(Output / TEXT("asset.json"))) ? 0 : 1;
}
