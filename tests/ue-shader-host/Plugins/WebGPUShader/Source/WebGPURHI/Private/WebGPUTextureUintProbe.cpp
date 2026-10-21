#include "WebGPUTextureUintProbe.h"
#include "WebGPUGlobalScope.h"
#include "WebGPUProbeUtils.h"

#include "Containers/ResourceArray.h"
#include "HAL/FileManager.h"
#include "PipelineStateCache.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"

namespace
{
struct FDiscardableBulk : FResourceBulkDataInterface
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
        UE_LOG(LogRHI, Display, TEXT("P2_TEXTURE_UINT %s %s pass=%d"), *Mode, *Name, OK);
    };
    Record(TEXT("global-device-and-recording-mode"), GDynamicRHI == &RHI && !GUsingNullRHI && Cmd.Bypass() == Bypass);
    {
        auto Load = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebTextureUint_LoadCS"))));
        auto Inspect =
            RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebTextureUint_InspectCS"))));
        auto FloatLoad = RHICreateComputeShader(FRHICreateShaderDesc(Packet(Directory, TEXT("WebTexture3D_LoadCS"))));
        const auto Find = [&](FRHIComputeShader *Shader, const TCHAR *Array, const TCHAR *Name) {
            const auto *Found = RHI.ShaderData(Shader).Metadata->GetArrayField(Array).FindByPredicate(
                [&](const auto &Value) { return Value->AsObject()->GetStringField(TEXT("name")) == Name; });
            check(Found);
            return (*Found)->AsObject();
        };
        const auto UIntBinding = Find(Load, TEXT("spirvBindings"), TEXT("Volume"));
        const auto FloatBinding = Find(FloatLoad, TEXT("spirvBindings"), TEXT("Volume"));
        Record(TEXT("shader-reflects-uint-texture"),
               UIntBinding->GetStringField(TEXT("textureSampleType")) == TEXT("uint") &&
                   UIntBinding->GetIntegerField(TEXT("textureDimension")) == 2 &&
                   !UIntBinding->GetBoolField(TEXT("textureArrayed")) &&
                   !UIntBinding->GetBoolField(TEXT("textureMultisampled")));
        Record(TEXT("shader-reflects-float-texture"),
               FloatBinding->GetStringField(TEXT("textureSampleType")) == TEXT("float"));
        for (const EPixelFormat PixelFormat :
             {PF_R32_UINT, PF_R16_UINT, PF_R8G8B8A8_UINT, PF_FloatRGBA, PF_R32_FLOAT, PF_R8, PF_G8, PF_R8G8})
        {
            const FString Prefix = FString::Printf(TEXT("system-2d-%u"), uint32(PixelFormat));
            const bool Unsigned = PixelFormat == PF_R32_UINT || PixelFormat == PF_R16_UINT ||
                                  PixelFormat == PF_R8G8B8A8_UINT;
            auto Desc = FRHITextureCreateDesc::Create2D(*Prefix, 3, 2, PixelFormat)
                            .SetFlags(ETextureCreateFlags::ShaderResource)
                            .SetInitialState(ERHIAccess::SRVCompute);
            FString Error;
            Record(Prefix + TEXT("-creation-valid"), RHI.ValidateTextureInitialization(Desc, Error));
            auto Texture = Cmd.CreateTexture(Desc);
            auto SRV = Cmd.CreateShaderResourceView(Texture,
                                                   FRHIViewDesc::CreateTextureSRV().SetDimensionFromTexture(Texture));
            Record(Prefix + TEXT("-view-valid"), RHI.ValidateTextureSRV(Texture, SRV->GetDesc(), Error));
            auto Binding = MakeShared<FJsonObject>(*(Unsigned ? UIntBinding : FloatBinding));
            Binding->SetNumberField(TEXT("textureDimension"), 1);
            Record(Prefix + TEXT("-direct-type-compatible"),
                   RHI.ValidateTextureBinding(Texture, *Binding, ERHIAccess::SRVCompute, Error));
            Record(Prefix + TEXT("-srv-type-compatible"),
                   RHI.ValidateTextureBinding(SRV, *Binding, ERHIAccess::SRVCompute, Error));
            Binding->SetStringField(TEXT("textureSampleType"), Unsigned ? TEXT("float") : TEXT("uint"));
            Record(Prefix + TEXT("-reject-scalar-mismatch"),
                   !RHI.ValidateTextureBinding(SRV, *Binding, ERHIAccess::SRVCompute, Error));
            auto Invalid = Desc;
            Invalid.Flags |= ETextureCreateFlags::SRGB;
            Record(Prefix + TEXT("-reject-srgb"), !RHI.ValidateTextureInitialization(Invalid, Error));
            Invalid = Desc;
            Invalid.Dimension = ETextureDimension::Texture2DArray;
            Record(Prefix + TEXT("-reject-array"), !RHI.ValidateTextureInitialization(Invalid, Error));
            Invalid = Desc;
            Invalid.Dimension = ETextureDimension::Texture3D;
            Invalid.Depth = 2;
            Record(Prefix + TEXT("-volume-scope-retained"),
                   RHI.ValidateTextureInitialization(Invalid, Error) ==
                       (PixelFormat == PF_R8G8B8A8_UINT || PixelFormat == PF_FloatRGBA));
        }
        auto Base = FRHITextureCreateDesc::Create3D(TEXT("IntegerVolumeProbe"), 3, 2, 3, PF_R8G8B8A8_UINT)
                        .SetFlags(ETextureCreateFlags::ShaderResource)
                        .SetInitialState(ERHIAccess::SRVCompute);
        FString Error;
        const auto RejectCreate = [&](const TCHAR *Name, auto Change) {
            auto Desc = Base;
            Change(Desc);
            Record(FString(TEXT("reject-create-")) + Name, !RHI.ValidateTextureInitialization(Desc, Error));
        };
        RejectCreate(TEXT("cube-integer"), [](auto &Desc) {
            Desc.Dimension = ETextureDimension::TextureCube;
            Desc.Depth = 1;
        });
        RejectCreate(TEXT("srgb"), [](auto &Desc) { Desc.Flags |= ETextureCreateFlags::SRGB; });
        RejectCreate(TEXT("render-target"), [](auto &Desc) { Desc.Flags |= ETextureCreateFlags::RenderTargetable; });
        RejectCreate(TEXT("uav"), [](auto &Desc) { Desc.Flags |= ETextureCreateFlags::UAV; });
        RejectCreate(TEXT("multi-mip"), [](auto &Desc) { Desc.NumMips = 2; });
        RejectCreate(TEXT("array"), [](auto &Desc) { Desc.ArraySize = 2; });
        RejectCreate(TEXT("multisample"), [](auto &Desc) { Desc.NumSamples = 4; });
        RejectCreate(TEXT("missing-bulk"), [](auto &Desc) { Desc.SetInitActionBulkData(nullptr); });
        RejectCreate(TEXT("dimension-limit"),
                     [&](auto &Desc) { Desc.Extent.X = RHI.Limits.maxTextureDimension3D + 1; });
        FDiscardableBulk InvalidBulk;
        InvalidBulk.Bytes.Init(0, 71);
        RejectCreate(TEXT("short-bulk"), [&](auto &Desc) { Desc.SetInitActionBulkData(&InvalidBulk); });
        InvalidBulk.Bytes.Add(0);
        InvalidBulk.Bytes.Add(0);
        RejectCreate(TEXT("oversized-bulk"), [&](auto &Desc) { Desc.SetInitActionBulkData(&InvalidBulk); });
        Record(TEXT("invalid-bulk-not-discarded"), InvalidBulk.Discards == 0 && InvalidBulk.Bytes.Num() == 73);
        TArray<uint32> Values;
        TArray<uint8> Bytes;
        const uint8 Edges[] = {0, 1, 127, 128, 254, 255};
        for (uint32 Index = 0; Index < 72; ++Index)
        {
            const uint8 Value = Index < UE_ARRAY_COUNT(Edges) ? Edges[Index] : (Index * 73 + 29) % 256;
            Values.Add(Value);
            Bytes.Add(Value);
        }
        TArray<uint32> Guards;
        Guards.Init(0xdeadbeef, 84);
        auto Sink = Buffer(RHI, Cmd,
                           FRHIBufferCreateDesc::CreateStructured(TEXT("IntegerVolumeReadback"), Guards.Num() * 4, 16)
                               .AddUsage(BUF_UnorderedAccess)
                               .SetInitialState(ERHIAccess::UAVCompute),
                           Guards.GetData(), Guards.Num() * 4);
        auto UAV = Cmd.CreateUnorderedAccessView(Sink, FRHIViewDesc::CreateBufferUAV().SetTypeFromBuffer(Sink));
        const auto Dispatch = [&](FRHIComputeShader *Shader, FRHIResource *Resource, FUintVector3 Extent) {
            SetComputePipelineState(Cmd, FComputePipelineStateInitializer(Shader));
            const auto Parameter = Find(Shader, TEXT("ueParameterMap"), TEXT("Extent"));
            const FRHIShaderParameter Allocation(Parameter->GetIntegerField(TEXT("bufferIndex")),
                                                 Parameter->GetIntegerField(TEXT("baseIndex")), 0, sizeof(Extent));
            const FRHIShaderParameterResource Resources[] = {
                {Resource->GetType() == RRT_Texture ? FRHIShaderParameterResource::EType::Texture
                                                    : FRHIShaderParameterResource::EType::ResourceView,
                 Resource,
                 uint16(Find(Shader, TEXT("ueParameterMap"), TEXT("Volume"))->GetIntegerField(TEXT("baseIndex")))},
                {UAV,
                 uint16(Find(Shader, TEXT("ueParameterMap"), TEXT("Output"))->GetIntegerField(TEXT("baseIndex")))}};
            Cmd.SetShaderParameters(Shader, MakeArrayView(reinterpret_cast<const uint8 *>(&Extent), sizeof(Extent)),
                                    MakeArrayView(&Allocation, 1), Resources, {});
            Cmd.DispatchComputeShader(1, 1, 1);
        };
        const auto CheckBuffer = [&](const FString &Name, const TArray<uint32> &Expected) {
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            const auto Read = RHI.ReadBuffer(Sink, Expected.Num() * 4);
            bool OK = Read.Num() == Expected.Num() * 4;
            for (int32 Index = 0; Index < Expected.Num() && OK; ++Index)
            {
                uint32 Actual;
                FMemory::Memcpy(&Actual, Read.GetData() + Index * 4, 4);
                OK &= Actual == Expected[Index];
            }
            Checked += Expected.Num();
            check(FFileHelper::SaveArrayToFile(Read, *(Output / (Mode + TEXT("-") + Name + TEXT(".bin")))));
            Record(Name, OK);
        };
        TArray<uint32> Expected = Guards;
        for (const bool Bulk : {false, true})
        {
            const FString Prefix = Bulk ? TEXT("bulk") : TEXT("initializer");
            auto Desc = Base;
            FDiscardableBulk Data;
            Data.Bytes = Bytes;
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
                Record(Prefix + TEXT("-subresource-layout"), Subresource.Size == 72 && Subresource.Stride == 12);
                Subresource.WriteData(Bytes.GetData(), Bytes.Num());
            }
            auto Texture = Initializer.Finalize();
            auto SRV = Cmd.CreateShaderResourceView(Texture, FRHIViewDesc::CreateTextureSRV()
                                                                 .SetDimension(ETextureDimension::Texture3D)
                                                                 .SetFormat(PF_R8G8B8A8_UINT));
            const auto View = SRV->GetDesc();
            const auto Info = View.Texture.SRV.GetViewInfo(Texture);
            Record(Prefix + TEXT("-view-layout"),
                   Info.Format == PF_R8G8B8A8_UINT && Info.MipRange.Num == 1 && Info.ArrayRange.Num == 1);
            Record(Prefix + TEXT("-shader-type-compatible"),
                   RHI.ValidateTextureBinding(SRV, *UIntBinding, ERHIAccess::SRVCompute, Error));
            Record(Prefix + TEXT("-reject-float-shader-direct"),
                   !RHI.ValidateTextureBinding(Texture, *FloatBinding, ERHIAccess::SRVCompute, Error));
            Record(Prefix + TEXT("-reject-float-shader-srv"),
                   !RHI.ValidateTextureBinding(SRV, *FloatBinding, ERHIAccess::SRVCompute, Error));
            const auto RejectBinding = [&](const TCHAR *Name, auto Change) {
                auto Binding = MakeShared<FJsonObject>(*UIntBinding);
                Change(*Binding);
                Record(Prefix + TEXT("-reject-binding-") + Name,
                       !RHI.ValidateTextureBinding(SRV, *Binding, ERHIAccess::SRVCompute, Error));
            };
            RejectBinding(TEXT("missing-type"), [](auto &Binding) { Binding.RemoveField(TEXT("textureSampleType")); });
            RejectBinding(TEXT("signed-type"),
                          [](auto &Binding) { Binding.SetStringField(TEXT("textureSampleType"), TEXT("sint")); });
            RejectBinding(TEXT("arrayed"), [](auto &Binding) { Binding.SetBoolField(TEXT("textureArrayed"), true); });
            RejectBinding(TEXT("multisampled"),
                          [](auto &Binding) { Binding.SetBoolField(TEXT("textureMultisampled"), true); });
            const auto RejectView = [&](const TCHAR *Name, auto Change) {
                auto Wrong = View;
                Change(Wrong.Texture.SRV);
                Record(Prefix + TEXT("-reject-view-") + Name, !RHI.ValidateTextureSRV(Texture, Wrong, Error));
            };
            RejectView(TEXT("float-format"), [](auto &V) { V.Format = PF_R8G8B8A8; });
            RejectView(TEXT("2d"), [](auto &V) { V.Dimension = FRHIViewDesc::EDimension::Texture2D; });
            RejectView(TEXT("mip"), [](auto &V) { V.MipRange.First = 1; });
            RejectView(TEXT("array-slice"), [](auto &V) { V.ArrayRange.First = 1; });
            Dispatch(Load, Texture, FUintVector3(3, 2, 3));
            for (int32 Index = 0; Index < Values.Num(); ++Index)
                Expected[4 + Index] = Values[Index];
            CheckBuffer(Prefix + TEXT("-direct-load-and-guards"), Expected);
            Dispatch(Load, SRV, FUintVector3(3, 2, 3));
            CheckBuffer(Prefix + TEXT("-srv-load-and-guards"), Expected);
            Dispatch(Inspect, SRV, FUintVector3(3, 2, 3));
            for (uint32 Index = 0; Index < 72; ++Index)
                Expected[4 + Index] = Values[(17 - Index / 4) * 4 + Index % 4];
            const uint32 Dimensions[] = {3, 2, 3, 1};
            FMemory::Memcpy(Expected.GetData() + 76, Dimensions, sizeof(Dimensions));
            CheckBuffer(Prefix + TEXT("-reverse-load-and-dimensions"), Expected);
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::SRVCompute, ERHIAccess::CopyDest));
            Cmd.ImmediateFlush(EImmediateFlushType::FlushRHIThread);
            Record(Prefix + TEXT("-reject-wrong-access"),
                   !RHI.ValidateTextureBinding(SRV, *UIntBinding, ERHIAccess::SRVCompute, Error));
            Cmd.Transition(FRHITransitionInfo(Texture, ERHIAccess::CopyDest, ERHIAccess::SRVCompute));
            Dispatch(Load, SRV, FUintVector3(3, 2, 3));
            SRV.SafeRelease();
            Texture.SafeRelease();
            for (int32 Index = 0; Index < Values.Num(); ++Index)
                Expected[4 + Index] = Values[Index];
            CheckBuffer(Prefix + TEXT("-released-view-load"), Expected);
            RHI.ShaderData(Load).Resources.Reset();
            RHI.ShaderData(Inspect).Resources.Reset();
        }
        auto Zero = Cmd.CreateTexture(Base);
        Dispatch(Load, Zero, FUintVector3(3, 2, 3));
        for (uint32 Index = 4; Index < 76; ++Index)
            Expected[Index] = 0;
        CheckBuffer(TEXT("default-zero-initialization"), Expected);
        FDiscardableBulk OneBulk;
        OneBulk.Bytes = {0, 127, 254, 255};
        auto OneDesc = FRHITextureCreateDesc::Create3D(TEXT("OneIntegerVolume"), 1, 1, 1, PF_R8G8B8A8_UINT)
                           .SetFlags(ETextureCreateFlags::ShaderResource)
                           .SetInitialState(ERHIAccess::SRVCompute)
                           .SetInitActionBulkData(&OneBulk);
        auto One = Cmd.CreateTexture(OneDesc);
        Dispatch(Inspect, One, FUintVector3(1, 1, 1));
        for (uint32 Index = 0; Index < 4; ++Index)
        {
            Expected[4 + Index] = Index == 0 ? 0 : Index == 1 ? 127 : Index == 2 ? 254 : 255;
            Expected[76 + Index] = 1;
        }
        CheckBuffer(TEXT("one-voxel-bulk-and-dimensions"), Expected);
        Record(TEXT("one-voxel-bulk-discarded"), OneBulk.Discards == 1 && OneBulk.Bytes.IsEmpty());
        auto FloatDesc = FRHITextureCreateDesc::Create3D(TEXT("NormalizedVolume"), 3, 2, 3, PF_R8G8B8A8)
                             .SetFlags(ETextureCreateFlags::ShaderResource)
                             .SetInitialState(ERHIAccess::SRVCompute);
        auto Normalized = Cmd.CreateTexture(FloatDesc);
        Record(TEXT("reject-uint-shader-for-unorm-texture"),
               !RHI.ValidateTextureBinding(Normalized, *UIntBinding, ERHIAccess::SRVCompute, Error));
        Record(TEXT("reject-null-texture-binding"),
               !RHI.ValidateTextureBinding(nullptr, *UIntBinding, ERHIAccess::SRVCompute, Error));
        RHI.ShaderData(Load).Resources.Reset();
        RHI.ShaderData(Inspect).Resources.Reset();
        Record(TEXT("compute-pipelines-reused"), RHI.ComputePipelinesCreated == 2 && RHI.Dispatches == 10);
    }
    Scope.PrepareShutdown();
    Record(TEXT("transitions-released"),
           RHI.TransitionsCreated == 4 && RHI.TransitionsReleased == 4 && RHI.Transitions.IsEmpty());
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

