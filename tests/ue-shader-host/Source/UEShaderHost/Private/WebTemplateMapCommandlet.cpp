#include "WebTemplateMapCommandlet.h"

#include "Components/LightComponent.h"
#include "Components/SceneComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Level.h"
#include "Engine/StaticMesh.h"
#include "Engine/TextureCube.h"
#include "Engine/World.h"
#include "Materials/Material.h"
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
            Components.Add(MakeShared<FJsonValueObject>(Entry));
        }
        Item->SetArrayField(TEXT("components"), Components);
        Actors.Add(MakeShared<FJsonValueObject>(Item));
    }
    Result->SetArrayField(TEXT("actors"), Actors);
    Result->SetBoolField(TEXT("pass"), !Actors.IsEmpty());
    FString Json;
    FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json, *Output) ? 0 : 1;
}
