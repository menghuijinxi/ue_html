#include "AssetCompilingManager.h"
#include "Engine/StaticMesh.h"
#include "GlobalShader.h"
#include "HAL/FileManager.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Interfaces/ITargetPlatform.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Nanite/NaniteFixupChunk.h"
#include "Rendering/NaniteResources.h"
#include "RenderUtils.h"
#include "Serialization/ArchiveSavePackageDataBuffer.h"
#include "Serialization/MemoryReader.h"
#include "Serialization/MemoryWriter.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "ShaderPreprocessTypes.h"
#include "StaticMeshAttributes.h"
#include "StaticMeshResources.h"
#include "WebGPUShaderCode.h"

// The optional round trip exercises the actual cooked resource serializer and
// Web target policy. It is not a packaged level or a runtime Nanite scene.
int32 RunWebNaniteAssetProbe(const FString& Params)
{
    FString Directory;
    if (!FParse::Value(*Params, TEXT("Output="), Directory)) return 1;
    IFileManager::Get().MakeDirectory(*Directory, true);
    const FString SourcePath = TEXT("/Engine/BasicShapes/Sphere.Sphere");
    UStaticMesh* Source = LoadObject<UStaticMesh>(nullptr, *SourcePath);
    if (!Source) return 1;
    UStaticMesh* Mesh = DuplicateObject<UStaticMesh>(Source, GetTransientPackage());
    Mesh->GetNaniteSettings().bEnabled = true;
    Mesh->GetNaniteSettings().TargetMinimumResidencyInKB = 32768;
    Mesh->GetNaniteSettings().PositionPrecision = 8;
    Mesh->GetNaniteSettings().FallbackPercentTriangles = 1.0f;
    Mesh->GetNaniteSettings().FallbackRelativeError = 0.0f;
    Mesh->Build(true);
    FAssetCompilingManager::Get().FinishAllCompilation();
    const auto* RenderData = Mesh->GetRenderData();
    if (!RenderData || !RenderData->NaniteResourcesPtr.IsValid()) return 1;
    auto& BuiltResources = *RenderData->NaniteResourcesPtr;
    if (!BuiltResources.NumRootPages || BuiltResources.HasStreamingData() || BuiltResources.RootData.IsEmpty()) return 1;

    Nanite::FResources CookedResources;
    const bool bCookRoundTrip = FParse::Param(*Params, TEXT("WebNaniteCookRoundTrip"));
    if (bCookRoundTrip)
    {
        const ITargetPlatform* Target = GetTargetPlatformManagerRef().FindTargetPlatform(TEXT("Web"));
        if (!Target) return 1;
        const bool bExpectRetained = FParse::Param(*Params, TEXT("WebNaniteCookData")) &&
            !FParse::Param(*Params, TEXT("WebGPUES31Cook")) &&
            FParse::Param(*Params, TEXT("WebGPUCook"));
        if (DoesTargetPlatformSupportNanite(Target) != bExpectRetained) return 1;
        TArray<uint8> CookedBytes;
        FArchiveSavePackageDataBuffer CookContext(Target, Mesh->GetOutermost());
        FMemoryWriter Writer(CookedBytes, true);
        Writer.SetSavePackageData(&CookContext);
        Writer.SetFilterEditorOnly(true);
        BuiltResources.Serialize(Writer, Mesh, true);
        if (Writer.IsError()) return 1;
        FMemoryReader Reader(CookedBytes, true);
        Reader.SetFilterEditorOnly(true);
        CookedResources.Serialize(Reader, Mesh, true);
        if (Reader.IsError() || Reader.Tell() != CookedBytes.Num()) return 1;
        if (bExpectRetained)
        {
            // Reserializing verifies every serialized field, including hierarchy,
            // fixups and dependency arrays, without a second hand-written layout.
            TArray<uint8> ReloadedBytes;
            FMemoryWriter ReloadedWriter(ReloadedBytes, true);
            ReloadedWriter.SetSavePackageData(&CookContext);
            ReloadedWriter.SetFilterEditorOnly(true);
            CookedResources.Serialize(ReloadedWriter, Mesh, true);
            if (ReloadedWriter.IsError() || ReloadedBytes != CookedBytes ||
                CookedResources.RootData != BuiltResources.RootData ||
                CookedResources.NumClusters != BuiltResources.NumClusters ||
                CookedResources.NumRootPages != BuiltResources.NumRootPages ||
                CookedResources.HierarchyNodes.Num() != BuiltResources.HierarchyNodes.Num()) return 1;
        }
        else if (!CookedResources.RootData.IsEmpty() || !CookedResources.PageStreamingStates.IsEmpty() ||
            !CookedResources.HierarchyNodes.IsEmpty() || CookedResources.NumClusters != 0) return 1;
        const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(FName(TEXT("SP_WEBGPU_SM5")));
        if (Platform == SP_NumPlatforms || DoesPlatformSupportNanite(Platform)) return 1;
        auto CookReport = MakeShared<FJsonObject>();
        CookReport->SetBoolField(TEXT("pass"), true);
        CookReport->SetBoolField(TEXT("retained"), bExpectRetained);
        CookReport->SetBoolField(TEXT("runtimeNaniteEnabled"), false);
        CookReport->SetNumberField(TEXT("serializedBytes"), CookedBytes.Num());
        CookReport->SetNumberField(TEXT("rootBytes"), CookedResources.RootData.Num());
        CookReport->SetNumberField(TEXT("clusters"), CookedResources.NumClusters);
        CookReport->SetNumberField(TEXT("hierarchyNodes"), CookedResources.HierarchyNodes.Num());
        FString CookJson;
        FJsonSerializer::Serialize(CookReport, TJsonWriterFactory<>::Create(&CookJson));
        if (!FFileHelper::SaveArrayToFile(CookedBytes, *(Directory / TEXT("resources.cooked.bin"))) ||
            !FFileHelper::SaveStringToFile(CookJson, *(Directory / TEXT("cook-roundtrip.json")),
                FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return 1;
        if (!bExpectRetained) return 0;
    }
    const auto& Resources = bCookRoundTrip ? CookedResources : BuiltResources;

    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("sourceAsset"), SourcePath);
    Report->SetStringField(TEXT("scope"), bCookRoundTrip ? TEXT("fully-resident-cooked-resource-roundtrip") : TEXT("fully-resident-editor-export"));
    Report->SetBoolField(TEXT("webCookEnabled"), bCookRoundTrip);
    Report->SetNumberField(TEXT("numRootPages"), Resources.NumRootPages);
    Report->SetNumberField(TEXT("numClusters"), Resources.NumClusters);
    Report->SetNumberField(TEXT("numInputTriangles"), Resources.NumInputTriangles);
    Report->SetNumberField(TEXT("positionPrecision"), Resources.PositionPrecision);
    Report->SetNumberField(TEXT("gpuPageBytes"), NANITE_ROOT_PAGE_GPU_SIZE);
    Report->SetNumberField(TEXT("clusterIndexBits"), NANITE_MAX_CLUSTERS_PER_PAGE_BITS);
    Report->SetNumberField(TEXT("transcodeGroupSize"), 32);
    Report->SetNumberField(TEXT("hierarchyNodes"), Resources.HierarchyNodes.Num());
    TArray<uint8> DiskPages;
    TArray<uint32> InstallInfo;
    TArray<TSharedPtr<FJsonValue>> Pages;
    for (uint32 PageIndex = 0; PageIndex < Resources.NumRootPages; ++PageIndex)
    {
        const auto& State = Resources.PageStreamingStates[PageIndex];
        if (uint64(State.BulkOffset) + State.BulkSize > uint64(Resources.RootData.Num()) ||
            State.BulkSize < sizeof(Nanite::FFixupChunk::FHeader)) return 1;
        const uint8* Data = Resources.RootData.GetData() + State.BulkOffset;
        const auto* Fixup = reinterpret_cast<const Nanite::FFixupChunk*>(Data);
        const uint32 FixupSize = Fixup->GetSize();
        if (FixupSize > State.BulkSize || State.PageSize != State.BulkSize - FixupSize ||
            Fixup->Header.Magic != NANITE_FIXUP_MAGIC || !Fixup->Header.NumClusters ||
            State.DependenciesNum != 0 || State.PageSize < 20) return 1;
        uint32 DiskHeader[5];
        FMemory::Memcpy(DiskHeader, Data + FixupSize, sizeof(DiskHeader));
        const uint32 DiskClusterCount = DiskHeader[0];
        if (DiskClusterCount != Fixup->Header.NumClusters) return 1;
        const uint32 SourceOffset = DiskPages.Num();
        DiskPages.Append(Data + FixupSize, State.PageSize);
        DiskPages.AddZeroed(Align(DiskPages.Num(), 16) - DiskPages.Num());
        for (uint32 Cluster = 0; Cluster < DiskClusterCount; ++Cluster)
        {
            InstallInfo.Append({(PageIndex << NANITE_MAX_CLUSTERS_PER_PAGE_BITS) | Cluster,
                SourceOffset, PageIndex * NANITE_ROOT_PAGE_GPU_SIZE, 0});
        }
        auto Page = MakeShared<FJsonObject>();
        Page->SetNumberField(TEXT("sourceOffset"), SourceOffset);
        Page->SetNumberField(TEXT("diskBytes"), State.PageSize);
        Page->SetNumberField(TEXT("fixupBytes"), FixupSize);
        Page->SetNumberField(TEXT("numClusters"), DiskClusterCount);
        Page->SetNumberField(TEXT("dependencyCount"), State.DependenciesNum);
        Page->SetNumberField(TEXT("vertexReferences"), DiskHeader[2]);
        Pages.Add(MakeShared<FJsonValueObject>(Page));
    }
    Report->SetArrayField(TEXT("pages"), Pages);
    if (InstallInfo.Num() / 4 != Resources.NumClusters) return 1;
    // Keep the original triangle soup as an oracle independent of Nanite decoding.
    const FMeshDescription* Description = Mesh->GetMeshDescription(0);
    if (!Description) return 1;
    FStaticMeshConstAttributes Attributes(*Description);
    const auto Positions = Attributes.GetVertexPositions();
    TArray<float> Triangles;
    for (const auto TriangleID : Description->Triangles().GetElementIDs())
    {
        for (const auto VertexInstance : Description->GetTriangleVertexInstances(TriangleID))
        {
            const FVector3f Position = Positions[Description->GetVertexInstanceVertex(VertexInstance)];
            Triangles.Append({Position.X, Position.Y, Position.Z});
        }
    }
    Report->SetNumberField(TEXT("sourceTriangles"), Triangles.Num() / 9);
    if (!FFileHelper::SaveArrayToFile(DiskPages, *(Directory / TEXT("pages.bin"))) ||
        !FFileHelper::SaveArrayToFile(MakeArrayView(reinterpret_cast<const uint8*>(InstallInfo.GetData()),
            InstallInfo.Num() * sizeof(uint32)), *(Directory / TEXT("install.bin"))) ||
        !FFileHelper::SaveArrayToFile(MakeArrayView(reinterpret_cast<const uint8*>(Triangles.GetData()),
            Triangles.Num() * sizeof(float)), *(Directory / TEXT("source-triangles.bin")))) return 1;
    FString Json;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    if (!FFileHelper::SaveStringToFile(Json, *(Directory / TEXT("asset.json")),
        FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return 1;

    AddShaderSourceDirectoryMapping(TEXT("/WebGPUProbe"),
        FPaths::ConvertRelativePathToFull(FPaths::ProjectDir() / TEXT("Shaders")));
    const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(FName(TEXT("SP_WEBGPU_SM5")));
    const auto* Format = GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    const auto* Type = FindShaderTypeByName(FHashedName(TEXT("FMemcpyCS")));
    check(Format && Type && Platform != SP_NumPlatforms);
    for (int32 Stage = 0; Stage < 3; ++Stage)
    {
        const FString Name = Stage == 0 ? TEXT("independent") : Stage == 1 ? TEXT("dependent") : TEXT("decode");
        FShaderCompileJob Job;
        Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, 0);
        GlobalBeginCompileShader(TEXT("WebNaniteAssetProbe"), nullptr, Type, nullptr, 0,
            Stage < 2 ? TEXT("/Engine/Private/Nanite/NaniteTranscode.usf") : TEXT("/WebGPUProbe/Private/WebNaniteDecodeProbe.usf"),
            Stage < 2 ? TEXT("TranscodePageToGPU") : TEXT("MainCS"),
            FShaderTarget(SF_Compute, Platform), Job.Input, false);
        Job.Input.ShaderFormat = UE::WebGPUShader::SM5Format;
        Job.Input.Environment.SetDefine(TEXT("VF_SUPPORTS_PRIMITIVE_SCENE_DATA"), 1);
        Job.Input.Environment.SetDefine(TEXT("GROUP_SIZE"), 32);
        Job.Input.Environment.SetDefine(TEXT("NANITE_TRANSCODE_PASS"), Stage);
        Job.Input.Environment.SetDefine(TEXT("NANITE_USE_VIEW_UNIFORM_BUFFER"), 0);
        Job.Input.Environment.CompilerFlags.Add(CFLAG_HLSL2021);
        Job.Input.Environment.CompilerFlags.Add(CFLAG_ForceDXC);
        Job.Input.Environment.CompilerFlags.Add(CFLAG_WaveOperations);
        Format->ModifyShaderCompilerInput(Job.Input);
        if (!Format->PreprocessShader(Job.Input, Job.Input.Environment, Job.PreprocessOutput))
        {
            for (const auto& Error : Job.PreprocessOutput.GetErrors())
                UE_LOG(LogTemp, Error, TEXT("%s"), *Error.StrippedErrorMessage);
            return 1;
        }
        Format->CompilePreprocessedShader(Job.Input, Job.PreprocessOutput, Job.Output);
        for (const auto& Error : Job.Output.Errors) UE_LOG(LogTemp, Display, TEXT("%s"), *Error.StrippedErrorMessage);
        if (!Job.Output.bSucceeded) return 1;
        UE::WebGPUShader::FPayload Payload;
        FString Error;
        const auto Bytes = Job.Output.ShaderCode.GetReadView().Left(Job.Output.ShaderCode.GetShaderCodeSize());
        if (!UE::WebGPUShader::Decode(Bytes, Payload, Error)) return 1;
        if (!FFileHelper::SaveStringToFile(Payload.Wgsl, *(Directory / (Name + TEXT(".wgsl")))) ||
            !FFileHelper::SaveStringToFile(Payload.MetadataJson, *(Directory / (Name + TEXT(".json")))) ||
            !FFileHelper::SaveArrayToFile(Bytes, *(Directory / (Name + TEXT(".webshader"))))) return 1;
    }
    return 0;
}
