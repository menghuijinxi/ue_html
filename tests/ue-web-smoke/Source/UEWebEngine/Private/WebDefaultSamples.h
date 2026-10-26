#pragma once

#include "UObject/UnrealType.h"

namespace WebDefaultSamples
{
static TArray<TWeakObjectPtr<UObject>> OriginalObjects;
static TArray<TWeakObjectPtr<AStaticMeshActor>> Spheres;

static FString Configuration()
{
    FString Result;
    for (const auto& Object : OriginalObjects)
    {
        check(Object.IsValid());
        Result += Object->GetPathName();
        for (TFieldIterator<FProperty> It(Object->GetClass()); It; ++It)
            if (It->HasAnyPropertyFlags(CPF_Edit) && !It->HasAnyPropertyFlags(CPF_Transient))
            {
                Result += It->GetName() + TEXT("=");
                for (int32 Index = 0; Index < It->ArrayDim; ++Index)
                    It->ExportText_InContainer(Index, Result, Object.Get(), nullptr, Object.Get(), PPF_None);
                Result += TEXT("\n");
            }
        if (const auto* Actor = Cast<AActor>(Object.Get()))
            Result += Actor->GetActorTransform().ToString();
    }
    return Result;
}

static bool Unchanged(const FString& Before)
{
    return !OriginalObjects.IsEmpty() && Before == Configuration();
}

static void Create(UWorld* World, APlayerController* Controller)
{
    check(Controller && Controller->GetPawn());
    FVector FloorOrigin = FVector::ZeroVector;
    float FloorZ = 0;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        OriginalObjects.Add(*It);
        for (UActorComponent* Component : (*It)->GetComponents())
            OriginalObjects.Add(Component);
        TInlineComponentArray<UStaticMeshComponent*> Components(*It);
        for (const auto* Component : Components)
            if (Component->GetStaticMesh() &&
                Component->GetStaticMesh()->GetName() == TEXT("SM_Template_Map_Floor"))
            {
                FloorOrigin = Component->Bounds.Origin;
                FloorZ = Component->Bounds.GetBox().Max.Z;
            }
    }
    const FString Before = Configuration();
    const FVector Eye = Controller->GetPawn()->GetActorLocation();
    const FRotator Rotation = Controller->GetControlRotation();
    const FRotator Heading(0, Rotation.Yaw, 0);
    const FVector Forward = Heading.Vector();
    const FVector Right = FRotationMatrix(Heading).GetUnitAxis(EAxis::Y);
    UStaticMesh* Sphere = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
    check(Sphere);
    const float Radius = 120;
    for (int32 Row = 0; Row < 2; ++Row)
        for (int32 Column = 0; Column < 4; ++Column)
        {
            const FString Name = FString::Printf(TEXT("M_Default_%d_%d"), Row, Column);
            const FString Path = TEXT("/Game/DefaultTemplateSamples/") + Name + TEXT(".") + Name;
            auto* Material = LoadObject<UMaterialInterface>(nullptr, *Path);
            check(Material && Material->GetShadingModels().HasShadingModel(MSM_DefaultLit));
            auto* Actor = World->SpawnActor<AStaticMeshActor>();
            check(Actor);
            auto* Component = Actor->GetStaticMeshComponent();
            Component->SetMobility(EComponentMobility::Movable);
            Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
            Component->SetStaticMesh(Sphere);
            Component->SetMaterial(0, Material);
            Component->SetCastShadow(true);
            FVector Position = Eye + Forward * (1550 + Row * 850) + Right * ((Column - 1.5) * 370);
            Position.Z = FloorZ + Radius;
            Actor->SetActorLocation(Position);
            Actor->SetActorScale3D(FVector(Radius / 50));
            Spheres.Add(Actor);
            EM_ASM({
                const state = globalThis.__webDefaultSamples ||= {samples: []};
                state.samples.push({row: $0, column: $1, material: UTF8ToString($2),
                    metallic: $0, roughness: [0.05, 0.25, 0.6, 1][$1], specular: 0.5,
                    x: $3, y: $4, z: $5, radius: $6});
            }, Row, Column, TCHAR_TO_UTF8(*Path), Position.X, Position.Y, Position.Z, double(Radius));
        }
    const bool Preserved = Unchanged(Before);
    check(Preserved);
    EM_ASM({
        Object.assign(globalThis.__webDefaultSamples, {count: $0, visible: true, sceneUnchanged: !!$1,
            camera: {x: $2, y: $3, z: $4, pitch: $5, yaw: $6, fov: $7},
            floor: {x: $8, y: $9, z: $10, top: $11}});
    }, Spheres.Num(), Preserved, Eye.X, Eye.Y, Eye.Z, Rotation.Pitch, Rotation.Yaw,
        double(Controller->PlayerCameraManager->GetFOVAngle()), FloorOrigin.X, FloorOrigin.Y,
        FloorOrigin.Z, double(FloorZ));
}

static int Visibility(int Visible)
{
    if (Spheres.Num() != 8 || (Visible != 0 && Visible != 1))
        return 0;
    // Compare across this operation; normal world ticks can evolve runtime properties.
    const FString Before = Configuration();
    APlayerController* Controller = Spheres[0].IsValid() ?
        Spheres[0]->GetWorld()->GetFirstPlayerController() : nullptr;
    if (!Controller)
        return 0;
    int32 Index = 0;
    for (const auto& Sphere : Spheres)
    {
        if (!Sphere.IsValid())
            return 0;
        Sphere->SetActorHiddenInGame(!Visible);
        FVector2D Center, Edge;
        const FVector Right = FRotationMatrix(Controller->GetControlRotation()).GetUnitAxis(EAxis::Y);
        if (!Controller->ProjectWorldLocationToScreen(Sphere->GetActorLocation(), Center) ||
            !Controller->ProjectWorldLocationToScreen(Sphere->GetActorLocation() + Right * 120, Edge))
            return 0;
        EM_ASM({
            globalThis.__webDefaultSamples.samples[$0].screen = ({x: $1, y: $2, radius: $3});
        }, Index++, Center.X, Center.Y, double(FVector2D::Distance(Center, Edge)));
    }
    const bool Preserved = Unchanged(Before);
    int32 Width = 0, Height = 0;
    Controller->GetViewportSize(Width, Height);
    EM_ASM({
        globalThis.__webDefaultSamples.visible = !!$0;
        globalThis.__webDefaultSamples.sceneUnchanged = !!$1;
        globalThis.__webDefaultSamples.viewport = ({width: $2, height: $3, viewFOV: $4});
    }, Visible, Preserved, Width, Height, double(Controller->PlayerCameraManager->GetCameraCacheView().FOV));
    return Preserved ? 1 : 0;
}
}