bool RunWebGPUTextureUintProbe(IDynamicRHIModule &Module, const FString &ShaderDirectory,
                               const FString &OutputDirectory)
{
    IFileManager::Get().MakeDirectory(*OutputDirectory, true);
    bool Pass = true;
    ENQUEUE_RENDER_COMMAND(WebGPUTextureUintProbe)([&](FRHICommandListImmediate &) {
        TArray<TSharedPtr<FJsonValue>> Modes;
        for (bool Bypass : {false, true})
        {
            auto Mode = RunMode(Module, ShaderDirectory, OutputDirectory, Bypass);
            Pass &= Mode->GetBoolField(TEXT("pass"));
            Modes.Add(MakeShared<FJsonValueObject>(Mode));
        }
        auto Report = MakeShared<FJsonObject>();
        Report->SetBoolField(TEXT("pass"), Pass);
        Report->SetBoolField(TEXT("integerVolumeLoadVerified"), Pass);
        Report->SetBoolField(TEXT("textureSampleTypeValidated"), Pass);
        Report->SetBoolField(TEXT("probeOnlyShaders"), true);
        Report->SetBoolField(TEXT("integerTextureFilteringImplemented"), false);
        Report->SetBoolField(TEXT("browserEngineImplemented"), false);
        Report->SetStringField(TEXT("hostRHI"), GDynamicRHI->GetName());
        Report->SetArrayField(TEXT("modes"), Modes);
        FString JSON;
        FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&JSON));
        check(FFileHelper::SaveStringToFile(JSON, *(OutputDirectory / TEXT("texture-uint-results.json")),
                                            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM));
    });
    FlushRenderingCommands();
    return Pass;
}
