#include "CoreMinimal.h"
#include "AssetCompilingManager.h"
#include "Engine/StaticMesh.h"
#include "Materials/Material.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "Rendering/NaniteResources.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshResources.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

// Save real mesh assets so Cook produces the native streamable bulk data and
// the browser exercises package IO, rather than a synthetic in-memory page set.
int32 RunWebNaniteStreamingProbe(const FString& Params)
{
    FString Directory, Output;
    if (!FParse::Value(*Params, TEXT("FixtureDirectory="), Directory) ||
        !FParse::Value(*Params, TEXT("Output="), Output)) return 1;
    IFileManager::Get().MakeDirectory(*Directory, true); IFileManager::Get().MakeDirectory(*Output, true);
    constexpr int32 Latitudes = 128, Longitudes = 256;
    FMeshDescription Description; FStaticMeshAttributes Attributes(Description); Attributes.Register();
    auto Positions = Attributes.GetVertexPositions(); auto Normals = Attributes.GetVertexInstanceNormals();
    auto UVs = Attributes.GetVertexInstanceUVs(); UVs.SetNumChannels(1);
    auto Colors = Attributes.GetVertexInstanceColors(); auto Signs = Attributes.GetVertexInstanceBinormalSigns();
    const auto Group = Description.CreatePolygonGroup(); Attributes.GetPolygonGroupMaterialSlotNames()[Group] = TEXT("Surface");
    TArray<FVertexID> Vertices;
    for (int32 Y = 0; Y <= Latitudes; ++Y) for (int32 X = 0; X <= Longitudes; ++X)
    {
        const double Theta = double(Y) / Latitudes * UE_DOUBLE_PI, Phi = double(X) / Longitudes * 2 * UE_DOUBLE_PI;
        const FVector3f Direction(FMath::Sin(Theta) * FMath::Cos(Phi), FMath::Sin(Theta) * FMath::Sin(Phi), FMath::Cos(Theta));
        const auto V = Description.CreateVertex(); Vertices.Add(V); Positions[V] = Direction * 70.0f;
    }
    auto Triangle = [&](int32 A, int32 B, int32 C)
    {
        TArray<FVertexInstanceID, TInlineAllocator<3>> Corners;
        for (int32 Index : {A, B, C})
        {
            const auto V = Description.CreateVertexInstance(Vertices[Index]); Corners.Add(V);
            Normals[V] = Positions[Vertices[Index]].GetSafeNormal(); Colors[V] = FVector4f(1, 1, 1, 1); Signs[V] = 1;
            UVs.Set(V, 0, FVector2f(float(Index % (Longitudes + 1)) / Longitudes, float(Index / (Longitudes + 1)) / Latitudes));
        }
        Description.CreateTriangle(Group, Corners);
    };
    for (int32 Y = 0; Y < Latitudes; ++Y) for (int32 X = 0; X < Longitudes; ++X)
    {
        const int32 A = Y * (Longitudes + 1) + X, B = A + Longitudes + 1;
        if (Y > 0) Triangle(A, B, A + 1);
        if (Y < Latitudes - 1) Triangle(A + 1, B, B + 1);
    }
    TArray<TSharedPtr<FJsonValue>> Assets;
    for (int32 Variant = 0; Variant < 3; ++Variant)
    {
        const bool Resident = Variant == 1;
        const FString Name = Resident ? TEXT("NaniteResidentSphere") : Variant == 0 ? TEXT("NaniteStreamingSphere") : TEXT("NaniteStreamingSphereB");
        const FString PackageName = TEXT("/Game/WebNaniteStreaming/") + Name;
        auto* Package = CreatePackage(*PackageName);
        auto* Mesh = NewObject<UStaticMesh>(Package, *Name, RF_Public | RF_Standalone);
        Mesh->AddSourceModel(); auto& Build = Mesh->GetSourceModel(0).BuildSettings;
        Build.bRecomputeNormals = false; Build.bRecomputeTangents = true; Build.bGenerateLightmapUVs = false;
        Mesh->CreateMeshDescription(0, Description); Mesh->CommitMeshDescription(0);
        Mesh->GetStaticMaterials().Add(FStaticMaterial(UMaterial::GetDefaultMaterial(MD_Surface), TEXT("Surface"), TEXT("Surface")));
        auto& Settings = Mesh->GetNaniteSettings(); Settings.bEnabled = true;
        Settings.TargetMinimumResidencyInKB = Resident ? 32768 : 0; Settings.PositionPrecision = 10;
        Settings.FallbackPercentTriangles = 0; Settings.FallbackRelativeError = 1;
        Mesh->Build(true); FAssetCompilingManager::Get().FinishAllCompilation();
        const auto* Data = Mesh->GetRenderData(); if (!Data || !Data->NaniteResourcesPtr) return 1;
        const auto& Resource = *Data->NaniteResourcesPtr;
        if (!Resource.NumRootPages || Resource.HasStreamingData() == Resident || Resource.NumInputTriangles < 60000) return 1;
        FSavePackageArgs Save; Save.TopLevelFlags = RF_Public | RF_Standalone;
        const FString File = Directory / Name + TEXT(".uasset");
        if (!UPackage::SavePackage(Package, Mesh, *File, Save)) return 1;
        auto J = MakeShared<FJsonObject>(); J->SetStringField(TEXT("asset"), PackageName + TEXT(".") + Name);
        J->SetStringField(TEXT("file"), File); J->SetBoolField(TEXT("resident"), Resident);
        J->SetNumberField(TEXT("triangles"), Resource.NumInputTriangles); J->SetNumberField(TEXT("clusters"), Resource.NumClusters);
        J->SetNumberField(TEXT("roots"), Resource.NumRootPages); J->SetNumberField(TEXT("pages"), Resource.PageStreamingStates.Num());
        J->SetNumberField(TEXT("dependencies"), Resource.PageDependencies.Num()); J->SetNumberField(TEXT("bulkBytes"), Resource.StreamablePages.GetBulkDataSize());
        J->SetNumberField(TEXT("hierarchyNodes"), Resource.HierarchyNodes.Num());
        Assets.Add(MakeShared<FJsonValueObject>(J));
        UE_LOG(LogTemp, Display, TEXT("WEB_NANITE_STREAMING_ASSET %s triangles=%u roots=%u pages=%d dependencies=%d"),
            *Name, Resource.NumInputTriangles, Resource.NumRootPages, Resource.PageStreamingStates.Num(), Resource.PageDependencies.Num());
    }
    auto Report = MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), true); Report->SetArrayField(TEXT("assets"), Assets);
    FString Json; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json, *(Output / TEXT("assets.json"))) ? 0 : 1;
}
