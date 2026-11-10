#if !WEB_NANITE_GPU_TEST_SHADER_ONLY
#include "WebNaniteGPUComponent.h"
#endif
#include "GlobalShader.h"
#include "GPUSceneWriter.h"
#include "RenderGraphUtils.h"
#include "ShaderCompilerCore.h"

class FWebNaniteGPUInstanceTestCS : public FGlobalShader
{
    DECLARE_GLOBAL_SHADER(FWebNaniteGPUInstanceTestCS);
    SHADER_USE_PARAMETER_STRUCT(FWebNaniteGPUInstanceTestCS, FGlobalShader);
    BEGIN_SHADER_PARAMETER_STRUCT(FParameters, )
        SHADER_PARAMETER_STRUCT_INCLUDE(FGPUSceneWriterParameters, GPUSceneWriterParameters)
        SHADER_PARAMETER(uint32, WebTestFirst)
        SHADER_PARAMETER(uint32, WebTestPrimitive)
        SHADER_PARAMETER(uint32, WebTestFlags)
        SHADER_PARAMETER(uint32, WebTestCount)
        SHADER_PARAMETER(uint32, WebTestStep)
        SHADER_PARAMETER(float, WebTestPhase)
        SHADER_PARAMETER(float, WebTestPreviousPhase)
        SHADER_PARAMETER(FVector3f, WebTestBoundsCenter)
        SHADER_PARAMETER(FVector3f, WebTestBoundsExtent)
    END_SHADER_PARAMETER_STRUCT()
    static bool ShouldCompilePermutation(const FGlobalShaderPermutationParameters& P)
    { return FDataDrivenShaderPlatformInfo::GetName(P.Platform) == FName(TEXT("SP_WEBGPU_SM5")); }
    static void ModifyCompilationEnvironment(const FGlobalShaderPermutationParameters& P, FShaderCompilerEnvironment& E)
    {
        FGlobalShader::ModifyCompilationEnvironment(P, E);
        E.SetDefine(TEXT("VF_SUPPORTS_PRIMITIVE_SCENE_DATA"), 1);
        E.CompilerFlags.Add(CFLAG_HLSL2021);
    }
};
IMPLEMENT_GLOBAL_SHADER(FWebNaniteGPUInstanceTestCS, "/Engine/Private/Nanite/WebNaniteGPUInstanceTest.usf", "WriteInstancesCS", SF_Compute);

#if !WEB_NANITE_GPU_TEST_SHADER_ONLY
#include "StaticMeshSceneProxy.h"
#include "InstanceDataSceneProxy.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "SceneInterface.h"
#include "PrimitiveSceneDesc.h"
#include "Rendering/NaniteWebScene.h"

