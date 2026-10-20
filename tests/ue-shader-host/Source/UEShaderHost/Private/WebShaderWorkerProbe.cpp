#include "WebShaderWorkerProbe.h"

#include "Dom/JsonObject.h"
#include "DataDrivenShaderPlatformInfo.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/ITargetPlatform.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Misc/EngineVersion.h"
#include "Misc/Compression.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/MemoryReader.h"
#include "Serialization/MemoryWriter.h"
#include "ShaderCompileWorkerUtil.h"
#include "WebGPUShaderCode.h"

static bool SameParameters(const FShaderParameterMap &A, const FShaderParameterMap &B)
{
    if (A.GetParameterMap().Num() != B.GetParameterMap().Num())
        return false;
    for (const auto &Pair : A.GetParameterMap())
    {
        const FParameterAllocation *Other = B.GetParameterMap().Find(Pair.Key);
        if (!Other || Pair.Value.BufferIndex != Other->BufferIndex || Pair.Value.BaseIndex != Other->BaseIndex ||
            Pair.Value.Size != Other->Size || Pair.Value.Type != Other->Type)
        {
            return false;
        }
    }
    return true;
}

FWebShaderWorkerProbe::FWebShaderWorkerProbe(const FString &Params, const FString &OutputDirectory, FName WebFormat)
    : Directory(OutputDirectory / TEXT("worker")), FormatName(WebFormat)
{
    Enabled = FParse::Value(*Params, TEXT("WebFormatWorker="), Worker);
    if (Enabled)
    {
        ITargetPlatformManagerModule &Platforms = GetTargetPlatformManagerRef();
        Format = Platforms.FindShaderFormat(FormatName);
        checkf(Format && Platforms.FindTargetPlatform(TEXT("WebGPUShaderHost")),
               TEXT("WebGPU shader host was not discovered through CustomTargetPlatforms"));
        check(Platforms.FindTargetPlatformWithSupport(TEXT("ShaderFormat"), FormatName) ==
              Platforms.FindTargetPlatform(TEXT("WebGPUShaderHost")));
        check(Platforms.ShaderFormatVersion(FormatName) == Format->GetVersion(FormatName));
        IFileManager::Get().MakeDirectory(*Directory, true);
    }
}

bool FWebShaderWorkerProbe::Add(const FString &Name, const FShaderCompilerInput &Input,
                                const FShaderParameterMap &NativeParameters,
                                const FShaderPreprocessOutput &NativePreprocessed)
{
    if (!Enabled)
        return true;
    FShaderCompileJob *Job = new FShaderCompileJob();
    Jobs.Add(Job);
    Names.Add(Name);
    Parameters.Add(NativeParameters);
    Job->Input = Input;
    Job->Input.ShaderFormat = FormatName;
    Job->Input.CompressionFormat = NAME_None;
    Format->ModifyShaderCompilerInput(Job->Input);
    if (!PreprocessShader(Job))
    {
        Prepared = false;
        return false;
    }
    Job->GetInputHash();
    CompileShader(TArray<const IShaderFormat *>{Format}, *Job);
    if (Job->PreprocessOutput.GetUnstrippedSourceView() != NativePreprocessed.GetUnstrippedSourceView())
    {
        Prepared = false;
        return false;
    }

    const bool Success = Job->Output.bSucceeded;
    const bool ExpectedUnsupported = !Name.StartsWith(TEXT("WebFallback_")) &&
                                     ((Name.StartsWith(TEXT("FClearReplacementCS_")) &&
                                       Name.Contains(TEXT("Buffer_")) && !Name.Contains(TEXT("StructuredBuffer_"))) ||
                                      Name == TEXT("TScreenVSForGS_true_"));
    Prepared &= Success != ExpectedUnsupported;
    Prepared &= !Success || SameParameters(NativeParameters, Job->Output.ParameterMap);
    ExpectedSuccess.Add(Success);
    ExpectedHashes.Add(Job->Output.OutputHash);
    if (Success)
    {
        FFileHelper::SaveArrayToFile(
            Job->Output.ShaderCode.GetReadView().Left(Job->Output.ShaderCode.GetShaderCodeSize()),
            *(Directory / (Name + TEXT(".editor.webshader"))));
    }
    Job->Output = FShaderCompilerOutput();
    Job->PreprocessOutput.EditSource().Compress();
    UE_LOG(LogTemp, Display, TEXT("P1_WEBFORMAT prepared %s success=%d expectedUnsupported=%d"), *Name, Success,
           ExpectedUnsupported);
    return Prepared;
}

