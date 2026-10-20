#include "WebGPUUint4Probe.h"
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
    const uint32 Values[] = {0, MAX_uint32, 0x80000000u, 0x12345678u};
    return Updated     ? (Index * 65537u) ^ 0xfedcba98u
           : Index < 4 ? Values[Index]
                       : (Index * 2654435761u) ^ (0x80000000u + Index % 4);
}

TSharedRef<FJsonObject> RunMode(IDynamicRHIModule &Module, const FString &Directory, const FString &Output, bool Bypass)
{
    using namespace WebGPUProbe;
    auto &Cmd = FRHICommandListImmediate::Get();
    FWebGPUGlobalScope Scope(Module);
    auto &RHI = *Scope.RHI;
    if (Bypass)
        GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                                       ERHISubmitFlags::EnableBypass);
    const FString Mode = Bypass ? TEXT("bypass") : TEXT("recorded");
    bool Pass = true;
    uint64 Checked = 0;
    TArray<TSharedPtr<FJsonValue>> Checks;
    const auto Record = [&](const FString &Name, bool OK) {
        auto Check = MakeShared<FJsonObject>();
        Check->SetStringField(TEXT("name"), Name);
        Check->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Check));
        Pass &= OK;
        UE_LOG(LogRHI, Display, TEXT("P2_UINT4 %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    {
        auto Copy = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebR32Uint4_MemcpyCS"))));
        auto Fill = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebR32Uint4_MemsetBufferCS"))));
        auto &CopyData = RHI.ShaderData(Copy);
        auto &FillData = RHI.ShaderData(Fill);
        const auto Binding = [&](const TCHAR *Name) {
            const auto *Found =
                CopyData.Metadata->GetArrayField(TEXT("spirvBindings")).FindByPredicate([&](const auto &Value) {
                    return Value->AsObject()->GetStringField(TEXT("name")) == Name;
                });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto ReadBinding = Binding(TEXT("SrcStructuredBuffer4x"));
        const auto WriteBinding = Binding(TEXT("DstStructuredBuffer4x"));
        Record(TEXT("shader-reflects-uint4-read-write-storage"),
               ReadBinding->GetBoolField(TEXT("readOnlyStorage")) &&
                   !WriteBinding->GetBoolField(TEXT("readOnlyStorage")) &&
                   ReadBinding->GetIntegerField(TEXT("storageElementFormat")) == PF_R32G32B32A32_UINT &&
                   WriteBinding->GetIntegerField(TEXT("storageElementFormat")) == PF_R32G32B32A32_UINT);
        TArray<uint32> SourceValues, Expected, Zero;
        for (uint32 Index = 0; Index < 512; ++Index)
            SourceValues.Add(Pattern(Index, false));
        Expected.Init(0xa5a5a5a5u, 512);
        Zero.Init(0, 512);
        auto Source = Buffer(RHI, Cmd,
                             FRHIBufferCreateDesc::Create(TEXT("Uint4Source"), 2048, 16, BUF_ShaderResource)
                                 .SetInitialState(ERHIAccess::SRVCompute),
                             SourceValues.GetData(), 2048);
        auto Target =
            Buffer(RHI, Cmd,
                   FRHIBufferCreateDesc::Create(TEXT("Uint4Target"), 2048, 16, BUF_ShaderResource | BUF_UnorderedAccess)
                       .SetInitialState(ERHIAccess::UAVCompute),
                   Expected.GetData(), 2048);
        auto Sink = Buffer(RHI, Cmd,
                           FRHIBufferCreateDesc::CreateStructured(TEXT("Uint4Readback"), 2048, 16)
                               .AddUsage(BUF_UnorderedAccess)
                               .SetInitialState(ERHIAccess::UAVCompute),
                           Zero.GetData(), 2048);
        auto Odd =
            Buffer(RHI, Cmd,
                   FRHIBufferCreateDesc::Create(TEXT("NotUint4Sized"), 20, 4, BUF_ShaderResource | BUF_UnorderedAccess)
                       .SetInitialState(ERHIAccess::UAVCompute),
                   Zero.GetData(), 20);
        auto SRVDesc =
            FRHIViewDesc::CreateBufferSRV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32G32B32A32_UINT);
        auto UAVDesc =
            FRHIViewDesc::CreateBufferUAV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32G32B32A32_UINT);
        FRHIViewDesc SRVValidation, UAVValidation;
        SRVValidation.Common.ViewType = FRHIViewDesc::EViewType::BufferSRV;
        SRVValidation.Buffer.SRV.BufferType = FRHIViewDesc::EBufferType::Typed;
        SRVValidation.Buffer.SRV.Format = PF_R32G32B32A32_UINT;
        UAVValidation.Common.ViewType = FRHIViewDesc::EViewType::BufferUAV;
        UAVValidation.Buffer.UAV.BufferType = FRHIViewDesc::EBufferType::Typed;
        UAVValidation.Buffer.UAV.Format = PF_R32G32B32A32_UINT;
        FString Error;
        Record(TEXT("uint4-storage-alignment-advertised"),
               RHIGetMinimumAlignmentForBufferBackedSRV(PF_R32G32B32A32_UINT) ==
                   RHI.Limits.minStorageBufferOffsetAlignment);
        Record(TEXT("reject-partial-uint4-srv"), !RHI.ValidateBufferSRV(Odd, SRVValidation, Error));
        Record(TEXT("reject-partial-uint4-uav"), !RHI.ValidateUAV(Odd, UAVValidation, Error));
        const auto Reject = [&](const TCHAR *Name, auto Change) {
            FRHIViewDesc ReadDesc = SRVValidation, WriteDesc = UAVValidation;
            Change(ReadDesc.Buffer.SRV);
            Change(WriteDesc.Buffer.UAV);
            Record(FString(TEXT("reject-srv-")) + Name, !RHI.ValidateBufferSRV(Source, ReadDesc, Error));
            Record(FString(TEXT("reject-uav-")) + Name, !RHI.ValidateUAV(Target, WriteDesc, Error));
        };
        Reject(TEXT("storage-offset-alignment"), [](auto &View) {
            View.OffsetInBytes = 16;
            View.NumElements = 1;
        });
        Reject(TEXT("out-of-range-elements"), [](auto &View) { View.NumElements = 129; });
        Reject(TEXT("overflowing-elements"), [](auto &View) { View.NumElements = MAX_uint32; });
        Reject(TEXT("offset-without-count"), [](auto &View) { View.OffsetInBytes = 256; });
        Reject(TEXT("float-scalar-format"), [](auto &View) { View.Format = PF_R32_FLOAT; });
        auto WholeSRV = Cmd.CreateShaderResourceView(Source, SRVDesc);
        auto RangeSRV = Cmd.CreateShaderResourceView(Source, FRHIViewDesc::CreateBufferSRV()
                                                                 .SetType(FRHIViewDesc::EBufferType::Typed)
                                                                 .SetFormat(PF_R32G32B32A32_UINT)
                                                                 .SetOffsetInBytes(256)
                                                                 .SetNumElements(64));
        auto WholeUAV = Cmd.CreateUnorderedAccessView(Target, UAVDesc);
        auto RangeUAV = Cmd.CreateUnorderedAccessView(Target, FRHIViewDesc::CreateBufferUAV()
                                                                  .SetType(FRHIViewDesc::EBufferType::Typed)
                                                                  .SetFormat(PF_R32G32B32A32_UINT)
                                                                  .SetOffsetInBytes(512)
                                                                  .SetNumElements(64));
        const auto FullRead = WholeSRV->GetDesc().Buffer.SRV.GetViewInfo(Source);
        const auto FullWrite = WholeUAV->GetDesc().Buffer.UAV.GetViewInfo(Target);
        const auto RangeRead = RangeSRV->GetDesc().Buffer.SRV.GetViewInfo(Source);
        const auto RangeWrite = RangeUAV->GetDesc().Buffer.UAV.GetViewInfo(Target);
        Record(TEXT("whole-views-normalized-to-16-byte-elements"),
               FullRead.StrideInBytes == 16 && FullRead.NumElements == 128 && FullRead.SizeInBytes == 2048 &&
                   FullWrite.StrideInBytes == 16 && FullWrite.NumElements == 128 && FullWrite.SizeInBytes == 2048);
        Record(TEXT("subranges-use-vector-element-counts"),
               RangeRead.OffsetInBytes == 256 && RangeRead.SizeInBytes == 1024 && RangeWrite.OffsetInBytes == 512 &&
                   RangeWrite.SizeInBytes == 1024);
        Record(TEXT("views-retain-buffers"), Source->GetRefCount() == 3 && Target->GetRefCount() == 3);
        auto WrongRead = MakeShared<FJsonObject>(*ReadBinding);
        auto WrongWrite = MakeShared<FJsonObject>(*WriteBinding);
        WrongRead->SetNumberField(TEXT("storageElementFormat"), PF_R32_UINT);
        WrongWrite->SetNumberField(TEXT("storageElementFormat"), PF_R32_UINT);
        Record(TEXT("reject-scalar-shader-for-uint4-srv"),
               !RHI.ValidateStorageSRVBinding(WholeSRV, *WrongRead, ERHIAccess::SRVCompute, Error));
        Record(TEXT("reject-scalar-shader-for-uint4-uav"),
               !RHI.ValidateStorageUAVBinding(WholeUAV, *WrongWrite, ERHIAccess::UAVCompute, Error));
        auto ScalarSRV = Cmd.CreateShaderResourceView(
            Source, FRHIViewDesc::CreateBufferSRV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32_UINT));
        auto ScalarUAV = Cmd.CreateUnorderedAccessView(
            Target, FRHIViewDesc::CreateBufferUAV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32_UINT));
        Record(TEXT("reject-uint4-shader-for-scalar-srv"),
               !RHI.ValidateStorageSRVBinding(ScalarSRV, *ReadBinding, ERHIAccess::SRVCompute, Error));
        Record(TEXT("reject-uint4-shader-for-scalar-uav"),
               !RHI.ValidateStorageUAVBinding(ScalarUAV, *WriteBinding, ERHIAccess::UAVCompute, Error));
        ScalarSRV.SafeRelease();
        ScalarUAV.SafeRelease();
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::UAVCompute, ERHIAccess::CopyDest));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-uav-access-mismatch"),
               !RHI.ValidateStorageUAVBinding(WholeUAV, *WriteBinding, ERHIAccess::UAVCompute, Error));
        const FRHITransitionInfo Info(Target, ERHIAccess::CopyDest, ERHIAccess::UAVCompute);
        auto *Transition = RHICreateTransition(FRHITransitionCreateInfo(
            ERHIPipeline::Graphics, ERHIPipeline::Graphics, ERHITransitionCreateFlags::None, MakeArrayView(&Info, 1)));
        Cmd.BeginTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-uav-during-split-transition"),
               !RHI.ValidateStorageUAVBinding(WholeUAV, *WriteBinding, ERHIAccess::UAVCompute, Error));
        Cmd.EndTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("uav-valid-after-transition-end"),
               RHI.ValidateStorageUAVBinding(WholeUAV, *WriteBinding, ERHIAccess::UAVCompute, Error));
        const auto SetValue = [&](FRHIComputeShader *Shader, const TCHAR *Name, uint32 Value) {
            const auto *Found = RHI.ShaderData(Shader)
                                    .Metadata->GetArrayField(TEXT("ueParameterMap"))
                                    .FindByPredicate([&](const auto &Item) {
                                        return Item->AsObject()->GetStringField(TEXT("name")) == Name;
                                    });
            check(Found);
            const auto Allocation = (*Found)->AsObject();
            const FRHIShaderParameter Parameter(Allocation->GetIntegerField(TEXT("bufferIndex")),
                                                Allocation->GetIntegerField(TEXT("baseIndex")), 0, 4);
            Cmd.SetShaderParameters(Shader, MakeArrayView(reinterpret_cast<const uint8 *>(&Value), 4),
                                    MakeArrayView(&Parameter, 1), {}, {});
        };
        const auto ResourceSlot = [&](FRHIComputeShader *Shader, const TCHAR *Name) -> uint16 {
            const auto *Found = RHI.ShaderData(Shader)
                                    .Metadata->GetArrayField(TEXT("ueParameterMap"))
                                    .FindByPredicate([&](const auto &Item) {
                                        return Item->AsObject()->GetStringField(TEXT("name")) == Name;
                                    });
            check(Found);
            return (*Found)->AsObject()->GetIntegerField(TEXT("baseIndex"));
        };
        const auto CopyVectors = [&](FRHIShaderResourceView *SRV, FRHIUnorderedAccessView *UAV, uint32 SrcOffset,
                                     uint32 DstOffset, uint32 Count) {
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Copy));
            const FRHIShaderParameterResource Resources[] = {{SRV, ResourceSlot(Copy, TEXT("SrcStructuredBuffer4x"))},
                                                             {UAV, ResourceSlot(Copy, TEXT("DstStructuredBuffer4x"))}};
            Cmd.SetShaderParameters(Copy, {}, {}, Resources, {});
            SetValue(Copy, TEXT("SrcOffset"), SrcOffset);
            SetValue(Copy, TEXT("DstOffset"), DstOffset);
            SetValue(Copy, TEXT("Size"), Count);
            Cmd.DispatchComputeShader(FMath::DivideAndRoundUp(Count, 64u), 1, 1);
        };
        const auto CheckBuffer = [&](const TCHAR *Name, FRHIBuffer *BufferToRead, const TArray<uint32> &Values) {
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(BufferToRead, 2048);
            bool OK = Bytes.Num() == 2048;
            for (int32 Index = 0; Index < Values.Num() && OK; ++Index)
            {
                uint32 Actual;
                FMemory::Memcpy(&Actual, Bytes.GetData() + Index * 4, 4);
                OK &= Actual == Values[Index];
            }
            Checked += 512;
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / (Mode + TEXT("-") + Name + TEXT(".bin")))));
            Record(Name, OK);
        };
        const auto UpdateExpected = [&](uint32 Src, uint32 Dst, uint32 Count) {
            for (uint32 Index = 0; Index < Count * 4; ++Index)
                Expected[Dst * 4 + Index] = SourceValues[Src * 4 + Index];
        };
        CopyVectors(WholeSRV, WholeUAV, 5, 7, 97);
        UpdateExpected(5, 7, 97);
        CheckBuffer(TEXT("whole-copy-distinct-components-and-guards"), Target, Expected);
        CheckBuffer(TEXT("read-only-source-preserved"), Source, SourceValues);
        CopyVectors(RangeSRV, RangeUAV, 3, 9, 37);
        UpdateExpected(16 + 3, 32 + 9, 37);
        CheckBuffer(TEXT("subrange-copy-distinct-components-and-guards"), Target, Expected);
        SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Fill));
        const FRHIShaderParameterResource FillResource(RangeUAV, ResourceSlot(Fill, TEXT("DstStructuredBuffer4x")));
        Cmd.SetShaderParameters(Fill, {}, {}, MakeArrayView(&FillResource, 1), {});
        SetValue(Fill, TEXT("Value"), 0xfedcba98u);
        SetValue(Fill, TEXT("DstOffset"), 1);
        SetValue(Fill, TEXT("Size"), 13);
        Cmd.DispatchComputeShader(1, 1, 1);
        for (uint32 Index = 0; Index < 13 * 4; ++Index)
            Expected[(32 + 1) * 4 + Index] = 0xfedcba98u;
        CheckBuffer(TEXT("subrange-memset-all-components"), Target, Expected);
        for (uint32 Index = 0; Index < 512; ++Index)
            SourceValues[Index] = Pattern(Index, true);
        auto Updated = Buffer(RHI, Cmd,
                              FRHIBufferCreateDesc::Create(TEXT("UpdatedUint4Source"), 2048, 16, BUF_ShaderResource)
                                  .SetInitialState(ERHIAccess::CopySrc),
                              SourceValues.GetData(), 2048);
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::SRVCompute, ERHIAccess::CopyDest));
        Cmd.CopyBufferRegion(Source, 0, Updated, 0, 2048);
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::CopyDest, ERHIAccess::SRVCompute));
        CopyVectors(WholeSRV, WholeUAV, 3, 13, 67);
        UpdateExpected(3, 13, 67);
        CheckBuffer(TEXT("existing-view-observes-source-update"), Target, Expected);
        auto TargetSRV = Cmd.CreateShaderResourceView(Target, SRVDesc);
        auto SinkUAV = Cmd.CreateUnorderedAccessView(
            Sink, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Sink).SetStride(16).SetNumElements(128));
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::UAVCompute, ERHIAccess::SRVCompute));
        CopyVectors(TargetSRV, SinkUAV, 0, 0, 128);
        CheckBuffer(TEXT("uint4-uav-writes-visible-through-srv"), Sink, Expected);
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::SRVCompute, ERHIAccess::UAVCompute));
        CopyVectors(WholeSRV, WholeUAV, 2, 3, 73);
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
        const auto *BoundRead = CopyData.Resources.Find((3u << 16) | ResourceSlot(Copy, TEXT("SrcStructuredBuffer4x")));
        const auto *BoundWrite =
            CopyData.Resources.Find((4u << 16) | ResourceSlot(Copy, TEXT("DstStructuredBuffer4x")));
        Record(TEXT("shader-bindings-retain-both-views"),
               BoundRead && BoundRead->IsValid() && BoundWrite && BoundWrite->IsValid());
        check(BoundRead && BoundWrite);
        auto *BoundSource = static_cast<FRHIShaderResourceView *>(BoundRead->GetReference())->GetBuffer();
        auto *BoundTarget = static_cast<FRHIBuffer *>(
            static_cast<FRHIUnorderedAccessView *>(BoundWrite->GetReference())->GetResource());
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
    Report->SetStringField(TEXT("adapter"), RHI.AdapterName);
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

bool RunWebGPUUint4Probe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUUint4Probe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("typedUint4StorageViewsVerified"), Pass);
        Report->SetBoolField(TEXT("generalTypedBufferShaderLoweringImplemented"), false);
        Report->SetBoolField(TEXT("resourceTableViewsImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetArrayField(TEXT("modes"), Modes);
        FString JSON;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
        check(FFileHelper::SaveStringToFile(JSON, *(OutputDirectory / TEXT("uint4-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
