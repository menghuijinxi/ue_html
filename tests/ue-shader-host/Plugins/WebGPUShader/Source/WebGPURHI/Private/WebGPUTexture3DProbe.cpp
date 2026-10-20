#include "WebGPUTexture3DProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"

#include "Containers/ResourceArray.h"
#include "HAL/FileManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

namespace
{
struct FDiscardableBulkData : FResourceBulkDataInterface
{
    TArray<uint8> Bytes;
    uint32 Discards = 0;
    const void *GetResourceBulkData() const override
    {
        return Bytes.GetData();
    }
    uint32 GetResourceBulkDataSize() const override
    {
        return Bytes.Num();
    }
    void Discard() override
    {
        ++Discards;
        FMemory::Memset(Bytes.GetData(), 0xdd, Bytes.Num());
        Bytes.Empty();
    }
};

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
        UE_LOG(LogRHI, Display, TEXT("P2_TEXTURE_3D %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    {
        auto Load = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebTexture3D_LoadCS"))));
        auto Sample = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebTexture3D_SampleCS"))));
        const auto Find = [&](FRHIComputeShader *Shader, const TCHAR *Array, const TCHAR *Name) {
            const auto *Found = RHI.ShaderData(Shader).Metadata->GetArrayField(Array).FindByPredicate(
                [&](const auto &Value) { return Value->AsObject()->GetStringField(TEXT("name")) == Name; });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto VolumeBinding = Find(Load, TEXT("spirvBindings"), TEXT("Volume"));
        Record(TEXT("shader-reflects-single-sampled-3d"),
               VolumeBinding->GetIntegerField(TEXT("textureDimension")) == 2 &&
                   !VolumeBinding->GetBoolField(TEXT("textureArrayed")) &&
                   !VolumeBinding->GetBoolField(TEXT("textureMultisampled")));
        const auto SetValue = [&](FRHIComputeShader *Shader, const TCHAR *Name, const auto &Value) {
            const auto Allocation = Find(Shader, TEXT("ueParameterMap"), Name);
            check(Allocation->GetIntegerField(TEXT("size")) == sizeof(Value));
            const FRHIShaderParameter Parameter(Allocation->GetIntegerField(TEXT("bufferIndex")),
                                                Allocation->GetIntegerField(TEXT("baseIndex")), 0, sizeof(Value));
            Cmd.SetShaderParameters(Shader, MakeArrayView(reinterpret_cast<const uint8 *>(&Value), sizeof(Value)),
                                    MakeArrayView(&Parameter, 1), {}, {});
        };
        const auto Slot = [&](FRHIComputeShader *Shader, const TCHAR *Name) -> uint16 {
            return Find(Shader, TEXT("ueParameterMap"), Name)->GetIntegerField(TEXT("baseIndex"));
        };
        TArray<uint32> Expected, Zero;
        TArray<uint8> RGBA;
        for (uint32 Index = 0; Index < 18; ++Index)
            for (uint32 Component = 0; Component < 4; ++Component)
            {
                const uint8 Value = (Index * 37 + Component * 61 + 13) % 256;
                Expected.Add(Value);
                RGBA.Add(Value);
            }
        Zero.Init(0, Expected.Num());
        auto Sink = Buffer(RHI, Cmd,
                           FRHIBufferCreateDesc::CreateStructured(TEXT("Texture3DReadback"), Zero.Num() * 4, 16)
                               .AddUsage(BUF_UnorderedAccess)
                               .SetInitialState(ERHIAccess::UAVCompute),
                           Zero.GetData(), Zero.Num() * 4);
        auto UAV = Cmd.CreateUnorderedAccessView(Sink, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Sink));
        auto Clamp = RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Point, AM_Clamp, AM_Clamp, AM_Clamp));
        auto Wrap = RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Point, AM_Wrap, AM_Wrap, AM_Wrap));
        const auto Dispatch = [&](FRHIComputeShader *Shader, FRHIResource *Resource, FRHISamplerState *Sampler,
                                  FVector3f Shift) {
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Shader));
            TArray<FRHIShaderParameterResource> Resources;
            Resources.Emplace(Resource->GetType() == RRT_Texture ? FRHIShaderParameterResource::EType::Texture
                                                                 : FRHIShaderParameterResource::EType::ResourceView,
                              Resource, Slot(Shader, TEXT("Volume")));
            Resources.Emplace(UAV, Slot(Shader, TEXT("Output")));
            if (Shader == Sample)
                Resources.Emplace(Sampler, Slot(Shader, TEXT("VolumeSampler")));
            Cmd.SetShaderParameters(Shader, {}, {}, Resources, {});
            SetValue(Shader, TEXT("Extent"), FUintVector3(3, 2, 3));
            if (Shader == Sample)
                SetValue(Shader, TEXT("SampleShift"), Shift);
            Cmd.DispatchComputeShader(1, 1, 1);
        };
        const auto CheckBuffer = [&](const FString &Name, const TArray<uint32> &Values) {
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Bytes = RHI.ReadBuffer(Sink, Values.Num() * 4);
            bool OK = Bytes.Num() == Values.Num() * 4;
            for (int32 Index = 0; Index < Values.Num() && OK; ++Index)
            {
                uint32 Value;
                FMemory::Memcpy(&Value, Bytes.GetData() + Index * 4, 4);
                OK &= Value == Values[Index];
            }
            Checked += Values.Num();
            check(FFileHelper::SaveArrayToFile(Bytes, *(Output / (Mode + TEXT("-") + Name + TEXT(".bin")))));
            Record(Name, OK);
        };
        auto Base = FRHITextureCreateDesc::Create3D(TEXT("VolumeProbe"), 3, 2, 3, PF_R8G8B8A8)
                        .SetFlags(ETextureCreateFlags::ShaderResource)
                        .SetInitialState(ERHIAccess::SRVCompute);
        FString Error;
        const auto Reject = [&](const TCHAR *Name, auto Change) {
            auto Desc = Base;
            Change(Desc);
            Record(FString(TEXT("reject-")) + Name, !RHI.ValidateTextureInitialization(Desc, Error));
        };
        Reject(TEXT("array"), [](auto &Desc) { Desc.ArraySize = 2; });
        Reject(TEXT("mips"), [](auto &Desc) { Desc.NumMips = 2; });
        Reject(TEXT("multisample"), [](auto &Desc) { Desc.NumSamples = 4; });
        Reject(TEXT("srgb"), [](auto &Desc) { Desc.Flags |= ETextureCreateFlags::SRGB; });
        Reject(TEXT("render-target-volume"), [](auto &Desc) { Desc.Flags |= ETextureCreateFlags::RenderTargetable; });
        Reject(TEXT("uav-volume"), [](auto &Desc) { Desc.Flags |= ETextureCreateFlags::UAV; });
        Reject(TEXT("zero-depth"), [](auto &Desc) { Desc.Depth = 0; });
        Reject(TEXT("zero-width"), [](auto &Desc) { Desc.Extent.X = 0; });
        Reject(TEXT("negative-height"), [](auto &Desc) { Desc.Extent.Y = -1; });
        Reject(TEXT("unsupported-format"), [](auto &Desc) { Desc.Format = PF_R16_UINT; });
        Reject(TEXT("missing-bulk"), [](auto &Desc) { Desc.SetInitActionBulkData(nullptr); });
        FDiscardableBulkData BadBulk;
        BadBulk.Bytes.Add(0);
        Reject(TEXT("bulk-size"), [&](auto &Desc) { Desc.SetInitActionBulkData(&BadBulk); });
        Record(TEXT("invalid-bulk-not-discarded"), BadBulk.Discards == 0 && BadBulk.Bytes.Num() == 1);
        for (const auto Format : {PF_R8G8B8A8, PF_B8G8R8A8})
        {
            TArray<uint8> Stored = RGBA;
            if (Format == PF_B8G8R8A8)
                for (int32 Index = 0; Index < Stored.Num(); Index += 4)
                    Swap(Stored[Index], Stored[Index + 2]);
            for (bool Bulk : {false, true})
            {
                const FString Prefix = FString(Format == PF_R8G8B8A8 ? TEXT("rgba") : TEXT("bgra")) +
                                       (Bulk ? TEXT("-bulk") : TEXT("-initializer"));
                auto Desc = Base;
                Desc.Format = Format;
                FDiscardableBulkData Data;
                Data.Bytes = Stored;
                if (Bulk)
                    Desc.SetInitActionBulkData(&Data);
                else
                    Desc.SetInitActionInitializer();
                auto Initializer = Cmd.CreateTextureInitializer(Desc);
                if (Bulk)
                    Record(Prefix + TEXT("-snapshot-and-discard"), Data.Discards == 1 && Data.Bytes.IsEmpty());
                else
                {
                    auto Subresource = Initializer.GetTexture3DSubresource(0);
                    Record(Prefix + TEXT("-subresource-layout"), Subresource.Stride == 12 && Subresource.Size == 72);
                    Subresource.WriteData(Stored.GetData(), Stored.Num());
                }
                auto Texture = Initializer.Finalize();
                auto SRV = Cmd.CreateShaderResourceView(
                    Texture, FRHIViewDesc::CreateTextureSRV().SetDimension(ETextureDimension::Texture3D));
                const auto ViewDesc = SRV->GetDesc();
                const auto ViewInfo = SRV->GetDesc().Texture.SRV.GetViewInfo(Texture);
                Record(Prefix + TEXT("-view-layout"), ViewInfo.MipRange.Num == 1 && ViewInfo.ArrayRange.Num == 1);
                Record(Prefix + TEXT("-shader-view-compatible"),
                       RHI.ValidateTextureBinding(SRV, *VolumeBinding, ERHIAccess::SRVCompute, Error));
                auto WrongBinding = MakeShared<FJsonObject>(*VolumeBinding);
                WrongBinding->SetNumberField(TEXT("textureDimension"), 1);
                Record(Prefix + TEXT("-reject-2d-shader"),
                       !RHI.ValidateTextureBinding(Texture, *WrongBinding, ERHIAccess::SRVCompute, Error));
                auto WrongView = ViewDesc;
                WrongView.Texture.SRV.Dimension = FRHIViewDesc::EDimension::Texture2D;
                Record(Prefix + TEXT("-reject-2d-view"), !RHI.ValidateTextureSRV(Texture, WrongView, Error));
                Dispatch(Load, Texture, nullptr, FVector3f::ZeroVector);
                CheckBuffer(Prefix + TEXT("-direct-load"), Expected);
                Dispatch(Load, SRV, nullptr, FVector3f::ZeroVector);
                CheckBuffer(Prefix + TEXT("-srv-load"), Expected);
                Dispatch(Sample, SRV, Clamp, FVector3f::ZeroVector);
                CheckBuffer(Prefix + TEXT("-point-sample"), Expected);
                Dispatch(Sample, SRV, Wrap, FVector3f(0, 0, 1));
                CheckBuffer(Prefix + TEXT("-wrap-z"), Expected);
                TArray<uint32> Clamped;
                for (uint32 Index = 0; Index < 18 * 4; ++Index)
                    Clamped.Add(Expected[12 * 4 + Index % (6 * 4)]);
                Dispatch(Sample, SRV, Clamp, FVector3f(0, 0, 1));
                CheckBuffer(Prefix + TEXT("-clamp-z"), Clamped);
                Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::SRVCompute, ERHIAccess::CopyDest));
                Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
                Record(Prefix + TEXT("-reject-wrong-access"),
                       !RHI.ValidateTextureBinding(SRV, *VolumeBinding, ERHIAccess::SRVCompute, Error));
                Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::CopyDest, ERHIAccess::SRVCompute));
                Dispatch(Load, SRV, nullptr, FVector3f::ZeroVector);
                SRV.SafeRelease();
                Texture.SafeRelease();
                CheckBuffer(Prefix + TEXT("-retained-view-load"), Expected);
                RHI.ShaderData(Load).Resources.Reset();
                RHI.ShaderData(Sample).Resources.Reset();
            }
            FDiscardableBulkData Bulk2D;
            Bulk2D.Bytes.Append(Stored.GetData(), 24);
            auto Texture2D = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("Bulk2DProbe"), 3, 2, Format)
                                                   .SetFlags(ETextureCreateFlags::ShaderResource)
                                                   .SetInitialState(ERHIAccess::SRVCompute)
                                                   .SetInitActionBulkData(&Bulk2D));
            TArray<FColor> Colors;
            Cmd.ReadSurfaceData(Texture2D, FIntRect(0, 0, 3, 2), Colors, RawReadback());
            bool OK = Colors.Num() == 6 && Bulk2D.Discards == 1;
            for (int32 Index = 0; Index < Colors.Num(); ++Index)
                OK &= Colors[Index] ==
                      FColor(RGBA[Index * 4], RGBA[Index * 4 + 1], RGBA[Index * 4 + 2], RGBA[Index * 4 + 3]);
            Checked += 24;
            Record(Format == PF_R8G8B8A8 ? TEXT("rgba-bulk-2d") : TEXT("bgra-bulk-2d"), OK);
            Record(Format == PF_R8G8B8A8 ? TEXT("rgba-reject-2d-texture-for-3d-shader")
                                         : TEXT("bgra-reject-2d-texture-for-3d-shader"),
                   !RHI.ValidateTextureBinding(Texture2D, *VolumeBinding, ERHIAccess::SRVCompute, Error));
        }
        Record(TEXT("compute-pipelines-reused"), RHI.ComputePipelinesCreated == 2 && RHI.Dispatches == 24);
    }
    Scope.PrepareShutdown();
    Record(TEXT("transitions-released"),
           RHI.TransitionsCreated == 8 && RHI.TransitionsReleased == 8 && RHI.Transitions.IsEmpty());
    Record(TEXT("gpu-validation-clean"), RHI.Errors.IsEmpty());
    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("mode"), Mode);
    Report->SetNumberField(TEXT("checkedValues"), Checked);
    Report->SetNumberField(TEXT("dispatches"), RHI.Dispatches);
    Report->SetNumberField(TEXT("computePipelinesCreated"), RHI.ComputePipelinesCreated);
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

bool RunWebGPUTexture3DProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory, const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUTexture3DProbe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("texture3DInitializationAndSamplingVerified"), Pass);
        Report->SetBoolField(TEXT("bulkDataSnapshotAndDiscardVerified"), Pass);
        Report->SetBoolField(TEXT("probeOnlyShaders"), true);
        Report->SetBoolField(TEXT("multiMipVolumeImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetArrayField(TEXT("modes"), Modes);
        FString JSON;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
        check(FFileHelper::SaveStringToFile(JSON, *(OutputDirectory / TEXT("texture-3d-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