TArray<uint8> FWebShaderWorkerProbe::MakeInput(int32 VersionDelta, uint32 FormatVersionDelta)
{
    TArray<uint8> Original;
    FMemoryWriter Writer(Original);
    FShaderCompileWorkerUtil::WriteTasks(Jobs, Writer);
    FMemoryReader Reader(Original);
    int32 Version;
    FString Compression;
    TMap<FName, uint32> Versions;
    Reader << Version << Compression << Versions;
    check(Compression == TEXT("None"));
    check(Versions.FindChecked(UE::WebGPUShader::ES31Format) == Format->GetVersion(UE::WebGPUShader::ES31Format));
    check(Versions.FindChecked(UE::WebGPUShader::SM5Format) == Format->GetVersion(UE::WebGPUShader::SM5Format));
    TArray<uint8> Result = Original;
    if (VersionDelta || FormatVersionDelta)
    {
        Versions[FormatName] += FormatVersionDelta;
        Version += VersionDelta;
        Result.Reset();
        FMemoryWriter Rewritten(Result);
        Rewritten << Version << Compression << Versions;
        Rewritten.Serialize(Original.GetData() + Reader.Tell(), Original.Num() - Reader.Tell());
    }
    FMemoryReader BodyReader(Result);
    BodyReader << Version << Compression;
    const int32 BodySize = Result.Num() - BodyReader.Tell();
    int32 CompressedSize = FCompression::CompressMemoryBound(NAME_Zlib, BodySize);
    TArray<uint8> Compressed;
    Compressed.SetNumUninitialized(CompressedSize);
    check(FCompression::CompressMemory(NAME_Zlib, Compressed.GetData(), CompressedSize,
                                       Result.GetData() + BodyReader.Tell(), BodySize));
    Compressed.SetNum(CompressedSize);
    TArray<uint8> Packet;
    FMemoryWriter PacketWriter(Packet);
    FString CompressionName(TEXT("Zlib"));
    int32 UncompressedSize = BodySize;
    PacketWriter << Version << CompressionName << UncompressedSize << Compressed;
    return Packet;
}

