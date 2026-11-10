#pragma once
#include "CoreMinimal.h"
#include "Components/StaticMeshComponent.h"
#include "RenderGraphFwd.h"
#include "WebNaniteGPUComponent.generated.h"

struct FWebGPUInstanceTestFrame
{
    uint32 Step = 0;
    uint32 Count = 0;
    float Phase = 0;
    float PreviousPhase = 0;
};

UCLASS(Transient)
class UWebNaniteGPUComponent : public UStaticMeshComponent
{
    GENERATED_BODY()
public:
    int32 GPUInstanceCount = 3;
    FVector2f GPUInstanceDistance = FVector2f::ZeroVector;
    FWebGPUInstanceTestFrame GPUFrame;
    virtual FPrimitiveSceneProxy* CreateSceneProxy() override;
    virtual FBoxSphereBounds CalcBounds(const FTransform& LocalToWorld) const override;
    virtual void CreateRenderState_Concurrent(FRegisterComponentContext* Context) override;
    virtual void SendRenderDynamicData_Concurrent() override;
};
extern FWebGPUInstanceTestFrame GWebGPUInstanceTestFrame;
extern uint32 GWebGPUInstanceWriterFirst, GWebGPUInstanceWriterPrimitive;
extern uint32 GWebGPUInstanceWriterRenderFrame;
extern FRDGBufferRef GWebGPUInstanceWriterSnapshot, GWebGPUInstanceWriterSource;
extern FUintVector3 GWebGPUInstanceWriterLayout;
extern bool GWebGPUInstanceSnapshotAfterWrite;
extern bool GWebGPUInstanceLegacyWriter;
void WriteWebGPUInstances(UWebNaniteGPUComponent* Component, FWebGPUInstanceTestFrame Frame);

