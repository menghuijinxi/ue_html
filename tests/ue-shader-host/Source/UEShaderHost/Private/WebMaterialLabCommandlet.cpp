#include "WebMaterialLabCommandlet.h"

#include "AssetCompilingManager.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Level.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "GameFramework/PlayerStart.h"
#include "GameFramework/WorldSettings.h"
#include "HAL/FileManager.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace
{
bool SaveAsset(UObject* Asset, bool Map = false)
{
    const FString Filename = FPackageName::LongPackageNameToFilename(
        Asset->GetOutermost()->GetName(),
        Map ? FPackageName::GetMapPackageExtension() : FPackageName::GetAssetPackageExtension());
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
    FSavePackageArgs Args;
    Args.TopLevelFlags = RF_Public | RF_Standalone;
    return UPackage::SavePackage(Asset->GetOutermost(), Asset, *Filename, Args);
}

UMaterial* MakeMaterial(const FString& Name, FLinearColor Color,
    float Metallic, float Roughness, float Specular, float Opacity, bool Translucent = false)
{
    UPackage* Package = CreatePackage(*(TEXT("/Game/MaterialLab/") + Name));
    // These generated packages are replaced in full, including on repeated builds.
    Package->MarkAsFullyLoaded();
    UMaterial* Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone);
    Material->SetShadingModel(MSM_DefaultLit);
    Material->BlendMode = Translucent ? BLEND_Translucent : BLEND_Opaque;
    Material->TranslucencyLightingMode = TLM_SurfacePerPixelLighting;
    Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
    auto* Base = NewObject<UMaterialExpressionConstant3Vector>(Material);
    Base->Constant = Color;
    Material->GetExpressionCollection().AddExpression(Base);
    Material->GetEditorOnlyData()->BaseColor.Connect(0, Base);
    const auto Scalar = [Material](FExpressionInput& Input, float Value) {
        auto* Node = NewObject<UMaterialExpressionConstant>(Material);
        Node->R = Value;
        Material->GetExpressionCollection().AddExpression(Node);
        Input.Connect(0, Node);
    };
    Scalar(Material->GetEditorOnlyData()->Metallic, Metallic);
    Scalar(Material->GetEditorOnlyData()->Roughness, Roughness);
    Scalar(Material->GetEditorOnlyData()->Specular, Specular);
    Scalar(Material->GetEditorOnlyData()->Opacity, Opacity);
    Material->PostEditChange();
    check(SaveAsset(Material));
    return Material;
}

AStaticMeshActor* Mesh(UWorld* World, const FString& Name, UStaticMesh* Shape,
    UMaterialInterface* Material, FVector Position, FVector Scale, bool Shadows = true)
{
    FActorSpawnParameters Params;
    Params.Name = *Name;
    auto* Actor = World->SpawnActor<AStaticMeshActor>(Params);
    check(Actor);
    Actor->SetActorLabel(Name);
    auto* Component = Actor->GetStaticMeshComponent();
    Component->SetMobility(EComponentMobility::Movable);
    Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    Component->SetStaticMesh(Shape);
    Component->SetMaterial(0, Material);
    Component->SetCastShadow(Shadows);
    Actor->SetActorLocation(Position);
    Actor->SetActorScale3D(Scale);
    return Actor;
}
}

UWebMaterialLabCommandlet::UWebMaterialLabCommandlet()
{
    IsClient = false;
    IsServer = false;
    IsEditor = true;
    LogToConsole = true;
}

