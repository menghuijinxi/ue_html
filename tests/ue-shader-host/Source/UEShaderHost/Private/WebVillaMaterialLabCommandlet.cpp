#include "WebVillaMaterialLabCommandlet.h"

#include "AssetCompilingManager.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture.h"
#include "Engine/World.h"
#include "GameFramework/PlayerStart.h"
#include "HAL/FileManager.h"
#include "Materials/MaterialInterface.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace
{
TArray<TSharedPtr<FJsonValue>> VectorJSON(const FVector& Value)
{
    return {MakeShared<FJsonValueNumber>(Value.X), MakeShared<FJsonValueNumber>(Value.Y),
        MakeShared<FJsonValueNumber>(Value.Z)};
}

TArray<TSharedPtr<FJsonValue>> CameraJSON(const FVector& Eye, const FVector& Target)
{
    const FRotator Rotation = (Target - Eye).Rotation();
    auto Values = VectorJSON(Eye);
    Values.Add(MakeShared<FJsonValueNumber>(Rotation.Pitch));
    Values.Add(MakeShared<FJsonValueNumber>(Rotation.Yaw));
    return Values;
}
}

UWebVillaMaterialLabCommandlet::UWebVillaMaterialLabCommandlet()
{
    IsClient = false;
    IsServer = false;
    IsEditor = true;
    LogToConsole = true;
}

