#include "AssetCompilingManager.h"
#include "Engine/StaticMesh.h"
#include "Engine/SkeletalMesh.h"
#include "HAL/FileManager.h"
#include "Materials/Material.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "NaniteAssemblyDataBuilder.h"
#include "Rendering/NaniteResources.h"
#include "Rendering/SkeletalMeshRenderData.h"
#include "../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/WebNaniteAssemblyCapacity.h"
#include "Serialization/JsonSerializer.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshResources.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

extern UMaterial* CreateWebNaniteSkinMaterial(int32 Index);
namespace WebAssemblyFixture
{
UPackage* Package(const FString& Name)
{
    auto* Result = CreatePackage(*(TEXT("/Game/WebNaniteAssembly/") + Name));
    Result->MarkAsFullyLoaded();
    return Result;
}
bool Save(UObject* Object, const FString& Directory)
{
    FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone;
    return UPackage::SavePackage(Object->GetPackage(), Object, *(Directory / (Object->GetName() + TEXT(".uasset"))), Args);
}
bool SaveResource(const FString& Name, const Nanite::FResources& R, const FString& Output, FJsonObject& Item)
{
    Item.SetNumberField(TEXT("rootNode"), R.HierarchyRootOffsets[0]);
    Item.SetNumberField(TEXT("transforms"), R.AssemblyTransforms.Num());
    Item.SetNumberField(TEXT("attachmentWords"), R.AssemblyBoneAttachmentData.Num());
    Nanite::FWebAssemblyCapacity Capacity;
    if (!Nanite::GetWebAssemblyCapacity(R.HierarchyNodes, R.HierarchyRootOffsets[0], Capacity)) return false;
    Item.SetNumberField(TEXT("queueCapacity"), Capacity.Queue);
    Item.SetNumberField(TEXT("clusterCapacity"), Capacity.Clusters);
    Item.SetNumberField(TEXT("hierarchyLevels"), Capacity.Levels);
    auto Bytes = [&](const FString& Suffix, const void* Data, int64 Size)
    {
        return FFileHelper::SaveArrayToFile(TArrayView<const uint8>(static_cast<const uint8*>(Data), Size), *(Output / (Name + Suffix)));
    };
    return Bytes(TEXT("-hierarchy.bin"), R.HierarchyNodes.GetData(), R.HierarchyNodes.Num() * sizeof(Nanite::FPackedHierarchyNode)) &&
        Bytes(TEXT("-transforms.bin"), R.AssemblyTransforms.GetData(), R.AssemblyTransforms.Num() * sizeof(FMatrix3x4)) &&
        Bytes(TEXT("-attachments.bin"), R.AssemblyBoneAttachmentData.GetData(), R.AssemblyBoneAttachmentData.Num() * 4);
}
UStaticMesh* MakePart(const FString& Name, int32 Side, int32 Variant, TConstArrayView<UMaterial*> Materials,
    const FString& Output, const FString& Directory)
{
    auto* Mesh = NewObject<UStaticMesh>(Package(Name), *Name, RF_Public | RF_Standalone);
    Mesh->InitResources(); Mesh->SetNumSourceModels(1);
    auto& Build = Mesh->GetSourceModel(0).BuildSettings;
    Build.bRecomputeNormals = false; Build.bRecomputeTangents = true;
    Build.bGenerateLightmapUVs = false; Build.bUseFullPrecisionUVs = true;
    auto* Description = Mesh->CreateMeshDescription(0);
    FStaticMeshAttributes A(*Description); A.Register();
    auto Positions = A.GetVertexPositions(); auto Normals = A.GetVertexInstanceNormals();
    auto UVs = A.GetVertexInstanceUVs(); UVs.SetNumChannels(1);
    auto Colors = A.GetVertexInstanceColors(); auto Signs = A.GetVertexInstanceBinormalSigns();
    TArray<FPolygonGroupID> Groups;
    for (int Slot = 0; Slot < 2; ++Slot)
    {
        const FName SlotName(*FString::Printf(TEXT("AssemblySlot%d"), Slot));
        Mesh->GetStaticMaterials().Add(FStaticMaterial(Materials[Slot], SlotName, SlotName));
        Groups.Add(Description->CreatePolygonGroup());
        A.GetPolygonGroupMaterialSlotNames()[Groups.Last()] = SlotName;
        Mesh->GetSectionInfoMap().Set(0, Slot, FMeshSectionInfo(Slot));
    }
    TArray<FVertexID> Vertices;
    for (int Z = 0; Z <= Side; ++Z) for (int Y = 0; Y <= Side; ++Y)
    {
        const auto V = Description->CreateVertex(); Vertices.Add(V);
        Positions[V] = FVector3f((Variant ? 1.1f : .75f) * FMath::Sin(Y * .9f) * FMath::Sin(Z * .8f),
            Y * 200.0f / Side - 100, Z * 200.0f / Side - 100);
    }
    TArray<float> Source;
    auto Triangle = [&](int I0, int I1, int I2, int Slot)
    {
        const FVector3f N = FVector3f::CrossProduct(Positions[Vertices[I2]] - Positions[Vertices[I0]],
            Positions[Vertices[I1]] - Positions[Vertices[I0]]).GetSafeNormal();
        TArray<FVertexInstanceID, TInlineAllocator<3>> Corners;
        for (int Index : {I0, I1, I2})
        {
            const auto V = Description->CreateVertexInstance(Vertices[Index]); Corners.Add(V);
            const FVector2f UV(float(Index % (Side + 1)) / Side, float(Index / (Side + 1)) / Side);
            Normals[V] = N; Signs[V] = 1; UVs.Set(V, 0, UV); Colors[V] = FVector4f(1, 1, 1, 1);
            const FVector3f P = Positions[Vertices[Index]];
            Source.Append({P.X,P.Y,P.Z,UV.X,UV.Y,N.X,N.Y,N.Z,float(Slot)});
        }
        Description->CreateTriangle(Groups[Slot], Corners);
    };
    for (int Z = 0; Z < Side; ++Z) for (int Y = 0; Y < Side; ++Y)
    {
        const int I = Z * (Side + 1) + Y, J = I + Side + 1, Slot = Y >= Side / 2;
        Triangle(I, I + 1, J, Slot); Triangle(I + 1, J + 1, J, Slot);
    }
    auto& Settings = Mesh->GetNaniteSettings(); Settings.bEnabled = true;
    Settings.TargetMinimumResidencyInKB = 32768; Settings.PositionPrecision = 10;
    Settings.FallbackPercentTriangles = 1; Settings.FallbackRelativeError = 0;
    Settings.FallbackTarget = ENaniteFallbackTarget::PercentTriangles;
    Mesh->CommitMeshDescription(0); Mesh->Build(true);
    FAssetCompilingManager::Get().FinishAllCompilation();
    if (!Mesh->GetRenderData() || !Mesh->GetRenderData()->NaniteResourcesPtr || !Save(Mesh, Directory)) return nullptr;
    if (!FFileHelper::SaveArrayToFile(TArrayView<const uint8>(reinterpret_cast<const uint8*>(Source.GetData()),
        Source.Num() * sizeof(float)), *(Output / (Name + TEXT("-source.bin"))))) return nullptr;
    return Mesh;
}
}

