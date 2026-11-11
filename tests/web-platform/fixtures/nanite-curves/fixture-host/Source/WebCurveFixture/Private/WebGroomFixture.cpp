#include "GroomAsset.h"
#include "HairDescription.h"
#include "NaniteGroomBuilder.h"
#include "NaniteBuilder.h"
#include "AssetCompilingManager.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionConstant.h"
#include "MaterialShared.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/SavePackage.h"
#include "UObject/Package.h"
#include "HAL/IConsoleManager.h"

UMaterial* CreateWebCurveMaterial(int32 Index);

namespace WebGroomFixture
{
bool Save(UObject* Object,const FString& File)
{
 FSavePackageArgs Args;Args.TopLevelFlags=RF_Public|RF_Standalone;Args.SaveFlags=SAVE_NoError;
 return UPackage::SavePackage(Object->GetOutermost(),Object,*File,Args);
}

bool Build(const FString& Output,const FString& AssetDirectory,const FString& Name,uint32 Curves,uint32 Points)
{
 const FString Directory=Output/Name;
 IFileManager::Get().MakeDirectory(*Directory,true);
 IFileManager::Get().MakeDirectory(*AssetDirectory,true);
 FHairDescription Description;
 Description.InitializeStrands(Curves);Description.InitializeVertices(Curves*Points);
 Description.StrandAttributes().RegisterAttribute<int>(HairAttribute::Strand::GroupID);
 Description.StrandAttributes().RegisterAttribute<int>(HairAttribute::Strand::Guide);
 Description.StrandAttributes().RegisterAttribute<FVector2f>(HairAttribute::Strand::RootUV);
 Description.VertexAttributes().RegisterAttribute<float>(HairAttribute::Vertex::Width);
 auto Counts=Description.StrandAttributes().GetAttributesRef<int>(HairAttribute::Strand::VertexCount);
 auto Groups=Description.StrandAttributes().GetAttributesRef<int>(HairAttribute::Strand::GroupID);
 auto Guides=Description.StrandAttributes().GetAttributesRef<int>(HairAttribute::Strand::Guide);
 auto Roots=Description.StrandAttributes().GetAttributesRef<FVector2f>(HairAttribute::Strand::RootUV);
 auto Positions=Description.VertexAttributes().GetAttributesRef<FVector3f>(HairAttribute::Vertex::Position);
 auto Widths=Description.VertexAttributes().GetAttributesRef<float>(HairAttribute::Vertex::Width);
 TArray<float> Authored;Authored.Reserve(Curves*Points*4);
 const uint32 Side=FMath::CeilToInt(FMath::Sqrt(float(Curves)));
 for(uint32 C=0;C<Curves;++C){
  const FStrandID Strand(C);Counts[Strand]=Points;Groups[Strand]=C<Curves/2?0:1;Guides[Strand]=0;
  Roots[Strand]=FVector2f(float(C%Side)/Side,float(C/Side)/Side);
  for(uint32 P=0;P<Points;++P){
   const float T=float(P)/float(Points-1),Phase=float(C%7)*.1f;
   const FVector3f Position((float(C%Side)-float(Side-1)*.5f)*6+8*FMath::Sin(T*2+Phase),
    (float(C/Side)-float(Side-1)*.5f)*6+3*T*T,40*T);
   const float Width=(.5f+.1f*float(C%3))*(1-.85f*T);
   const FVertexID Vertex(C*Points+P);Positions[Vertex]=Position;Widths[Vertex]=Width;
   Authored.Append({Position.X,Position.Y,Position.Z,Width});
  }
 }
 if(!Description.IsValid())return false;
 UPackage* Package=CreatePackage(*(TEXT("/Game/WebNaniteCurves/")+Name));
 Package->FullyLoad();
 UGroomAsset* Groom=NewObject<UGroomAsset>(Package,*Name,RF_Public|RF_Standalone);
 Groom->SetNumGroup(2);
 // Native Nanite Groom supports non-simulated curves. Author that state
 // explicitly: the default disabled solver still names AngularSprings, and
 // PostLoad's UpdatePhysicsSystems loads/cooks that unrelated simulation.
 for(auto& Physics:Groom->GetHairGroupsPhysics()){
  Physics.SolverSettings.EnableSimulation=false;
  Physics.SolverSettings.bEnableDeformation=false;
  Physics.SolverSettings.NiagaraSolver=EGroomNiagaraSolvers::None;
  Physics.SolverSettings.CustomSystem.Reset();
 }
 for(uint32 G=0;G<2;++G){
  const FString MaterialName=Name+FString::Printf(TEXT("Material%u"),G);
  UPackage* MaterialPackage=CreatePackage(*(TEXT("/Game/WebNaniteCurves/")+MaterialName));MaterialPackage->FullyLoad();
  UMaterial* Material=NewObject<UMaterial>(MaterialPackage,*MaterialName,RF_Public|RF_Standalone);
  Material->SetShadingModel(MSM_DefaultLit);Material->TwoSided=true;
  bool Recompile=false;Material->SetMaterialUsage(Recompile,MATUSAGE_Nanite);Material->SetMaterialUsage(Recompile,MATUSAGE_HairStrands);Material->SetMaterialUsage(Recompile,MATUSAGE_Curves);
  auto* Color=NewObject<UMaterialExpressionConstant3Vector>(Material);
  Color->Constant=G?FLinearColor(.08f,.6f,.25f):FLinearColor(.7f,.08f,.03f);
  Material->GetExpressionCollection().AddExpression(Color);Material->GetEditorOnlyData()->BaseColor.Expression=Color;
  auto* Roughness=NewObject<UMaterialExpressionConstant>(Material);Roughness->R=.45f;
  Material->GetExpressionCollection().AddExpression(Roughness);Material->GetEditorOnlyData()->Roughness.Expression=Roughness;
  Material->PostEditChange();
  auto& Slot=Groom->GetHairGroupsMaterials().AddDefaulted_GetRef();Slot.Material=Material;Slot.SlotName=*MaterialName;
  Groom->GetHairGroupsRendering()[G].MaterialSlotName=Slot.SlotName;
  Groom->GetHairGroupsInfo()[G].GroupID=G;
  if(!Save(Material,AssetDirectory/(MaterialName+TEXT(".uasset"))))return false;
 }
 // Exercise group-to-material-slot remapping on the streaming asset. The
 // compressed curve material IDs remain group IDs, independent of slot order.
 if(Curves>64)for(uint32 G=0;G<2;++G)
  Groom->GetHairGroupsRendering()[G].MaterialSlotName=Groom->GetHairGroupsMaterials()[1-G].SlotName;
 Groom->CommitHairDescription(MoveTemp(Description),EHairDescriptionType::Source);
 if(!Groom->CacheDerivedDatas())return false;
 FAssetCompilingManager::Get().FinishAllCompilation();
 TPimplPtr<Nanite::FResources> Resources;
 FGroomAssetNaniteBuilder Builder;
 if(!Builder.Build(Resources,Groom)||!Resources.IsValid())return false;
 const Nanite::FResources& R=*Resources;
 if(!R.NumRootPages||!R.NumClusters||R.RootData.IsEmpty())return false;
 auto Bytes=[&](const TCHAR* File,const void* Data,int64 Size){return FFileHelper::SaveArrayToFile(
  TArrayView<const uint8>(static_cast<const uint8*>(Data),Size),*(Directory/File));};
 if(!Bytes(TEXT("authored-position-width.bin"),Authored.GetData(),Authored.Num()*sizeof(float))||
    !Bytes(TEXT("roots.bin"),R.RootData.GetData(),R.RootData.Num())||
    !Bytes(TEXT("hierarchy.bin"),R.HierarchyNodes.GetData(),R.HierarchyNodes.Num()*sizeof(Nanite::FPackedHierarchyNode))||
    !Bytes(TEXT("page-states.bin"),R.PageStreamingStates.GetData(),R.PageStreamingStates.Num()*sizeof(Nanite::FPageStreamingState))||
    !Bytes(TEXT("page-dependencies.bin"),R.PageDependencies.GetData(),R.PageDependencies.Num()*sizeof(R.PageDependencies[0])))return false;
 if(R.StreamablePages.GetBulkDataSize()){
  auto& Bulk=Resources->StreamablePages;const void* Data=Bulk.LockReadOnly();
  const bool Saved=Bytes(TEXT("streaming.bin"),Data,Bulk.GetBulkDataSize());Bulk.Unlock();if(!Saved)return false;
 }
 const FString AssetFile=AssetDirectory/(Name+TEXT(".uasset"));
 if(!Save(Groom,AssetFile))return false;
 auto Report=MakeShared<FJsonObject>();Report->SetBoolField(TEXT("pass"),true);
 Report->SetStringField(TEXT("asset"),Groom->GetPathName());Report->SetStringField(TEXT("assetFile"),AssetFile);
 Report->SetStringField(TEXT("class"),Groom->GetClass()->GetName());Report->SetStringField(TEXT("builderVersion"),Nanite::IBuilderModule::Get().GetVersionString());
 Report->SetNumberField(TEXT("authoredCurves"),Curves);Report->SetNumberField(TEXT("authoredPointsPerCurve"),Points);
 Report->SetNumberField(TEXT("builderMaxPointsPerCurve"),IConsoleManager::Get().FindConsoleVariable(TEXT("r.HairStrands.Nanite.MaxPointPerCurve"))->GetInt());
 Report->SetNumberField(TEXT("groups"),Groom->GetNumHairGroups());Report->SetNumberField(TEXT("materials"),Groom->GetHairGroupsMaterials().Num());
 Report->SetBoolField(TEXT("simulationEnabled"),false);
 Report->SetBoolField(TEXT("simulationSystemAssigned"),false);
 for(const auto& Physics:Groom->GetHairGroupsPhysics()){
  if(Physics.SolverSettings.EnableSimulation||Physics.SolverSettings.bEnableDeformation||
     Physics.SolverSettings.NiagaraSolver!=EGroomNiagaraSolvers::None||!Physics.SolverSettings.CustomSystem.IsNull())return false;
 }
 TArray<TSharedPtr<FJsonValue>> GroupSlots;
 for(const auto& Group:Groom->GetHairGroupsRendering())GroupSlots.Add(MakeShared<FJsonValueNumber>(Groom->GetMaterialIndex(Group.MaterialSlotName)));
 Report->SetArrayField(TEXT("groupMaterialSlots"),GroupSlots);
 Report->SetNumberField(TEXT("rootPages"),R.NumRootPages);Report->SetNumberField(TEXT("pages"),R.PageStreamingStates.Num());
 Report->SetNumberField(TEXT("clusters"),R.NumClusters);Report->SetNumberField(TEXT("rootNodes"),R.HierarchyRootOffsets.Num());
 Report->SetNumberField(TEXT("positionPrecision"),R.PositionPrecision);Report->SetNumberField(TEXT("dependencyStride"),sizeof(R.PageDependencies[0]));
 FString Json;FJsonSerializer::Serialize(Report,TJsonWriterFactory<>::Create(&Json));
 UE_LOG(LogTemp,Display,TEXT("WEB_GROOM_FIXTURE asset=%s curves=%u clusters=%u pages=%d"),*Name,Curves,R.NumClusters,R.PageStreamingStates.Num());
 return FFileHelper::SaveStringToFile(Json,*(Directory/TEXT("groom.json")),FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
}
}

int32 RunWebGroomFixture(const FString& Params)
{
 FString Output,Assets;
 if(!FParse::Value(*Params,TEXT("Output="),Output)||!FParse::Value(*Params,TEXT("FixtureDirectory="),Assets))return 1;
 // Verify actual startup configuration, including read-only variables. Source
 // points still follow Groom's 255-point import limit before resampling.
 auto* MaxPoints=IConsoleManager::Get().FindConsoleVariable(TEXT("r.HairStrands.Nanite.MaxPointPerCurve"));
 check(MaxPoints && MaxPoints->GetInt()==256);
 check(IConsoleManager::Get().FindConsoleVariable(TEXT("r.HairStrands.Nanite"))->GetInt()==1);
 check(NaniteCurvesSupported());
 for(int32 Index=0;Index<5;++Index){
  UMaterial* Material=CreateWebCurveMaterial(Index);
  if(!Material||!WebGroomFixture::Save(Material,Assets/(Material->GetName()+TEXT(".uasset"))))return 1;
 }
 return WebGroomFixture::Build(Output,Assets,TEXT("NaniteGroomSmall"),64,8)&&
  WebGroomFixture::Build(Output,Assets,TEXT("NaniteGroomStreaming"),1024,32)&&
  WebGroomFixture::Build(Output,Assets,TEXT("NaniteGroomLong256"),64,256)&&
  WebGroomFixture::Build(Output,Assets,TEXT("NaniteGroomStreamingB"),1024,32)?0:1;
}
