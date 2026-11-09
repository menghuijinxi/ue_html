#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Interfaces/ITargetPlatform.h"
#include "Misc/FileHelper.h"
#include "Serialization/ArchiveSavePackageDataBuffer.h"
#include "Serialization/MemoryWriter.h"
#include "Serialization/MemoryReader.h"
#include "ShaderCompiler.h"
#include "ShaderPreprocessTypes.h"
#include "WebGPUShaderCode.h"

#define WEB_NANITE_HIERARCHY_SHADER_ONLY 1
#include "../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebHierarchy.cpp"
#define WEB_NANITE_RASTER_SHADER_ONLY 1
#include "../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebRaster.cpp"
#define WEB_NANITE_HZB_SHADER_ONLY 1
#include "../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebHZB.cpp"
#define WEB_NANITE_DEPTH_SHADER_ONLY 1
#include "../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebDepth.cpp"
#define WEB_NANITE_GBUFFER_SHADER_ONLY 1
#include "../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebGBuffer.cpp"

int32 RunWebNaniteHierarchyProbe(const FString& Params)
{
    FString Directory;
    if (!FParse::Value(*Params, TEXT("Output="), Directory)) return 1;
    IFileManager::Get().MakeDirectory(*Directory, true);
    const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
    const auto* Format = GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    const auto* Target = GetTargetPlatformManagerRef().FindTargetPlatform(TEXT("Web"));
    if (!Format || !Target || Platform == SP_NumPlatforms) return 1;
    FGlobalShaderMap Map(Platform);
    TArray<FGlobalShaderType*> Types = {&Nanite::FWebNaniteHierarchyCull_CS::GetStaticType(),
        &Nanite::FWebNaniteRasterVS::GetStaticType(), &Nanite::FWebNaniteRasterPS::GetStaticType(),
        &Nanite::FWebNaniteScalarRasterPS::GetStaticType(), &Nanite::FWebNaniteMicroRasterCS::GetStaticType(),
        &Nanite::FWebNaniteHZBBuildCS::GetStaticType(), &Nanite::FWebNaniteOcclusionCS::GetStaticType(),
        &Nanite::FWebNaniteVisibleClustersCS::GetStaticType(), &Nanite::FWebNaniteMaterialInputsCS::GetStaticType(),
        &Nanite::FWebNaniteResolveCS::GetStaticType(), &Nanite::FWebNaniteDepthVS::GetStaticType(),
        &Nanite::FWebNaniteDepthPS::GetStaticType(), &Nanite::FWebNaniteDepthSnapshotCS::GetStaticType(),
        &Nanite::FWebNaniteGBufferVS::GetStaticType(), &Nanite::FWebNaniteGBufferPS::GetStaticType(),
        &Nanite::FWebNaniteGBufferSnapshotCS::GetStaticType(), &Nanite::FWebNaniteGBufferTilesCS::GetStaticType()};
    const TArray<FGlobalShaderType*> DiagnosticTypes = Types;
    FString SupplementNames;
    TArray<FString> Names;
    const bool Supplement = FParse::Value(*Params, TEXT("SupplementShaderTypes="), SupplementNames, false);
    const auto PermutationFlags = Supplement ? EShaderPermutationFlags::None : EShaderPermutationFlags::HasEditorOnlyData;
    if (Supplement)
    {
        // Explicit runtime-required permutations may be absent from an older
        // native Cook predicate. Compile only the named types, with real UE
        // metadata and compiler environments, and preserve startup validation.
        SupplementNames.ParseIntoArray(Names, TEXT(","), true);
        if (Names.IsEmpty()) return 1;
        Types.Reset();
        for (const auto& Name : Names)
        {
            FGlobalShaderType* Found = nullptr;
            for (TLinkedList<FShaderType*>::TIterator It(FShaderType::GetTypeList()); It; ++It)
                if (Name == It->GetName()) { Found = It->GetGlobalShaderType(); break; }
            if (!Found || Types.Contains(Found)) return 1;
            Types.Add(Found);
        }
        if (FParse::Param(*Params, TEXT("SupplementVirtualShadowMaps")))
        {
            // The current native host has the Web VSM predicates. Preserve
            // their permutation filtering instead of forcing the whole domain.
            for (TLinkedList<FShaderType*>::TIterator It(FShaderType::GetTypeList()); It; ++It)
            {
                auto* Global = It->GetGlobalShaderType();
                if (!Global || !FString(It->GetShaderFilename()).StartsWith(TEXT("/Engine/Private/VirtualShadowMaps/"))) continue;
                for (int32 Permutation = 0; Permutation < Global->GetPermutationCount(); ++Permutation)
                    if (Global->ShouldCompilePermutation(Platform, Permutation, PermutationFlags))
                    { Types.AddUnique(Global); break; }
            }
        }
        FString BaselineFile;
        if (FParse::Value(*Params, TEXT("SupplementBaseline="), BaselineFile))
        {
            TArray<uint8> BaselineBytes;
            if (!FFileHelper::LoadFileToArray(BaselineBytes, *BaselineFile)) return 1;
            FMemoryReader Reader(BaselineBytes, true);
            // The Cook stores code in an external shader library. Read only
            // the serialized map metadata, without requesting RHI resources.
            TMap<FGlobalShaderType*, TSet<int32>> Available;
            const FTypeLayoutDesc* MapLayout = FTypeLayoutDesc::Find(FHashedName(TEXT("FGlobalShaderMapContent")).GetHash());
            if (!MapLayout) return 1;
            int32 SectionCount = 0; Reader << SectionCount;
            if (SectionCount <= 0 || SectionCount > 4096) return 1;
            for (int32 Section = 0; Section < SectionCount; ++Section)
            {
                FShaderMapPointerTable Pointers;
                FPlatformTypeLayoutParameters Layout;
                FMemoryImageObject Loaded = FMemoryImageResult::LoadFromArchive(
                    Reader, *MapLayout, &Pointers, Layout);
                if (!Loaded.Object) return 1;
                const auto* Content = static_cast<FGlobalShaderMapContent*>(Loaded.Object);
                for (TLinkedList<FShaderType*>::TIterator It(FShaderType::GetTypeList()); It; ++It)
                {
                    auto* Global = It->GetGlobalShaderType();
                    if (!Global || Global->GetHashedShaderFilename() != Content->GetHashedSourceFilename()) continue;
                    for (int32 Permutation = 0; Permutation < Global->GetPermutationCount(); ++Permutation)
                        if (Content->GetShader(Global->GetHashedName(), Permutation)) Available.FindOrAdd(Global).Add(Permutation);
                }
                Loaded.Destroy(&Pointers);
                bool SharedCode = false; FName ShaderPlatformName; FShaderHash ResourceHash;
                Reader << SharedCode << ShaderPlatformName;
                if (!SharedCode) return 1; // This input is the shared-code Villa Cook.
                Reader << ResourceHash;
            }
            if (Reader.IsError() || Reader.Tell() != Reader.TotalSize()) return 1;
            TSet<FString> MissingSections;
            for (TLinkedList<FShaderType*>::TIterator It(FShaderType::GetTypeList()); It; ++It)
            {
                auto* Global = It->GetGlobalShaderType();
                if (!Global || DiagnosticTypes.Contains(Global) || FString(It->GetName()).StartsWith(TEXT("FWebProbe"))) continue;
                for (int32 Permutation = 0; Permutation < Global->GetPermutationCount(); ++Permutation)
                    if (Global->ShouldCompilePermutation(Platform, Permutation, PermutationFlags) &&
                        (!Available.Contains(Global) || !Available[Global].Contains(Permutation)))
                    {
                        MissingSections.Add(It->GetShaderFilename());
                        UE_LOG(LogTemp, Display, TEXT("WEB_SHADER_MISSING type=%s permutation=%d"), It->GetName(), Permutation);
                    }
            }
            for (TLinkedList<FShaderType*>::TIterator It(FShaderType::GetTypeList()); It; ++It)
            {
                auto* Global = It->GetGlobalShaderType();
                if (!Global || !MissingSections.Contains(It->GetShaderFilename())) continue;
                for (int32 Permutation = 0; Permutation < Global->GetPermutationCount(); ++Permutation)
                    if (Global->ShouldCompilePermutation(Platform, Permutation, PermutationFlags))
                    { Types.AddUnique(Global); break; }
            }
        }
    }
    for (auto* Type : Types)
    {
    int32 CompiledPermutations = 0;
    for (int32 Permutation = 0; Permutation < Type->GetPermutationCount(); ++Permutation)
    {
        if ((!Supplement || !Names.Contains(Type->GetName())) &&
            !Type->ShouldCompilePermutation(Platform, Permutation, PermutationFlags)) continue;
        FShaderCompileJob Job;
        Job.Key = FShaderCompileJobKey(Type, Platform, nullptr, Permutation);
        GlobalBeginCompileShader(TEXT("WebNaniteHierarchyProbe"), nullptr, Type, nullptr, Permutation,
            Type->GetShaderFilename(), Type->GetFunctionName(), FShaderTarget(Type->GetFrequency(), Platform), Job.Input, false);
        Job.Input.ShaderFormat = UE::WebGPUShader::SM5Format;
        Type->SetupCompileEnvironment(Platform, Permutation, PermutationFlags, Job.Input.Environment);
        Format->ModifyShaderCompilerInput(Job.Input);
        if (!Format->PreprocessShader(Job.Input, Job.Input.Environment, Job.PreprocessOutput)) return 1;
        Format->CompilePreprocessedShader(Job.Input, Job.PreprocessOutput, Job.Output);
        for (const auto& Error : Job.Output.Errors) UE_LOG(LogTemp, Display, TEXT("%s"), *Error.StrippedErrorMessage);
        if (!Job.Output.bSucceeded) return 1;
        Job.Output.GenerateOutputHash();
        Map.FindOrAddSection(Type)->GetResourceCode()->AddShaderCompilerOutput(Job.Output, Job.Key);
        Map.FindOrAddShader(Type, Permutation, Type->ConstructCompiled(FGlobalShaderType::CompiledShaderInitializerType(
            Type, nullptr, Permutation, Job.Output, 0, nullptr, nullptr)));
        Job.Output.ParameterMap.VerifyBindingsAreComplete(Type->GetName(), Job.Output.Target, nullptr);
        ++CompiledPermutations;
        UE_LOG(LogTemp, Display, TEXT("WEB_NANITE_SHADER type=%s permutation=%d"), Type->GetName(), Permutation);
        if (Supplement) UE_LOG(LogTemp, Display, TEXT("WEB_SHADER_SUPPLEMENT type=%s permutation=%d"), Type->GetName(), Permutation);
    }
    if (!CompiledPermutations) return 1;
    }
    TSet<FGlobalShaderMapSection*> Sections;
    for (auto* Type : Types) Sections.Add(Map.FindOrAddSection(Type));
    for (auto* Section : Sections) Section->FinalizeContent();
    TArray<uint8> Archive;
    FArchiveSavePackageDataBuffer CookContext(Target);
    FMemoryWriter Writer(Archive, true); Writer.SetSavePackageData(&CookContext); Writer.SetFilterEditorOnly(true);
    Map.SaveToGlobalArchive(Writer);
    return FFileHelper::SaveArrayToFile(Archive, *(Directory / (Supplement ? TEXT("supplement-global-shaders.bin") : TEXT("hierarchy-global-shaders.bin")))) ? 0 : 1;
}
