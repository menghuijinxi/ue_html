#include "CoreMinimal.h"
#include "AssetCompilingManager.h"
#include "Containers/Ticker.h"
#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "GlobalShader.h"
#include "GroomAsset.h"
#include "GroomComponent.h"
#include "HAL/IConsoleManager.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/CommandLine.h"
#include "Misc/CoreDelegates.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "NaniteGroomAsset.h"
#include "PrimitiveSceneProxy.h"
#include "RenderGraphUtils.h"
#include "Rendering/NaniteResources.h"
#include "RHIGPUReadback.h"
#include "SceneRendering.h"
#include "SceneTextures.h"
#include "SceneViewExtension.h"
#include "Serialization/JsonSerializer.h"
#include "Settings/LevelEditorViewportSettings.h"
#include "ShaderCompiler.h"
#include "Slate/SceneViewport.h"

namespace
{
class FWebGroomNativeCaptureCS : public FGlobalShader
{
 DECLARE_GLOBAL_SHADER(FWebGroomNativeCaptureCS);
 SHADER_USE_PARAMETER_STRUCT(FWebGroomNativeCaptureCS,FGlobalShader);
 BEGIN_SHADER_PARAMETER_STRUCT(FParameters,)
  SHADER_PARAMETER(FUintVector2,CaptureSize)
  SHADER_PARAMETER(FUintVector2,CaptureOrigin)
  SHADER_PARAMETER(uint32,CaptureStride)
  SHADER_PARAMETER_RDG_TEXTURE(Texture2D<float>,CaptureDepth)
  SHADER_PARAMETER_RDG_TEXTURE(Texture2D<float4>,CaptureA)
  SHADER_PARAMETER_RDG_TEXTURE(Texture2D<float4>,CaptureB)
  SHADER_PARAMETER_RDG_TEXTURE(Texture2D<float4>,CaptureC)
  SHADER_PARAMETER_RDG_BUFFER_UAV(RWStructuredBuffer<float4>,CaptureOutput)
 END_SHADER_PARAMETER_STRUCT()
 static bool ShouldCompilePermutation(const FGlobalShaderPermutationParameters& P){return P.Platform==SP_PCD3D_SM6;}
};
IMPLEMENT_GLOBAL_SHADER(FWebGroomNativeCaptureCS,"/WebCurveProbe/WebGroomNativeCapture.usf","MainCS",SF_Compute);

TArray<TSharedPtr<FJsonValue>> CaptureMatrix(const FMatrix& M)
{
 TArray<TSharedPtr<FJsonValue>> R;for(int I=0;I<4;++I)for(int J=0;J<4;++J)R.Add(MakeShared<FJsonValueNumber>(M.M[I][J]));return R;
}
FMatrix ReadCaptureMatrix(const TSharedPtr<FJsonObject>& J,const TCHAR* Name)
{
 const auto& V=J->GetArrayField(Name);check(V.Num()==16);FMatrix M;
 for(int I=0;I<4;++I)for(int K=0;K<4;++K)M.M[I][K]=V[I*4+K]->AsNumber();return M;
}
class FWebGroomNativeView : public FSceneViewExtensionBase
{
public:
 FWebGroomNativeView(const FAutoRegister& R):FSceneViewExtensionBase(R){}
 const FRenderTarget* Target=nullptr;
 bool Requested=false;
 uint32 Bytes=0;
 TUniquePtr<FRHIGPUBufferReadback> Readback;
 TSharedPtr<FJsonObject> Metadata;
 virtual void SetupViewFamily(FSceneViewFamily& F)override{if(F.RenderTarget==Target)F.bRealtimeUpdate=true;}
 virtual void PostRenderViewFamily_RenderThread(FRDGBuilder& Graph,FSceneViewFamily& Family)override
 {
  if(!Requested||Family.RenderTarget!=Target||Family.Views.Num()!=1||Family.Views[0]->bIsSceneCapture)return;
  Requested=false;const auto& View=*Family.Views[0];const auto& Textures=static_cast<const FViewFamilyInfo&>(Family).GetSceneTextures();
  check(Textures.GBufferA&&Textures.GBufferB&&Textures.GBufferC&&Textures.Depth.Resolve);
  const FIntRect Rect=static_cast<const FViewInfo&>(View).ViewRect;
  const FUintVector2 Size(FMath::DivideAndRoundUp(uint32(Rect.Width()),8u),FMath::DivideAndRoundUp(uint32(Rect.Height()),8u));
  auto* P=Graph.AllocParameters<FWebGroomNativeCaptureCS::FParameters>();
  P->CaptureSize=Size;P->CaptureOrigin=FUintVector2(Rect.Min.X,Rect.Min.Y);P->CaptureStride=8;
  P->CaptureDepth=Textures.Depth.Resolve;P->CaptureA=Textures.GBufferA;P->CaptureB=Textures.GBufferB;P->CaptureC=Textures.GBufferC;
  auto* Buffer=Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(sizeof(FVector4f),Size.X*Size.Y*4),TEXT("GroomNativeSnapshot"));
  P->CaptureOutput=Graph.CreateUAV(Buffer);
  FComputeShaderUtils::AddPass(Graph,RDG_EVENT_NAME("GroomNativeSnapshot"),TShaderMapRef<FWebGroomNativeCaptureCS>(GetGlobalShaderMap(View.GetFeatureLevel())),P,FIntVector(FMath::DivideAndRoundUp(Size.X*Size.Y,64u),1,1));
  Bytes=Size.X*Size.Y*4*sizeof(FVector4f);Readback=MakeUnique<FRHIGPUBufferReadback>(TEXT("GroomNativeReadback"));
  AddEnqueueCopyPass(Graph,Readback.Get(),Buffer,Bytes);
  Metadata=MakeShared<FJsonObject>();Metadata->SetNumberField(TEXT("width"),Size.X);Metadata->SetNumberField(TEXT("height"),Size.Y);
  Metadata->SetNumberField(TEXT("viewWidth"),Rect.Width());Metadata->SetNumberField(TEXT("viewHeight"),Rect.Height());
  Metadata->SetArrayField(TEXT("worldToClip"),CaptureMatrix(View.ViewMatrices.GetWorldToClip()));
  Metadata->SetArrayField(TEXT("projection"),CaptureMatrix(View.ViewMatrices.GetViewToClip()));
  Metadata->SetNumberField(TEXT("antiAliasingMethod"),int32(View.AntiAliasingMethod));
  Metadata->SetNumberField(TEXT("jitterX"),View.ViewMatrices.GetTemporalAAJitter().X);
  Metadata->SetNumberField(TEXT("jitterY"),View.ViewMatrices.GetTemporalAAJitter().Y);
  Metadata->SetNumberField(TEXT("featureLevel"),int32(View.GetFeatureLevel()));
  Metadata->SetBoolField(TEXT("realtime"),Family.bRealtimeUpdate);
 }
};
TSharedPtr<FWebGroomNativeView,ESPMode::ThreadSafe> CaptureView;
}

