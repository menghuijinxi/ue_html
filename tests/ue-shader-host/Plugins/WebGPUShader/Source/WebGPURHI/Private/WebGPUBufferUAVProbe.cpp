#include "WebGPUBufferUAVProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"

#include "HAL/FileManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

namespace
{
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
        UE_LOG(LogRHI, Display, TEXT("P2_BUFFER_UAV %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    {
        auto Fill = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebR32Uint_MemsetBufferCS"))));
        auto Copy = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebR32Uint_MemcpyCS"))));
        auto &FillData = RHI.ShaderData(Fill);
        auto &CopyData = RHI.ShaderData(Copy);
        const auto Parameter = [&](FRHIComputeShader *Shader, const TCHAR *Name) {
            const auto *Found = RHI.ShaderData(Shader)
                                    .Metadata->GetArrayField(TEXT("ueParameterMap"))
                                    .FindByPredicate([&](const auto &Value) {
                                        return Value->AsObject()->GetStringField(TEXT("name")) == Name;
                                    });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto *BindingValue =
            FillData.Metadata->GetArrayField(TEXT("spirvBindings")).FindByPredicate([](const auto &Value) {
                return Value->AsObject()->GetStringField(TEXT("name")) == TEXT("DstStructuredBuffer1x");
            });
        check(BindingValue);
        const auto Binding = (*BindingValue)->AsObject();
        Record(TEXT("shader-reflects-writable-uint32-storage"),
               !Binding->GetBoolField(TEXT("readOnlyStorage")) &&
                   Binding->GetIntegerField(TEXT("storageElementFormat")) == PF_R32_UINT &&
                   Parameter(Fill, TEXT("DstStructuredBuffer1x"))->GetIntegerField(TEXT("type")) == 4);
        TArray<uint32> SourceValues, Expected, Zero;
        for (uint32 Index = 0; Index < 256; ++Index)
            SourceValues.Add(Index == 0 ? 0u : Index == 1 ? MAX_uint32 : (Index * 2654435761u) ^ 0x80000000u);
        Expected.Init(0xcafebabeu, 256);
        Zero.Init(0, 256);
        auto Target = Buffer(
            RHI, Cmd,
            FRHIBufferCreateDesc::Create(TEXT("TypedUAVTarget"), 1024, 4, BUF_UnorderedAccess | BUF_ShaderResource)
                .SetInitialState(ERHIAccess::UAVCompute),
            Expected.GetData(), 1024);
        auto Source = Buffer(RHI, Cmd,
                             FRHIBufferCreateDesc::Create(TEXT("TypedUAVSource"), 1024, 4, BUF_ShaderResource)
                                 .SetInitialState(ERHIAccess::SRVCompute),
                             SourceValues.GetData(), 1024);
        auto ReadTarget = Buffer(RHI, Cmd,
                                 FRHIBufferCreateDesc::CreateStructured(TEXT("TypedUAVReadTarget"), 1024, 4)
                                     .AddUsage(BUF_UnorderedAccess)
                                     .SetInitialState(ERHIAccess::UAVCompute),
                                 Zero.GetData(), 1024);
        auto Preserved = Buffer(
            RHI, Cmd,
            FRHIBufferCreateDesc::CreateVertex(TEXT("TypedUAVSnapshot"), 1024).SetInitialState(ERHIAccess::CopyDest),
            Zero.GetData(), 1024);
        FRHIViewDesc Default;
        Default.Common.ViewType = FRHIViewDesc::EViewType::BufferUAV;
        Default.Buffer.UAV.BufferType = FRHIViewDesc::EBufferType::Typed;
        Default.Buffer.UAV.Format = PF_R32_UINT;
        FString Error;
        Record(TEXT("reject-null-buffer"), !RHI.ValidateUAV(nullptr, Default, Error));
        Record(TEXT("reject-missing-uav-capability"), !RHI.ValidateUAV(Source, Default, Error));
        Record(TEXT("reject-typed-view-of-structured-buffer"), !RHI.ValidateUAV(ReadTarget, Default, Error));
        const auto Reject = [&](const TCHAR *Name, auto Change) {
            auto Desc = Default;
            Change(Desc.Buffer.UAV);
            Record(Name, !RHI.ValidateUAV(Target, Desc, Error));
        };
        Reject(TEXT("reject-unknown-buffer-type"),
               [](auto &View) { View.BufferType = FRHIViewDesc::EBufferType::Unknown; });
        Reject(TEXT("reject-raw-buffer-view"), [](auto &View) { View.BufferType = FRHIViewDesc::EBufferType::Raw; });
        Reject(TEXT("reject-float-format"), [](auto &View) { View.Format = PF_R32_FLOAT; });
        Reject(TEXT("reject-explicit-typed-stride"), [](auto &View) { View.Stride = 4; });
        Reject(TEXT("reject-counter-view"), [](auto &View) { View.bAtomicCounter = true; });
        Reject(TEXT("reject-append-view"), [](auto &View) { View.bAppendBuffer = true; });
        Reject(TEXT("reject-unaligned-offset"), [](auto &View) {
            View.OffsetInBytes = 4;
            View.NumElements = 1;
        });
        Reject(TEXT("reject-offset-without-count"), [](auto &View) { View.OffsetInBytes = 256; });
        Reject(TEXT("reject-offset-at-buffer-end"), [](auto &View) {
            View.OffsetInBytes = 1024;
            View.NumElements = 1;
        });
        Reject(TEXT("reject-out-of-range-count"), [](auto &View) { View.NumElements = 257; });
        Reject(TEXT("reject-overflowing-count"), [](auto &View) { View.NumElements = MAX_uint32; });
        auto WrongType = Default;
        WrongType.Common.ViewType = FRHIViewDesc::EViewType::BufferSRV;
        Record(TEXT("reject-srv-descriptor"), !RHI.ValidateUAV(Target, WrongType, Error));
        auto Whole = Cmd.CreateUnorderedAccessView(
            Target, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Target).SetFormat(PF_R32_UINT));
        auto Range = Cmd.CreateUnorderedAccessView(Target, FRHIViewDesc::CreateBufferUAV()
                                                               .SetType(FRHIViewDesc::EBufferType::Typed)
                                                               .SetFormat(PF_R32_UINT)
                                                               .SetOffsetInBytes(256)
                                                               .SetNumElements(96));
        const auto WholeInfo = Whole->GetDesc().Buffer.UAV.GetViewInfo(Target);
        const auto RangeInfo = Range->GetDesc().Buffer.UAV.GetViewInfo(Target);
        Record(TEXT("whole-resource-normalized"),
               WholeInfo.StrideInBytes == 4 && WholeInfo.NumElements == 256 && WholeInfo.SizeInBytes == 1024);
        Record(TEXT("subrange-normalized"),
               RangeInfo.OffsetInBytes == 256 && RangeInfo.NumElements == 96 && RangeInfo.SizeInBytes == 384);
        Record(TEXT("views-retain-buffer"), Target->GetRefCount() == 3);
        Record(TEXT("reject-non-view-storage-binding"),
               !RHI.ValidateStorageUAVBinding(Target, *Binding, ERHIAccess::UAVCompute, Error));
        auto WrongBinding = MakeShared<FJsonObject>(*Binding);
        WrongBinding->SetNumberField(TEXT("storageElementFormat"), PF_R32_FLOAT);
        Record(TEXT("reject-storage-element-type-mismatch"),
               !RHI.ValidateStorageUAVBinding(Whole, *WrongBinding, ERHIAccess::UAVCompute, Error));
        WrongBinding->RemoveField(TEXT("storageElementFormat"));
        Record(TEXT("reject-missing-storage-element-type"),
               !RHI.ValidateStorageUAVBinding(Whole, *WrongBinding, ERHIAccess::UAVCompute, Error));
        WrongBinding->SetNumberField(TEXT("storageElementFormat"), PF_R32_UINT);
        WrongBinding->SetBoolField(TEXT("readOnlyStorage"), true);
        Record(TEXT("reject-read-only-storage-shader"),
               !RHI.ValidateStorageUAVBinding(Whole, *WrongBinding, ERHIAccess::UAVCompute, Error));
        WrongBinding->RemoveField(TEXT("readOnlyStorage"));
        Record(TEXT("reject-missing-storage-access"),
               !RHI.ValidateStorageUAVBinding(Whole, *WrongBinding, ERHIAccess::UAVCompute, Error));
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::UAVCompute, ERHIAccess::CopyDest));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-uav-access-mismatch"),
               !RHI.ValidateStorageUAVBinding(Whole, *Binding, ERHIAccess::UAVCompute, Error));
        const FRHITransitionInfo Info(Target, ERHIAccess::CopyDest, ERHIAccess::UAVCompute);
        auto *Transition = RHICreateTransition(FRHITransitionCreateInfo(
            ERHIPipeline::Graphics, ERHIPipeline::Graphics, ERHITransitionCreateFlags::None, MakeArrayView(&Info, 1)));
        Cmd.BeginTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-uav-during-split-transition"),
               !RHI.ValidateStorageUAVBinding(Whole, *Binding, ERHIAccess::UAVCompute, Error));
        Cmd.EndTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("uav-valid-after-transition-end"),
               RHI.ValidateStorageUAVBinding(Whole, *Binding, ERHIAccess::UAVCompute, Error));
        auto SourceSRV = Cmd.CreateShaderResourceView(
            Source, FRHIViewDesc::CreateBufferSRV().SetTypeFromBuffer(Source).SetFormat(PF_R32_UINT));
        auto TargetSRV = Cmd.CreateShaderResourceView(
            Target, FRHIViewDesc::CreateBufferSRV().SetTypeFromBuffer(Target).SetFormat(PF_R32_UINT));
        auto ReadUAV = Cmd.CreateUnorderedAccessView(
            ReadTarget, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(ReadTarget).SetStride(4).SetNumElements(256));
        const auto SetValue = [&](FRHIComputeShader *Shader, const TCHAR *Name, uint32 Value) {
            const auto Allocation = Parameter(Shader, Name);
            const FRHIShaderParameter ParameterValue(Allocation->GetIntegerField(TEXT("bufferIndex")),
                                                     Allocation->GetIntegerField(TEXT("baseIndex")), 0, 4);
            Cmd.SetShaderParameters(Shader, MakeArrayView(reinterpret_cast<const uint8 *>(&Value), 4),
                                    MakeArrayView(&ParameterValue, 1), {}, {});
        };
        const auto DispatchFill = [&](FRHIUnorderedAccessView *UAV, uint32 Value, uint32 Offset, uint32 Size) {
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Fill));
            const FRHIShaderParameterResource Resource(
                UAV, Parameter(Fill, TEXT("DstStructuredBuffer1x"))->GetIntegerField(TEXT("baseIndex")));
            Cmd.SetShaderParameters(Fill, {}, {}, MakeArrayView(&Resource, 1), {});
            SetValue(Fill, TEXT("Value"), Value);
            SetValue(Fill, TEXT("DstOffset"), Offset);
            SetValue(Fill, TEXT("Size"), Size);
            Cmd.DispatchComputeShader(FMath::DivideAndRoundUp(Size, 64u), 1, 1);
        };
        const auto DispatchCopy = [&](FRHIShaderResourceView *SRV, FRHIUnorderedAccessView *UAV, uint32 SourceOffset,
                                      uint32 DestinationOffset, uint32 Size) {
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Copy));
            const FRHIShaderParameterResource Resources[] = {
                {SRV, uint16(Parameter(Copy, TEXT("SrcStructuredBuffer1x"))->GetIntegerField(TEXT("baseIndex")))},
                {UAV, uint16(Parameter(Copy, TEXT("DstStructuredBuffer1x"))->GetIntegerField(TEXT("baseIndex")))}};
            Cmd.SetShaderParameters(Copy, {}, {}, Resources, {});
            SetValue(Copy, TEXT("SrcOffset"), SourceOffset);
            SetValue(Copy, TEXT("DstOffset"), DestinationOffset);
            SetValue(Copy, TEXT("Size"), Size);
            Cmd.DispatchComputeShader(FMath::DivideAndRoundUp(Size, 64u), 1, 1);
        };
        const auto CheckBuffer = [&](const TCHAR *Name, FRHIBuffer *BufferToRead, const TArray<uint32> &Values) {
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(BufferToRead, 1024);
            bool OK = Bytes.Num() == 1024;
            for (int32 Index = 0; Index < Values.Num() && OK; ++Index)
            {
                uint32 Actual;
                FMemory::Memcpy(&Actual, Bytes.GetData() + Index * 4, 4);
                OK &= Actual == Values[Index];
            }
            Checked += 256;
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / (Mode + TEXT("-") + Name + TEXT(".bin")))));
            Record(Name, OK);
        };
        DispatchFill(Whole, MAX_uint32, 0, 256);
        Expected.Init(MAX_uint32, 256);
        CheckBuffer(TEXT("whole-view-fill"), Target, Expected);
        DispatchFill(Range, 0x80000001u, 5, 67);
        for (uint32 Index = 0; Index < 67; ++Index)
            Expected[64 + 5 + Index] = 0x80000001u;
        CheckBuffer(TEXT("subrange-fill-and-guards"), Target, Expected);
        const auto Earlier = Expected;
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
        Cmd.CopyBufferRegion(Preserved, 0, Target, 0, 1024);
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::CopySrc, ERHIAccess::UAVCompute));
        DispatchCopy(SourceSRV, Range, 7, 9, 73);
        for (uint32 Index = 0; Index < 73; ++Index)
            Expected[64 + 9 + Index] = SourceValues[7 + Index];
        DispatchFill(Range, 0xfedcba98u, 1, 13);
        for (uint32 Index = 0; Index < 13; ++Index)
            Expected[64 + 1 + Index] = 0xfedcba98u;
        Record(TEXT("commands-obey-recording-mode"), RHI.Dispatches == (Bypass ? 4u : 2u));
        CheckBuffer(TEXT("memcpy-and-memset-order"), Target, Expected);
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::UAVCompute, ERHIAccess::SRVCompute));
        DispatchCopy(TargetSRV, ReadUAV, 0, 0, 256);
        CheckBuffer(TEXT("typed-uav-writes-visible-through-srv"), ReadTarget, Expected);
        CheckBuffer(TEXT("copy-preserves-earlier-write"), Preserved, Earlier);
        CheckBuffer(TEXT("read-only-source-preserved"), Source, SourceValues);
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::SRVCompute, ERHIAccess::UAVCompute));
        CopyData.Resources.Reset();
        SourceSRV.SafeRelease();
        TargetSRV.SafeRelease();
        Source.SafeRelease();
        DispatchFill(Whole, 0, 143, 111);
        Whole.SafeRelease();
        Range.SafeRelease();
        Target.SafeRelease();
        for (uint32 Index = 0; Index < 111; ++Index)
            Expected[143 + Index] = 0;
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        const uint32 Slot = Parameter(Fill, TEXT("DstStructuredBuffer1x"))->GetIntegerField(TEXT("baseIndex"));
        const auto *Bound = FillData.Resources.Find((4u << 16) | Slot);
        Record(TEXT("shader-binding-retains-buffer-view"),
               Bound && Bound->IsValid() && (*Bound)->GetType() == RRT_UnorderedAccessView);
        check(Bound && Bound->IsValid());
        auto *BoundBuffer =
            static_cast<FRHIBuffer *>(static_cast<FRHIUnorderedAccessView *>(Bound->GetReference())->GetResource());
        CheckBuffer(TEXT("uav-survives-caller-release"), BoundBuffer, Expected);
        Record(TEXT("compute-psos-reused"), RHI.ComputePipelinesCreated == 2 && RHI.Dispatches == 6);
        FillData.Resources.Reset();
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

bool RunWebGPUBufferUAVProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUBufferUAVProbe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("typedR32UintStorageUAVVerified"), Pass);
        Report->SetBoolField(TEXT("generalTypedBufferShaderLoweringImplemented"), false);
        Report->SetBoolField(TEXT("resourceTableUAVImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetArrayField(TEXT("modes"), Modes);
        FString JSON;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
        check(FFileHelper::SaveStringToFile(JSON, *(OutputDirectory / TEXT("buffer-uav-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
