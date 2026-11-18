#include "WebNaniteSkinningComponent.h"
#include "RenderingThread.h"

FWebSkinningPoseSnapshot GWebSkinningPoses[2];

void UWebNaniteSkinningComponent::SetTestPose(const FTransform& Root, const FTransform& Bend)
{
    AuthoredBones[0] = Root; AuthoredBones[1] = Bend;
    SetBoneTransformByName(TEXT("Root"), Root, EBoneSpaces::ComponentSpace);
    SetBoneTransformByName(TEXT("Bend"), Bend, EBoneSpaces::ComponentSpace);
    // The ordinary component tick refreshes this dirty pose once. Refreshing
    // here as well would flip its previous-pose buffer twice in the same frame.
}

void UWebNaniteSkinningComponent::RecordPose()
{
    if (!SceneProxy) return;
    const int32 Index = TestIndex;
    const FMatrix Root = AuthoredBones[0].ToMatrixWithScale();
    const FMatrix Bend = AuthoredBones[1].ToMatrixWithScale();
    ENQUEUE_RENDER_COMMAND(RecordWebSkinningPose)([Index, Root, Bend](FRHICommandListImmediate&) {
        auto& Pose = GWebSkinningPoses[Index];
        if (Pose.Frame != GFrameNumberRenderThread)
        {
            Pose.PreviousBones[0] = Pose.Bones[0]; Pose.PreviousBones[1] = Pose.Bones[1];
        }
        Pose.Frame = GFrameNumberRenderThread; Pose.Bones[0] = Root; Pose.Bones[1] = Bend;
    });
}

void UWebNaniteSkinningComponent::CreateRenderState_Concurrent(FRegisterComponentContext* Context)
{
    Super::CreateRenderState_Concurrent(Context);
    RecordPose();
}

void UWebNaniteSkinningComponent::SendRenderDynamicData_Concurrent()
{
    Super::SendRenderDynamicData_Concurrent();
    RecordPose();
}