int32 RunWebNaniteAssemblyProbe(const FString& Output, const FString& Directory)
{
    using namespace WebAssemblyFixture;
    if (Output.IsEmpty() || Directory.IsEmpty()) return 1;
    IFileManager::Get().MakeDirectory(*Output, true); IFileManager::Get().MakeDirectory(*Directory, true);
    FPackageName::RegisterMountPoint(TEXT("/Game/WebNaniteSkinning/"), FPaths::GetPath(Directory) / TEXT("WebNaniteSkinning/"));
    TArray<UMaterial*> Materials;
    for (int I = 0; I < 5; ++I)
    {
        const FString Name = FString::Printf(TEXT("NaniteAssemblyMaterial%d"), I);
        auto* Material = DuplicateObject<UMaterial>(CreateWebNaniteSkinMaterial(I), Package(Name), *Name);
        Material->SetFlags(RF_Public | RF_Standalone); Materials.Add(Material);
        if (!Save(Material, Directory)) return 1;
    }
    UStaticMesh* Parts[2][2]{};
    for (int Size = 0; Size < 2; ++Size) for (int Variant = 0; Variant < 2; ++Variant)
    {
        const FString Name = FString::Printf(TEXT("NaniteAssemblyPart%d%d"), Size, Variant);
        Parts[Size][Variant] = MakePart(Name, Size ? 128 : 32, Variant, Materials, Output, Directory);
        if (!Parts[Size][Variant]) return 1;
    }
    const FTransform3f Transforms[] = {
        FTransform3f(FRotator3f(0,0,0), FVector3f(0,-115,-115)),
        FTransform3f(FRotator3f(5,15,-10), FVector3f(20,115,-115), FVector3f(1,.85f,1.1f)),
        FTransform3f(FRotator3f(-8,-12,7), FVector3f(-15,-115,115), FVector3f(1,-.9f,.9f)),
        FTransform3f(FRotator3f(12,8,10), FVector3f(30,115,115), FVector3f(.8f,1.1f,.75f))};
    TArray<TSharedPtr<FJsonValue>> Results;
    for (int Mode = 0; Mode < 4; ++Mode)
    {
        const TCHAR* Names[] = {TEXT("NaniteAssemblySmall"), TEXT("NaniteAssemblyStreaming"), TEXT("NaniteAssemblyResident"), TEXT("NaniteAssemblyStreamingB")};
        const FString Name = Names[Mode];
        auto* Mesh = NewObject<UStaticMesh>(Package(Name), *Name, RF_Public | RF_Standalone); Mesh->InitResources();
        FNaniteAssemblyDataBuilder Builder;
        for (auto* Material : Materials) Builder.AddMaterialSlot(Material);
        const int Size = Mode != 0;
        const int Part0 = Builder.AddPart(FSoftObjectPath(Parts[Size][0]));
        const int Part1 = Builder.AddPart(FSoftObjectPath(Parts[Size][1]));
        Builder.RemapPartMaterial(Part0,0,0); Builder.RemapPartMaterial(Part0,1,1);
        Builder.RemapPartMaterial(Part1,0,1); Builder.RemapPartMaterial(Part1,1,0);
        for (int I = 0; I < 4; ++I) Builder.AddNode(I < 2 ? Part0 : Part1, Transforms[I]);
        if (!Builder.ApplyToStaticMesh(*Mesh)) return 1;
        auto& Settings = Mesh->GetNaniteSettings(); Settings.bEnabled = true;
        Settings.TargetMinimumResidencyInKB = (Mode == 1 || Mode == 3) ? 0 : 32768; Settings.PositionPrecision = 10;
        Settings.FallbackTarget = ENaniteFallbackTarget::PercentTriangles;
        Settings.FallbackPercentTriangles = 1; Settings.FallbackRelativeError = 0;
        Mesh->RecacheNaniteAssemblyReferences(); Mesh->Build(true);
        FAssetCompilingManager::Get().FinishAllCompilation();
        const auto* Render = Mesh->GetRenderData();
        if (!Render || !Render->NaniteResourcesPtr) return 1;
        const auto& R = *Render->NaniteResourcesPtr;
        UE_LOG(LogTemp, Display, TEXT("WEB_ASSEMBLY_FIXTURE name=%s transforms=%d clusters=%u roots=%u pages=%d streaming=%d"),
            *Name, R.AssemblyTransforms.Num(), R.NumClusters, R.NumRootPages, R.PageStreamingStates.Num(), R.HasStreamingData());
        if (R.AssemblyTransforms.Num() != 4 || !R.NumRootPages || R.HasStreamingData() != ((Mode == 1 || Mode == 3)) || !Save(Mesh,Directory)) return 1;
        auto Item = MakeShared<FJsonObject>(); Item->SetStringField(TEXT("asset"), Mesh->GetPathName());
        Item->SetNumberField(TEXT("clusters"),R.NumClusters); Item->SetNumberField(TEXT("rootPages"),R.NumRootPages);
        Item->SetNumberField(TEXT("pages"),R.PageStreamingStates.Num()); Item->SetNumberField(TEXT("nodes"),R.HierarchyNodes.Num());
        Item->SetBoolField(TEXT("streaming"),R.HasStreamingData());
        TArray<TSharedPtr<FJsonValue>> Nodes;
        for (int I = 0; I < 4; ++I)
        {
            auto Node = MakeShared<FJsonObject>(); Node->SetStringField(TEXT("part"), Parts[Size][I < 2 ? 0 : 1]->GetName());
            TArray<TSharedPtr<FJsonValue>> Matrix; const auto M = Transforms[I].ToMatrixWithScale();
            for (int Y=0;Y<4;++Y)for(int X=0;X<4;++X)Matrix.Add(MakeShared<FJsonValueNumber>(M.M[Y][X]));
            Node->SetArrayField(TEXT("transform"),Matrix); Nodes.Add(MakeShared<FJsonValueObject>(Node));
        }
        Item->SetArrayField(TEXT("instances"),Nodes);
        if (!SaveResource(Name, R, Output, *Item)) return 1;
        Results.Add(MakeShared<FJsonValueObject>(Item));
    }
    auto* Base = LoadObject<USkeletalMesh>(nullptr, TEXT("/Game/WebNaniteSkinning/NaniteSkinPlane.NaniteSkinPlane"));
    if (!Base || Base->GetRefSkeleton().GetNum() != 2) return 1;
    USkeletalMesh* SkinParts[2][2]{};
    for (int Size=0;Size<2;++Size) for (int Variant=0;Variant<2;++Variant)
    {
        auto* Source = Size ? LoadObject<USkeletalMesh>(nullptr, TEXT("/Game/WebNaniteSkinning/NaniteSkinStreamingPlane.NaniteSkinStreamingPlane")) : Base;
        if (!Source) return 1;
        const FString PartName=FString::Printf(TEXT("NaniteAssemblySkinPart%d%d"),Size,Variant);
        auto* Part=DuplicateObject<USkeletalMesh>(Source,Package(PartName),*PartName);
        Part->PreEditChange(nullptr);
        Part->SetMaterials({FSkeletalMaterial(Materials[Variant],true,false,TEXT("Skin"),TEXT("Skin"))});
        auto Settings=Part->GetNaniteSettings();Settings.TargetMinimumResidencyInKB=32768;Part->SetNaniteSettings(Settings);
        Part->PostEditChange();FAssetCompilingManager::Get().FinishAllCompilation();
        if(!Part->GetResourceForRendering()||!Part->GetResourceForRendering()->NaniteResourcesPtr||!Save(Part,Directory))return 1;
        SkinParts[Size][Variant]=Part;
    }
    for (int Mode = 0; Mode < 4; ++Mode)
    {
        const TCHAR* Names[] = {TEXT("NaniteAssemblySkinSmall"), TEXT("NaniteAssemblySkinStreaming"), TEXT("NaniteAssemblySkinResident"), TEXT("NaniteAssemblySkinStreamingB")};
        const FString Name = Names[Mode];
        auto* Mesh = DuplicateObject<USkeletalMesh>(Base, Package(Name), *Name);
        Mesh->PreEditChange(nullptr);
        FNaniteAssemblyDataBuilder Builder;
        for (auto* Material : Materials) Builder.AddMaterialSlot(Material);
        const int Size = Mode != 0;
        const int Part0 = Builder.AddPart(FSoftObjectPath(SkinParts[Size][0]));
        const int Part1 = Builder.AddPart(FSoftObjectPath(SkinParts[Size][1]));
        Builder.RemapPartMaterial(Part0,0,0); Builder.RemapPartMaterial(Part1,0,1);
        Builder.RemapBaseMeshMaterial(0,0);
        TArray<TSharedPtr<FJsonValue>> Nodes;
        for (int I = 0; I < 4; ++I)
        {
            TArray<FNaniteAssemblyBoneInfluence> Weights;
            if (I == 2) { Weights.Add({0, .25f}); Weights.Add({1, .75f}); }
            else Weights.Add({I == 1 ? 1 : 0, 1.0f});
            Builder.AddNode(I < 2 ? Part0 : Part1, Transforms[I],
                I == 3 ? ENaniteAssemblyNodeTransformSpace::BoneRelative : ENaniteAssemblyNodeTransformSpace::Local, Weights);
            auto Node = MakeShared<FJsonObject>(); Node->SetStringField(TEXT("part"), SkinParts[Size][I < 2 ? 0 : 1]->GetName());
            Node->SetStringField(TEXT("space"), I == 3 ? TEXT("bone-relative") : TEXT("local"));
            TArray<TSharedPtr<FJsonValue>> Matrix, Influences; const auto M = Transforms[I].ToMatrixWithScale();
            for (int Y=0;Y<4;++Y)for(int X=0;X<4;++X)Matrix.Add(MakeShared<FJsonValueNumber>(M.M[Y][X]));
            for (const auto& W : Weights) { auto Weight = MakeShared<FJsonObject>(); Weight->SetNumberField(TEXT("bone"), W.BoneIndex);
                Weight->SetNumberField(TEXT("weight"), W.BoneWeight); Influences.Add(MakeShared<FJsonValueObject>(Weight)); }
            Node->SetArrayField(TEXT("transform"), Matrix); Node->SetArrayField(TEXT("weights"), Influences); Nodes.Add(MakeShared<FJsonValueObject>(Node));
        }
        if (!Builder.ApplyToSkeletalMesh(*Mesh)) return 1;
        auto Settings = Mesh->GetNaniteSettings(); Settings.bEnabled = true;
        Settings.TargetMinimumResidencyInKB = (Mode == 1 || Mode == 3) ? 0 : 32768;
        Settings.PositionPrecision = 10; Settings.BoneWeightPrecision = 8;
        Settings.FallbackPercentTriangles = 1; Settings.FallbackRelativeError = 0;
        Mesh->SetNaniteSettings(Settings); Mesh->RecacheNaniteAssemblyReferences(); Mesh->PostEditChange();
        FAssetCompilingManager::Get().FinishAllCompilation();
        const auto* Render = Mesh->GetResourceForRendering(); if (!Render || !Render->NaniteResourcesPtr) return 1;
        const auto& R = *Render->NaniteResourcesPtr;
        UE_LOG(LogTemp, Display, TEXT("WEB_ASSEMBLY_SKIN_FIXTURE name=%s transforms=%d attachments=%d clusters=%u roots=%u pages=%d streaming=%d"),
            *Name, R.AssemblyTransforms.Num(), R.AssemblyBoneAttachmentData.Num(), R.NumClusters, R.NumRootPages, R.PageStreamingStates.Num(), R.HasStreamingData());
        if (R.AssemblyTransforms.Num() != 4 || R.AssemblyBoneAttachmentData.IsEmpty() || !R.NumRootPages || R.HasStreamingData() != ((Mode == 1 || Mode == 3)) || !Save(Mesh, Directory)) return 1;
        auto Item=MakeShared<FJsonObject>(); Item->SetStringField(TEXT("asset"), Mesh->GetPathName());
        Item->SetStringField(TEXT("baseAsset"), Base->GetPathName());
        Item->SetNumberField(TEXT("clusters"),R.NumClusters); Item->SetNumberField(TEXT("rootPages"),R.NumRootPages);
        Item->SetNumberField(TEXT("pages"),R.PageStreamingStates.Num()); Item->SetNumberField(TEXT("nodes"),R.HierarchyNodes.Num());
        Item->SetBoolField(TEXT("streaming"),R.HasStreamingData()); Item->SetBoolField(TEXT("skinning"),true); Item->SetArrayField(TEXT("instances"),Nodes);
        if (!SaveResource(Name, R, Output, *Item)) return 1;
        Results.Add(MakeShared<FJsonValueObject>(Item));
    }
    auto Report=MakeShared<FJsonObject>(); Report->SetBoolField(TEXT("pass"),true); Report->SetArrayField(TEXT("fixtures"),Results);
    FString Json; FJsonSerializer::Serialize(Report,TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json,*(Output/TEXT("fixtures.json")),FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)?0:1;
}