bool FWebShaderWorkerProbe::Execute(TArray<uint8> &Input, const FString &Batch, TArray<uint8> &Output, int32 &ErrorCode)
{
    const FString WorkingDirectory =
        FPaths::ConvertRelativePathToFull(Directory / (Batch + FGuid::NewGuid().ToString()));
    IFileManager::Get().MakeDirectory(*WorkingDirectory, true);
    FFileHelper::SaveArrayToFile(Input, *(WorkingDirectory / TEXT("WorkerInput.in")));
    FFileHelper::SaveArrayToFile(Input, *(Directory / (Batch + TEXT(".input.bin"))));
    const FString Arguments =
        FString::Printf(TEXT("\"%s/\" %u 0 WorkerInput.in WorkerOutput.out -unattended -nop4 -NoSound"),
                        *WorkingDirectory, FPlatformProcess::GetCurrentProcessId());
    FProcHandle Process =
        FPlatformProcess::CreateProc(*Worker, *Arguments, false, true, true, nullptr, 0, nullptr, nullptr);
    if (!Process.IsValid())
    {
        UE_LOG(LogTemp, Error, TEXT("P1_WEBFORMAT Worker launch failed"));
        return false;
    }
    const double Deadline = FPlatformTime::Seconds() + 120;
    while (FPlatformProcess::IsProcRunning(Process) && FPlatformTime::Seconds() < Deadline)
    {
        FPlatformProcess::Sleep(0.05f);
    }
    const bool TimedOut = FPlatformProcess::IsProcRunning(Process);
    if (TimedOut)
        FPlatformProcess::TerminateProc(Process, true);
    int32 ExitCode = -1;
    FPlatformProcess::GetProcReturnCode(Process, &ExitCode);
    FPlatformProcess::CloseProc(Process);
    if (TimedOut || !FFileHelper::LoadFileToArray(Output, *(WorkingDirectory / TEXT("WorkerOutput.out"))) ||
        Output.Num() < 60)
    {
        UE_LOG(LogTemp, Error, TEXT("P1_WEBFORMAT Worker missing output batch=%s exit=%d timeout=%d"), *Batch, ExitCode,
               TimedOut);
        return false;
    }
    FFileHelper::SaveArrayToFile(Output, *(Directory / (Batch + TEXT(".output.bin"))));
    FMemoryReader Header(Output);
    int32 Version;
    int64 FileSize;
    FShaderCompileWorkerDiagnostics Diagnostics;
    Header << Version << FileSize << Diagnostics;
    ErrorCode = Diagnostics.ErrorCode;
    UE_LOG(LogTemp, Display, TEXT("P1_WEBFORMAT Worker batch=%s exit=%d error=%d bytes=%d"), *Batch, ExitCode,
           ErrorCode, Output.Num());
    return Version == ShaderCompileWorkerOutputVersion && FileSize >= Header.Tell() && FileSize <= Output.Num() &&
           !Header.IsError();
}

