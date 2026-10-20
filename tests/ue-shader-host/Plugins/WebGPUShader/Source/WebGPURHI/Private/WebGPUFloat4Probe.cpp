#include "WebGPUFloat4Probe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"

#include "HAL/FileManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

namespace
{
float Pattern(uint32 Index, bool Updated)
{
    const float First[] = {0.0f, -1.5f, 0.25f, 1024.0f};
    return Updated     ? (int32(Index * 29 % 509) - 254) * 0.125f
           : Index < 4 ? First[Index]
                       : (int32(Index * 17 % 257) - 128) * 0.25f;
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
        UE_LOG(LogRHI, Display, TEXT("P2_FLOAT4 %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    {
        auto Transform = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebFloat4_TransformCS"))));
        auto Fill = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebFloat4_FillCS"))));
        auto &Data = RHI.ShaderData(Transform);
        auto &FillData = RHI.ShaderData(Fill);
        const auto Binding = [&](const TCHAR *Name) {
            const auto *Found =
                Data.Metadata->GetArrayField(TEXT("spirvBindings")).FindByPredicate([&](const auto &Value) {
                    return Value->AsObject()->GetStringField(TEXT("name")) == Name;
                });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto ReadBinding = Binding(TEXT("SrcFloat4")), WriteBinding = Binding(TEXT("DstFloat4"));
        Record(TEXT("shader-reflects-float4-storage-and-access"),
               ReadBinding->GetIntegerField(TEXT("storageElementFormat")) == PF_A32B32G32R32F &&
                   WriteBinding->GetIntegerField(TEXT("storageElementFormat")) == PF_A32B32G32R32F &&
                   ReadBinding->GetIntegerField(TEXT("storageElementStride")) == 16 &&
                   WriteBinding->GetIntegerField(TEXT("storageElementStride")) == 16 &&
                   ReadBinding->GetBoolField(TEXT("readOnlyStorage")) &&
                   !WriteBinding->GetBoolField(TEXT("readOnlyStorage")));
        const FVector4f Scale(0.5f, -2.0f, 4.0f, -0.25f), Bias(-3.0f, 0.25f, 16.0f, -0.5f);
        const FVector4f FillValue(-0.5f, 7.25f, -16.0f, 0.125f);
        TArray<float> SourceValues, Expected, Zero;
        for (uint32 Index = 0; Index < 1024; ++Index)
            SourceValues.Add(Pattern(Index, false));
        Expected.Init(-2048.5f, 1024);
        Zero.Init(0, 1024);
        auto Source = Buffer(RHI, Cmd,
                             FRHIBufferCreateDesc::Create(TEXT("Float4Source"), 4096, 16, BUF_ShaderResource)
                                 .SetInitialState(ERHIAccess::SRVCompute),
                             SourceValues.GetData(), 4096);
        auto Target = Buffer(
            RHI, Cmd,
            FRHIBufferCreateDesc::Create(TEXT("Float4Target"), 4096, 16, BUF_ShaderResource | BUF_UnorderedAccess)
                .SetInitialState(ERHIAccess::UAVCompute),
            Expected.GetData(), 4096);
        auto Sink = Buffer(RHI, Cmd,
                           FRHIBufferCreateDesc::CreateStructured(TEXT("Float4Sink"), 4096, 16)
                               .AddUsage(BUF_UnorderedAccess)
                               .SetInitialState(ERHIAccess::UAVCompute),
                           Zero.GetData(), 4096);
        auto Odd =
            Buffer(RHI, Cmd,
                   FRHIBufferCreateDesc::Create(TEXT("PartialFloat4"), 20, 4, BUF_ShaderResource | BUF_UnorderedAccess)
                       .SetInitialState(ERHIAccess::UAVCompute),
                   Zero.GetData(), 20);
        FRHIViewDesc ReadDesc, WriteDesc;
        ReadDesc.Common.ViewType = FRHIViewDesc::EViewType::BufferSRV;
        ReadDesc.Buffer.SRV.BufferType = FRHIViewDesc::EBufferType::Typed;
        ReadDesc.Buffer.SRV.Format = PF_A32B32G32R32F;
        WriteDesc.Common.ViewType = FRHIViewDesc::EViewType::BufferUAV;
        WriteDesc.Buffer.UAV.BufferType = FRHIViewDesc::EBufferType::Typed;
        WriteDesc.Buffer.UAV.Format = PF_A32B32G32R32F;
        FString Error;
        Record(TEXT("float4-storage-alignment-advertised"),
               RHIGetMinimumAlignmentForBufferBackedSRV(PF_A32B32G32R32F) ==
                   RHI.Limits.minStorageBufferOffsetAlignment);
        Record(TEXT("reject-partial-element-srv"), !RHI.ValidateBufferSRV(Odd, ReadDesc, Error));
        Record(TEXT("reject-partial-element-uav"), !RHI.ValidateUAV(Odd, WriteDesc, Error));
        const auto Reject = [&](const TCHAR *Name, auto Change) {
            auto Read = ReadDesc, Write = WriteDesc;
            Change(Read.Buffer.SRV);
            Change(Write.Buffer.UAV);
            Record(FString(TEXT("reject-srv-")) + Name, !RHI.ValidateBufferSRV(Source, Read, Error));
            Record(FString(TEXT("reject-uav-")) + Name, !RHI.ValidateUAV(Target, Write, Error));
        };
        Reject(TEXT("explicit-stride"), [](auto &View) { View.Stride = 16; });
        Reject(TEXT("offset-alignment"), [](auto &View) {
            View.OffsetInBytes = 16;
            View.NumElements = 1;
        });
        Reject(TEXT("offset-without-count"), [](auto &View) { View.OffsetInBytes = 256; });
        Reject(TEXT("range"), [](auto &View) { View.NumElements = 257; });
        Reject(TEXT("overflow"), [](auto &View) { View.NumElements = MAX_uint32; });
        Reject(TEXT("float-scalar-format"), [](auto &View) { View.Format = PF_R32_FLOAT; });
        auto WholeSRV = Cmd.CreateShaderResourceView(
            Source,
            FRHIViewDesc::CreateBufferSRV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_A32B32G32R32F));
        auto WholeUAV = Cmd.CreateUnorderedAccessView(
            Target,
            FRHIViewDesc::CreateBufferUAV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_A32B32G32R32F));
        auto RangeSRV = Cmd.CreateShaderResourceView(Source, FRHIViewDesc::CreateBufferSRV()
                                                                 .SetType(FRHIViewDesc::EBufferType::Typed)
                                                                 .SetFormat(PF_A32B32G32R32F)
                                                                 .SetOffsetInBytes(256)
                                                                 .SetNumElements(96));
        auto RangeUAV = Cmd.CreateUnorderedAccessView(Target, FRHIViewDesc::CreateBufferUAV()
                                                                  .SetType(FRHIViewDesc::EBufferType::Typed)
                                                                  .SetFormat(PF_A32B32G32R32F)
                                                                  .SetOffsetInBytes(512)
                                                                  .SetNumElements(96));
        const auto FullRead = WholeSRV->GetDesc().Buffer.SRV.GetViewInfo(Source);
        const auto FullWrite = WholeUAV->GetDesc().Buffer.UAV.GetViewInfo(Target);
        const auto RangeRead = RangeSRV->GetDesc().Buffer.SRV.GetViewInfo(Source);
        const auto RangeWrite = RangeUAV->GetDesc().Buffer.UAV.GetViewInfo(Target);
        Record(TEXT("whole-views-normalized"), FullRead.StrideInBytes == 16 && FullRead.NumElements == 256 &&
                                                   FullRead.SizeInBytes == 4096 && FullWrite.StrideInBytes == 16 &&
                                                   FullWrite.NumElements == 256 && FullWrite.SizeInBytes == 4096);
        Record(TEXT("subranges-normalized"), RangeRead.OffsetInBytes == 256 && RangeRead.SizeInBytes == 1536 &&
                                                 RangeWrite.OffsetInBytes == 512 && RangeWrite.SizeInBytes == 1536);
        Record(TEXT("views-retain-buffers"), Source->GetRefCount() == 3 && Target->GetRefCount() == 3);
        auto WrongRead = MakeShared<FJsonObject>(*ReadBinding), WrongWrite = MakeShared<FJsonObject>(*WriteBinding);
        WrongRead->SetNumberField(TEXT("storageElementFormat"), PF_R32G32B32A32_UINT);
        WrongWrite->SetNumberField(TEXT("storageElementFormat"), PF_R32G32B32A32_UINT);
        Record(TEXT("reject-uint4-shader-for-float4-srv"),
               !RHI.ValidateStorageSRVBinding(WholeSRV, *WrongRead, ERHIAccess::SRVCompute, Error));
        Record(TEXT("reject-uint4-shader-for-float4-uav"),
               !RHI.ValidateStorageUAVBinding(WholeUAV, *WrongWrite, ERHIAccess::UAVCompute, Error));
        auto UintSRV = Cmd.CreateShaderResourceView(
            Source,
            FRHIViewDesc::CreateBufferSRV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32G32B32A32_UINT));
        auto UintUAV = Cmd.CreateUnorderedAccessView(
            Target,
            FRHIViewDesc::CreateBufferUAV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_R32G32B32A32_UINT));
        Record(TEXT("reject-float4-shader-for-uint4-srv"),
               !RHI.ValidateStorageSRVBinding(UintSRV, *ReadBinding, ERHIAccess::SRVCompute, Error));
        Record(TEXT("reject-float4-shader-for-uint4-uav"),
               !RHI.ValidateStorageUAVBinding(UintUAV, *WriteBinding, ERHIAccess::UAVCompute, Error));
        UintSRV.SafeRelease();
        UintUAV.SafeRelease();
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
        const auto Parameter = [&](FRHIComputeShader *Shader, const TCHAR *Name) {
            const auto *Found = RHI.ShaderData(Shader)
                                    .Metadata->GetArrayField(TEXT("ueParameterMap"))
                                    .FindByPredicate([&](const auto &Value) {
                                        return Value->AsObject()->GetStringField(TEXT("name")) == Name;
                                    });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto SetValue = [&](FRHIComputeShader *Shader, const TCHAR *Name, const auto &Value) {
            const auto Allocation = Parameter(Shader, Name);
            check(Allocation->GetIntegerField(TEXT("size")) == sizeof(Value));
            const FRHIShaderParameter Item(Allocation->GetIntegerField(TEXT("bufferIndex")),
                                           Allocation->GetIntegerField(TEXT("baseIndex")), 0, sizeof(Value));
            Cmd.SetShaderParameters(Shader, MakeArrayView(reinterpret_cast<const uint8 *>(&Value), sizeof(Value)),
                                    MakeArrayView(&Item, 1), {}, {});
        };
        const auto Slot = [&](FRHIComputeShader *Shader, const TCHAR *Name) -> uint16 {
            return Parameter(Shader, Name)->GetIntegerField(TEXT("baseIndex"));
        };
        const auto Dispatch = [&](FRHIShaderResourceView *SRV, FRHIUnorderedAccessView *UAV, uint32 Src, uint32 Dst,
                                  uint32 Count, bool Identity = false) {
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Transform));
            const FRHIShaderParameterResource Resources[] = {{SRV, Slot(Transform, TEXT("SrcFloat4"))},
                                                             {UAV, Slot(Transform, TEXT("DstFloat4"))}};
            Cmd.SetShaderParameters(Transform, {}, {}, Resources, {});
            SetValue(Transform, TEXT("SrcOffset"), Src);
            SetValue(Transform, TEXT("DstOffset"), Dst);
            SetValue(Transform, TEXT("Size"), Count);
            SetValue(Transform, TEXT("Scale"), Identity ? FVector4f(1, 1, 1, 1) : Scale);
            SetValue(Transform, TEXT("Bias"), Identity ? FVector4f(0, 0, 0, 0) : Bias);
            Cmd.DispatchComputeShader(FMath::DivideAndRoundUp(Count, 64u), 1, 1);
        };
        const auto UpdateExpected = [&](uint32 Src, uint32 Dst, uint32 Count) {
            for (uint32 Index = 0; Index < Count * 4; ++Index)
                Expected[Dst * 4 + Index] = SourceValues[Src * 4 + Index] * Scale[Index % 4] + Bias[Index % 4];
        };
        const auto CheckBuffer = [&](const TCHAR *Name, FRHIBuffer *ToRead, const TArray<float> &Values) {
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(ToRead, 4096);
            bool OK = Bytes.Num() == 4096;
            for (int32 Index = 0; Index < Values.Num() && OK; ++Index)
            {
                float Actual;
                FMemory::Memcpy(&Actual, Bytes.GetData() + Index * 4, 4);
                OK &= FMath::IsFinite(Actual) && Actual == Values[Index];
            }
            Checked += 1024;
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / (Mode + TEXT("-") + Name + TEXT(".bin")))));
            Record(Name, OK);
        };
        Dispatch(WholeSRV, WholeUAV, 5, 7, 197);
        UpdateExpected(5, 7, 197);
        CheckBuffer(TEXT("whole-transform-fractions-and-guards"), Target, Expected);
        CheckBuffer(TEXT("read-only-source-preserved"), Source, SourceValues);
        Dispatch(RangeSRV, RangeUAV, 3, 9, 67);
        UpdateExpected(16 + 3, 32 + 9, 67);
        CheckBuffer(TEXT("subrange-transform-and-guards"), Target, Expected);
        SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Fill));
        const FRHIShaderParameterResource FillResource(RangeUAV, Slot(Fill, TEXT("DstFloat4")));
        Cmd.SetShaderParameters(Fill, {}, {}, MakeArrayView(&FillResource, 1), {});
        SetValue(Fill, TEXT("FillValue"), FillValue);
        SetValue(Fill, TEXT("DstOffset"), uint32(1));
        SetValue(Fill, TEXT("Size"), uint32(13));
        Cmd.DispatchComputeShader(1, 1, 1);
        for (uint32 Index = 0; Index < 13 * 4; ++Index)
            Expected[(32 + 1) * 4 + Index] = FillValue[Index % 4];
        CheckBuffer(TEXT("subrange-fill-distinct-components"), Target, Expected);
        for (uint32 Index = 0; Index < 1024; ++Index)
            SourceValues[Index] = Pattern(Index, true);
        auto Updated = Buffer(RHI, Cmd,
                              FRHIBufferCreateDesc::Create(TEXT("UpdatedFloat4"), 4096, 16, BUF_ShaderResource)
                                  .SetInitialState(ERHIAccess::CopySrc),
                              SourceValues.GetData(), 4096);
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::SRVCompute, ERHIAccess::CopyDest));
        Cmd.CopyBufferRegion(Source, 0, Updated, 0, 4096);
        Cmd.Transition(FRHITransitionInfo(Source, ERHIAccess::CopyDest, ERHIAccess::SRVCompute));
        Dispatch(WholeSRV, WholeUAV, 3, 13, 167);
        UpdateExpected(3, 13, 167);
        CheckBuffer(TEXT("existing-view-observes-update"), Target, Expected);
        auto TargetSRV = Cmd.CreateShaderResourceView(
            Target,
            FRHIViewDesc::CreateBufferSRV().SetType(FRHIViewDesc::EBufferType::Typed).SetFormat(PF_A32B32G32R32F));
        auto SinkUAV = Cmd.CreateUnorderedAccessView(Sink, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Sink));
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::UAVCompute, ERHIAccess::SRVCompute));
        Dispatch(TargetSRV, SinkUAV, 0, 0, 256, true);
        CheckBuffer(TEXT("uav-writes-visible-through-srv"), Sink, Expected);
        Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::SRVCompute, ERHIAccess::UAVCompute));
        Dispatch(WholeSRV, WholeUAV, 2, 3, 173);
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
        UpdateExpected(2, 3, 173);
        Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
        const auto *Read = Data.Resources.Find((3u << 16) | Slot(Transform, TEXT("SrcFloat4")));
        const auto *Write = Data.Resources.Find((4u << 16) | Slot(Transform, TEXT("DstFloat4")));
        Record(TEXT("shader-bindings-retain-views"), Read && Read->IsValid() && Write && Write->IsValid());
        check(Read && Write);
        auto *BoundSource = static_cast<FRHIShaderResourceView *>(Read->GetReference())->GetBuffer();
        auto *BoundTarget =
            static_cast<FRHIBuffer *>(static_cast<FRHIUnorderedAccessView *>(Write->GetReference())->GetResource());
        CheckBuffer(TEXT("views-survive-caller-release"), BoundTarget, Expected);
        CheckBuffer(TEXT("updated-read-only-source-preserved"), BoundSource, SourceValues);
        Record(TEXT("compute-psos-reused"), RHI.ComputePipelinesCreated == 2 && RHI.Dispatches == 6);
        Data.Resources.Reset();
    }
    Scope.PrepareShutdown();
    Record(TEXT("transitions-released"),
           RHI.TransitionsCreated == 6 && RHI.TransitionsReleased == 6 && RHI.Transitions.IsEmpty());
    Record(TEXT("gpu-validation-clean"), RHI.Errors.IsEmpty());
    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("mode"), Mode);
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

bool RunWebGPUFloat4Probe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUFloat4Probe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("typedFloat4StorageViewsVerified"), Pass);
        Report->SetBoolField(TEXT("probeOnlyShaders"), true);
        Report->SetBoolField(TEXT("generalTypedBufferShaderLoweringImplemented"), false);
        Report->SetBoolField(TEXT("resourceTableViewsImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetArrayField(TEXT("modes"), Modes);
        FString JSON;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
        check(FFileHelper::SaveStringToFile(JSON, *(OutputDirectory / TEXT("float4-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
