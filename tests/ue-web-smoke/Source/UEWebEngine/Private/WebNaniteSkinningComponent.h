#pragma once
#include "CoreMinimal.h"
#include "Components/PoseableMeshComponent.h"
#include "WebNaniteSkinningComponent.generated.h"

struct FWebSkinningPoseSnapshot
{
    uint32 Frame = MAX_uint32;
    FMatrix Bones[2] = {FMatrix::Identity, FMatrix::Identity};
    FMatrix PreviousBones[2] = {FMatrix::Identity, FMatrix::Identity};
};
extern FWebSkinningPoseSnapshot GWebSkinningPoses[2];

// The component uses the ordinary poseable-mesh skinning path. This subclass
// only records authored transforms when native dynamic data is submitted.
UCLASS(Transient)
class UWebNaniteSkinningComponent : public UPoseableMeshComponent
{
    GENERATED_BODY()
public:
    int32 TestIndex = 0;
    FTransform AuthoredBones[2] = {FTransform::Identity, FTransform::Identity};
    void SetTestPose(const FTransform& Root, const FTransform& Bend);
    virtual void CreateRenderState_Concurrent(FRegisterComponentContext* Context) override;
    virtual void SendRenderDynamicData_Concurrent() override;
private:
    void RecordPose();
};
