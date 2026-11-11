#include "WebCurveFixtureCommandlet.h"
#include "Engine/StaticMesh.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "NaniteBuilder.h"
#include "Rendering/NaniteResources.h"
#include "Serialization/JsonSerializer.h"

namespace WebCurveFixture
{
// Use the native groom builder's curve input layout. Keep this original point
// stream independent of the compressed Nanite pages for decoding comparisons.
bool Build(const FString& Directory, uint32 PointsPerCurve, uint32 Curves, bool VariableRadius, bool Streaming, uint32 MaterialPattern = 0)
{
 IFileManager::Get().MakeDirectory(*Directory,true);
 Nanite::IBuilderModule::FInputMeshData Input;
 const uint32 Points=PointsPerCurve*Curves;
 Input.NumTexCoords=2;Input.CurveCounts.Add(Curves);Input.CurveIndices.SetNum(Curves);
 Input.MaterialIndices.SetNum(Curves);Input.Vertices.Position.SetNum(Points);
 Input.Vertices.TangentX.SetNum(Points);Input.Vertices.TangentY.SetNum(Points);Input.Vertices.TangentZ.SetNum(Points);
 Input.Vertices.CurveRadius.SetNum(Points);Input.Vertices.UVs.SetNum(2);
 for(auto& UV:Input.Vertices.UVs)UV.SetNum(Points);
 TArray<float> Source;Source.Reserve(Points*11);
 const uint32 Side=FMath::CeilToInt(FMath::Sqrt(float(Curves)));
 for(uint32 C=0;C<Curves;++C){
  Input.CurveIndices[C].Offset=C*PointsPerCurve;Input.CurveIndices[C].Count=PointsPerCurve;
  Input.MaterialIndices[C]=MaterialPattern==1?C%2:MaterialPattern==2?C%64:MaterialPattern==3?(C==0?0:1):(C<Curves/2?0:1);
  const float X=(float(C%Side)-float(Side-1)*.5f)*6;
  const float Y=(float(C/Side)-float(Side-1)*.5f)*6;
  for(uint32 J=0;J<PointsPerCurve;++J){
   const uint32 V=C*PointsPerCurve+J;const float T=float(J)/float(PointsPerCurve-1);
   const float Phase=float(C%7)*.1f;
   const FVector3f P(X+8*FMath::Sin(T*2+Phase),Y+3*T*T,40*T);
   const FVector3f N=FVector3f(16*FMath::Cos(T*2+Phase),6*T,40).GetSafeNormal();
   const float Sign=N.Z>=0?1.f:-1.f,A=-1.f/(Sign+N.Z),B=N.X*N.Y*A;
   const FVector3f TX(1+Sign*A*N.X*N.X,Sign*B,-Sign*N.X),TY(B,Sign+A*N.Y*N.Y,-N.Y);
   const float R=VariableRadius?(.25f+.05f*float(C%3))*(1-.85f*T):.3f;
   const FVector2f Root(float(C%Side)/Side,float(C/Side)/Side);
   Input.Vertices.Position[V]=P;Input.VertexBounds+=P;
   Input.Vertices.TangentX[V]=TX;Input.Vertices.TangentY[V]=TY;Input.Vertices.TangentZ[V]=N;
   Input.Vertices.CurveRadius[V]=R;Input.Vertices.UVs[0][V]=FVector2f(T,0);Input.Vertices.UVs[1][V]=Root;
   Source.Append({P.X,P.Y,P.Z,N.X,N.Y,N.Z,R,T,0,Root.X,Root.Y});
  }
 }
 FStaticMeshSectionArray Sections;
 const uint32 MaterialSlots=MaterialPattern==2?64:2;
 for(uint32 S=0;S<MaterialSlots;++S){
  uint32 Begin=Curves,End=0;
  for(uint32 C=0;C<Curves;++C)if(Input.MaterialIndices[C]==int32(S)){Begin=FMath::Min(Begin,C);End=C+1;}
  check(Begin<End);
  auto& Section=Sections.AddDefaulted_GetRef();Section.MaterialIndex=S;Section.FirstIndex=Begin;
  Section.MinVertexIndex=Begin*PointsPerCurve;Section.MaxVertexIndex=End*PointsPerCurve-1;
  Section.bEnableCollision=false;Section.bCastShadow=true;Section.bVisibleInRayTracing=false;
  Section.bAffectDistanceFieldLighting=false;Section.bForceOpaque=true;
  Section.UVDensities[0]=Section.Weights[0]=1;
 }
 Input.Sections=Nanite::BuildMeshSections(Sections);
 FMeshNaniteSettings Settings;Settings.bEnabled=true;Settings.ShapePreservation=ENaniteShapePreservation::None;
 Settings.bVoxelNDF=false;Settings.bVoxelOpacity=true;Settings.VoxelLevel=0;Settings.bExplicitTangents=true;
 Settings.TargetMinimumResidencyInKB=Streaming?0:32768;
 // Build consumes the input material array. Preserve the authored reference
 // before ownership transfers into the native builder.
 const TArray<int32> SourceMaterials=Input.MaterialIndices;
 Nanite::FResources R;
 if(!Nanite::IBuilderModule::Get().Build(R,Input,nullptr,nullptr,nullptr,Settings,nullptr))return false;
 if(!R.NumRootPages||!R.NumClusters||R.RootData.IsEmpty()||R.HasStreamingData()!=Streaming)return false;
 auto Bytes=[&](const TCHAR* Name,const void* Data,int64 Count){
  return FFileHelper::SaveArrayToFile(TArrayView<const uint8>(static_cast<const uint8*>(Data),Count),*(Directory/Name));
 };
 if(!Bytes(TEXT("source-points.bin"),Source.GetData(),Source.Num()*sizeof(float))||
    !Bytes(TEXT("source-materials.bin"),SourceMaterials.GetData(),SourceMaterials.Num()*sizeof(int32))||
    !Bytes(TEXT("roots.bin"),R.RootData.GetData(),R.RootData.Num())||
    !Bytes(TEXT("hierarchy.bin"),R.HierarchyNodes.GetData(),R.HierarchyNodes.Num()*sizeof(Nanite::FPackedHierarchyNode))||
    !Bytes(TEXT("page-states.bin"),R.PageStreamingStates.GetData(),R.PageStreamingStates.Num()*sizeof(Nanite::FPageStreamingState))||
    !Bytes(TEXT("page-dependencies.bin"),R.PageDependencies.GetData(),R.PageDependencies.Num()*sizeof(R.PageDependencies[0])))return false;
 if(R.StreamablePages.GetBulkDataSize()){
  const void* Data=R.StreamablePages.LockReadOnly();const bool Saved=Bytes(TEXT("streaming.bin"),Data,R.StreamablePages.GetBulkDataSize());
  R.StreamablePages.Unlock();if(!Saved)return false;
 }
 auto Report=MakeShared<FJsonObject>();Report->SetBoolField(TEXT("pass"),true);
 Report->SetStringField(TEXT("builderVersion"),Nanite::IBuilderModule::Get().GetVersionString());
 Report->SetNumberField(TEXT("curves"),Curves);Report->SetNumberField(TEXT("pointsPerCurve"),PointsPerCurve);
 Report->SetNumberField(TEXT("points"),Points);Report->SetNumberField(TEXT("sourceStrideFloats"),11);
 Report->SetBoolField(TEXT("variableRadius"),VariableRadius);Report->SetBoolField(TEXT("streaming"),Streaming);
 Report->SetNumberField(TEXT("materialPattern"),MaterialPattern);Report->SetNumberField(TEXT("materialSlots"),MaterialSlots);
 Report->SetNumberField(TEXT("rootPages"),R.NumRootPages);Report->SetNumberField(TEXT("pages"),R.PageStreamingStates.Num());
 Report->SetNumberField(TEXT("clusters"),R.NumClusters);Report->SetNumberField(TEXT("rootNode"),R.HierarchyRootOffsets[0]);
 Report->SetNumberField(TEXT("positionPrecision"),R.PositionPrecision);Report->SetNumberField(TEXT("dependencyStride"),sizeof(R.PageDependencies[0]));
 Report->SetNumberField(TEXT("hierarchyNodes"),R.HierarchyNodes.Num());Report->SetNumberField(TEXT("pageStateStride"),sizeof(Nanite::FPageStreamingState));
 FString Json;FJsonSerializer::Serialize(Report,TJsonWriterFactory<>::Create(&Json));
 UE_LOG(LogTemp,Display,TEXT("WEB_CURVE_FIXTURE points=%u curves=%u streaming=%d clusters=%u pages=%d"),PointsPerCurve,Curves,Streaming,R.NumClusters,R.PageStreamingStates.Num());
 return FFileHelper::SaveStringToFile(Json,*(Directory/TEXT("fixture.json")),FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
}
}
extern int32 RunWebCurveShaders(const FString& Params);
extern int32 RunWebGroomFixture(const FString& Params);
extern int32 RunWebCurveMaterialShaders(const FString& Params);
int32 UWebCurveFixtureCommandlet::Main(const FString& Params)
{
 if(FParse::Param(*Params,TEXT("CurveShaders")))return RunWebCurveShaders(Params);
 if(FParse::Param(*Params,TEXT("GroomFixture")))return RunWebGroomFixture(Params);
 if(FParse::Param(*Params,TEXT("CurveMaterialShaders")))return RunWebCurveMaterialShaders(Params);
 FString Output;if(!FParse::Value(*Params,TEXT("Output="),Output))return 1;
 uint32 PointsOnly=0;FParse::Value(*Params,TEXT("PointsOnly="),PointsOnly);
 for(uint32 Points:{2u,4u,8u,16u,32u,64u,128u,255u,256u})for(bool Variable:{false,true}){
  if(PointsOnly && Points!=PointsOnly)continue;
  if(!WebCurveFixture::Build(Output/FString::Printf(TEXT("resident-%u-%s"),Points,Variable?TEXT("tapered"):TEXT("constant")),Points,257,Variable,false))return 1;
 }
 if(PointsOnly)return 0;
 if(!WebCurveFixture::Build(Output/TEXT("streaming-32-tapered"),32,4096,true,true))return 1;
 // Exercise the material table's 64-run capacity and exact/full/tail cluster
 // boundaries. Curve point order must continue to preserve the LOD prefix.
 for(uint32 Curves:{64u,65u,128u,129u})for(uint32 Pattern:{1u,2u}){
  if(!WebCurveFixture::Build(Output/FString::Printf(TEXT("boundary-2-%u-material-%u"),Curves,Pattern),2,Curves,true,false,Pattern))return 1;
 }
 for(uint32 Curves:{64u,129u}){
  if(!WebCurveFixture::Build(Output/FString::Printf(TEXT("reverse-ranges-2-%u"),Curves),2,Curves,true,false,3))return 1;
 }
 return 0;
}