bool FWebShaderWorkerProbe::Run()
{
    if (!Enabled)
        return true;
    TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("hostEngine"), FEngineVersion::Current().ToString());
    Report->SetStringField(TEXT("worker"), Worker);
    Report->SetStringField(TEXT("format"), FormatName.ToString());
    Report->SetNumberField(TEXT("formatVersion"), Format->GetVersion(FormatName));
    Report->SetNumberField(TEXT("inputVersion"), ShaderCompileWorkerInputVersion);
    Report->SetNumberField(TEXT("outputVersion"), ShaderCompileWorkerOutputVersion);
    Report->SetStringField(TEXT("taskCompression"), TEXT("Zlib"));
    Report->SetBoolField(TEXT("officialFormatDiscovery"), true);
    Report->SetBoolField(TEXT("officialPreprocessAndInputHash"), true);
    Report->SetBoolField(TEXT("officialWorkerFormatVersions"), true);
    ITargetPlatformManagerModule &Platforms = GetTargetPlatformManagerRef();
    ITargetPlatform *HostPlatform = Platforms.FindTargetPlatform(TEXT("WebGPUShaderHost"));
    check(HostPlatform);
    TSharedRef<FJsonObject> Registration = MakeShared<FJsonObject>();
    Registration->SetStringField(TEXT("name"), HostPlatform->PlatformName());
    Registration->SetStringField(TEXT("deviceProfile"), HostPlatform->CookingDeviceProfileName());
    Registration->SetBoolField(TEXT("canCookPackages"),
                               HostPlatform->SupportsFeature(ETargetPlatformFeatures::CanCookPackages));
    Registration->SetBoolField(TEXT("canPackage"), HostPlatform->SupportsFeature(ETargetPlatformFeatures::Packaging));
    Registration->SetBoolField(TEXT("canBuildGame"), HostPlatform->SupportsBuildTarget(EBuildTargetType::Game));
    FString Documentation;
    Registration->SetBoolField(TEXT("runtimeSdkInstalled"), HostPlatform->IsSdkInstalled(true, Documentation));
    TSharedRef<FJsonObject> RegisteredVersions = MakeShared<FJsonObject>();
    RegisteredVersions->SetNumberField(UE::WebGPUShader::ES31Format.ToString(),
                                       Platforms.ShaderFormatVersion(UE::WebGPUShader::ES31Format));
    RegisteredVersions->SetNumberField(UE::WebGPUShader::SM5Format.ToString(),
                                       Platforms.ShaderFormatVersion(UE::WebGPUShader::SM5Format));
    Registration->SetObjectField(TEXT("officialVersions"), RegisteredVersions);
    Report->SetObjectField(TEXT("targetPlatformRegistration"), Registration);
    const bool WebPlatform =
        !Jobs.IsEmpty() && FDataDrivenShaderPlatformInfo::GetPlatformName(
                               Jobs[0]->GetSingleShaderJob()->Input.Target.GetPlatform()) == FName(TEXT("WebGPU"));
    Report->SetBoolField(TEXT("independentWebShaderPlatform"), WebPlatform);
    Report->SetStringField(
        TEXT("registrationBoundary"),
        WebPlatform
            ? TEXT("Web static ShaderPlatform/DDPI loaded in isolated Editor/Worker hosts. Other modules are stock "
                   "5.8.0; full Web UBT factory/toolchain, Cook and RHI are not implemented.")
            : TEXT("WebGPUShaderHost discovers formats through CustomTargetPlatforms; runtime ShaderPlatform "
                   "remains native Vulkan. Web Cook/UBT/DDPI/RHI are not implemented."));
    TArray<TSharedPtr<FJsonValue>> Cases;
    TArray<uint8> Input = MakeInput(), Output;
    int32 ErrorCode = -1;
    bool Pass = Prepared && Execute(Input, TEXT("valid"), Output, ErrorCode) && ErrorCode == FSCWErrorCode::Success;
    if (Pass)
    {
        FMemoryReader WireReader(Output);
        int32 WireVersion, NumProcessed, CallstackLength, ExceptionLength, HostnameLength, JobHeader, JobCount;
        int64 WireSize;
        FShaderCompileWorkerDiagnostics WireDiagnostics;
        WireReader << WireVersion << WireSize << WireDiagnostics << NumProcessed << CallstackLength << ExceptionLength
                   << HostnameLength << JobHeader << JobCount;
        TArray<bool> ValidatedHashes;
        check(JobCount == Jobs.Num() && JobHeader == ShaderCompileWorkerSingleJobHeader);
        for (int32 Index = 0; Index < JobCount; ++Index)
        {
            FShaderCompilerOutput WireOutput;
            bool Secondary, Succeeded;
            WireReader << WireOutput << Secondary;
            check(!Secondary);
            WireReader << Succeeded;
            ValidatedHashes.Add(WireOutput.ValidateInputHash == Jobs[Index]->GetSingleShaderJob()->Input.Hash);
        }
        FMemoryReader Reader(Output);
        FShaderCompileWorkerDiagnostics Diagnostics;
        Pass &= FShaderCompileWorkerUtil::ReadTasks(Jobs, Reader, &Diagnostics,
                                                    FShaderCompileWorkerUtil::EReadTasksFlags::WillRetry) ==
                FSCWErrorCode::Success;
        for (int32 Index = 0; Index < Jobs.Num(); ++Index)
        {
            FShaderCompileJob *Job = Jobs[Index]->GetSingleShaderJob();
            TSharedRef<FJsonObject> Case = MakeShared<FJsonObject>();
            Case->SetStringField(TEXT("name"), Names[Index]);
            Case->SetBoolField(TEXT("compiled"), Job->Output.bSucceeded);
            Case->SetBoolField(TEXT("expectedRejection"), !ExpectedSuccess[Index]);
            Case->SetStringField(TEXT("inputHash"), LexToString(Job->InputHash));
            Case->SetStringField(TEXT("outputHash"), Job->Output.OutputHash.ToString());
            Case->SetStringField(TEXT("expectedOutputHash"), ExpectedHashes[Index].ToString());
            Case->SetBoolField(TEXT("inputHashVerified"), ValidatedHashes[Index]);
            Case->SetBoolField(TEXT("outputHashMatchesEditor"), Job->Output.OutputHash == ExpectedHashes[Index]);
            Case->SetNumberField(TEXT("shaderPlatformEnum"), Job->Input.Target.GetPlatform());
            bool CasePass = Job->Output.bSucceeded == ExpectedSuccess[Index] && ValidatedHashes[Index] &&
                            (!Job->Output.bSucceeded || Job->Output.OutputHash == ExpectedHashes[Index]);
            if (Job->Output.bSucceeded)
            {
                CasePass &= SameParameters(Parameters[Index], Job->Output.ParameterMap);
                const TConstArrayView<uint8> Code = Job->Output.ShaderCode.GetReadView();
                const TConstArrayView<uint8> Packet = Code.Left(Job->Output.ShaderCode.GetShaderCodeSize());
                UE::WebGPUShader::FPayload Payload;
                FString Error;
                const bool Decoded = UE::WebGPUShader::Decode(Packet, Payload, Error);
                Case->SetBoolField(TEXT("decoded"), Decoded);
                CasePass &= Decoded && Payload.FormatVersion == Format->GetVersion(FormatName) &&
                            Payload.Frequency == static_cast<uint32>(Job->Input.Target.GetFrequency());
                TSharedPtr<FJsonObject> Metadata;
                const bool MetadataRead = Decoded && FJsonSerializer::Deserialize(
                                                         TJsonReaderFactory<>::Create(Payload.MetadataJson), Metadata);
                CasePass &=
                    MetadataRead &&
                    Metadata->GetIntegerField(TEXT("shaderPlatformEnum")) == Job->Input.Target.GetPlatform() &&
                    Metadata->GetStringField(TEXT("shaderPlatform")) ==
                        FDataDrivenShaderPlatformInfo::GetName(Job->Input.Target.GetPlatform()).ToString() &&
                    Metadata->GetNumberField(TEXT("shaderPlatformPropertiesHash")) ==
                        FDataDrivenShaderPlatformInfo::GetShaderPlatformPropertiesHash(Job->Input.Target.GetPlatform());
                Case->SetNumberField(TEXT("packetBytes"), Packet.Num());
                Case->SetStringField(TEXT("packet"), Names[Index] + TEXT(".webshader"));
                Case->SetBoolField(TEXT("parameterMapMatchesNative"),
                                   SameParameters(Parameters[Index], Job->Output.ParameterMap));
                CasePass &= FFileHelper::SaveArrayToFile(Packet, *(Directory / (Names[Index] + TEXT(".webshader"))));
            }
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const FShaderCompilerError &Error : Job->Output.Errors)
            {
                Errors.Add(MakeShared<FJsonValueString>(Error.GetErrorString()));
            }
            Case->SetArrayField(TEXT("errors"), Errors);
            Case->SetBoolField(TEXT("pass"), CasePass);
            Pass &= CasePass;
            Cases.Add(MakeShared<FJsonValueObject>(Case));
        }
    }
    Report->SetArrayField(TEXT("cases"), Cases);
    Report->SetBoolField(TEXT("validBatch"), Pass);
    TArray<uint8> BadVersion = MakeInput(1), BadFormat = MakeInput(0, 1), NegativeOutput;
    int32 BadVersionCode = -1, BadFormatCode = -1;
    const bool VersionRejected = Execute(BadVersion, TEXT("bad-input-version"), NegativeOutput, BadVersionCode) &&
                                 BadVersionCode == FSCWErrorCode::BadInputVersion;
    const bool FormatRejected = Execute(BadFormat, TEXT("bad-format-version"), NegativeOutput, BadFormatCode) &&
                                BadFormatCode == FSCWErrorCode::BadShaderFormatVersion;
    Report->SetBoolField(TEXT("badInputVersionRejected"), VersionRejected);
    Report->SetBoolField(TEXT("badFormatVersionRejected"), FormatRejected);
    Pass &= VersionRejected && FormatRejected && !Cases.IsEmpty();
    Report->SetBoolField(TEXT("pass"), Pass);
    FString Json;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    FFileHelper::SaveStringToFile(Json, *(Directory / TEXT("worker-results.json")),
                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    return Pass;
}
