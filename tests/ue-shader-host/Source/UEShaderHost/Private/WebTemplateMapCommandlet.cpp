#include "WebTemplateMapCommandlet.h"

#include "AssetCompilingManager.h"
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
#include "Engine/PostProcessVolume.h"
#include "SceneInterface.h"
#include "RenderingThread.h"
#include "Serialization/MemoryWriter.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionFeatureLevelSwitch.h"
#include "UObject/UObjectIterator.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"

UWebTemplateMapCommandlet::UWebTemplateMapCommandlet()
{
    IsClient = true;
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
    bool InitializedForCapture = false;
    ON_SCOPE_EXIT
    {
        if (InitializedForCapture)
        {
            World->CleanupWorld();
            FlushRenderingCommands();
        }
    };
    FString SkyCaptureOutput;
    if (FParse::Value(*Params, TEXT("SkyCaptureOutput="), SkyCaptureOutput))
    {
        World->WorldType = EWorldType::Editor;
        World->InitWorld(UWorld::InitializationValues().AllowAudioPlayback(false)
            .CreatePhysicsScene(false).CreateNavigation(false).CreateAISystem(false));
        InitializedForCapture = true;
        World->UpdateWorldComponents(true, false);
        FAssetCompilingManager::Get().FinishAllCompilation();
        FlushRenderingCommands();
        TArray<USkyLightComponent*> Skies;
        for (AActor* Actor : World->PersistentLevel->Actors)
            if (Actor)
                for (UActorComponent* Component : Actor->GetComponents())
                    if (auto* Sky = Cast<USkyLightComponent>(Component);
                        Sky && Sky->GetVisibleFlag() && Sky->SourceType == SLS_SpecifiedCubemap && Sky->Cubemap)
                        Skies.Add(Sky);
        TArray<uint8> Bytes;
        FMemoryWriter Writer(Bytes);
        uint32 Magic = 0x57425348, Version = 1;
        int32 Count = Skies.Num();
        Writer << Magic << Version << Count;
        for (USkyLightComponent* Sky : Skies)
        {
            FString Component = Sky->GetPathName();
            FString Cubemap = Sky->Cubemap->GetPathName();
            int32 Resolution = Sky->CubemapResolution;
            float Angle = Sky->SourceCubemapAngle;
            bool LowerBlack = Sky->bLowerHemisphereIsBlack;
            FLinearColor LowerColor = Sky->LowerHemisphereColor;
            float Brightness = 0.0f;
            FSHVectorRGB3 Irradiance;
            FLinearColor Scale = FLinearColor::White;
            World->Scene->UpdateSkyCaptureContents(Sky, Sky->bCaptureEmissiveOnly,
                Sky->Cubemap, nullptr, Brightness, Irradiance, nullptr, &Scale);
            FlushRenderingCommands();
            if (!FMath::IsFinite(Brightness) || Brightness <= 0.0f)
            {
                UE_LOG(LogTemp, Error, TEXT("WEB_SKY_CAPTURE: invalid brightness=%g component=%s client=%d featureLevel=%d"),
                    Brightness, *Component, GIsClient, int32(World->GetFeatureLevel()));
                return 1;
            }
            Writer << Component << Cubemap << Resolution << Angle << LowerBlack << LowerColor;
            Writer << Brightness << Irradiance << Scale;
            UE_LOG(LogTemp, Display, TEXT("WEB_SKY_CAPTURE: component=%s brightness=%g sh0=(%g,%g,%g)"),
                *Component, Brightness, Irradiance.R.V[0], Irradiance.G.V[0], Irradiance.B.V[0]);
        }
        if (Writer.IsError() || !FFileHelper::SaveArrayToFile(Bytes, *SkyCaptureOutput))
            return 1;
    }
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
        if (auto* Volume = Cast<APostProcessVolume>(Actor))
        {
            const FPostProcessSettings& Settings = Volume->Settings;
            Item->SetBoolField(TEXT("unbound"), Volume->bUnbound);
            Item->SetNumberField(TEXT("exposureMethod"), int32(Settings.AutoExposureMethod));
            Item->SetNumberField(TEXT("exposureBias"), Settings.AutoExposureBias);
            Item->SetNumberField(TEXT("exposureMin"), Settings.AutoExposureMinBrightness);
            Item->SetNumberField(TEXT("exposureMax"), Settings.AutoExposureMaxBrightness);
            Item->SetBoolField(TEXT("overrideExposureMethod"), Settings.bOverride_AutoExposureMethod);
            Item->SetBoolField(TEXT("overrideExposureBias"), Settings.bOverride_AutoExposureBias);
            Item->SetBoolField(TEXT("overrideExposureMin"), Settings.bOverride_AutoExposureMinBrightness);
            Item->SetBoolField(TEXT("overrideExposureMax"), Settings.bOverride_AutoExposureMaxBrightness);
        }
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