int32 UWebMaterialLabCommandlet::Main(const FString& Params)
{
    FString Output;
    if (!FParse::Value(*Params, TEXT("Output="), Output))
        return 1;
    const TCHAR* Template = TEXT("/Engine/Maps/Templates/Template_Default");
    UPackage* Source = LoadPackage(nullptr, Template, LOAD_None);
    UWorld* Original = Source ? UWorld::FindWorldInPackage(Source) : nullptr;
    if (!Original)
        return 1;
    UPackage* Package = CreatePackage(TEXT("/Game/WebMaterialLab"));
    Package->MarkAsFullyLoaded();
    UWorld* World = Cast<UWorld>(StaticDuplicateObject(Original, Package, TEXT("WebMaterialLab")));
    if (!World)
        return 1;
    World->SetFlags(RF_Public | RF_Standalone);
    World->WorldType = EWorldType::Editor;
    World->InitWorld(UWorld::InitializationValues().AllowAudioPlayback(false).CreatePhysicsScene(false)
        .CreateNavigation(false).CreateAISystem(false).CreateFXSystem(false));
    World->GetWorldSettings()->bEnableWorldBoundsChecks = false;
    World->UpdateWorldComponents(true, false);

    UStaticMesh* Sphere = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
    UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    check(Sphere && Cube);
    UMaterial* Floor = MakeMaterial(TEXT("M_Floor"), FLinearColor(0.32f, 0.32f, 0.32f), 0, 0.75f, 0.5f, 1);
    const FVector Eye(0, -1450, 1450);
    const FRotator Rotation = (FVector(0, 0, 60) - Eye).Rotation();
    for (AActor* Actor : World->PersistentLevel->Actors)
    {
        if (!Actor)
            continue;
        if (auto* Start = Cast<APlayerStart>(Actor))
            Start->SetActorLocationAndRotation(Eye, Rotation);
        if (auto* Light = Actor->FindComponentByClass<UDirectionalLightComponent>())
        {
            Light->DynamicShadowDistanceMovableLight = 6000;
            Light->DynamicShadowCascades = 4;
        }
        if (auto* Static = Cast<AStaticMeshActor>(Actor);
            Static && Static->GetStaticMeshComponent()->GetStaticMesh() &&
            Static->GetStaticMeshComponent()->GetStaticMesh()->GetName() != TEXT("SM_SkySphere"))
        {
            Static->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
            Static->GetStaticMeshComponent()->SetStaticMesh(Cube);
            Static->GetStaticMeshComponent()->SetMaterial(0, Floor);
            Static->SetActorLocation(FVector(0, 0, -25));
            Static->SetActorScale3D(FVector(22, 22, 0.5));
        }
    }
    auto* Exposure = World->SpawnActor<APostProcessVolume>();
    Exposure->bUnbound = true;
    Exposure->Priority = 100;
    Exposure->Settings.bOverride_AutoExposureMinBrightness = true;
    Exposure->Settings.bOverride_AutoExposureMaxBrightness = true;
    Exposure->Settings.AutoExposureMinBrightness = 0;
    Exposure->Settings.AutoExposureMaxBrightness = 0;
    Exposure->Settings.bOverride_AutoExposureBias = true;
    Exposure->Settings.AutoExposureBias = 0;
    Exposure->Settings.bOverride_BloomIntensity = true;
    Exposure->Settings.BloomIntensity = 0;
    Exposure->SetActorLabel(TEXT("Lab_FixedExposure_EV100_0"));

    const float Roughness[] = {0.05f, 0.25f, 0.6f, 1.0f};
    const float Specular[] = {0, 0.25f, 0.5f, 1};
    const float Opacity[] = {0.15f, 0.35f, 0.65f, 1};
    TArray<TSharedPtr<FJsonValue>> Samples;
    for (int32 Row = 0; Row < 4; ++Row)
        for (int32 Column = 0; Column < 4; ++Column)
        {
            const FString Name = FString::Printf(TEXT("M_Lab_%d_%d"), Row, Column);
            const float M = Row == 1 ? 1 : 0;
            const float R = Row < 2 ? Roughness[Column] : 0.12f;
            const float S = Row == 2 ? Specular[Column] : 0.5f;
            const float A = Row == 3 ? Opacity[Column] : 1;
            const FLinearColor Color = Row == 3 ? FLinearColor(0.08f, 0.3f, 0.65f) :
                FLinearColor(0.5f, 0.5f, 0.5f);
            UMaterial* Material = MakeMaterial(Name, Color, M, R, S, A, Row == 3);
            const FVector Position((1.5 - Column) * 230, (Row - 1.5) * 260, 75);
            Mesh(World, TEXT("Lab_Sphere_") + Name, Sphere, Material, Position, FVector(1.5));
            auto Item = MakeShared<FJsonObject>();
            Item->SetNumberField(TEXT("row"), Row);
            Item->SetNumberField(TEXT("column"), Column);
            Item->SetStringField(TEXT("material"), Material->GetPathName());
            Item->SetNumberField(TEXT("metallic"), M);
            Item->SetNumberField(TEXT("roughness"), R);
            Item->SetNumberField(TEXT("specular"), S);
            Item->SetNumberField(TEXT("opacity"), A);
            Item->SetBoolField(TEXT("translucent"), Row == 3);
            Samples.Add(MakeShared<FJsonValueObject>(Item));
        }
    UMaterial* White = MakeMaterial(TEXT("M_White"), FLinearColor(0.8f, 0.8f, 0.8f), 0, 0.8f, 0.5f, 1);
    UMaterial* Red = MakeMaterial(TEXT("M_Red"), FLinearColor(0.65f, 0.025f, 0.025f), 0, 0.8f, 0.5f, 1);
    for (int32 Stripe = 0; Stripe < 12; ++Stripe)
        Mesh(World, FString::Printf(TEXT("Lab_Transparency_Backdrop_%d"), Stripe), Cube,
            Stripe % 2 ? White : Red, FVector((Stripe - 5.5) * 80, 510, 100),
            FVector(0.8, 0.15, 2), false);
    Mesh(World, TEXT("Lab_Shadow_Pillar"), Cube, White, FVector(650, -100, 150), FVector(0.8, 0.8, 3));
    Mesh(World, TEXT("Lab_Shadow_FloatingSphere"), Sphere, White, FVector(650, 180, 200), FVector(1.5));
    FAssetCompilingManager::Get().FinishAllCompilation();
    const bool Saved = SaveAsset(World, true);
    auto Manifest = MakeShared<FJsonObject>();
    Manifest->SetStringField(TEXT("map"), TEXT("/Game/WebMaterialLab"));
    Manifest->SetStringField(TEXT("sourceMap"), Template);
    Manifest->SetNumberField(TEXT("exposureEV100"), 0);
    Manifest->SetArrayField(TEXT("samples"), Samples);
    Manifest->SetStringField(TEXT("camera"), FString::Printf(TEXT("%g,%g,%g,%g,%g"),
        Eye.X, Eye.Y, Eye.Z, Rotation.Pitch, Rotation.Yaw));
    FString JSON;
    FJsonSerializer::Serialize(Manifest, TJsonWriterFactory<>::Create(&JSON));
    const bool ManifestSaved = FFileHelper::SaveStringToFile(JSON, *Output);
    UE_LOG(LogTemp, Display, TEXT("WEB_MATERIAL_LAB: saved=%d samples=%d manifest=%s"), Saved, Samples.Num(), *Output);
    World->CleanupWorld();
    return Saved && ManifestSaved ? 0 : 1;
}
