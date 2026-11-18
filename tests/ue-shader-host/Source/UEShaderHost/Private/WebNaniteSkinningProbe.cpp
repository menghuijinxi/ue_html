#include "CoreMinimal.h"
#include "NaniteBuilder.h"
#include "Engine/SkeletalMesh.h"
#include "Animation/Skeleton.h"
#include "ReferenceSkeleton.h"
#include "SkeletalMeshAttributes.h"
#include "BoneWeights.h"
#include "Rendering/SkeletalMeshModel.h"
#include "Rendering/SkeletalMeshLODModel.h"
#include "Rendering/SkeletalMeshRenderData.h"
#include "Rendering/NaniteResources.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionComponentMask.h"
#include "Materials/MaterialExpressionPreviousFrameSwitch.h"
#include "Materials/MaterialExpressionVertexColor.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "MaterialShared.h"
#include "AssetCompilingManager.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "Serialization/JsonSerializer.h"

UMaterial* CreateWebNaniteSkinMaterial(int32 Index)
{
    const FString Name = Index == 0 ? TEXT("NaniteSkinMaterial") : FString::Printf(TEXT("NaniteSkinMaterial%d"), Index);
    auto* Package = CreatePackage(*(TEXT("/Game/WebNaniteSkinning/") + Name));
    if (auto* Existing = FindObject<UMaterial>(Package, *Name)) return Existing;
    Package->MarkAsFullyLoaded();
    auto* Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone);
    Material->AddToRoot(); Material->SetShadingModel(MSM_DefaultLit);
    Material->FloatPrecisionMode = EMaterialFloatPrecisionMode::MFPM_Full;
    Material->TwoSided = Index != 3;
    Material->SetMaterialUsage(MATUSAGE_SkeletalMesh); Material->SetMaterialUsage(MATUSAGE_Nanite);
    auto* Color = NewObject<UMaterialExpressionVectorParameter>(Material);
    Color->ParameterName = TEXT("NaniteColor"); Color->DefaultValue = FLinearColor(.8f, .04f, .03f);
    Material->GetExpressionCollection().AddExpression(Color);
    Material->GetEditorOnlyData()->BaseColor.Connect(0, Color);
    auto* Roughness = NewObject<UMaterialExpressionConstant>(Material); Roughness->R = .7f;
    Material->GetExpressionCollection().AddExpression(Roughness);
    Material->GetEditorOnlyData()->Roughness.Connect(0, Roughness);
    if (Index == 1 || Index == 2)
    {
        Material->BlendMode = BLEND_Masked; Material->OpacityMaskClipValue = .5f;
        auto* UV = NewObject<UMaterialExpressionTextureCoordinate>(Material);
        auto* Mask = NewObject<UMaterialExpressionComponentMask>(Material);
        Mask->Input.Connect(0, UV); Mask->R = true;
        Material->GetExpressionCollection().AddExpression(UV);
        Material->GetExpressionCollection().AddExpression(Mask);
        Material->GetEditorOnlyData()->OpacityMask.Connect(0, Mask);
        auto* Depth = NewObject<UMaterialExpressionScalarParameter>(Material);
        Depth->ParameterName = TEXT("NaniteDepthOffset"); Depth->DefaultValue = 25;
        Material->GetExpressionCollection().AddExpression(Depth);
        Material->GetEditorOnlyData()->PixelDepthOffset.Connect(0, Depth);
    }
    if (Index == 2 || Index == 4)
    {
        Material->MaxWorldPositionOffsetDisplacement = Index == 4 ? 0 : 120;
        Material->bAlwaysEvaluateWorldPositionOffset = Index == 4;
        auto* Offset = NewObject<UMaterialExpressionVectorParameter>(Material);
        Offset->ParameterName = TEXT("NaniteWorldOffset"); Offset->DefaultValue = FLinearColor(40, 25, 15);
        auto* Previous = NewObject<UMaterialExpressionVectorParameter>(Material);
        Previous->ParameterName = TEXT("NanitePreviousWorldOffset"); Previous->DefaultValue = Offset->DefaultValue;
        auto* Switch = NewObject<UMaterialExpressionPreviousFrameSwitch>(Material);
        Switch->CurrentFrame.Connect(0, Offset); Switch->PreviousFrame.Connect(0, Previous);
        auto* VertexColor = NewObject<UMaterialExpressionVertexColor>(Material);
        auto* Product = NewObject<UMaterialExpressionMultiply>(Material);
        Product->A.Connect(0, Switch); Product->B.Connect(0, VertexColor);
        for (UMaterialExpression* Expression : TArray<UMaterialExpression*>{Offset, Previous, Switch, VertexColor, Product})
            Material->GetExpressionCollection().AddExpression(Expression);
        Material->GetEditorOnlyData()->WorldPositionOffset.Connect(0, Product);
    }
    Material->UpdateCachedExpressionData(); Material->PostEditChange();
    return Material;
}

