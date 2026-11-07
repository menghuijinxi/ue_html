#if WITH_EDITOR
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "ShaderPreprocessTypes.h"
#include "RenderingThread.h"
#include "RenderGraphResourcePool.h"
#include "WebGPUShaderCode.h"
#include "Serialization/ArchiveSavePackageDataBuffer.h"
#include "Serialization/MemoryWriter.h"
#include "Interfaces/ITargetPlatform.h"

// Generated from the runtime source, with only class/console names changed.
#include "NaniteStreamingPageUploader.cpp"

bool RunWebGPUNaniteUploaderProbe(IDynamicRHIModule& Module, const FString& Directory, const FString& Output)
{
    using FTranscode = Nanite::FWebProbeTranscodePageToGPU_CS;
    IFileManager::Get().MakeDirectory(*Output, true);
    TArray<uint8> Disk;
    FString AssetText;
    TSharedPtr<FJsonObject> Asset;
    if (!FFileHelper::LoadFileToArray(Disk, *(Directory / TEXT("pages.bin"))) ||
        !FFileHelper::LoadFileToString(AssetText, *(Directory / TEXT("asset.json"))) ||
        !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(AssetText), Asset)) return false;
    // Start with the cooked resident fixture. Streamed dependencies/fixups are
    // not claimed by this test, even though the production planner runs here.
    if (!Asset->GetBoolField(TEXT("webCookEnabled")) || Asset->GetIntegerField(TEXT("numRootPages")) != 1) return false;
    const auto Page = Asset->GetArrayField(TEXT("pages"))[0]->AsObject();
    const uint32 PageBytes = Asset->GetIntegerField(TEXT("gpuPageBytes"));
    const uint32 DiskBytes = Page->GetIntegerField(TEXT("diskBytes"));
    const uint32 Clusters = Page->GetIntegerField(TEXT("numClusters"));
    if (Page->GetIntegerField(TEXT("sourceOffset")) != 0 || Page->GetIntegerField(TEXT("dependencyCount")) != 0 ||
        DiskBytes > uint32(Disk.Num()) || !Clusters) return false;
    const auto Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
    const auto* Format = GetTargetPlatformManagerRef().FindShaderFormat(UE::WebGPUShader::SM5Format);
    if (!Format || Platform == SP_NumPlatforms) return false;
    auto* Type = &FTranscode::GetStaticType();
    int32 PolicyChecks = 0;
    for (const FIntVector4 Test : {FIntVector4(32, 32, 0, 32), FIntVector4(32, 64, 0, 32),
        FIntVector4(64, 64, 32, 32), FIntVector4(16, 64, 0, 0), FIntVector4(0, 0, 0, 0),
        FIntVector4(64, 32, 0, 0), FIntVector4(32, 64, 64, 0), FIntVector4(32, 32, -1, 0)})
    {
        if (Nanite::GetWebTranscodeGroupSize(true, Test.X, Test.Y, Test.Z) != Test.W) return false;
        ++PolicyChecks;
    }
    if (Nanite::GetWebTranscodeGroupSize(false, 32, 32, 0) != 0) return false;
    ++PolicyChecks;
    const auto Mobile = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_ES31"));
    if (Mobile == SP_NumPlatforms) return false;
    for (int32 Id = 0; Id < FTranscode::FPermutationDomain::PermutationCount; ++Id)
    {
        const FTranscode::FPermutationDomain P(Id);
        if (Type->ShouldCompilePermutation(Platform, Id, EShaderPermutationFlags::HasEditorOnlyData) !=
            (P.Get<FTranscode::FGroupSizeDim>() == 32) ||
            Type->ShouldCompilePermutation(Mobile, Id, EShaderPermutationFlags::HasEditorOnlyData)) return false;
        ++PolicyChecks;
    }
    TArray<TUniquePtr<FShaderCompileJob>> Jobs;
    for (int32 Stage : {NANITE_TRANSCODE_PASS_INDEPENDENT, NANITE_TRANSCODE_PASS_PARENT_DEPENDENT})
    {
        FTranscode::FPermutationDomain Permutation;
        Permutation.Set<FTranscode::FGroupSizeDim>(32);
        Permutation.Set<FTranscode::FTranscodePassDim>(Stage);
        auto Job = MakeUnique<FShaderCompileJob>();
        const int32 Id = Permutation.ToDimensionValueId();
        Job->Key = FShaderCompileJobKey(Type, Platform, nullptr, Id);
        GlobalBeginCompileShader(TEXT("WebNaniteUploaderProbe"), nullptr, Type, nullptr, Id,
            TEXT("/Engine/Private/Nanite/NaniteTranscode.usf"), TEXT("TranscodePageToGPU"),
            FShaderTarget(SF_Compute, Platform), Job->Input, false);
        Job->Input.ShaderFormat = UE::WebGPUShader::SM5Format;
        Type->SetupCompileEnvironment(Platform, Id, EShaderPermutationFlags::HasEditorOnlyData, Job->Input.Environment);
        Format->ModifyShaderCompilerInput(Job->Input);
        if (!Format->PreprocessShader(Job->Input, Job->Input.Environment, Job->PreprocessOutput)) return false;
        Format->CompilePreprocessedShader(Job->Input, Job->PreprocessOutput, Job->Output);
        for (const auto& Error : Job->Output.Errors) UE_LOG(LogRHI, Display, TEXT("%s"), *Error.StrippedErrorMessage);
        if (!Job->Output.bSucceeded) return false;
        Job->Output.GenerateOutputHash();
        Jobs.Add(MoveTemp(Job));
    }
    // Export a cooked global-map section using the production shader type.
    // Browser UE loads this through its ordinary global shader archive; the
    // diagnostic names used by the native coexistence test never enter it.
    {
        auto* ShaderType = FShaderType::GetShaderTypeByName(TEXT("FTranscodePageToGPU_CS"));
        auto* RuntimeType = ShaderType ? ShaderType->GetGlobalShaderType() : nullptr;
        const ITargetPlatform* Target = GetTargetPlatformManagerRef().FindTargetPlatform(TEXT("Web"));
        if (!RuntimeType || !Target)
        {
            UE_LOG(LogRHI, Error, TEXT("Nanite shader archive requires the production shader type and -WebGPUCook Web target."));
            return false;
        }
        FGlobalShaderMap RuntimeMap(Platform);
        for (const auto& Job : Jobs)
        {
            RuntimeMap.FindOrAddSection(RuntimeType)->GetResourceCode()->AddShaderCompilerOutput(Job->Output, Job->Key);
            auto* Shader = RuntimeType->ConstructCompiled(FGlobalShaderType::CompiledShaderInitializerType(
                RuntimeType, nullptr, Job->Key.PermutationId, Job->Output, 0, nullptr, nullptr));
            RuntimeMap.FindOrAddShader(RuntimeType, Job->Key.PermutationId, Shader);
        }
        RuntimeMap.FindOrAddSection(RuntimeType)->FinalizeContent();
        TArray<uint8> Archive;
        FArchiveSavePackageDataBuffer CookContext(Target);
        FMemoryWriter Writer(Archive, true);
        Writer.SetSavePackageData(&CookContext);
        Writer.SetFilterEditorOnly(true);
        RuntimeMap.SaveToGlobalArchive(Writer);
        if (!FFileHelper::SaveArrayToFile(Archive, *(Output / TEXT("uploader-global-shaders.bin")))) return false;
    }
    bool Success = true;
    ENQUEUE_RENDER_COMMAND(WebNaniteUploaderProbe)([&](FRHICommandListImmediate& Cmd) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            FWebGPUGlobalScope Scope(Module);
            auto& RHI = *Scope.RHI;
            if (Bypass) GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU | ERHISubmitFlags::EnableBypass);
            bool Pass = GRHISupportsWaveOperations && GRHIMinimumWaveSize >= 32;
            auto Mode = MakeShared<FJsonObject>();
            Mode->SetBoolField(TEXT("bypass"), Bypass);
            Mode->SetStringField(TEXT("adapter"), RHI.AdapterName);
            Mode->SetNumberField(TEXT("minimumWaveSize"), GRHIMinimumWaveSize);
            Mode->SetNumberField(TEXT("maximumWaveSize"), GRHIMaximumWaveSize);
            FGlobalShaderMap* PreviousMap = GGlobalShaderMap[Platform];
            auto Map = MakeUnique<FGlobalShaderMap>(Platform);
            GGlobalShaderMap[Platform] = Map.Get();
            if (Pass)
            {
                for (const auto& Job : Jobs)
                {
                    auto* Section = Map->FindOrAddSection(Type);
                    Section->GetResourceCode()->AddShaderCompilerOutput(Job->Output, Job->Key);
                    auto* Shader = Type->ConstructCompiled(FGlobalShaderType::CompiledShaderInitializerType(
                        Type, nullptr, Job->Key.PermutationId, Job->Output, 0, nullptr, nullptr));
                    Job->Output.ParameterMap.VerifyBindingsAreComplete(Type->GetName(), Job->Output.Target, nullptr);
                    Map->FindOrAddShader(Type, Job->Key.PermutationId, Shader);
                }
                Map->FindOrAddSection(Type)->FinalizeContent();
                TArray<TSharedPtr<FJsonValue>> Cases;
                Nanite::FWebProbeStreamingPageUploader Uploader;
                // Reuse one uploader across graphs, including an empty batch.
                for (uint32 CaseIndex = 0; CaseIndex < 4; ++CaseIndex)
                {
                    const uint32 Prefix = CaseIndex == 0 ? 0 : 256;
                    const uint32 NumPages = CaseIndex >= 2 ? 2 : 1;
                    const uint32 ExpectedDispatches = CaseIndex == 2 ? 3 : CaseIndex == 3 ? 4 : 2;
                    TRefCountPtr<FRDGPooledBuffer> Result;
                    TArray<uint8> Initial;
                    Initial.Init(0xa5, Prefix + NumPages * PageBytes + 256);
                    FMemory::Memzero(Initial.GetData() + Prefix, NumPages * PageBytes);
                    const uint64 Before = RHI.Dispatches;
                    {
                        FRDGBuilder Graph(Cmd, RDG_EVENT_NAME("NaniteUploaderProbe"));
                        auto* Target = Graph.CreateBuffer(FRDGBufferDesc::CreateByteAddressDesc(Initial.Num()), TEXT("NaniteUploaderTarget"));
                        Graph.QueueBufferUpload(Target, MakeArrayView(Initial));
                        Uploader.Init(Graph, NumPages, NumPages * DiskBytes, 0);
                        // Two real root pages with a synthetic dependency edge,
                        // deliberately submitted child first to exercise the
                        // production sort and nonzero dependent StartClusterIndex.
                        if (CaseIndex == 2)
                            FMemory::Memcpy(Uploader.Add_GetRef(DiskBytes, Clusters, Prefix + PageBytes, {1, 1}, {0}), Disk.GetData(), DiskBytes);
                        FMemory::Memcpy(Uploader.Add_GetRef(DiskBytes, Clusters, Prefix, {1, 0}, {}), Disk.GetData(), DiskBytes);
                        Uploader.ResourceUploadTo(Graph, Target);
                        if (CaseIndex == 3)
                        {
                            Uploader.Init(Graph, 1, DiskBytes, 0);
                            FMemory::Memcpy(Uploader.Add_GetRef(DiskBytes, Clusters, Prefix + PageBytes, {2, 0}, {}), Disk.GetData(), DiskBytes);
                            Uploader.ResourceUploadTo(Graph, Target);
                        }
                        Graph.QueueBufferExtraction(Target, &Result, ERHIAccess::CopySrc);
                        Graph.Execute();
                    }
                    Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                    const auto Bytes = RHI.ReadBuffer(Result->GetRHI(), Initial.Num());
                    bool OK = Bytes.Num() == Initial.Num() && RHI.Dispatches - Before == ExpectedDispatches;
                    if (OK)
                    {
                        OK &= FMemory::Memcmp(Bytes.GetData(), Initial.GetData(), Prefix) == 0;
                        OK &= FMemory::Memcmp(Bytes.GetData() + Prefix + NumPages * PageBytes, Initial.GetData() + Prefix + NumPages * PageBytes, 256) == 0;
                        for (uint32 PageIndex = 0; PageIndex < NumPages; ++PageIndex)
                            OK &= FFileHelper::SaveArrayToFile(MakeArrayView(Bytes.GetData() + Prefix + PageIndex * PageBytes, int32(PageBytes)),
                                *(Output / FString::Printf(TEXT("page-%d-%u-%u.bin"), Bypass, CaseIndex, PageIndex)));
                    }
                    auto Case = MakeShared<FJsonObject>();
                    Case->SetNumberField(TEXT("prefix"), Prefix);
                    Case->SetNumberField(TEXT("index"), CaseIndex);
                    Case->SetNumberField(TEXT("pages"), NumPages);
                    Case->SetNumberField(TEXT("dispatches"), RHI.Dispatches - Before);
                    Case->SetBoolField(TEXT("pass"), OK);
                    Cases.Add(MakeShared<FJsonValueObject>(Case));
                    Pass &= OK;
                    Result.SafeRelease();
                    {
                        FRDGBuilder Graph(Cmd, RDG_EVENT_NAME("NaniteUploaderEmptyBatch"));
                        Uploader.Init(Graph, 1, 16, 0);
                        Uploader.ResourceUploadTo(Graph, nullptr);
                        Graph.Execute();
                    }
                    Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                    Pass &= RHI.Dispatches - Before == ExpectedDispatches;
                }
                Uploader.Release();
                Mode->SetArrayField(TEXT("cases"), Cases);
            }
            RHI.ReleaseBindings();
            for (const auto& Job : Jobs)
            {
                const auto Shader = Map->GetShader(Type, Job->Key.PermutationId);
                if (Shader.IsValid()) RHI.ShaderData(Shader.GetComputeShader()).Resources.Reset();
            }
            GGlobalShaderMap[Platform] = PreviousMap;
            Map.Reset();
            static_cast<FRenderResource&>(GRenderGraphResourcePool).ReleaseRHI();
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThreadFlushResources);
            Scope.PrepareShutdown();
            Pass &= RHI.Errors.IsEmpty();
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const auto& Error : RHI.Errors) Errors.Add(MakeShared<FJsonValueString>(Error));
            Mode->SetArrayField(TEXT("errors"), Errors);
            Scope.Restore();
            Pass &= Scope.IsRestored();
            Mode->SetBoolField(TEXT("pass"), Pass);
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
            Success &= Pass;
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Success);
        Report->SetNumberField(TEXT("policyChecks"), PolicyChecks);
        Report->SetArrayField(TEXT("modes"), Modes);
        FString Json;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
        Success &= FFileHelper::SaveStringToFile(Json, *(Output / TEXT("uploader-results.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    });
    FlushRenderingCommands();
    return Success;
}
#endif
