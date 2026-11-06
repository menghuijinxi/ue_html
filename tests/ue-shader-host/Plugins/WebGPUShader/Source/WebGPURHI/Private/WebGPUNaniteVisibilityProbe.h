#pragma once

#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

inline bool RunWebGPUNaniteVisibilityProbe(IDynamicRHIModule& Module, const FString& Directory, const FString& Output)
{
    bool Success = true;
    IFileManager::Get().MakeDirectory(*Output, true);
    ENQUEUE_RENDER_COMMAND(WebNaniteVisibilityProbe)([&](FRHICommandListImmediate& Cmd) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            FWebGPUGlobalScope Scope(Module);
            auto& RHI = *Scope.RHI;
            if (Bypass)
                GRHICommandList.Submit({}, ERHISubmitFlags::FlushRHIThread | ERHISubmitFlags::SubmitToGPU |
                    ERHISubmitFlags::EnableBypass);
            bool Pass = true;
            TArray<TSharedPtr<FJsonValue>> Checks;
            const auto Record = [&](const TCHAR* Name, bool OK) {
                auto Check = MakeShared<FJsonObject>();
                Check->SetStringField(TEXT("name"), Name);
                Check->SetBoolField(TEXT("pass"), OK);
                Checks.Add(MakeShared<FJsonValueObject>(Check));
                Pass &= OK;
                UE_LOG(LogRHI, Display, TEXT("NANITE_VISIBILITY bypass=%d %s pass=%d"), Bypass, Name, OK);
            };
            const bool Supported = wgpuDeviceHasFeature(RHI.Device, WGPUFeatureName_AtomicVec2uMinMax) != 0;
            Record(TEXT("packed-atomic-device-feature"), Supported);
            if (Supported)
            {
                auto Shader = RHICreateComputeShader(FRHICreateShaderDesc(WebGPUProbe::Packet(Directory, TEXT("compute"))));
                auto& Data = RHI.ShaderData(Shader);
                const auto Parameter = [&](const TCHAR* Name) {
                    const auto* Found = Data.Metadata->GetArrayField(TEXT("ueParameterMap")).FindByPredicate(
                        [&](const auto& Value) { return Value->AsObject()->GetStringField(TEXT("name")) == Name; });
                    check(Found);
                    return (*Found)->AsObject();
                };
                constexpr uint32 PrefixWords = 64, Pixels = 64, OutputWords = PrefixWords + Pixels * 2 + 64;
                TArray<uint32> Expected, Candidates;
                Expected.Init(0xa5a5a5a5u, OutputWords);
                FMemory::Memzero(Expected.GetData() + PrefixWords, Pixels * 8);
                const auto AddCandidate = [&](uint32 ID, uint32 Depth, uint32 X, uint32 Y) {
                    Candidates.Append({ID, Depth, X, Y});
                    if (X >= 8 || Y >= 8) return;
                    const uint32 Index = PrefixWords + (Y * 8 + X) * 2;
                    if (Depth > Expected[Index + 1] || (Depth == Expected[Index + 1] && ID > Expected[Index]))
                    {
                        Expected[Index] = ID;
                        Expected[Index + 1] = Depth;
                    }
                };
                for (uint32 Index = 0; Index < 4096; ++Index)
                    AddCandidate((Index * 2654435761u) ^ 0x80000000u,
                        Index % 3 == 0 ? 0x3f400000u : 0x3f000000u, Index % 8, (Index / 8) % 8);
                AddCandidate(MAX_uint32, 0x3f800000u, MAX_uint32, 0);
                AddCandidate(MAX_uint32, 0x3f800000u, 0, MAX_uint32);
                AddCandidate(MAX_uint32, 0x3f400000u, 2, 2);
                TArray<uint32> Initial;
                Initial.Init(0xa5a5a5a5u, OutputWords);
                FMemory::Memzero(Initial.GetData() + PrefixWords, Pixels * 8);
                auto Target = WebGPUProbe::Buffer(RHI, Cmd,
                    FRHIBufferCreateDesc::CreateStructured(TEXT("NaniteVisibility"), OutputWords * 4, 8)
                        .AddUsage(BUF_UnorderedAccess | BUF_ShaderResource).SetInitialState(ERHIAccess::UAVCompute),
                    Initial.GetData(), OutputWords * 4);
                auto Input = WebGPUProbe::Buffer(RHI, Cmd,
                    FRHIBufferCreateDesc::CreateStructured(TEXT("NaniteCandidates"), Candidates.Num() * 4, 16)
                        .AddUsage(BUF_ShaderResource).SetInitialState(ERHIAccess::SRVCompute),
                    Candidates.GetData(), Candidates.Num() * 4);
                auto SRV = Cmd.CreateShaderResourceView(Input, FRHIViewDesc::CreateBufferSRV().SetTypeFromBuffer(Input));
                auto UAV = Cmd.CreateUnorderedAccessView(Target, FRHIViewDesc::CreateBufferUAV()
                    .SetTypeFromBuffer(Target).SetOffsetInBytes(256).SetNumElements(Pixels));
                const FRHIShaderParameterResource Resources[] = {
                    {SRV.GetReference(), uint16(Parameter(TEXT("Candidates"))->GetIntegerField(TEXT("baseIndex")))},
                    {UAV.GetReference(), uint16(Parameter(TEXT("WebNaniteAtomicMax_Visibility"))->GetIntegerField(TEXT("baseIndex")))},
                };
                const auto SizeParameter = Parameter(TEXT("WebNaniteVisibilitySize"));
                const FRHIShaderParameter SizeBinding(SizeParameter->GetIntegerField(TEXT("bufferIndex")),
                    SizeParameter->GetIntegerField(TEXT("baseIndex")), 0, 8);
                const uint32 Size[2]{8, 8};
                SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Shader));
                Cmd.SetShaderParameters(Shader, MakeArrayView(reinterpret_cast<const uint8*>(Size), 8),
                    MakeArrayView(&SizeBinding, 1), Resources, {});
                Cmd.DispatchComputeShader(FMath::DivideAndRoundUp(uint32(Candidates.Num() / 4), 64u) + 1, 1, 1);
                Cmd.Transition(FRHITransitionInfo(Target, ERHIAccess::UAVCompute, ERHIAccess::CopySrc));
                Cmd.Transition(FRHITransitionInfo(Input, ERHIAccess::SRVCompute, ERHIAccess::CopySrc));
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                const auto Bytes = RHI.ReadBuffer(Target, OutputWords * 4);
                Record(TEXT("ue-packet-dispatch-subview-contention-and-guards"),
                    Bytes.Num() == OutputWords * 4 && !FMemory::Memcmp(Bytes.GetData(), Expected.GetData(), OutputWords * 4));
                const auto InputBytes = RHI.ReadBuffer(Input, Candidates.Num() * 4);
                Record(TEXT("read-only-input-preserved"), InputBytes.Num() == Candidates.Num() * 4 &&
                    !FMemory::Memcmp(InputBytes.GetData(), Candidates.GetData(), InputBytes.Num()));
                Record(TEXT("compute-submission"), RHI.Dispatches == 1 && RHI.ComputePipelinesCreated == 1);
                Data.Resources.Reset();
            }
            Scope.PrepareShutdown();
            Record(TEXT("gpu-validation-clean"), RHI.Errors.IsEmpty());
            auto Mode = MakeShared<FJsonObject>();
            Mode->SetBoolField(TEXT("bypass"), Bypass);
            Mode->SetStringField(TEXT("adapter"), RHI.AdapterName);
            TArray<TSharedPtr<FJsonValue>> Errors;
            for (const auto& Error : RHI.Errors) Errors.Add(MakeShared<FJsonValueString>(Error));
            Mode->SetArrayField(TEXT("errors"), Errors);
            Scope.Restore();
            Record(TEXT("host-rhi-restored"), Scope.IsRestored());
            Mode->SetBoolField(TEXT("pass"), Pass);
            Mode->SetArrayField(TEXT("checks"), Checks);
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
            Success &= Pass;
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Success);
        Report->SetArrayField(TEXT("modes"), Modes);
        FString Json;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
        Success &= FFileHelper::SaveStringToFile(Json, *(Output / TEXT("nanite-rhi-results.json")),
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    });
    FlushRenderingCommands();
    return Success;
}
