#pragma once

#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture2D.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/Pawn.h"
#include "Materials/Material.h"
#include "Materials/MaterialInstanceDynamic.h"

static void CreateWebRenderScene(UWorld* World)
{
    UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    UMaterialInterface* Material = LoadObject<UMaterialInterface>(nullptr,
        TEXT("/Engine/EngineMaterials/Widget3DPassThrough_Opaque.Widget3DPassThrough_Opaque"));
    check(Mesh && Material);
    AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>();
    check(Actor);
    UStaticMeshComponent* Component = Actor->GetStaticMeshComponent();
    Component->SetMobility(EComponentMobility::Movable);
    Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    Component->SetCastShadow(false);
    Component->SetStaticMesh(Mesh);
    UMaterialInstanceDynamic* Instance = UMaterialInstanceDynamic::Create(Material, Actor);
    UTexture2D* Texture = LoadObject<UTexture2D>(nullptr,
        TEXT("/Engine/EngineMaterials/DefaultDiffuse.DefaultDiffuse"));
    check(Texture);
    Instance->SetTextureParameterValue(TEXT("SlateUI"), Texture);
    Instance->SetVectorParameterValue(TEXT("TintColorAndOpacity"), FLinearColor(0.05f, 0.7f, 0.3f));
    Component->SetMaterial(0, Instance);
    Actor->SetActorScale3D(FVector(2.0f));
    Actor->SetActorRotation(FRotator(0.0f, 20.0f, 0.0f));
    ACameraActor* Camera = World->SpawnActor<ACameraActor>();
    check(Camera);
    Camera->SetActorLocation(FVector(400.0f, -550.0f, 350.0f));
    Camera->SetActorRotation((-Camera->GetActorLocation()).Rotation());
    Camera->GetCameraComponent()->SetFieldOfView(50.0f);
    Camera->GetCameraComponent()->bConstrainAspectRatio = false;
    APlayerController* Controller = World->GetFirstPlayerController();
    check(Controller);
    if (APawn* Pawn = Controller->GetPawn())
        Pawn->SetActorHiddenInGame(true);
    Controller->SetViewTarget(Camera);
    std::printf("P3_RENDER_SCENE {\"meshes\":1,\"asset\":\"/Engine/BasicShapes/Cube\","
        "\"material\":\"/Engine/EngineMaterials/Widget3DPassThrough_Opaque\",\"unlit\":%s,\"camera\":true}\n",
        Material->GetMaterial()->GetShadingModels().HasShadingModel(MSM_Unlit) ? "true" : "false");
}
