#include "WebGPUStructuredProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"

#include "HAL/FileManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

namespace
{
uint32 Pattern(uint32 Index, bool Updated)
{
    const uint32 First[] = {0, MAX_uint32, 0x80000000u, 0x12345678u};
    return Updated     ? (Index * 65537u) ^ 0xfedcba98u
           : Index < 4 ? First[Index]
                       : (Index * 2654435761u) ^ (0x80000000u + Index % 4);
}

TSharedRef<FJsonObject> RunMode(IDynamicRHIModule &Module, const FString &Directory, const FString &Output, bool Bypass,
                                uint32 Stride)
{
    using namespace WebGPUProbe;
    auto &Cmd = FRHICommandListImmediate::Get();
    FWebGPUGlobalScope Scope(Module);
    auto &RHI = *Scope.RHI;
    if (Bypass)
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                       ERHISubmitFlags::EnableBypass);
    const FString Mode = FString(Bypass ? TEXT("bypass-") : TEXT("recorded-")) + FString::FromInt(Stride);
    const uint32 Size = 256 * Stride, Words = Size / 4, Components = Stride / 4;
    bool Pass = true;
    uint64 Checked = 0;
    TArray<TSharedPtr<FJsonValue>> Checks;
    const auto Record = [&](const FString &Name, bool OK) {
        auto Check = MakeShared<FJsonObject>();
        Check->SetStringField(TEXT("name"), Name);
        Check->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Check));
        Pass &= OK;
        UE_LOG(LogRHI, Display, TEXT("P2_STRUCTURED %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    {
        const FString Prefix = Stride == 4 ? TEXT("WebR32Uint_") : TEXT("WebR32Uint4_");
        const FString SrcName = Stride == 4 ? TEXT("SrcStructuredBuffer1x") : TEXT("SrcStructuredBuffer4x");
        const FString DstName = Stride == 4 ? TEXT("DstStructuredBuffer1x") : TEXT("DstStructuredBuffer4x");
        auto Copy = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, *(Prefix + TEXT("MemcpyCS")))));
        auto Fill = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, *(Prefix + TEXT("MemsetBufferCS")))));
        auto &CopyData = RHI.ShaderData(Copy);
        auto &FillData = RHI.ShaderData(Fill);
        const auto Binding = [&](const FString &Name) {
            const auto *Found =
                CopyData.Metadata->GetArrayField(TEXT("spirvBindings")).FindByPredicate([&](const auto &Value) {
                    return Value->AsObject()->GetStringField(TEXT("name")) == Name;
                });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto ReadBinding = Binding(SrcName), WriteBinding = Binding(DstName);
        Record(TEXT("shader-reflects-storage-stride-and-access"),
               ReadBinding->GetIntegerField(TEXT("storageElementStride")) == Stride &&
                   WriteBinding->GetIntegerField(TEXT("storageElementStride")) == Stride &&
                   ReadBinding->GetBoolField(TEXT("readOnlyStorage")) &&
                   !WriteBinding->GetBoolField(TEXT("readOnlyStorage")));
        TArray<uint32> SourceValues, Expected, Zero;
        for (uint32 Index = 0; Index < Words; ++Index)
            SourceValues.Add(Pattern(Index, false));
        Expected.Init(0xa5a5a5a5u, Words);
        Zero.Init(0, Words);
        auto Source = Buffer(RHI, Cmd,
                             FRHIBufferCreateDesc::CreateStructured(TEXT("StructuredSource"), Size, Stride)
                                 .AddUsage(BUF_ShaderResource)
                                 .SetInitialState(ERHIAccess::SRVCompute),
                             SourceValues.GetData(), Size);
        auto Target = Buffer(RHI, Cmd,
                             FRHIBufferCreateDesc::CreateStructured(TEXT("StructuredTarget"), Size, Stride)
                                 .AddUsage(BUF_ShaderResource | BUF_UnorderedAccess)
                                 .SetInitialState(ERHIAccess::UAVCompute),
                             Expected.GetData(), Size);
        auto Sink = Buffer(RHI, Cmd,
                           FRHIBufferCreateDesc::CreateStructured(TEXT("StructuredSink"), Size, Stride)
                               .AddUsage(BUF_UnorderedAccess)
                               .SetInitialState(ERHIAccess::UAVCompute),
                           Zero.GetData(), Size);
        auto NoUsage = Buffer(RHI, Cmd,
                              FRHIBufferCreateDesc::CreateStructured(TEXT("NoViewUsage"), Size, Stride)
                                  .SetInitialState(ERHIAccess::CopySrc),
                              Zero.GetData(), Size);
        auto NotStructured = Buffer(
            RHI, Cmd,
            FRHIBufferCreateDesc::Create(TEXT("NonStructured"), Size, Stride, BUF_ShaderResource | BUF_UnorderedAccess)
                .SetInitialState(ERHIAccess::UAVCompute),
            Zero.GetData(), Size);
        FRHIViewDesc ReadDesc, WriteDesc;
        ReadDesc.Common.ViewType = FRHIViewDesc::EViewType::BufferSRV;
        ReadDesc.Buffer.SRV.BufferType = FRHIViewDesc::EBufferType::Structured;
        WriteDesc.Common.ViewType = FRHIViewDesc::EViewType::BufferUAV;
        WriteDesc.Buffer.UAV.BufferType = FRHIViewDesc::EBufferType::Structured;
        FString Error;
        Record(TEXT("reject-null-srv"), !RHI.ValidateBufferSRV(nullptr, ReadDesc, Error));
        Record(TEXT("reject-null-uav"), !RHI.ValidateUAV(nullptr, WriteDesc, Error));
        Record(TEXT("reject-srv-without-capability"), !RHI.ValidateBufferSRV(NoUsage, ReadDesc, Error));
        Record(TEXT("reject-uav-without-capability"), !RHI.ValidateUAV(NoUsage, WriteDesc, Error));
        Record(TEXT("reject-srv-of-non-structured-buffer"), !RHI.ValidateBufferSRV(NotStructured, ReadDesc, Error));
        Record(TEXT("reject-uav-of-non-structured-buffer"), !RHI.ValidateUAV(NotStructured, WriteDesc, Error));
        const auto Reject = [&](const TCHAR *Name, auto Change) {
            auto Read = ReadDesc, Write = WriteDesc;
            Change(Read.Buffer.SRV);
            Change(Write.Buffer.UAV);
            Record(FString(TEXT("reject-srv-")) + Name, !RHI.ValidateBufferSRV(Source, Read, Error));
            Record(FString(TEXT("reject-uav-")) + Name, !RHI.ValidateUAV(Target, Write, Error));
        };
        Reject(TEXT("format"), [](auto &View) { View.Format = PF_R32_UINT; });
        Reject(TEXT("stride"), [&](auto &View) { View.Stride = Stride == 4 ? 16 : 4; });
        Reject(TEXT("counter"), [](auto &View) { View.bAtomicCounter = true; });
        Reject(TEXT("append"), [](auto &View) { View.bAppendBuffer = true; });
        Reject(TEXT("storage-alignment"), [&](auto &View) {
            View.OffsetInBytes = Stride;
            View.NumElements = 1;
        });
        Reject(TEXT("offset-without-count"), [](auto &View) { View.OffsetInBytes = 256; });
        Reject(TEXT("offset-at-end"), [&](auto &View) {
            View.OffsetInBytes = Size;
            View.NumElements = 1;
        });
        Reject(TEXT("range"), [](auto &View) { View.NumElements = 257; });
        Reject(TEXT("overflow"), [](auto &View) { View.NumElements = MAX_uint32; });
        auto WholeSRV = Cmd.CreateShaderResourceView(Source, FRHIViewDesc::CreateBufferSRV().SetTypeFromBuffer(Source));
        auto WholeUAV =
            Cmd.CreateUnorderedAccessView(Target, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Target));
        auto RangeSRV = Cmd.CreateShaderResourceView(Source, FRHIViewDesc::CreateBufferSRV()
                                                                 .SetTypeFromBuffer(Source)
                                                                 .SetStride(Stride)
                                                                 .SetOffsetInBytes(256)
                                                                 .SetNumElements(96));
        auto RangeUAV = Cmd.CreateUnorderedAccessView(
            Target, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Target).SetOffsetInBytes(512).SetNumElements(96));
        const auto ReadInfo = WholeSRV->GetDesc().Buffer.SRV.GetViewInfo(Source);
        const auto WriteInfo = WholeUAV->GetDesc().Buffer.UAV.GetViewInfo(Target);
        const auto RangeRead = RangeSRV->GetDesc().Buffer.SRV.GetViewInfo(Source);
        const auto RangeWrite = RangeUAV->GetDesc().Buffer.UAV.GetViewInfo(Target);
        Record(TEXT("default-views-inherit-stride-and-count"),
               ReadInfo.Format == PF_Unknown && WriteInfo.Format == PF_Unknown && ReadInfo.StrideInBytes == Stride &&
                   WriteInfo.StrideInBytes == Stride && ReadInfo.NumElements == 256 && WriteInfo.NumElements == 256 &&
                   ReadInfo.SizeInBytes == Size && WriteInfo.SizeInBytes == Size);
        Record(TEXT("explicit-and-inherited-subranges"),
               RangeRead.OffsetInBytes == 256 && RangeWrite.OffsetInBytes == 512 &&
                   RangeRead.SizeInBytes == 96 * Stride && RangeWrite.SizeInBytes == 96 * Stride);
        Record(TEXT("views-retain-buffers"), Source->GetRefCount() == 3 && Target->GetRefCount() == 3);
        for (bool Missing : {false, true})
        {
            auto WrongRead = MakeShared<FJsonObject>(*ReadBinding), WrongWrite = MakeShared<FJsonObject>(*WriteBinding);
            WrongRead->SetNumberField(TEXT("storageElementStride"), Stride == 4 ? 16 : 4);
            WrongWrite->SetNumberField(TEXT("storageElementStride"), Stride == 4 ? 16 : 4);
            if (Missing)
            {
                WrongRead->RemoveField(TEXT("storageElementStride"));
                WrongWrite->RemoveField(TEXT("storageElementStride"));
            }
            const FString Reason = Missing ? TEXT("missing-shader-stride") : TEXT("shader-stride-mismatch");
            Record(TEXT("reject-srv-") + Reason,
                   !RHI.ValidateStorageSRVBinding(WholeSRV, *WrongRead, ERHIAccess::SRVCompute, Error));
            Record(TEXT("reject-uav-") + Reason,
                   !RHI.ValidateStorageUAVBinding(WholeUAV, *WrongWrite, ERHIAccess::UAVCompute, Error));
        }
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::SRVCompute, ERHIAccess::CopyDest));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-srv-access-mismatch"),
               !RHI.ValidateStorageSRVBinding(WholeSRV, *ReadBinding, ERHIAccess::SRVCompute, Error));
        const FRHITransitionInfo Info(Source, ERHIAccess::CopyDest, ERHIAccess::SRVCompute);
        auto *Transition = RHICreateTransition(FRHITransitionCreateInfo(
            ERHIPipeline::Graphics, ERHIPipeline::Graphics, ERHITransitionCreateFlags::None, MakeArrayView(&Info, 1)));
        Cmd.BeginTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-srv-during-split-transition"),
               !RHI.ValidateStorageSRVBinding(WholeSRV, *ReadBinding, ERHIAccess::SRVCompute, Error));
        Cmd.EndTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("srv-valid-after-transition-end"),
               RHI.ValidateStorageSRVBinding(WholeSRV, *ReadBinding, ERHIAccess::SRVCompute, Error));
        const auto Parameter = [&](FRHIComputeShader *Shader, const FString &Name) {
            const auto *Found = RHI.ShaderData(Shader)
                                    .Metadata->GetArrayField(TEXT("ueParameterMap"))
                                    .FindByPredicate([&](const auto &Value) {
                                        return Value->AsObject()->GetStringField(TEXT("name")) == Name;
                                    });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto SetValue = [&](FRHIComputeShader *Shader, const TCHAR *Name, uint32 Value) {
            const auto Allocation = Parameter(Shader, Name);
            const FRHIShaderParameter Item(Allocation->GetIntegerField(TEXT("bufferIndex")),
                                           Allocation->GetIntegerField(TEXT("baseIndex")), 0, 4);
            Cmd.SetShaderParameters(Shader, MakeArrayView(reinterpret_cast<const uint8 *>(&Value), 4),
                                    MakeArrayView(&Item, 1), {}, {});
        };
        const auto Slot = [&](FRHIComputeShader *Shader, const FString &Name) -> uint16 {
            return Parameter(Shader, Name)->GetIntegerField(TEXT("baseIndex"));
        };
        const auto Dispatch = [&](FRHIShaderResourceView *SRV, FRHIUnorderedAccessView *UAV, uint32 Src, uint32 Dst,
                                  uint32 Count) {
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Copy));
            const FRHIShaderParameterResource Resources[] = {{SRV, Slot(Copy, SrcName)}, {UAV, Slot(Copy, DstName)}};
            Cmd.SetShaderParameters(Copy, {}, {}, Resources, {});
            SetValue(Copy, TEXT("SrcOffset"), Src);
            SetValue(Copy, TEXT("DstOffset"), Dst);
            SetValue(Copy, TEXT("Size"), Count);
            Cmd.DispatchComputeShader(FMath::DivideAndRoundUp(Count, 64u), 1, 1);
        };
        const auto CheckBuffer = [&](const TCHAR *Name, FRHIBuffer *ToRead, const TArray<uint32> &Values) {
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(ToRead, Size);
            bool OK = Bytes.Num() == Size;
            for (int32 Index = 0; Index < Values.Num() && OK; ++Index)
            {
                uint32 Actual;
                FMemory::Memcpy(&Actual, Bytes.GetData() + Index * 4, 4);
                OK &= Actual == Values[Index];
            }
            Checked += Words;
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / (Mode + TEXT("-") + Name + TEXT(".bin")))));
            Record(Name, OK);
        };
        const auto UpdateExpected = [&](uint32 Src, uint32 Dst, uint32 Count) {
            for (uint32 Index = 0; Index < Count * Components; ++Index)
                Expected[Dst * Components + Index] = SourceValues[Src * Components + Index];
        };
        Dispatch(WholeSRV, WholeUAV, 7, 11, 129);
        UpdateExpected(7, 11, 129);
        CheckBuffer(TEXT("whole-copy-and-guards"), Target, Expected);
        CheckBuffer(TEXT("read-only-source-preserved"), Source, SourceValues);
        Dispatch(RangeSRV, RangeUAV, 3, 9, 67);
        UpdateExpected(256 / Stride + 3, 512 / Stride + 9, 67);
        CheckBuffer(TEXT("subrange-copy-and-guards"), Target, Expected);
        SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Fill));
        const FRHIShaderParameterResource FillResource(RangeUAV, Slot(Fill, DstName));
        Cmd.SetShaderParameters(Fill, {}, {}, MakeArrayView(&FillResource, 1), {});
        SetValue(Fill, TEXT("Value"), 0xfedcba98u);
        SetValue(Fill, TEXT("DstOffset"), 1);
        SetValue(Fill, TEXT("Size"), 13);
        Cmd.DispatchComputeShader(1, 1, 1);
        for (uint32 Index = 0; Index < 13 * Components; ++Index)
            Expected[(512 / Stride + 1) * Components + Index] = 0xfedcba98u;
        CheckBuffer(TEXT("subrange-fill-all-components"), Target, Expected);
        for (uint32 Index = 0; Index < Words; ++Index)
            SourceValues[Index] = Pattern(Index, true);
        auto Updated = Buffer(RHI, Cmd,
                              FRHIBufferCreateDesc::CreateStructured(TEXT("UpdatedStructured"), Size, Stride)
                                  .SetInitialState(ERHIAccess::CopySrc),
                              SourceValues.GetData(), Size);
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::SRVCompute, ERHIAccess::CopyDest));
        Cmd.CopyBufferRegion(Source, 0, Updated, 0, Size);
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::CopyDest, ERHIAccess::SRVCompute));
        Dispatch(RangeSRV, WholeUAV, 10, 199, 35);
        UpdateExpected(256 / Stride + 10, 199, 35);
        CheckBuffer(TEXT("existing-view-observes-update"), Target, Expected);
        auto TargetSRV =
            Cmd.CreateShaderResourceView(Target, FRHIViewDesc::CreateBufferSRV().SetTypeFromBuffer(Target));
        auto SinkUAV = Cmd.CreateUnorderedAccessView(Sink, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Sink));
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::UAVCompute, ERHIAccess::SRVCompute));
        Dispatch(TargetSRV, SinkUAV, 0, 0, 256);
        CheckBuffer(TEXT("uav-writes-visible-through-srv"), Sink, Expected);
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::SRVCompute, ERHIAccess::UAVCompute));
        Dispatch(WholeSRV, WholeUAV, 2, 3, 73);
        Record(TEXT("commands-obey-recording-mode"), RHI.Dispatches == (Bypass ? 6u : 5u));
        FillData.Resources.Reset();
        WholeSRV.SafeRelease();
        RangeSRV.SafeRelease();
        WholeUAV.SafeRelease();
        RangeUAV.SafeRelease();
        TargetSRV.SafeRelease();
        Source.SafeRelease();
        Target.SafeRelease();
        Updated.SafeRelease();
        UpdateExpected(2, 3, 73);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        const auto *Read = CopyData.Resources.Find((3u << 16) | Slot(Copy, SrcName));
        const auto *Write = CopyData.Resources.Find((4u << 16) | Slot(Copy, DstName));
        Record(TEXT("shader-bindings-retain-views"), Read && Read->IsValid() && Write && Write->IsValid());
        check(Read && Write);
        auto *BoundSource = static_cast<FRHIShaderResourceView *>(Read->GetReference())->GetBuffer();
        auto *BoundTarget =
            static_cast<FRHIBuffer *>(static_cast<FRHIUnorderedAccessView *>(Write->GetReference())->GetResource());
        CheckBuffer(TEXT("views-survive-caller-release"), BoundTarget, Expected);
        CheckBuffer(TEXT("updated-read-only-source-preserved"), BoundSource, SourceValues);
        Record(TEXT("compute-psos-reused"), RHI.ComputePipelinesCreated == 2 && RHI.Dispatches == 6);
        CopyData.Resources.Reset();
    }
    Scope.PrepareShutdown();
    Record(TEXT("transitions-released"),
           RHI.TransitionsCreated == 6 && RHI.TransitionsReleased == 6 && RHI.Transitions.IsEmpty());
    Record(TEXT("gpu-validation-clean"), RHI.Errors.IsEmpty());
    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("mode"), Mode);
    Report->SetNumberField(TEXT("stride"), Stride);
    Report->SetNumberField(TEXT("checkedValues"), Checked);
    Report->SetNumberField(TEXT("dispatches"), RHI.Dispatches);
    Report->SetNumberField(TEXT("computePipelinesCreated"), RHI.ComputePipelinesCreated);
    Report->SetNumberField(TEXT("finalizedCommandLists"), RHI.Finalized);
    Report->SetNumberField(TEXT("submittedCommandLists"), RHI.Submitted);
    Report->SetNumberField(TEXT("boundGroups"), RHI.BoundGroups);
    Report->SetNumberField(TEXT("transitionsReleased"), RHI.TransitionsReleased);
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

bool RunWebGPUStructuredProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUStructuredProbe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
            for (uint32 Stride : {4u, 16u})
            {
                auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass, Stride);
                Pass &= Mode->GetBoolField(TEXT("pass"));
                Modes.Add(MakeShared<FJsonValueObject>(Mode));
            }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("structuredStorageViewsVerified"), Pass);
        Report->SetBoolField(TEXT("resourceTableViewsImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetArrayField(TEXT("modes"), Modes);
        FString JSON;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
        check(FFileHelper::SaveStringToFile(JSON, *(OutputDirectory / TEXT("structured-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