void StartWebGroomNativeCapture()
{
 FString Input;if(IsRunningCommandlet()||!FParse::Value(FCommandLine::Get(),TEXT("WebGroomNativeCapture="),Input))return;
 FCoreDelegates::OnFEngineLoopInitComplete.AddLambda([Input]{
  FString Text;check(FFileHelper::LoadFileToString(Text,*Input));TSharedPtr<FJsonObject> Settings;
  check(FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text),Settings));
  CaptureView=FSceneViewExtensions::NewExtension<FWebGroomNativeView>();
  FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([Settings,Index=0,Frames=0,Phase=0,Actors=TArray<AActor*>()](float)mutable{
   auto* Client=GCurrentLevelEditingViewportClient;if(!GEditor||!Client||!Client->Viewport)return true;
   UWorld* World=Client->GetWorld();if(!World||World->GetPackage()->GetName()!=TEXT("/Engine/Maps/Templates/Template_Default"))return true;
   const auto& Tests=Settings->GetArrayField(TEXT("tests"));if(Index>=Tests.Num()){FPlatformMisc::RequestExit(false);return false;}
   const auto Test=Tests[Index]->AsObject();
   if(Phase==0){
    FlushRenderingCommands();CaptureView->Readback.Reset();CaptureView->Metadata.Reset();
    for(auto* Actor:Actors)Actor->Destroy();Actors.Empty();
    for(const auto& Value:Test->GetArrayField(TEXT("entries"))){
     const auto E=Value->AsObject();const FString Name=E->GetStringField(TEXT("assetName"));
     auto* Groom=LoadObject<UGroomAsset>(nullptr,*FString::Printf(TEXT("/Game/WebNaniteCurves/%s.%s"),*Name,*Name));check(Groom);
     auto* Actor=World->SpawnActor<AActor>();auto* Component=NewObject<UGroomComponent>(Actor);Actor->SetRootComponent(Component);Actor->AddInstanceComponent(Component);
     Component->SetMobility(EComponentMobility::Movable);Component->SetGroomAsset(Groom);Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);Component->SetCastShadow(false);
     Component->SetWorldTransform(FTransform(ReadCaptureMatrix(E,TEXT("localToWorld"))));
     const int Step=Test->GetIntegerField(TEXT("step"));const bool Front=E->GetIntegerField(TEXT("component"))==0;
     if(Front&&Step==10){Component->SetMaterial(0,Groom->GetHairGroupsMaterials()[1].Material);Component->SetMaterial(1,Groom->GetHairGroupsMaterials()[0].Material);}
     if(Front&&(Step==24||Step==32)){
      auto* Parent=LoadObject<UMaterialInterface>(nullptr,TEXT("/Game/WebNaniteCurves/NaniteCurveMaterial.NaniteCurveMaterial"));check(Parent);
      auto* Material=UMaterialInstanceDynamic::Create(Parent,Component);Material->SetVectorParameterValue(TEXT("NaniteColor"),Step==32?FLinearColor(.1f,.7f,.2f):FLinearColor(.8f,.04f,.03f));
      Component->SetMaterial(0,Material);Component->SetMaterial(1,Material);
     }
     Component->RegisterComponent();Actors.Add(Actor);
    }
    GetMutableDefault<ULevelEditorViewportSettings>()->AspectRatioAxisConstraint=AspectRatio_MaintainXFOV;
    Client->SetRealtime(true);Client->AddRealtimeOverride(true,FText::FromString(TEXT("Groom native capture")));Client->SetGameView(true);Client->EngineShowFlags.SetSelectionOutline(false);
    Client->SetViewportType(LVT_Perspective);Client->ViewFOV=Test->GetNumberField(TEXT("horizontalFOV"));
    const auto& O=Test->GetArrayField(TEXT("viewOrigin"));const auto& D=Test->GetArrayField(TEXT("viewForward"));
    Client->SetViewLocation(FVector(O[0]->AsNumber(),O[1]->AsNumber(),O[2]->AsNumber()));Client->SetViewRotation(FVector(D[0]->AsNumber(),D[1]->AsNumber(),D[2]->AsNumber()).Rotation());
    static_cast<FSceneViewport*>(Client->Viewport)->SetFixedViewportSize(Test->GetIntegerField(TEXT("viewWidth")),Test->GetIntegerField(TEXT("viewHeight")));
    for(const TCHAR* Name:{TEXT("r.AntiAliasingMethod"),TEXT("r.RenderTimeFrozen"),TEXT("r.MotionBlurQuality")})IConsoleManager::Get().FindConsoleVariable(Name)->Set(0,ECVF_SetByCode);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.ScreenPercentage"))->Set(100,ECVF_SetByCode);
    IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge"))->Set(float(Test->GetNumberField(TEXT("maxPixelsPerEdge"))),ECVF_SetByCode);
    FAssetCompilingManager::Get().FinishAllCompilation();FlushRenderingCommands();CaptureView->Target=Client->Viewport;Frames=0;Phase=1;
   }
   Client->Invalidate();
   if(Phase==1){
    if(++Frames<240||FAssetCompilingManager::Get().GetNumRemainingAssets()||(GShaderCompilingManager&&GShaderCompilingManager->IsCompiling()))return true;
    FlushRenderingCommands();for(auto* Actor:Actors){auto* C=CastChecked<UGroomComponent>(Actor->GetRootComponent());
     UE_LOG(LogTemp,Display,TEXT("GROOM_NATIVE_PROXY registered=%d renderState=%d proxy=%d nanite=%d groups=%u assetGroups=%d valid=%d"),
      C->IsRegistered(),C->IsRenderStateCreated(),C->SceneProxy!=nullptr,C->SceneProxy&&C->SceneProxy->IsNaniteMesh(),C->GetGroupCount(),C->GroomAsset->GetNumHairGroups(),C->GroomAsset->IsValid());
     for(const auto& G:C->GroomAsset->GetHairGroupsPlatformData())UE_LOG(LogTemp,Display,TEXT("GROOM_NATIVE_DATA strands=%u points=%u"),G.Strands.BulkData.Header.CurveCount,G.Strands.BulkData.Header.PointCount);
     check(C->SceneProxy&&C->SceneProxy->IsNaniteMesh());}
    ENQUEUE_RENDER_COMMAND(RequestGroomNative)([](FRHICommandListImmediate&){CaptureView->Requested=true;});Phase=2;return true;
   }
   if(Phase==2){
    FlushRenderingCommands();if(!CaptureView->Readback||!CaptureView->Readback->IsReady())return true;
    const FString Prefix=Settings->GetStringField(TEXT("output"))/Test->GetStringField(TEXT("name"));
    ENQUEUE_RENDER_COMMAND(SaveGroomNative)([Prefix](FRHICommandListImmediate&){
     const auto* Data=static_cast<const uint8*>(CaptureView->Readback->Lock(CaptureView->Bytes));check(Data);
     check(FFileHelper::SaveArrayToFile(MakeArrayView(Data,CaptureView->Bytes),*(Prefix+TEXT(".bin"))));CaptureView->Readback->Unlock();
    });FlushRenderingCommands();
    auto Metadata=CaptureView->Metadata;Metadata->SetNumberField(TEXT("naniteComponents"),Actors.Num());Metadata->SetNumberField(TEXT("step"),Test->GetIntegerField(TEXT("step")));
    TArray<TSharedPtr<FJsonValue>> Entries;
    for(auto* Actor:Actors){auto* C=CastChecked<UGroomComponent>(Actor->GetRootComponent());auto E=MakeShared<FJsonObject>();
     E->SetBoolField(TEXT("nanite"),C->SceneProxy&&C->SceneProxy->IsNaniteMesh());E->SetArrayField(TEXT("localToWorld"),CaptureMatrix(C->GetComponentTransform().ToMatrixWithScale()));
     check(C->SceneProxy&&C->SceneProxy->IsNaniteMesh());
     E->SetNumberField(TEXT("curves"),static_cast<Nanite::FSceneProxyBase*>(C->SceneProxy)->GetResourceMeshInfo().NumCurves);Entries.Add(MakeShared<FJsonValueObject>(E));}
    Metadata->SetArrayField(TEXT("entries"),Entries);
    FString Json;FJsonSerializer::Serialize(Metadata.ToSharedRef(),TJsonWriterFactory<>::Create(&Json));check(FFileHelper::SaveStringToFile(Json,*(Prefix+TEXT(".json"))));
    TArray<FColor> Pixels;check(GetViewportScreenShot(Client->Viewport,Pixels));for(auto& P:Pixels)P.A=255;
    const FIntPoint Size=Client->Viewport->GetSizeXY();TArray64<uint8> PNG;FImageUtils::PNGCompressImageArray(Size.X,Size.Y,Pixels,PNG);check(FFileHelper::SaveArrayToFile(PNG,*(Prefix+TEXT(".png"))));
    UE_LOG(LogTemp,Display,TEXT("GROOM_NATIVE_CAPTURE step=%d components=%d"),Test->GetIntegerField(TEXT("step")),Actors.Num());++Index;Phase=0;
   }
   return true;
  }));
 });
}
