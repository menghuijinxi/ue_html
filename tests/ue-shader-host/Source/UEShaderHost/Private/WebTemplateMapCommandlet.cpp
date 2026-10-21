#include "WebTemplateMapCommandlet.h"

#include "Components/LightComponent.h"
#include "Components/SceneComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/TextureCube.h"
#include "Engine/VolumeTexture.h"
#include "Engine/World.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionFeatureLevelSwitch.h"
#include "UObject/UObjectIterator.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"

UWebTemplateMapCommandlet::UWebTemplateMapCommandlet()
{
    IsClient = false;
    IsServer = false;
    IsEditor = true;
    LogToConsole = true;
}

int32 UWebTemplateMapCommandlet::Main(const FString& Params)
{
    FString Map = TEXT("/Engine/Maps/Templates/Template_Default");
    FString Output;
    FParse::Value(*Params, TEXT("Map="), Map);
    if (!FParse::Value(*Params, TEXT("Output="), Output))
        return 1;
    UPackage* Package = LoadPackage(nullptr, *Map, LOAD_None);
    UWorld* World = Package ? UWorld::FindWorldInPackage(Package) : nullptr;
    if (!World || !World->PersistentLevel)
        return 1;
    TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("map"), Map);
    TArray<TSharedPtr<FJsonValue>> Actors;
    for (AActor* Actor : World->PersistentLevel->Actors)
    {
        if (!Actor)
            continue;
        TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("name"), Actor->GetName());
        Item->SetStringField(TEXT("class"), Actor->GetClass()->GetPathName());
        Item->SetStringField(TEXT("location"), Actor->GetActorLocation().ToString());
        Item->SetStringField(TEXT("rotation"), Actor->GetActorRotation().ToString());
        TArray<TSharedPtr<FJsonValue>> Components;
        for (UActorComponent* Component : Actor->GetComponents())
        {
            if (!Component)
                continue;
            TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("name"), Component->GetName());
            Entry->SetStringField(TEXT("class"), Component->GetClass()->GetPathName());
            if (USceneComponent* Scene = Cast<USceneComponent>(Component))
            {
                Entry->SetStringField(TEXT("relativeTransform"), Scene->GetRelativeTransform().ToString());
            }
            if (UStaticMeshComponent* Mesh = Cast<UStaticMeshComponent>(Component))
            {
                Entry->SetStringField(TEXT("mesh"), GetPathNameSafe(Mesh->GetStaticMesh()));
                TArray<TSharedPtr<FJsonValue>> Materials;
                for (UMaterialInterface* Material : Mesh->GetMaterials())
                {
                    TSharedRef<FJsonObject> Info = MakeShared<FJsonObject>();
                    Info->SetStringField(TEXT("path"), GetPathNameSafe(Material));
                    if (Material)
                    {
                        Info->SetNumberField(TEXT("blendMode"), Material->GetBlendMode());
                        Info->SetBoolField(TEXT("unlit"), Material->GetShadingModels().HasShadingModel(MSM_Unlit));
                    }
                    Materials.Add(MakeShared<FJsonValueObject>(Info));
                }
                Entry->SetArrayField(TEXT("materials"), Materials);
            }
            if (ULightComponent* Light = Cast<ULightComponent>(Component))
            {
                Entry->SetNumberField(TEXT("intensity"), Light->Intensity);
                Entry->SetBoolField(TEXT("castShadows"), Light->CastShadows);
                Entry->SetNumberField(TEXT("mobility"), int32(Light->Mobility));
            }
            if (USkyLightComponent* Sky = Cast<USkyLightComponent>(Component))
            {
                Entry->SetNumberField(TEXT("intensity"), Sky->Intensity);
                Entry->SetNumberField(TEXT("sourceType"), int32(Sky->SourceType));
                Entry->SetStringField(TEXT("cubemap"), GetPathNameSafe(Sky->Cubemap));
                Entry->SetBoolField(TEXT("realtimeCapture"), Sky->bRealTimeCapture);
                Entry->SetNumberField(TEXT("mobility"), int32(Sky->Mobility));
            }
            if (UVolumetricCloudComponent* Cloud = Cast<UVolumetricCloudComponent>(Component))
            {
                UMaterialInterface* Material = Cloud->Material.LoadSynchronous();
                Entry->SetStringField(TEXT("material"), GetPathNameSafe(Material));
                Entry->SetNumberField(TEXT("layerBottomAltitudeKm"), Cloud->LayerBottomAltitude);
                Entry->SetNumberField(TEXT("layerHeightKm"), Cloud->LayerHeight);
                if (Material)
                {
                    Entry->SetNumberField(TEXT("materialDomain"), Material->GetMaterial()->MaterialDomain);
                    Entry->SetBoolField(TEXT("usedWithVolumetricCloud"), Material->GetMaterial()->bUsedWithVolumetricCloud);
                    const UMaterial* Base = Material->GetMaterial();
                    const UMaterialEditorOnlyData* Editor = Base->GetEditorOnlyData();
                    Entry->SetBoolField(TEXT("extinctionActive"), Material->IsPropertyActive(MP_SubsurfaceColor));
                    Entry->SetStringField(TEXT("extinctionInput"), GetPathNameSafe(Editor->SubsurfaceColor.Expression));
                    Entry->SetStringField(TEXT("frontMaterialInput"), GetPathNameSafe(Editor->FrontMaterial.Expression));
                    TSet<const UTexture*> Textures;
                    Material->GetReferencedTexturesAndOverrides(Textures);
                    TArray<TSharedPtr<FJsonValue>> Inventory;
                    for (const UTexture* Texture : Textures)
                    {
                        TSharedRef<FJsonObject> Info = MakeShared<FJsonObject>();
                        Info->SetStringField(TEXT("path"), Texture->GetPathName());
                        Info->SetStringField(TEXT("class"), Texture->GetClass()->GetName());
                        Info->SetBoolField(TEXT("sRGB"), Texture->SRGB);
                        if (const UVolumeTexture* Volume = Cast<UVolumeTexture>(Texture))
                        {
                            Info->SetNumberField(TEXT("sizeX"), Volume->GetSizeX());
                            Info->SetNumberField(TEXT("sizeY"), Volume->GetSizeY());
                            Info->SetNumberField(TEXT("sizeZ"), Volume->GetSizeZ());
                            Info->SetNumberField(TEXT("mips"), Volume->GetNumMips());
                        }
                        Inventory.Add(MakeShared<FJsonValueObject>(Info));
                    }
                    Entry->SetArrayField(TEXT("textures"), Inventory);
                }
            }
            if (UExponentialHeightFogComponent* Fog = Cast<UExponentialHeightFogComponent>(Component))
            {
                Entry->SetNumberField(TEXT("density"), Fog->FogDensity);
                Entry->SetNumberField(TEXT("heightFalloff"), Fog->FogHeightFalloff);
                Entry->SetBoolField(TEXT("volumetricFog"), Fog->bEnableVolumetricFog);
                Entry->SetNumberField(TEXT("volumetricDistance"), Fog->VolumetricFogDistance);
            }
            Components.Add(MakeShared<FJsonValueObject>(Entry));
        }
        Item->SetArrayField(TEXT("components"), Components);
        Actors.Add(MakeShared<FJsonValueObject>(Item));
    }
    Result->SetArrayField(TEXT("actors"), Actors);
    TArray<TSharedPtr<FJsonValue>> Switches;
    for (TObjectIterator<UMaterialExpressionFeatureLevelSwitch> It; It; ++It)
    {
        TSharedRef<FJsonObject> Info = MakeShared<FJsonObject>();
        Info->SetStringField(TEXT("path"), It->GetPathName());
        Info->SetStringField(TEXT("default"), GetPathNameSafe(It->Default.GetTracedInput().Expression));
        Info->SetStringField(TEXT("es31"), GetPathNameSafe(It->Inputs[ERHIFeatureLevel::ES3_1].GetTracedInput().Expression));
        Info->SetStringField(TEXT("sm5"), GetPathNameSafe(It->Inputs[ERHIFeatureLevel::SM5].GetTracedInput().Expression));
        Switches.Add(MakeShared<FJsonValueObject>(Info));
    }
    Result->SetArrayField(TEXT("featureLevelSwitches"), Switches);
    Result->SetBoolField(TEXT("pass"), !Actors.IsEmpty());
    FString Json;
    FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json, *Output) ? 0 : 1;
}