// Authored two-bone geometry is retained separately from Nanite's decoded
// payload so browser validation can calculate deformation independently.
static int32 BuildWebNaniteSkinningFixture(const FString& Output, const FString& FixtureDirectory, int32 Mode)
{
    if (FixtureDirectory.IsEmpty()) return 1;
    const bool Streaming = Mode == 1 || Mode == 3;
    const TCHAR* Names[] = {TEXT("NaniteSkinPlane"), TEXT("NaniteSkinStreamingPlane"), TEXT("NaniteSkinResidentPlane"), TEXT("NaniteSkinStreamingPlaneB")};
    const FString MeshName = Names[Mode];
    const FString AssetPath = TEXT("/Game/WebNaniteSkinning/") + MeshName;
    UPackage* Package = CreatePackage(*AssetPath);
    Package->MarkAsFullyLoaded();
    auto* Mesh = NewObject<USkeletalMesh>(Package, *MeshName, RF_Public | RF_Standalone);
    Mesh->PreEditChange(nullptr);
    auto& LOD = Mesh->AddLODInfo();
    Mesh->GetImportedModel()->LODModels.Add(new FSkeletalMeshLODModel);
    LOD.BuildSettings.bRecomputeNormals = false;
    LOD.BuildSettings.bRecomputeTangents = true;
    LOD.BuildSettings.bUseFullPrecisionUVs = true;
    LOD.ReductionSettings.NumOfTrianglesPercentage = 1;
    LOD.ReductionSettings.NumOfVertPercentage = 1;
    LOD.ReductionSettings.MaxNumOfTriangles = MAX_int32;
    LOD.ReductionSettings.MaxNumOfVerts = MAX_int32;
    FReferenceSkeleton Reference;
    {
        FReferenceSkeletonModifier Modifier(Reference, nullptr);
        Modifier.Add(FMeshBoneInfo(TEXT("Root"), TEXT("Root"), INDEX_NONE), FTransform::Identity);
        Modifier.Add(FMeshBoneInfo(TEXT("Bend"), TEXT("Bend"), 0), FTransform::Identity);
    }
    Mesh->SetRefSkeleton(Reference); Mesh->CalculateInvRefMatrices();
    const FString SkeletonName = Mode == 0 ? TEXT("NaniteSkinSkeleton") : MeshName + TEXT("Skeleton");
    auto* SkeletonPackage = CreatePackage(*(TEXT("/Game/WebNaniteSkinning/") + SkeletonName));
    SkeletonPackage->MarkAsFullyLoaded();
    auto* Skeleton = NewObject<USkeleton>(SkeletonPackage, *SkeletonName, RF_Public | RF_Standalone);
    Mesh->SetSkeleton(Skeleton); Skeleton->MergeAllBonesToBoneTree(Mesh);

    FMeshDescription* Description = Mesh->CreateMeshDescription(0); check(Description);
    FSkeletalMeshAttributes Attributes(*Description); Attributes.Register();
    auto Positions = Attributes.GetVertexPositions(); auto Normals = Attributes.GetVertexInstanceNormals();
    auto UVs = Attributes.GetVertexInstanceUVs(); UVs.SetNumChannels(1);
    auto Colors = Attributes.GetVertexInstanceColors(); auto Signs = Attributes.GetVertexInstanceBinormalSigns();
    auto Weights = Attributes.GetVertexSkinWeights();
    for (int Bone = 0; Bone < 2; ++Bone)
    {
        const auto ID = Attributes.CreateBone();
        Attributes.GetBoneNames()[ID] = Bone ? TEXT("Bend") : TEXT("Root");
        Attributes.GetBoneParentIndices()[ID] = Bone ? 0 : INDEX_NONE;
        Attributes.GetBonePoses()[ID] = FTransform::Identity;
    }
    const FPolygonGroupID Group = Description->CreatePolygonGroup();
    Attributes.GetPolygonGroupMaterialSlotNames()[Group] = TEXT("Skin");
    const int Side = Mode == 0 ? 32 : 128;
    TArray<FVertexID> Vertices;
    TArray<float> WeightValues;
    for (int Z = 0; Z <= Side; ++Z) for (int Y = 0; Y <= Side; ++Y)
    {
        const FVertexID V = Description->CreateVertex(); Vertices.Add(V);
        Positions[V] = FVector3f(.75f * FMath::Sin(Y * .9f) * FMath::Sin(Z * .8f),
            Y * 200.0f / Side - 100, Z * 200.0f / Side - 100);
        // Exact end weights and an interior blend exercise both rigid bone
        // islands and genuinely blended vertices after quantized encoding.
        const float Weight = FMath::Clamp((float(Y) / Side - .25f) * 2.0f, 0.0f, 1.0f);
        using namespace UE::AnimationCore;
        const FBoneWeights Binding = FBoneWeights::Create({FBoneWeight(0, 1.0f - Weight), FBoneWeight(1, Weight)});
        Weights.Set(V, Binding);
        float Quantized = 0;
        for (const auto& Influence : Binding) if (Influence.GetBoneIndex() == 1) Quantized = Influence.GetWeight();
        WeightValues.Add(Quantized);
    }
    TArray<float> Source;
    auto Triangle = [&](int A, int B, int C)
    {
        const FVector3f N = FVector3f::CrossProduct(Positions[Vertices[C]] - Positions[Vertices[A]],
            Positions[Vertices[B]] - Positions[Vertices[A]]).GetSafeNormal();
        TArray<FVertexInstanceID, TInlineAllocator<3>> Corners;
        for (const int Index : {A, B, C})
        {
            const int Y = Index % (Side + 1), Z = Index / (Side + 1);
            const auto V = Description->CreateVertexInstance(Vertices[Index]); Corners.Add(V);
            const FVector2f UV(float(Y) / Side, float(Z) / Side);
            Normals[V] = N; Signs[V] = 1; UVs.Set(V, 0, UV);
            const float VertexWeight = float(FMath::RoundToInt(WeightValues[Index] * 255)) / 255;
            Colors[V] = FVector4f(VertexWeight, VertexWeight, VertexWeight, 1);
            const FVector3f P = Positions[Vertices[Index]];
            Source.Append({P.X, P.Y, P.Z, UV.X, UV.Y, N.X, N.Y, N.Z, WeightValues[Index]});
        }
        Description->CreateTriangle(Group, Corners);
    };
    for (int Z = 0; Z < Side; ++Z) for (int Y = 0; Y < Side; ++Y)
    {
        const int A = Z * (Side + 1) + Y, B = A + Side + 1;
        Triangle(A, A + 1, B); Triangle(A + 1, B + 1, B);
    }
    TArray<UMaterial*> Materials; for (int I = 0; I < 5; ++I) Materials.Add(CreateWebNaniteSkinMaterial(I));
    Mesh->SetMaterials({FSkeletalMaterial(Materials[0], true, false, TEXT("Skin"), TEXT("Skin"))});
    FMeshNaniteSettings Settings = Mesh->GetNaniteSettings(); Settings.bEnabled = true;
    Settings.TargetMinimumResidencyInKB = Streaming ? 0 : 32768; Settings.PositionPrecision = 10;
    Settings.BoneWeightPrecision = 8;
    Settings.FallbackPercentTriangles = 1; Settings.FallbackRelativeError = 0;
    Mesh->SetNaniteSettings(Settings); Mesh->CommitMeshDescription(0); Mesh->PostEditChange();
    FAssetCompilingManager::Get().FinishAllCompilation();
    const auto* Render = Mesh->GetResourceForRendering();
    if (!Render || !Render->NaniteResourcesPtr) return 1;
    const auto& Resource = *Render->NaniteResourcesPtr;
    UE_LOG(LogTemp, Display, TEXT("WEB_SKINNING_FIXTURE name=%s triangles=%u clusters=%u roots=%u pages=%d bones=%d streaming=%d expected=%d"),
        *MeshName, Resource.NumInputTriangles, Resource.NumClusters, Resource.NumRootPages, Resource.PageStreamingStates.Num(), Resource.BoneIndices.Num(), Resource.HasStreamingData(), Streaming);
    if (!Resource.NumRootPages || Resource.HasStreamingData() != Streaming || Resource.NumInputTriangles != Side * Side * 2 || Resource.BoneIndices.IsEmpty()) return 1;
    auto Save = [&](UObject* Asset)
    {
        FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone;
        const FString Filename = FixtureDirectory / (Asset->GetName() + TEXT(".uasset"));
        const bool Saved = UPackage::SavePackage(Asset->GetPackage(), Asset, *Filename, Args);
        UE_LOG(LogTemp, Display, TEXT("WEB_SKINNING_SAVE name=%s saved=%d file=%s"), *Asset->GetName(), Saved, *Filename);
        return Saved;
    };
    for (auto* Material : Materials) if (!Save(Material)) return 1;
    if (!Save(Skeleton) || !Save(Mesh)) return 1;
    if (!FFileHelper::SaveArrayToFile(TArrayView<const uint8>(reinterpret_cast<const uint8*>(Source.GetData()),
        Source.Num() * sizeof(float)), *(Output / (Mode == 0 ? TEXT("skin-source-triangles.bin") : TEXT("skin-streaming-source-triangles.bin"))))) return 1;
    auto Report = MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"), true);
    Report->SetNumberField(TEXT("triangles"), Resource.NumInputTriangles);
    Report->SetNumberField(TEXT("clusters"), Resource.NumClusters);
    Report->SetNumberField(TEXT("rootPages"), Resource.NumRootPages);
    Report->SetNumberField(TEXT("pages"), Resource.PageStreamingStates.Num());
    Report->SetBoolField(TEXT("streaming"), Streaming);
    Report->SetNumberField(TEXT("bones"), Mesh->GetRefSkeleton().GetNum());
    Report->SetNumberField(TEXT("hierarchyBoneIndices"), Resource.BoneIndices.Num());
    Report->SetStringField(TEXT("asset"), Mesh->GetPathName());
    const auto& Builder = FModuleManager::LoadModuleChecked<Nanite::IBuilderModule>(TEXT("NaniteBuilder"));
    Report->SetStringField(TEXT("builderVersion"), Builder.GetVersionString());
    Report->SetStringField(TEXT("builderModule"), FModuleManager::Get().GetModuleFilename(TEXT("NaniteBuilder")));
    if (!Builder.GetVersionString().EndsWith(TEXT("_SKINNING_WELD_2"))) return 1;
    FString Json; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json, *(Output / (Mode == 0 ? TEXT("fixture.json") : FString::Printf(TEXT("fixture-%d.json"), Mode))), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) ? 0 : 1;
}

int32 RunWebNaniteSkinningProbe(const FString& Output, const FString& FixtureDirectory)
{
    for (int32 Mode = 0; Mode < 4; ++Mode)
        if (BuildWebNaniteSkinningFixture(Output, FixtureDirectory, Mode) != 0) return 1;
    return 0;
}
