#include "CoreMinimal.h"
#include "AssetCompilingManager.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Materials/Material.h"
#include "Materials/MaterialInterface.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Rendering/NaniteResources.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshResources.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

// Inspect the actual loaded level and optionally enable Nanite in a separate,
// explicitly named project copy. Materials, actor transforms and lights stay intact.
int32 RunWebNaniteSceneAssets(const FString& Params)
{
    FString Map, Output, AllowedRoot;
    const bool Convert = FParse::Param(*Params, TEXT("EnableNanite"));
    if (!FParse::Value(*Params, TEXT("Map="), Map) || !FParse::Value(*Params, TEXT("Output="), Output)) return 1;
    if (Convert)
    {
        FString ProjectRoot = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
        const bool HasRoot = FParse::Value(*Params, TEXT("NaniteProjectRoot="), AllowedRoot);
        FPaths::NormalizeDirectoryName(ProjectRoot); FPaths::NormalizeDirectoryName(AllowedRoot);
        if (!HasRoot || !FPaths::IsSamePath(ProjectRoot, AllowedRoot) ||
            !FPaths::FileExists(AllowedRoot / TEXT(".web-nanite-project-copy.json")))
        {
            UE_LOG(LogTemp, Error, TEXT("Nanite conversion requires a verified separate project copy: actual=%s requested=%s"), *ProjectRoot, *AllowedRoot);
            return 1;
        }
    }
    auto* Package = LoadPackage(nullptr, *Map, LOAD_None);
    auto* World = Package ? UWorld::FindWorldInPackage(Package) : nullptr;
    if (!World) return 1;
    World->WorldType = EWorldType::Editor;
    World->InitWorld(UWorld::InitializationValues().AllowAudioPlayback(false).CreatePhysicsScene(false)
        .CreateNavigation(false).CreateAISystem(false).CreateFXSystem(false));
    ON_SCOPE_EXIT { World->CleanupWorld(); };
    World->UpdateWorldComponents(true, false);
    FAssetCompilingManager::Get().FinishAllCompilation();
    TMap<UStaticMesh*, int32> MeshUses;
    TSet<UMaterialInterface*> Interfaces;
    int32 Components = 0;
    for (const ULevel* Level : World->GetLevels()) for (const AActor* Actor : Level->Actors) if (Actor)
        for (const UActorComponent* Component : Actor->GetComponents()) if (const auto* MeshComponent = Cast<UStaticMeshComponent>(Component))
        {
            if (UStaticMesh* Mesh = MeshComponent->GetStaticMesh()) { ++MeshUses.FindOrAdd(Mesh); ++Components; }
            for (int I = 0; I < MeshComponent->GetNumMaterials(); ++I) if (auto* Material = MeshComponent->GetMaterial(I)) Interfaces.Add(Material);
        }
    const auto Save = [](UObject* Object)
    {
        UPackage* P = Object->GetOutermost();
        if (!P->GetName().StartsWith(TEXT("/Game/"))) return false;
        FString File;
        if (!FPackageName::DoesPackageExist(P->GetName(), &File)) return false;
        if (!FPaths::IsUnderDirectory(FPaths::ConvertRelativePathToFull(File),
            FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir()))) return false;
        FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone; Args.SaveFlags = SAVE_NoError;
        return UPackage::SavePackage(P, Object, *File, Args);
    };
    TSet<UMaterial*> ChangedMaterials;
    TArray<TSharedPtr<FJsonValue>> Materials;
    for (auto* Interface : Interfaces)
    {
        auto Item = MakeShared<FJsonObject>(); Item->SetStringField(TEXT("path"), Interface->GetPathName());
        const EBlendMode Blend = Interface->GetBlendMode();
        auto* Material = Interface->GetMaterial();
        // NullRHI has no shader resource, so render relevance is empty. Inspect
        // authored properties here; runtime tests inspect compiled relevance.
        Item->SetNumberField(TEXT("blendMode"), int32(Blend));
        Item->SetBoolField(TEXT("masked"), Blend == BLEND_Masked);
        Item->SetBoolField(TEXT("wpoConnected"), Material && Material->HasVertexPositionOffsetConnected());
        Item->SetBoolField(TEXT("pdoConnected"), Material && Material->HasPixelDepthOffsetConnected());
        Item->SetNumberField(TEXT("shadingModels"), Interface->GetShadingModels().GetShadingModelField());
        Item->SetBoolField(TEXT("twoSided"), Interface->IsTwoSided());
        Item->SetBoolField(TEXT("opaque"), Blend == BLEND_Opaque);
        Item->SetStringField(TEXT("base"), Material ? Material->GetPathName() : TEXT(""));
        if (Convert && Material && Material->GetOutermost()->GetName().StartsWith(TEXT("/Game/")) &&
            (Blend == BLEND_Opaque || Blend == BLEND_Masked) && !ChangedMaterials.Contains(Material))
        {
            Material->SetMaterialUsage(MATUSAGE_Nanite);
            Material->SetMaterialUsage(MATUSAGE_InstancedStaticMeshes);
            Material->PostEditChange(); ChangedMaterials.Add(Material);
        }
        Materials.Add(MakeShared<FJsonValueObject>(Item));
    }
    FAssetCompilingManager::Get().FinishAllCompilation();
    for (auto* Material : ChangedMaterials) if (!Save(Material)) return 1;
    TArray<TSharedPtr<FJsonValue>> Meshes;
    for (const auto& Pair : MeshUses)
    {
        auto* Mesh = Pair.Key;
        const bool OriginalNanite = Mesh->GetNaniteSettings().bEnabled;
        const bool Local = Mesh->GetOutermost()->GetName().StartsWith(TEXT("/Game/"));
        if (Convert && Local)
        {
            auto& Settings = Mesh->GetNaniteSettings(); Settings.bEnabled = true; Settings.TargetMinimumResidencyInKB = 32;
            // Preserve a complete fallback for shadow passes and unsupported
            // native material categories; do not change the source geometry.
            Settings.FallbackTarget = ENaniteFallbackTarget::PercentTriangles;
            Settings.FallbackPercentTriangles = 1; Settings.FallbackRelativeError = 0;
            TArray<FText> Errors; Mesh->Build(true, &Errors); FAssetCompilingManager::Get().FinishAllCompilation();
            if (!Errors.IsEmpty() || !Save(Mesh)) return 1;
        }
        const auto* Data = Mesh->GetRenderData(); const auto* Nanite = Data ? Data->NaniteResourcesPtr.Get() : nullptr;
        auto Item = MakeShared<FJsonObject>(); Item->SetStringField(TEXT("path"), Mesh->GetPathName());
        Item->SetNumberField(TEXT("components"), Pair.Value); Item->SetBoolField(TEXT("originalNanite"), OriginalNanite);
        Item->SetBoolField(TEXT("nanite"), Mesh->GetNaniteSettings().bEnabled);
        Item->SetNumberField(TEXT("fallbackTriangles"), Data && !Data->LODResources.IsEmpty() ? Data->LODResources[0].GetNumTriangles() : 0);
        Item->SetNumberField(TEXT("clusters"), Nanite ? Nanite->NumClusters : 0);
        Item->SetNumberField(TEXT("rootPages"), Nanite ? Nanite->NumRootPages : 0);
        Item->SetNumberField(TEXT("pages"), Nanite ? Nanite->PageStreamingStates.Num() : 0);
        Meshes.Add(MakeShared<FJsonValueObject>(Item));
        UE_LOG(LogTemp, Display, TEXT("WEB_NANITE_SCENE_ASSET: %s clusters=%u"), *Mesh->GetPathName(), Nanite ? Nanite->NumClusters : 0);
    }
    auto Report = MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), !Meshes.IsEmpty());
    Report->SetBoolField(TEXT("converted"), Convert); Report->SetStringField(TEXT("map"), Map);
    Report->SetNumberField(TEXT("levels"), World->GetLevels().Num()); Report->SetNumberField(TEXT("components"), Components);
    Report->SetArrayField(TEXT("meshes"), Meshes); Report->SetArrayField(TEXT("materials"), Materials);
    FString JSON; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
    return !Meshes.IsEmpty() && FFileHelper::SaveStringToFile(JSON, *Output) ? 0 : 1;
}
