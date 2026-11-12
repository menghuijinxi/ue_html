#include "CoreMinimal.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "StaticMeshResources.h"
#include "Rendering/NaniteResources.h"
#include "UObject/StrongObjectPtr.h"
#include <emscripten.h>

namespace
{
struct FWebEligibilityComponent
{
    TWeakObjectPtr<UStaticMeshComponent> Component;
    TStrongObjectPtr<UStaticMesh> Mesh;
    bool Disallow, ForceDisable, Visible;
    explicit FWebEligibilityComponent(UStaticMeshComponent* C)
        : Component(C), Mesh(C->GetStaticMesh()), Disallow(C->IsDisallowNanite()),
          ForceDisable(C->IsForceDisableNanite()), Visible(C->IsVisible()) {}
};
TArray<FWebEligibilityComponent> WebEligibilityComponents;
}

// Diagnostic component changes only. Preserve authored assets, restore original
// mesh references/flags, and let the ordinary component lifecycle rebuild proxies.
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteEligibilityTest(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (Mode < -1 || Mode > 5 || !GEngine) return 0;
    UWorld* World = nullptr;
    for (const auto& Context : GEngine->GetWorldContexts())
        if (Context.WorldType == EWorldType::Game) World = Context.World();
    if (!World) return 0;
    if (WebEligibilityComponents.IsEmpty())
    {
        if (Mode < 0) return 0;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            TInlineComponentArray<UStaticMeshComponent*> Components(*It);
            for (auto* Component : Components)
            {
                const UStaticMesh* Mesh = Component->GetStaticMesh();
                const auto* Data = Mesh ? Mesh->GetRenderData() : nullptr;
                if (Data && Data->NaniteResourcesPtr && Data->NaniteResourcesPtr->NumClusters)
                    WebEligibilityComponents.Emplace(Component);
            }
        }
    }
    UStaticMesh* OrdinaryMesh = Mode == 5 ? LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube")) : nullptr;
    if (Mode == 5 && (!OrdinaryMesh || OrdinaryMesh->HasValidNaniteData())) return 0;
    int Changed = 0;
    for (auto& Saved : WebEligibilityComponents)
        if (auto* Component = Saved.Component.Get())
        {
            UStaticMesh* Mesh = Mode == 5 ? OrdinaryMesh : Saved.Mesh.Get();
            const bool ReplaceMesh = Component->GetStaticMesh() != Mesh;
            const bool Registered = Component->IsRegistered();
            if (ReplaceMesh && Registered) Component->UnregisterComponent();
            if (ReplaceMesh) { Component->SetStaticMesh(Mesh); check(Component->GetStaticMesh() == Mesh); }
            const bool Disallow = Mode == 1 || Mode == 3 || Saved.Disallow;
            const bool DisallowChanged = Component->IsDisallowNanite() != Disallow;
            Component->bDisallowNanite = Disallow;
            Component->SetForceDisableNanite(Mode == 2 || Mode == 3 || Saved.ForceDisable);
            Component->SetVisibility(Mode == 4 ? false : Saved.Visible);
            // The runtime setter must schedule its own proxy recreation. Only
            // the authored direct field assignment needs an explicit dirty mark.
            if (DisallowChanged) Component->MarkRenderStateDirty();
            if (ReplaceMesh && Registered) Component->RegisterComponentWithWorld(World);
            ++Changed;
        }
    MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteEligibility = ({mode:$0,components:$1,ordinaryMesh:!!$2});}, Mode, Changed, OrdinaryMesh != nullptr);
    if (Mode < 0) WebEligibilityComponents.Empty();
    return Changed;
}