int32 UWebVillaMaterialLabCommandlet::Main(const FString& Params)
{
    FString Output;
    if (!FParse::Value(*Params, TEXT("Output="), Output))
        return 1;
    const TCHAR* SourceMap = TEXT("/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla");
    const TCHAR* TemplateMap = TEXT("/Engine/Maps/Templates/Template_Default");
    const TCHAR* TargetMap = TEXT("/Game/WebVillaMaterialLab");
    auto LoadWorld = [](const TCHAR* Name) {
        UPackage* Package = LoadPackage(nullptr, Name, LOAD_None);
        return Package ? UWorld::FindWorldInPackage(Package) : nullptr;
    };
    UWorld* Villa = LoadWorld(SourceMap);
    UWorld* Template = LoadWorld(TemplateMap);
    if (!Villa || !Template)
        return 1;
    UPackage* Package = CreatePackage(TargetMap);
    Package->MarkAsFullyLoaded();
    UWorld* World = Cast<UWorld>(StaticDuplicateObject(Template, Package, TEXT("WebVillaMaterialLab")));
    if (!World)
        return 1;
    World->SetFlags(RF_Public | RF_Standalone);
    for (UWorld* Scene : {Villa, World})
    {
        Scene->WorldType = EWorldType::Editor;
        Scene->InitWorld(UWorld::InitializationValues().AllowAudioPlayback(false).CreatePhysicsScene(false)
            .CreateNavigation(false).CreateAISystem(false).CreateFXSystem(false));
        Scene->UpdateWorldComponents(true, false);
    }
    FAssetCompilingManager::Get().FinishAllCompilation();

    struct FSample
    {
        const TCHAR* ID;
        const TCHAR* Actor;
        const TCHAR* Mesh;
    };
    const FSample Samples[] = {
        {TEXT("cupboard-door"), TEXT("BP_CupboardDoor_826"), TEXT("SM_CupboardDoor")},
        {TEXT("brick-wall"), TEXT("SM_Home_pCube23_163"), TEXT("SM_Home_pCube23")},
        {TEXT("cupboard-body"), TEXT("SM_CupboardBody_8"), TEXT("SM_CupboardBody")},
        {TEXT("dining-table"), TEXT("SM_DiningTable_9"), TEXT("SM_DiningTable")},
        {TEXT("sink"), TEXT("SM_Sink_32"), TEXT("SM_Sink")},
        {TEXT("pot"), TEXT("SM_Pans_polySurface43_20"), TEXT("SM_Pot")}
    };
    TArray<TSharedPtr<FJsonValue>> Entries;
    for (int32 Index = 0; Index < UE_ARRAY_COUNT(Samples); ++Index)
    {
        const FSample& Sample = Samples[Index];
        UStaticMeshComponent* Source = nullptr;
        for (AActor* Actor : Villa->PersistentLevel->Actors)
            if (Actor && Actor->GetName() == Sample.Actor)
                for (UActorComponent* Component : Actor->GetComponents())
                    if (auto* Mesh = Cast<UStaticMeshComponent>(Component);
                        Mesh && Mesh->GetStaticMesh() && Mesh->GetStaticMesh()->GetName() == Sample.Mesh)
                        Source = Mesh;
        if (!Source)
        {
            UE_LOG(LogTemp, Error, TEXT("WEB_VILLA_LAB: missing %s/%s"), Sample.Actor, Sample.Mesh);
            return 1;
        }
        FActorSpawnParameters Spawn;
        Spawn.Name = *FString::Printf(TEXT("VillaSample_%d"), Index);
        auto* Actor = World->SpawnActor<AStaticMeshActor>(Spawn);
        Actor->SetActorLabel(Sample.ID);
        auto* Mesh = Actor->GetStaticMeshComponent();
        Mesh->SetMobility(EComponentMobility::Movable);
        Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        Mesh->SetStaticMesh(Source->GetStaticMesh());
        Mesh->SetCastShadow(Source->CastShadow);
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("id"), Sample.ID);
        Entry->SetStringField(TEXT("sourceActor"), Sample.Actor);
        Entry->SetStringField(TEXT("mesh"), Source->GetStaticMesh()->GetPathName());
        Entry->SetStringField(TEXT("sourceTransform"), Source->GetComponentTransform().ToString());
        TArray<TSharedPtr<FJsonValue>> Materials;
        for (int32 Slot = 0; Slot < Source->GetNumMaterials(); ++Slot)
        {
            UMaterialInterface* Material = Source->GetMaterial(Slot);
            Mesh->SetMaterial(Slot, Material);
            auto Item = MakeShared<FJsonObject>();
            Item->SetNumberField(TEXT("slot"), Slot);
            Item->SetStringField(TEXT("path"), GetPathNameSafe(Material));
            TArray<TSharedPtr<FJsonValue>> Textures;
            TSet<const UTexture*> Referenced;
            if (Material)
                Material->GetReferencedTexturesAndOverrides(Referenced);
            for (const UTexture* Texture : Referenced)
            {
                auto Info = MakeShared<FJsonObject>();
                Info->SetStringField(TEXT("path"), Texture->GetPathName());
                Info->SetBoolField(TEXT("sRGB"), Texture->SRGB);
                Info->SetNumberField(TEXT("compression"), Texture->CompressionSettings);
                Info->SetNumberField(TEXT("lodBias"), Texture->LODBias);
                Textures.Add(MakeShared<FJsonValueObject>(Info));
            }
            Item->SetArrayField(TEXT("textures"), Textures);
            Materials.Add(MakeShared<FJsonValueObject>(Item));
        }
        Entry->SetArrayField(TEXT("materials"), Materials);
        const FVector Station((Index % 3 - 1) * 1000, Index < 3 ? 450 : -350, 2);
        FTransform Transform = Source->GetComponentTransform();
        const FBox SourceBounds = Source->GetStaticMesh()->GetBoundingBox().TransformBy(Transform);
        Transform.AddToTranslation(Station - FVector(SourceBounds.GetCenter().X,
            SourceBounds.GetCenter().Y, SourceBounds.Min.Z));
        Actor->SetActorTransform(Transform);
        const FBox Bounds = Source->GetStaticMesh()->GetBoundingBox().TransformBy(Transform);
        const FVector Size = Bounds.GetSize();
        const FVector Center = Bounds.GetCenter();
        const FVector Front = Index == 0 || Index == 2 ? FVector(0, 1, 0) :
            Size.X < Size.Y * 0.25 && Size.X < Size.Z * 0.25 ? FVector(-1, 0, 0) : FVector(0, -1, 0);
        const double Depth = FVector::DotProduct(Bounds.GetExtent(), Front.GetAbs());
        const double Span = FMath::Max(Size.X, FMath::Max(Size.Y, Size.Z));
        const bool LowSample = Index >= 3;
        const FVector Eye = Center + Front * (Depth + Span * 0.85 + 65) +
            FVector(0, 0, FMath::Max(Span * (LowSample ? 0.7 : 0.25), 30.0));
        FVector DetailTarget(Center.X, Center.Y, LowSample ? Bounds.Max.Z - 3 :
            FMath::Clamp(Center.Z, Bounds.Min.Z + 5, Bounds.Min.Z + 140));
        if (Index == 0)
            DetailTarget.Z = Bounds.Min.Z + Size.Z * 0.85;
        if (Index == 1)
            DetailTarget.X = Bounds.Min.X + Size.X * 0.2;
        if (Index == 2)
        {
            DetailTarget.X = Bounds.Min.X + Size.X * 0.2;
            DetailTarget.Z = Bounds.Min.Z + Size.Z * 0.4;
        }
        const FVector DetailEye = DetailTarget + Front * (Depth + FMath::Clamp(Span * 0.25, 25.0, 100.0)) +
            FVector(0, 0, FMath::Clamp(Span * (LowSample ? 0.5 : 0.15), 15.0, 90.0));
        Entry->SetArrayField(TEXT("size"), VectorJSON(Size));
        Entry->SetArrayField(TEXT("camera"), CameraJSON(Eye, Center));
        Entry->SetArrayField(TEXT("detailCamera"), CameraJSON(DetailEye, DetailTarget));
        Entry->SetStringField(TEXT("transform"), Transform.ToString());
        Entries.Add(MakeShared<FJsonValueObject>(Entry));
        UE_LOG(LogTemp, Display, TEXT("WEB_VILLA_LAB: sample=%s size=%s slots=%d"),
            Sample.ID, *Size.ToString(), Source->GetNumMaterials());
    }
    const FVector Eye(0, -2200, 1000);
    const FVector Target(0, 100, 160);
    for (AActor* Actor : World->PersistentLevel->Actors)
        if (auto* Start = Cast<APlayerStart>(Actor))
            Start->SetActorLocationAndRotation(Eye, (Target - Eye).Rotation());
    FAssetCompilingManager::Get().FinishAllCompilation();
    const FString Filename = FPackageName::LongPackageNameToFilename(TargetMap,
        FPackageName::GetMapPackageExtension());
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
    FSavePackageArgs Save;
    Save.TopLevelFlags = RF_Public | RF_Standalone;
    const bool Saved = UPackage::SavePackage(Package, World, *Filename, Save);
    auto Manifest = MakeShared<FJsonObject>();
    Manifest->SetStringField(TEXT("map"), TargetMap);
    Manifest->SetStringField(TEXT("sourceMap"), SourceMap);
    Manifest->SetStringField(TEXT("templateMap"), TemplateMap);
    Manifest->SetBoolField(TEXT("templateLightingUnmodified"), true);
    Manifest->SetBoolField(TEXT("sourceMaterialsUnmodified"), true);
    Manifest->SetArrayField(TEXT("camera"), CameraJSON(Eye, Target));
    Manifest->SetArrayField(TEXT("samples"), Entries);
    FString JSON;
    FJsonSerializer::Serialize(Manifest, TJsonWriterFactory<>::Create(&JSON));
    const bool ManifestSaved = FFileHelper::SaveStringToFile(JSON, *Output);
    World->CleanupWorld();
    Villa->CleanupWorld();
    return Saved && ManifestSaved ? 0 : 1;
}