namespace
{
class FWebGPUStaticMeshSceneProxy final : public FStaticMeshSceneProxy
{
    FInstanceSceneDataBuffers GPUInstances;
    FVector2f DrawDistance;
public:
    explicit FWebGPUStaticMeshSceneProxy(UWebNaniteGPUComponent* Component)
        : FStaticMeshSceneProxy(Component, false), GPUInstances(true), DrawDistance(Component->GPUInstanceDistance)
    {
        FInstanceSceneDataBuffers::FAccessTag Tag(PointerHash(this));
        auto Data = GPUInstances.BeginWriteAccess(Tag);
        GPUInstances.SetPrimitiveLocalToWorld(Component->GetRenderMatrix(), Tag);
        Data.NumInstancesGPUOnly = Component->GPUInstanceCount;
        Data.InstanceLocalBounds.SetNum(1);
        Data.InstanceLocalBounds[0] = Component->GetStaticMesh()->GetBounds();
        Data.Flags.bHasPerInstanceDynamicData = true;
        Data.Flags.bHasPerInstanceLocalBounds = true;
        GPUInstances.EndWriteAccess(Tag); GPUInstances.ValidateData();
        SetupInstanceSceneDataBuffers(&GPUInstances);
        bAlwaysHasVelocity = true;
        check(GPUInstances.IsInstanceDataGPUOnly());
        check(GPUInstances.GetReadView().InstanceToPrimitiveRelative.IsEmpty());
    }
    virtual bool GetInstanceDrawDistanceMinMax(FVector2f& Out) const override
    { Out = DrawDistance; return DrawDistance.Y > 0; }
    virtual void CreateRenderThreadResources(FRHICommandListBase& RHICmdList) override
    {
        FStaticMeshSceneProxy::CreateRenderThreadResources(RHICmdList);
        Nanite::SetWebInstanceDrawDistance(this, DrawDistance);
    }
};
}
FPrimitiveSceneProxy* UWebNaniteGPUComponent::CreateSceneProxy()
{
    return GetStaticMesh() && GetStaticMesh()->GetRenderData() ? new FWebGPUStaticMeshSceneProxy(this) : nullptr;
}
FBoxSphereBounds UWebNaniteGPUComponent::CalcBounds(const FTransform& LocalToWorld) const
{
    // CPU knows only a conservative primitive envelope, not per-instance poses.
    return FBoxSphereBounds(FBox(FVector(-3000), FVector(3000))).TransformBy(LocalToWorld);
}
FWebGPUInstanceTestFrame GWebGPUInstanceTestFrame;
uint32 GWebGPUInstanceWriterFirst = MAX_uint32, GWebGPUInstanceWriterPrimitive = MAX_uint32;
uint32 GWebGPUInstanceWriterRenderFrame = MAX_uint32;
FRDGBufferRef GWebGPUInstanceWriterSnapshot = nullptr, GWebGPUInstanceWriterSource = nullptr;
FUintVector3 GWebGPUInstanceWriterLayout;
bool GWebGPUInstanceSnapshotAfterWrite = false;
bool GWebGPUInstanceLegacyWriter = false;
static void SubmitWebGPUInstances(UWebNaniteGPUComponent* Component, FWebGPUInstanceTestFrame Frame)
{
    if (!Component || !Component->IsRegistered() || !Component->SceneProxy || !Frame.Count) return;
    FPrimitiveSceneDesc Primitive;
    Primitive.SceneProxy = Component->SceneProxy;
    const auto Bounds = Component->GetStaticMesh()->GetBounds();
    Component->GetWorld()->Scene->UpdatePrimitiveInstancesFromCompute(&Primitive,
        FGPUSceneWriteDelegate::CreateLambda([Frame, Bounds](FRDGBuilder& Graph, const FGPUSceneWriteDelegateParams& Writer)
        {
            GWebGPUInstanceTestFrame = Frame;
            GWebGPUInstanceWriterRenderFrame = GFrameNumberRenderThread;
            GWebGPUInstanceWriterFirst = Writer.InstanceSceneDataOffset;
            GWebGPUInstanceWriterPrimitive = Writer.PersistentPrimitiveId;
            auto* P = Graph.AllocParameters<FWebNaniteGPUInstanceTestCS::FParameters>();
            // SM5 uses the native loose UAV/common-parameter writer layout.
            // The legacy struct also carries the opaque UB on other platforms.
            PRAGMA_DISABLE_DEPRECATION_WARNINGS
            P->GPUSceneWriterParameters = Writer.GPUWriteParams;
            PRAGMA_ENABLE_DEPRECATION_WARNINGS
            P->WebTestFirst = Writer.InstanceSceneDataOffset; P->WebTestPrimitive = Writer.PersistentPrimitiveId;
            P->WebTestFlags = Writer.PackedInstanceSceneDataFlags; P->WebTestCount = Frame.Count;
            P->WebTestStep = Frame.Step; P->WebTestPhase = Frame.Phase; P->WebTestPreviousPhase = Frame.PreviousPhase;
            P->WebTestBoundsCenter = FVector3f(Bounds.Origin); P->WebTestBoundsExtent = FVector3f(Bounds.BoxExtent);
            FComputeShaderUtils::AddPass(Graph, RDG_EVENT_NAME("Nanite.Web.TestGPUWriter"),
                TShaderMapRef<FWebNaniteGPUInstanceTestCS>(GetGlobalShaderMap(GMaxRHIShaderPlatform)), P,
                FIntVector(FMath::DivideAndRoundUp(Frame.Count, 64u), 1, 1));
            GWebGPUInstanceWriterSource = P->GPUSceneWriterParameters.GPUSceneInstanceSceneDataRW->Desc.Buffer;
            const auto& Layout = P->GPUSceneWriterParameters.CommonParameters;
            GWebGPUInstanceWriterLayout = FUintVector3(Layout.GPUSceneInstanceDataTileSizeLog2,
                Layout.GPUSceneInstanceDataTileSizeMask, Layout.GPUSceneInstanceDataTileStride);
            GWebGPUInstanceWriterSnapshot = nullptr;
            if (GWebGPUInstanceSnapshotAfterWrite)
            {
            GWebGPUInstanceWriterSnapshot = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(16, Frame.Count * 4), TEXT("Nanite.Web.GPUWriterSnapshot"));
            for (uint32 I = 0; I < Frame.Count; ++I) for (uint32 Row = 0; Row < 4; ++Row)
            {
                const uint32 ID = Writer.InstanceSceneDataOffset + I;
                const uint32 SourceIndex = GWebGPUInstanceWriterLayout.Z * (ID >> GWebGPUInstanceWriterLayout.X) +
                    (Row << GWebGPUInstanceWriterLayout.X) + (ID & GWebGPUInstanceWriterLayout.Y);
                AddCopyBufferPass(Graph, GWebGPUInstanceWriterSnapshot, (I * 4 + Row) * 16, GWebGPUInstanceWriterSource, SourceIndex * 16, 16);
            }
            }
        }));
}
void UWebNaniteGPUComponent::CreateRenderState_Concurrent(FRegisterComponentContext* Context)
{
    Super::CreateRenderState_Concurrent(Context);
    // Recreating a proxy discards commands queued against the previous proxy.
    // Initialize GPU-owned instances after the replacement has joined the scene.
    if (!GWebGPUInstanceLegacyWriter) FRegisterComponentContext::SendRenderDynamicData(Context, this);
}
void UWebNaniteGPUComponent::SendRenderDynamicData_Concurrent()
{
    Super::SendRenderDynamicData_Concurrent();
    if (!GWebGPUInstanceLegacyWriter) SubmitWebGPUInstances(this, GPUFrame);
}
void WriteWebGPUInstances(UWebNaniteGPUComponent* Component, FWebGPUInstanceTestFrame Frame)
{
    if (!Component) return;
    Component->GPUFrame = Frame;
    if (GWebGPUInstanceLegacyWriter) SubmitWebGPUInstances(Component, Frame);
    else Component->MarkRenderDynamicDataDirty();
}
#endif

