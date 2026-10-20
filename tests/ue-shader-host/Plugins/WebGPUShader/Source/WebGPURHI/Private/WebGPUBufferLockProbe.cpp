#include "WebGPUBufferLockProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"

#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

namespace
{
TSharedRef<FJsonObject> RunMode(IDynamicRHIModule &Module, const FString &Directory, const FString &Output, bool Bypass,
                                bool Buffered)
{
    using namespace WebGPUProbe;
    auto &Cmd = FRHICommandListImmediate::Get();
    FWebGPUGlobalScope Scope(Module);
    auto &RHI = *Scope.RHI;
    if (Bypass)
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                       ERHISubmitFlags::EnableBypass);
    auto *LockSetting = IConsoleManager::Get().FindConsoleVariable(TEXT("r.RHICmdBufferWriteLocks"));
    check(LockSetting);
    const FString Mode =
        FString(Bypass ? TEXT("bypass-") : TEXT("recorded-")) + (Buffered ? TEXT("buffered") : TEXT("direct"));
    bool Pass = true;
    uint64 Checked = 0;
    TArray<TSharedPtr<FJsonValue>> Checks;
    const auto Record = [&](const FString &Name, bool OK) {
        auto Check = MakeShared<FJsonObject>();
        Check->SetStringField(TEXT("name"), Name);
        Check->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Check));
        Pass &= OK;
        UE_LOG(LogRHI, Display, TEXT("P2_BUFFER_LOCK %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    Record(TEXT("ue-buffered-lock-setting"), LockSetting->GetInt() == int32(Buffered));
    {
        TArray<uint32> Initial, Expected;
        Initial.Init(0xdddddddd, 256);
        for (uint32 Index = 0; Index < 256; ++Index)
            Expected.Add((Index * 37 + 11) ^ 0xa5a55a5a);
        auto Source = Buffer(RHI, Cmd,
                             FRHIBufferCreateDesc::Create(TEXT("LockVertexSource"), 1024, 4,
                                                          BUF_VertexBuffer | BUF_ShaderResource | BUF_UnorderedAccess)
                                 .SetInitialState(ERHIAccess::CopySrc),
                             Initial.GetData(), 1024);
        const auto CopyTarget = [&](const TCHAR *Name) {
            return Buffer(
                RHI, Cmd,
                FRHIBufferCreateDesc::Create(Name, 1024, 4, BUF_ShaderResource).SetInitialState(ERHIAccess::CopyDest),
                Initial.GetData(), 1024);
        };
        auto Before = CopyTarget(TEXT("BeforeLockUpdate"));
        auto Partial = CopyTarget(TEXT("AfterPartialLockUpdate"));
        auto Repeated = CopyTarget(TEXT("AfterRepeatedLockUpdate"));
        FString Error;
        Record(TEXT("reject-null-lock"), !RHI.ValidateBufferLock(nullptr, 0, 4, RLM_WriteOnly, Error));
        Record(TEXT("reject-unmatched-unlock"), !RHI.ValidateBufferUnlock(Source, Error));
        const auto Reject = [&](const TCHAR *Name, uint32 Offset, uint32 Size, EResourceLockMode LockMode) {
            Record(Name, !RHI.ValidateBufferLock(Source, Offset, Size, LockMode, Error));
        };
        Reject(TEXT("reject-empty-lock"), 0, 0, RLM_WriteOnly);
        Reject(TEXT("reject-offset-alignment"), 2, 4, RLM_WriteOnly);
        Reject(TEXT("reject-size-alignment"), 0, 6, RLM_WriteOnly);
        Reject(TEXT("reject-range"), 1020, 8, RLM_WriteOnly);
        Reject(TEXT("reject-overflow"), MAX_uint32 - 3, 8, RLM_WriteOnly);
        Reject(TEXT("reject-no-overwrite"), 0, 4, RLM_WriteOnly_NoOverwrite);
        Reject(TEXT("reject-invalid-mode"), 0, 4, RLM_Num);
        auto *Whole = Cmd.LockBuffer(Source, 0, 1024, RLM_WriteOnly);
        FMemory::Memcpy(Whole, Expected.GetData(), 1024);
        Cmd.UnlockBuffer(Source);
        Record(TEXT("upload-obeys-ue-lock-mode"), RHI.BufferUploads == (Buffered && !Bypass ? 0u : 1u));
        Cmd.CopyBufferRegion(Before, 0, Source, 0, 1024);
        auto *Words = static_cast<uint32 *>(Cmd.LockBuffer(Source, 20, 40, RLM_WriteOnly));
        auto First = Expected;
        for (uint32 Index = 0; Index < 10; ++Index)
            Words[Index] = Expected[5 + Index] = 1000 + Index * 3;
        Cmd.UnlockBuffer(Source);
        Cmd.CopyBufferRegion(Partial, 0, Source, 0, 1024);
        auto Second = Expected;
        Words = static_cast<uint32 *>(Cmd.LockBuffer(Source, 32, 16, RLM_WriteOnly));
        for (uint32 Index = 0; Index < 4; ++Index)
            Words[Index] = Expected[8 + Index] = 9000 + Index;
        Cmd.UnlockBuffer(Source);
        Cmd.CopyBufferRegion(Repeated, 0, Source, 0, 1024);
        const auto CheckBytes = [&](const TCHAR *Name, TConstArrayView<uint8> Bytes, TConstArrayView<uint32> Values) {
            bool OK = Bytes.Num() == Values.Num() * 4;
            for (int32 Index = 0; OK && Index < Values.Num(); ++Index)
            {
                uint32 Actual;
                FMemory::Memcpy(&Actual, Bytes.GetData() + Index * 4, 4);
                OK &= Actual == Values[Index];
            }
            Checked += Values.Num();
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / (Mode + TEXT("-") + Name + TEXT(".bin")))));
            Record(Name, OK);
        };
        const auto CheckBuffer = [&](const TCHAR *Name, FRHIBuffer *BufferToRead, const TArray<uint32> &Values) {
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(BufferToRead, 1024);
            CheckBytes(Name, Bytes, Values);
        };
        CheckBuffer(TEXT("copy-before-update-preserved"), Before, First);
        CheckBuffer(TEXT("partial-write-and-sentinels"), Partial, Second);
        CheckBuffer(TEXT("overlapping-update-in-order"), Repeated, Expected);
        CheckBuffer(TEXT("updated-vertex-buffer"), Source, Expected);

        auto Fill = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebR32Uint_MemsetBufferCS"))));
        auto UAV = Cmd.CreateUnorderedAccessView(
            Source, FRHIViewDesc::CreateBufferUAV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32_UINT));
        const auto Parameter = [&](const TCHAR *Name) {
            const auto *Found = RHI.ShaderData(Fill)
                                    .Metadata->GetArrayField(TEXT("ueParameterMap"))
                                    .FindByPredicate([&](const auto &Value) {
                                        return Value->AsObject()->GetStringField(TEXT("name")) == Name;
                                    });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto SetValue = [&](const TCHAR *Name, uint32 Value) {
            const auto Allocation = Parameter(Name);
            const FRHIShaderParameter Item(Allocation->GetIntegerField(TEXT("bufferIndex")),
                                           Allocation->GetIntegerField(TEXT("baseIndex")), 0, 4);
            Cmd.SetShaderParameters(Fill, MakeArrayView(reinterpret_cast<const uint8 *>(&Value), 4),
                                    MakeArrayView(&Item, 1), {}, {});
        };
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
        SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Fill));
        const FRHIShaderParameterResource FillResource(
            UAV, Parameter(TEXT("DstStructuredBuffer1x"))->GetIntegerField(TEXT("baseIndex")));
        Cmd.SetShaderParameters(Fill, {}, {}, MakeArrayView(&FillResource, 1), {});
        SetValue(TEXT("Value"), 0x13579bdf);
        SetValue(TEXT("DstOffset"), 17);
        SetValue(TEXT("Size"), 23);
        Cmd.DispatchComputeShader(1, 1, 1);
        for (uint32 Index = 17; Index < 40; ++Index)
            Expected[Index] = 0x13579bdf;
        const auto *Read = static_cast<const uint8 *>(Cmd.LockBuffer(Source, 64, 128, RLM_ReadOnly));
        CheckBytes(TEXT("read-lock-observes-gpu-write"), MakeArrayView(Read, 128),
                   MakeArrayView(Expected.GetData() + 16, 32));
        Record(TEXT("read-lock-preserves-logical-state"), RHI.ResourceState(Source).Access == ERHIAccess::UAVCompute);
        Record(TEXT("reject-access-during-read-lock"), !RHI.ValidateAccess(Source, ERHIAccess::CopySrc, Error, true));
        FMemory::Memset(const_cast<uint8 *>(Read), 0, 128);
        Cmd.UnlockBuffer(Source);
        CheckBuffer(TEXT("read-lock-cpu-changes-discarded"), Source, Expected);

        const FRHITransitionInfo SplitInfo(Source, ERHIAccess::UAVCompute, ERHIAccess::CopySrc);
        auto *Split = RHICreateTransition(FRHITransitionCreateInfo(ERHIPipeline::Graphics, ERHIPipeline::Graphics,
                                                                   ERHITransitionCreateFlags::None,
                                                                   MakeArrayView(&SplitInfo, 1)));
        Cmd.BeginTransition(Split);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-write-lock-during-split"), !RHI.ValidateBufferLock(Source, 0, 4, RLM_WriteOnly, Error));
        Record(TEXT("reject-read-lock-during-split"), !RHI.ValidateBufferLock(Source, 0, 4, RLM_ReadOnly, Error));
        Cmd.EndTransition(Split);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        const FRHITransitionInfo LockedInfo(Source, ERHIAccess::CopySrc, ERHIAccess::SRVCompute);
        auto *LockedTransition = RHICreateTransition(
            FRHITransitionCreateInfo(ERHIPipeline::Graphics, ERHIPipeline::Graphics, ERHITransitionCreateFlags::None,
                                     MakeArrayView(&LockedInfo, 1)));
        auto Index = Buffer(RHI, Cmd,
                            FRHIBufferCreateDesc::CreateIndex(TEXT("LockedIndex16"), 1024, 2)
                                .AddUsage(BUF_Static)
                                .SetInitialState(ERHIAccess::VertexOrIndexBuffer),
                            Initial.GetData(), 1024);
        auto *IndexRaw = Index.GetReference();
        auto *IndexBytes = static_cast<uint32 *>(RHI.LockBuffer_BottomOfPipe(Cmd, Index, 128, 16, RLM_WriteOnly));
        auto *VertexWord = static_cast<uint32 *>(RHI.LockBuffer_BottomOfPipe(Cmd, Source, 0, 4, RLM_WriteOnly));
        Record(TEXT("independent-buffers-lock-simultaneously"), RHI.BufferLocks.Num() == 2);
        Record(TEXT("write-lock-preserves-logical-state"),
               RHI.ResourceState(Source).Access == ERHIAccess::CopySrc &&
                   RHI.ResourceState(Index).Access == ERHIAccess::VertexOrIndexBuffer);
        Record(TEXT("reject-double-write-lock"), !RHI.ValidateBufferLock(Source, 0, 4, RLM_WriteOnly, Error));
        Record(TEXT("reject-read-lock-during-write-lock"), !RHI.ValidateBufferLock(Source, 0, 4, RLM_ReadOnly, Error));
        Record(TEXT("reject-readback-during-write-lock"),
               !RHI.ValidateAccess(Source, ERHIAccess::CopySrc, Error, true));
        Record(TEXT("reject-gpu-access-during-write-lock"), !RHI.ValidateAccess(Source, ERHIAccess::CopySrc, Error));
        RHI.RHIGetDefaultContext();
        const FRHITransition *LockedBatch[] = {LockedTransition};
        Record(TEXT("reject-transition-during-write-lock"),
               !RHI.ValidateTransitionBatch(MakeArrayView(LockedBatch), true, Error));
        auto Image = Target(RHI, Cmd, 8, 8);
        Cmd.BeginRenderPass(FRHIRenderPassInfo(Image, ERenderTargetActions::Clear_Store), TEXT("LockNegativePass"));
        Cmd.EnqueueLambda([&](FRHICommandListBase &) {
            Record(TEXT("reject-lock-inside-render-pass"), !RHI.ValidateBufferLock(Before, 0, 4, RLM_WriteOnly, Error));
            Record(TEXT("reject-unlock-inside-render-pass"), !RHI.ValidateBufferUnlock(Source, Error));
        });
        Cmd.EndRenderPass();
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        auto IndexExpected = Initial;
        for (uint32 Word = 0; Word < 4; ++Word)
            IndexBytes[Word] = IndexExpected[32 + Word] = 0xfeedface + Word;
        *VertexWord = Expected[0] = 0xabcdef01;
        Index.SafeRelease();
        Record(TEXT("active-lock-retains-released-buffer"), IndexRaw->GetRefCount() == 1);
        Index = IndexRaw;
        RHI.UnlockBuffer_BottomOfPipe(Cmd, Index);
        RHI.UnlockBuffer_BottomOfPipe(Cmd, Source);
        Record(TEXT("reject-double-unlock"), !RHI.ValidateBufferUnlock(Index, Error));
        Cmd.BeginTransition(LockedTransition);
        Cmd.EndTransition(LockedTransition);
        CheckBuffer(TEXT("index16-lock-upload-and-guards"), Index, IndexExpected);
        CheckBuffer(TEXT("direct-lock-after-gpu-write"), Source, Expected);
        RHI.ShaderData(Fill).Resources.Reset();
    }
    Scope.PrepareShutdown();
    Record(TEXT("all-locks-and-uploads-balanced"), RHI.BufferLocks.IsEmpty() && RHI.BufferLocksCreated == 6 &&
                                                       RHI.BufferLocksReleased == 6 && RHI.BufferUploads == 5 &&
                                                       RHI.BufferReadLocks == 1 && RHI.BufferUploadBytes == 1100);
    Record(TEXT("all-transitions-released"),
           RHI.TransitionsCreated == 3 && RHI.TransitionsReleased == 3 && RHI.Transitions.IsEmpty());
    Record(TEXT("gpu-validation-clean"), RHI.Errors.IsEmpty());
    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("mode"), Mode);
    Report->SetBoolField(TEXT("bypass"), Bypass);
    Report->SetBoolField(TEXT("bufferedWriteLocks"), Buffered);
    Report->SetNumberField(TEXT("checkedValues"), Checked);
    Report->SetNumberField(TEXT("dispatches"), RHI.Dispatches);
    Report->SetNumberField(TEXT("bufferLocksCreated"), RHI.BufferLocksCreated);
    Report->SetNumberField(TEXT("bufferLocksReleased"), RHI.BufferLocksReleased);
    Report->SetNumberField(TEXT("bufferUploads"), RHI.BufferUploads);
    Report->SetNumberField(TEXT("bufferUploadBytes"), RHI.BufferUploadBytes);
    Report->SetNumberField(TEXT("bufferReadLocks"), RHI.BufferReadLocks);
    Report->SetNumberField(TEXT("finalizedCommandLists"), RHI.Finalized);
    Report->SetNumberField(TEXT("submittedCommandLists"), RHI.Submitted);
    TArray<TSharedPtr<FJsonValue>> Errors;
    for (const auto &Error : RHI.Errors)
        Errors.Add(MakeShared<FJsonValueString>(Error));
    Report->SetArrayField(TEXT("errors"), Errors);
    Scope.Restore();
    Record(TEXT("host-rhi-restored"), Scope.IsRestored());
    Report->SetArrayField(TEXT("checks"), Checks);
    Report->SetBoolField(TEXT("pass"), Pass);
    return Report;
}
} // namespace

bool RunWebGPUBufferLockProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    check(IsInGameThread());
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    TArray<TSharedPtr<FJsonValue>> Modes;
    auto *LockSetting = IConsoleManager::Get().FindConsoleVariable(TEXT("r.RHICmdBufferWriteLocks"));
    check(LockSetting);
    const int32 PreviousSetting = LockSetting->GetInt();
    for (bool Bypass : {false, true})
        for (bool Buffered : {false, true})
        {
            LockSetting->Set(Buffered ? 1 : 0, ECVF_SetByCode);
            TSharedPtr<FJsonObject> Mode;
            ENQUEUE_RENDER_COMMAND(WebGPUBufferLockProbe)([&](FRHICommandListImmediate &) {
                Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass, Buffered);
            });
            FlushRenderingCommands();
            LockSetting->Set(PreviousSetting, ECVF_SetByCode);
            FlushRenderingCommands();
            const bool Restored = LockSetting->GetInt() == PreviousSetting;
            auto Check = MakeShared<FJsonObject>();
            Check->SetStringField(TEXT("name"), TEXT("ue-lock-setting-restored"));
            Check->SetBoolField(TEXT("pass"), Restored);
            auto Checks = Mode->GetArrayField(TEXT("checks"));
            Checks.Add(MakeShared<FJsonValueObject>(Check));
            Mode->SetArrayField(TEXT("checks"), Checks);
            const bool ModePass = Mode->GetBoolField(TEXT("pass")) && Restored;
            Mode->SetBoolField(TEXT("pass"), ModePass);
            UE_LOG(LogRHI, Display, TEXT("P2_BUFFER_LOCK %s ue-lock-setting-restored pass=%d"),
                   *Mode->GetStringField(TEXT("mode")), Restored);
            Pass &= ModePass;
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
    auto Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), Pass);
    Report->SetBoolField(TEXT("bufferLockUploadVerified"), Pass);
    Report->SetBoolField(TEXT("synchronousNativeReadLocksVerified"), Pass);
    Report->SetBoolField(TEXT("unalignedLocksImplemented"), false);
    Report->SetBoolField(TEXT("noOverwriteLocksImplemented"), false);
    Report->SetBoolField(TEXT("browserEngineImplemented"), false);
    Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
    Report->SetArrayField(TEXT("modes"), Modes);
    FString JSON;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
    check(FFileHelper::SaveStringToFile(JSON, *(OutputDirectory / TEXT("buffer-lock-results.json")),
                                       FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    return Pass;
}
