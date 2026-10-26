#include "WebGPUBufferSRVProbe.h"
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
    return Updated      ? (Index * 65537u) ^ 0xfedcba98u
           : Index == 0 ? 0u
           : Index == 1 ? MAX_uint32
                        : (Index * 2654435761u) ^ 0x80000000u;
}

FRHIViewDesc Description()
{
    FRHIViewDesc Desc;
    Desc.Common.ViewType = FRHIViewDesc::EViewType::BufferSRV;
    Desc.Buffer.SRV.BufferType = FRHIViewDesc::EBufferType::Typed;
    Desc.Buffer.SRV.Format = PF_R32_UINT;
    return Desc;
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
        UE_LOG(LogRHI, Display, TEXT("P2_BUFFER_SRV %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    {
        auto Compute = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebR32Uint_MemcpyCS"))));
        auto &Data = RHI.ShaderData(Compute);
        const auto Parameter = [&](const TCHAR *Name) {
            const auto *Found =
                Data.Metadata->GetArrayField(TEXT("ueParameterMap")).FindByPredicate([&](const auto &Value) {
                    return Value->AsObject()->GetStringField(TEXT("name")) == Name;
                });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto *BindingValue =
            Data.Metadata->GetArrayField(TEXT("spirvBindings")).FindByPredicate([](const auto &Value) {
                return Value->AsObject()->GetStringField(TEXT("name")) == TEXT("SrcStructuredBuffer1x");
            });
        check(BindingValue);
        const auto Binding = (*BindingValue)->AsObject();
        Record(TEXT("shader-reflects-read-only-uint32-storage"),
               Binding->GetBoolField(TEXT("readOnlyStorage")) &&
                   Binding->GetIntegerField(TEXT("storageElementFormat")) == PF_R32_UINT &&
                   Parameter(TEXT("SrcStructuredBuffer1x"))->GetIntegerField(TEXT("type")) == 4);
        TArray<uint32> SourceValues, Expected;
        for (uint32 Index = 0; Index < 256; ++Index)
            SourceValues.Add(Pattern(Index, false));
        Expected.Init(0xa5a5a5a5u, 256);
        auto Source = Buffer(RHI, Cmd,
                             FRHIBufferCreateDesc::Create(TEXT("TypedR32UintSource"), 1024, 4, BUF_ShaderResource)
                                 .SetInitialState(ERHIAccess::SRVCompute),
                             SourceValues.GetData(), 1024);
        auto Destination = Buffer(RHI, Cmd,
                                  FRHIBufferCreateDesc::CreateStructured(TEXT("TypedR32UintOutput"), 1024, 4)
                                      .AddUsage(BUF_UnorderedAccess)
                                      .SetInitialState(ERHIAccess::UAVCompute),
                                  Expected.GetData(), 1024);
        auto NoSampling = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("NoBufferSRV"), 1024),
                                 SourceValues.GetData(), 1024);
        auto Default = Description();
        FString Error;
        Record(TEXT("typed-srv-alignment-advertised"),
               RHIGetMinimumAlignmentForBufferBackedSRV(PF_R32_UINT) == RHI.Limits.minStorageBufferOffsetAlignment);
        Record(TEXT("reject-null-resource"), !RHI.ValidateBufferSRV(nullptr, Default, Error));
        Record(TEXT("reject-missing-shader-resource-capability"), !RHI.ValidateBufferSRV(NoSampling, Default, Error));
        Record(TEXT("reject-typed-view-of-structured-buffer"), !RHI.ValidateBufferSRV(Destination, Default, Error));
        const auto Reject = [&](const TCHAR *Name, auto Change) {
            auto Desc = Default;
            Change(Desc.Buffer.SRV);
            Record(Name, !RHI.ValidateBufferSRV(Source, Desc, Error));
        };
        Reject(TEXT("reject-unknown-buffer-type"),
               [](auto &View) { View.BufferType = FRHIViewDesc::EBufferType::Unknown; });
        Reject(TEXT("reject-raw-buffer-view"), [](auto &View) { View.BufferType = FRHIViewDesc::EBufferType::Raw; });
        Reject(TEXT("reject-float-format"), [](auto &View) { View.Format = PF_R32_FLOAT; });
        Reject(TEXT("reject-explicit-typed-stride"), [](auto &View) { View.Stride = 4; });
        Reject(TEXT("reject-counter-view"), [](auto &View) { View.bAtomicCounter = true; });
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
        WrongType.Common.ViewType = FRHIViewDesc::EViewType::BufferUAV;
        Record(TEXT("reject-uav-descriptor"), !RHI.ValidateBufferSRV(Source, WrongType, Error));
        auto Whole = Cmd.CreateShaderResourceView(
            Source, FRHIViewDesc::CreateBufferSRV().SetTypeFromBuffer(Source).SetFormat(PF_R32_UINT));
        auto Range = Cmd.CreateShaderResourceView(Source, FRHIViewDesc::CreateBufferSRV()
                                                              .SetType(FRHIViewDesc::EBufferType::Typed)
                                                              .SetFormat(PF_R32_UINT)
                                                              .SetOffsetInBytes(256)
                                                              .SetNumElements(96));
        const auto WholeInfo = Whole->GetDesc().Buffer.SRV.GetViewInfo(Source);
        const auto RangeInfo = Range->GetDesc().Buffer.SRV.GetViewInfo(Source);
        Record(TEXT("whole-resource-normalized"),
               WholeInfo.StrideInBytes == 4 && WholeInfo.NumElements == 256 && WholeInfo.SizeInBytes == 1024);
        Record(TEXT("subrange-normalized"),
               RangeInfo.OffsetInBytes == 256 && RangeInfo.NumElements == 96 && RangeInfo.SizeInBytes == 384);
        Record(TEXT("views-retain-buffer"), Source->GetRefCount() == 3 && Whole->GetBuffer() == Source);
        Record(TEXT("reject-non-view-storage-binding"),
               !RHI.ValidateStorageSRVBinding(Source, *Binding, ERHIAccess::SRVCompute, Error));
        auto WrongBinding = MakeShared<FJsonObject>(*Binding);
        WrongBinding->SetNumberField(TEXT("storageElementFormat"), PF_R32_FLOAT);
        Record(TEXT("reject-storage-element-type-mismatch"),
               !RHI.ValidateStorageSRVBinding(Whole, *WrongBinding, ERHIAccess::SRVCompute, Error));
        WrongBinding->SetNumberField(TEXT("storageElementFormat"), PF_R32_UINT);
        WrongBinding->SetBoolField(TEXT("readOnlyStorage"), false);
        Record(TEXT("reject-writable-storage-shader"),
               !RHI.ValidateStorageSRVBinding(Whole, *WrongBinding, ERHIAccess::SRVCompute, Error));
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::SRVCompute, ERHIAccess::CopyDest));
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-srv-access-mismatch"),
               !RHI.ValidateStorageSRVBinding(Whole, *Binding, ERHIAccess::SRVCompute, Error));
        const FRHITransitionInfo TransitionInfo(Source, ERHIAccess::CopyDest, ERHIAccess::SRVCompute);
        auto *Transition = RHICreateTransition(FRHITransitionCreateInfo(ERHIPipeline::Graphics, ERHIPipeline::Graphics,
                                                                        ERHITransitionCreateFlags::None,
                                                                        MakeArrayView(&TransitionInfo, 1)));
        Cmd.BeginTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("reject-srv-during-split-transition"),
               !RHI.ValidateStorageSRVBinding(Whole, *Binding, ERHIAccess::SRVCompute, Error));
        Cmd.EndTransition(Transition);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        Record(TEXT("srv-valid-after-transition-end"),
               RHI.ValidateStorageSRVBinding(Whole, *Binding, ERHIAccess::SRVCompute, Error));
        auto UAV = Cmd.CreateUnorderedAccessView(
            Destination,
            FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Destination).SetStride(4).SetNumElements(256));
        const auto Dispatch = [&](FRHIShaderResourceView *SRV, uint32 SourceOffset, uint32 DestinationOffset,
                                  uint32 Size) {
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Compute));
            const uint16 SourceSlot = Parameter(TEXT("SrcStructuredBuffer1x"))->GetIntegerField(TEXT("baseIndex"));
            const uint16 DestinationSlot = Parameter(TEXT("DstStructuredBuffer1x"))->GetIntegerField(TEXT("baseIndex"));
            const FRHIShaderParameterResource Resources[] = {{SRV, SourceSlot}, {UAV, DestinationSlot}};
            Cmd.SetShaderParameters(Compute, {}, {}, Resources, {});
            for (auto Pair : {TPair<const TCHAR *, uint32>(TEXT("Size"), Size),
                              {TEXT("SrcOffset"), SourceOffset},
                              {TEXT("DstOffset"), DestinationOffset}})
            {
                const auto Allocation = Parameter(Pair.Key);
                const FRHIShaderParameter Value(Allocation->GetIntegerField(TEXT("bufferIndex")),
                                                Allocation->GetIntegerField(TEXT("baseIndex")), 0, 4);
                Cmd.SetShaderParameters(Compute, MakeArrayView(reinterpret_cast<const uint8 *>(&Pair.Value), 4),
                                        MakeArrayView(&Value, 1), {}, {});
            }
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
        Dispatch(Whole, 7, 11, 129);
        for (uint32 Index = 0; Index < 129; ++Index)
            Expected[11 + Index] = SourceValues[7 + Index];
        CheckBuffer(TEXT("whole-view-copy-and-guards"), Destination, Expected);
        CheckBuffer(TEXT("read-only-source-preserved"), Source, SourceValues);
        Dispatch(Range, 3, 97, 67);
        for (uint32 Index = 0; Index < 67; ++Index)
            Expected[97 + Index] = SourceValues[64 + 3 + Index];
        CheckBuffer(TEXT("subrange-copy-and-guards"), Destination, Expected);
        auto Raw = Buffer(RHI, Cmd,
            FRHIBufferCreateDesc::CreateByteAddress(TEXT("RawSource"), 1024, 4)
                .AddUsage(BUF_ShaderResource).SetInitialState(ERHIAccess::SRVCompute),
            SourceValues.GetData(), 1024);
        auto RawDesc = Description();
        RawDesc.Buffer.SRV.BufferType = FRHIViewDesc::EBufferType::Raw;
        RawDesc.Buffer.SRV.Format = PF_Unknown;
        Record(TEXT("raw-byte-address-view-valid"), RHI.ValidateBufferSRV(Raw, RawDesc, Error));
        auto BadRaw = RawDesc;
        BadRaw.Buffer.SRV.OffsetInBytes = 4;
        BadRaw.Buffer.SRV.NumElements = 1;
        Record(TEXT("reject-unaligned-raw-range"), !RHI.ValidateBufferSRV(Raw, BadRaw, Error));
        BadRaw = RawDesc;
        BadRaw.Buffer.SRV.NumElements = 257;
        Record(TEXT("reject-out-of-bounds-raw-range"), !RHI.ValidateBufferSRV(Raw, BadRaw, Error));
        auto RawView = Cmd.CreateShaderResourceView(Raw,
            FRHIViewDesc::CreateBufferSRV().SetTypeFromBuffer(Raw));
        Record(TEXT("raw-storage-layout-matches"),
            RHI.ValidateStorageSRVBinding(RawView, *Binding, ERHIAccess::SRVCompute, Error));
        Dispatch(RawView, 0, 0, 256);
        Expected = SourceValues;
        CheckBuffer(TEXT("raw-view-copy-and-guards"), Destination, Expected);
        for (uint32 Index = 0; Index < 256; ++Index)
            SourceValues[Index] = Pattern(Index, true);
        auto Updated = Buffer(RHI, Cmd,
                              FRHIBufferCreateDesc::Create(TEXT("UpdatedTypedData"), 1024, 4, BUF_ShaderResource)
                                  .SetInitialState(ERHIAccess::CopySrc),
                              SourceValues.GetData(), 1024);
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::SRVCompute, ERHIAccess::CopyDest));
        Cmd.CopyBufferRegion(Source, 0, Updated, 0, 1024);
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::CopyDest, ERHIAccess::SRVCompute));
        Dispatch(Range, 10, 199, 35);
        for (uint32 Index = 0; Index < 35; ++Index)
            Expected[199 + Index] = SourceValues[64 + 10 + Index];
        CheckBuffer(TEXT("view-observes-copy-update"), Destination, Expected);
        Dispatch(Whole, 5, 3, 200);
        Record(TEXT("commands-obey-recording-mode"), RHI.Dispatches == (Bypass ? 5u : 4u));
        Whole.SafeRelease();
        Range.SafeRelease();
        Source.SafeRelease();
        Updated.SafeRelease();
        for (uint32 Index = 0; Index < 200; ++Index)
            Expected[3 + Index] = SourceValues[5 + Index];
        CheckBuffer(TEXT("srv-survives-caller-release"), Destination, Expected);
        const uint32 Slot = Parameter(TEXT("SrcStructuredBuffer1x"))->GetIntegerField(TEXT("baseIndex"));
        const auto *Bound = Data.Resources.Find((3u << 16) | Slot);
        Record(TEXT("shader-binding-retains-buffer-view"),
               Bound && Bound->IsValid() && (*Bound)->GetType() == RRT_ShaderResourceView &&
                   static_cast<FRHIShaderResourceView *>(Bound->GetReference())->GetBuffer()->GetRefCount() >= 1);
        auto *BoundSource = static_cast<FRHIShaderResourceView *>(Bound->GetReference())->GetBuffer();
        CheckBuffer(TEXT("updated-read-only-source-preserved"), BoundSource, SourceValues);
        Record(TEXT("compute-pso-reused"), RHI.ComputePipelinesCreated == 1 && RHI.Dispatches == 5);
        Data.Resources.Reset();
    }
    Scope.PrepareShutdown();
    Record(TEXT("transitions-released"),
           RHI.TransitionsCreated == 4 && RHI.TransitionsReleased == 4 && RHI.Transitions.IsEmpty());
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

bool RunWebGPUBufferSRVProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUBufferSRVProbe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("typedR32UintStorageSRVVerified"), Pass);
        Report->SetBoolField(TEXT("generalTypedBufferShaderLoweringImplemented"), false);
        Report->SetBoolField(TEXT("resourceTableSRVImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetArrayField(TEXT("modes"), Modes);
        FString JSON;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
        check(FFileHelper::SaveStringToFile(JSON, *(OutputDirectory / TEXT("buffer-srv-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
