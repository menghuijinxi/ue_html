#include "WebGPUMaterialProbe.h"
#include "WebGPUProbeUtils.h"
#include "RHIUniformBufferLayoutInitializer.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderParameterMetadata.h"
#include "ShaderParameterMacros.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

namespace
{
using namespace WebGPUProbe;
struct FMaterialConfig
{
    float SX = 1, SY = 1, TX = 0, TY = 0, ProjectionX = 1, ProjectionY = 1, Exposure = 1;
    FVector3f ViewLow = FVector3f::ZeroVector, ViewHigh = FVector3f::ZeroVector, PositionHigh = FVector3f::ZeroVector;
    bool Override = false, Index32 = false, Inverted = false;
};
const uint8 Palette[] = {32, 64, 96, 255, 96, 128, 160, 255, 160, 192, 224, 255, 224, 64, 128, 255};
TSharedPtr<FJsonObject> ReadJson(const FString &File)
{
    FString Text;
    TSharedPtr<FJsonObject> Result;
    check(FFileHelper::LoadFileToString(Text, *File));
    check(FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Result));
    return Result;
}
TRefCountPtr<FRHIUniformBufferLayout> RebuildLayout(const FJsonObject &Source)
{
    const FString Name = Source.GetStringField(TEXT("name"));
    FRHIUniformBufferLayoutInitializer Initializer(*Name);
    Initializer.ConstantBufferSize = Source.GetIntegerField(TEXT("constantBufferSize"));
    Initializer.StaticSlot = Source.GetIntegerField(TEXT("staticSlot"));
    Initializer.BindingFlags = EUniformBufferBindingFlags(Source.GetIntegerField(TEXT("bindingFlags")));
    Initializer.Flags = ERHIUniformBufferFlags(Source.GetIntegerField(TEXT("flags")));
    if (const auto *Metadata = FindUniformBufferStructByLayoutHash(uint32(Source.GetNumberField(TEXT("hash")))))
        Initializer.StaticSlot = Metadata->GetLayout().StaticSlot;
    for (const auto &Value : Source.GetArrayField(TEXT("resources")))
    {
        const auto Member = Value->AsObject();
        FRHIUniformBufferResourceInitializer Resource;
        Resource.MemberOffset = Member->GetIntegerField(TEXT("offset"));
        Resource.MemberType = EUniformBufferBaseType(Member->GetIntegerField(TEXT("type")));
        Initializer.Resources.Add(Resource);
    }
    Initializer.ComputeHash();
    checkf(Initializer.GetHash() == uint32(Source.GetNumberField(TEXT("hash"))),
           TEXT("Reconstructed UE uniform layout hash mismatch: %s"), *Name);
    return new FRHIUniformBufferLayout(Initializer);
}
void WriteMember(TArray<uint8> &Bytes, const FShaderParametersMetadata &Metadata, const TCHAR *Name, const void *Value,
                 uint32 Size)
{
    const auto *Member = Metadata.GetMembers().FindByPredicate(
        [&](const auto &Candidate) { return FString(Candidate.GetName()) == Name; });
    check(Member && Member->GetMemberSize() == Size && Member->GetOffset() + Size <= uint32(Bytes.Num()));
    FMemory::Memcpy(Bytes.GetData() + Member->GetOffset(), Value, Size);
}
TArray<uint8> FillConstants(const FRHIUniformBufferLayout &Layout, const FMaterialConfig &Config, bool View)
{
    const auto *Metadata = FindUniformBufferStructByLayoutHash(Layout.GetHash());
    check(Metadata && Metadata->GetLayout().GetHash() == Layout.GetHash());
    TArray<uint8> Bytes;
    Bytes.SetNumZeroed(Layout.ConstantBufferSize);
    const float Identity[] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    if (View)
    {
        float Projection[16];
        FMemory::Memcpy(Projection, Identity, sizeof(Projection));
        Projection[0] = Config.ProjectionX;
        Projection[5] = Config.ProjectionY;
        WriteMember(Bytes, *Metadata, TEXT("TranslatedWorldToClip"), Projection, sizeof(Projection));
        WriteMember(Bytes, *Metadata, TEXT("FirstPersonTransform"), Identity, sizeof(Identity));
        WriteMember(Bytes, *Metadata, TEXT("PreViewTranslationHigh"), &Config.ViewHigh, sizeof(Config.ViewHigh));
        WriteMember(Bytes, *Metadata, TEXT("PreViewTranslationLow"), &Config.ViewLow, sizeof(Config.ViewLow));
        WriteMember(Bytes, *Metadata, TEXT("PreExposure"), &Config.Exposure, sizeof(Config.Exposure));
    }
    else
    {
        float Transform[16];
        FMemory::Memcpy(Transform, Identity, sizeof(Transform));
        Transform[0] = Config.SX;
        Transform[5] = Config.SY;
        Transform[12] = Config.TX;
        Transform[13] = Config.TY;
        Transform[14] = 0.5f;
        const FVector3f Inverse(1 / Config.SX, 1 / Config.SY, 1);
        WriteMember(Bytes, *Metadata, TEXT("LocalToRelativeWorld"), Transform, sizeof(Transform));
        WriteMember(Bytes, *Metadata, TEXT("PositionHigh"), &Config.PositionHigh, sizeof(Config.PositionHigh));
        WriteMember(Bytes, *Metadata, TEXT("InvNonUniformScale"), &Inverse, sizeof(Inverse));
    }
    return Bytes;
}
TArray<uint8> FillMaterial(const FString &Directory, const FString &Material, const FRHIUniformBufferLayout &Layout,
                           bool Override, FRHITexture *Texture, FRHISamplerState *Sampler)
{
    TArray<uint8> Bytes, Constants;
    Bytes.SetNumZeroed(Layout.ConstantBufferSize);
    check(FFileHelper::LoadFileToArray(
        Constants, *(Directory / (Material + (Override ? TEXT(".override.uniform.bin") : TEXT(".uniform.bin"))))));
    check(Constants.Num() <= Bytes.Num());
    FMemory::Memcpy(Bytes.GetData(), Constants.GetData(), Constants.Num());
    for (const auto &Member : Layout.Resources)
    {
        check(Member.MemberOffset >= Constants.Num() && Member.MemberOffset + sizeof(void *) <= uint32(Bytes.Num()));
        FRHIResource *Resource = Member.MemberType == UBMT_TEXTURE   ? static_cast<FRHIResource *>(Texture)
                                 : Member.MemberType == UBMT_SAMPLER ? static_cast<FRHIResource *>(Sampler)
                                                                     : nullptr;
        check(Member.MemberType == UBMT_TEXTURE || Member.MemberType == UBMT_SAMPLER);
        FMemory::Memcpy(Bytes.GetData() + Member.MemberOffset, &Resource, sizeof(Resource));
    }
    return Bytes;
}
FColor Expected(const FString &Material, const FMaterialConfig &Config, int32 X, int32 Y)
{
    const double LX = ((2 * (X + 0.5) / 64 - 1) / Config.ProjectionX - Config.TX - Config.ViewLow.X -
                       Config.PositionHigh.X - Config.ViewHigh.X) /
                      Config.SX;
    const double LY = ((1 - 2 * (Y + 0.5) / 64) / Config.ProjectionY - Config.TY - Config.ViewLow.Y -
                       Config.PositionHigh.Y - Config.ViewHigh.Y) /
                      Config.SY;
    if (FMath::Abs(LX) > 0.5f || FMath::Abs(LY) > 0.5f)
        return FColor(0, 0, 0, 0);
    float Values[3];
    if (Material == TEXT("UnlitColor"))
    {
        Values[0] = (Config.Override ? 0.75f : 0.125f) * 255;
        Values[1] = (Config.Override ? 0.25f : 0.5f) * 255;
        Values[2] = (Config.Override ? 0.125f : 0.75f) * 255;
    }
    else
    {
        const uint8 *P = Palette + ((LY < 0 ? 2 : 0) + (LX >= 0 ? 1 : 0)) * 4;
        for (int32 Channel = 0; Channel < 3; ++Channel)
            Values[Channel] = Config.Inverted ? 255 - P[Channel] : P[Channel];
    }
    return FColor(FMath::RoundToInt(FMath::Clamp(Values[0] * Config.Exposure, 0.f, 255.f)),
                  FMath::RoundToInt(FMath::Clamp(Values[1] * Config.Exposure, 0.f, 255.f)),
                  FMath::RoundToInt(FMath::Clamp(Values[2] * Config.Exposure, 0.f, 255.f)), 0);
}
bool CheckMemberOffsets(const FWebGPUShaderData &Shader)
{
    for (const auto &Value : Shader.Metadata->GetArrayField(TEXT("spirvBindings")))
    {
        const auto Binding = Value->AsObject();
        const FString UniformName = Binding->GetStringField(TEXT("name"));
        if (UniformName != TEXT("View") && UniformName != TEXT("Primitive"))
            continue;
        const uint32 Slot = UniformName == TEXT("View") ? 0 : 1;
        const auto *Metadata =
            FindUniformBufferStructByLayoutHash(Shader.ResourceTable.ResourceTableLayoutHashes[Slot]);
        if (!Metadata)
            return false;
        for (const auto &Field : Binding->GetArrayField(TEXT("members")))
        {
            const auto Reflected = Field->AsObject();
            const FString Name = Reflected->GetStringField(TEXT("name")).RightChop(UniformName.Len() + 1);
            const auto *Member = Metadata->GetMembers().FindByPredicate(
                [&](const auto &Candidate) { return FString(Candidate.GetName()) == Name; });
            if (!Member || Member->GetOffset() != uint32(Reflected->GetIntegerField(TEXT("offset"))) ||
                Member->GetMemberSize() != uint32(Reflected->GetIntegerField(TEXT("size"))))
                return false;
        }
    }
    return true;
}
} // namespace

TSharedRef<FJsonObject> RunWebGPUMaterialProbe(FWebGPUDynamicRHI &RHI, const FString &Directory,
                                               const FString &OutputDirectory)
{
    const uint32 StartDraws = RHI.Draws, StartGroups = RHI.BoundGroups, StartTables = RHI.ResourceTableBindings;
    const bool StaticView = FParse::Param(FCommandLine::Get(), TEXT("WebStaticUniformProbe"));
    const uint32 StartStaticResolutions = RHI.StaticUniformResolutions;
    TArray<TSharedPtr<FJsonValue>> Checks;
    uint64 Checked = 0;
    bool Pass = true;
    const auto Record = [&](const FString &Name, bool OK) {
        auto Check = MakeShared<FJsonObject>();
        Check->SetStringField(TEXT("name"), Name);
        Check->SetBoolField(TEXT("pass"), OK);
        Checks.Add(MakeShared<FJsonValueObject>(Check));
        UE_LOG(LogRHI, Display, TEXT("P2_MATERIAL %s pass=%d"), *Name, OK);
        Pass &= OK;
    };
    const auto Layouts = ReadJson(Directory / TEXT("uniform-layouts.json"));
    const auto ViewLayout = RebuildLayout(*Layouts->GetObjectField(TEXT("UnlitColor:View")));
    const auto PrimitiveLayout = RebuildLayout(*Layouts->GetObjectField(TEXT("UnlitColor:Primitive")));
    FBufferRHIRef Streams[3], IB16, IB32;
    FTextureRHIRef Images[2];
    auto Sampler = RHI.RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Point, AM_Wrap, AM_Wrap));
    auto Blend = RHI.RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
    auto Raster = RHI.RHICreateRasterizerState(FRasterizerStateInitializerRHI(FM_Solid, CM_None, false));
    auto Depth = RHI.RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
    const float Positions[] = {-0.5, 0.5, 0, 1, 0.5, 0.5, 0, 1, -0.5, -0.5, 0, 1, 0.5, -0.5, 0, 1};
    const float Tangents[] = {1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1};
    const float UVs[] = {0, 0, 1, 0, 0, 1, 1, 1};
    const uint16 Indices16[] = {0, 2, 1, 1, 2, 3};
    const uint32 Indices32[] = {0, 2, 1, 1, 2, 3};
    RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
    {
        FCommandList Cmd(&RHI);
        Streams[0] = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("Positions"), sizeof(Positions)),
                            Positions, sizeof(Positions));
        Streams[1] = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("Tangents"), sizeof(Tangents)), Tangents,
                            sizeof(Tangents));
        Streams[2] = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("UVs"), sizeof(UVs)), UVs, sizeof(UVs));
        IB16 = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateIndex(TEXT("MaterialIndices16"), sizeof(Indices16), 2),
                      Indices16, sizeof(Indices16));
        IB32 = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateIndex(TEXT("MaterialIndices32"), sizeof(Indices32), 4),
                      Indices32, sizeof(Indices32));
        for (uint32 Index = 0; Index < 2; ++Index)
        {
            uint8 Pixels[16];
            for (uint32 Byte = 0; Byte < 16; ++Byte)
                Pixels[Byte] = Index && Byte % 4 != 3 ? 255 - Palette[Byte] : Palette[Byte];
            Images[Index] = Target(RHI, Cmd, 2, 2);
            RHI.RHIUpdateTexture2D(Cmd, Images[Index], 0, FUpdateTextureRegion2D(0, 0, 0, 0, 2, 2), 8, Pixels);
            Cmd.TransitionLocal(RHI, FRHITransitionInfo(Images[Index], ERHIAccess::RTV, ERHIAccess::SRVGraphicsPixel));
        }
    }
    RHI.SubmitCurrent();
    for (const FString Material : {FString(TEXT("UnlitColor")), FString(TEXT("UnlitTexture"))})
    {
        const bool Textured = Material == TEXT("UnlitTexture");
        auto Vertex = RHI.RHICreateVertexShader(FRHICreateShaderDesc(
            Packet(Directory, *(Material + TEXT("_WebVertexInput_TMobileBasePassVSFNoLightMapPolicy")))));
        auto Pixel = RHI.RHICreatePixelShader(FRHICreateShaderDesc(
            Packet(Directory, *(Material + TEXT("_WebVertexInput_TMobileBasePassPSFNoLightMapPolicy")))));
        Record(Material + TEXT("-runtime-member-offsets"),
               CheckMemberOffsets(RHI.ShaderData(Vertex)) && CheckMemberOffsets(RHI.ShaderData(Pixel)));
        const auto MaterialLayout = RebuildLayout(*Layouts->GetObjectField(Material + TEXT(":Material")));
        FVertexDeclarationElementList Elements;
        Elements.Add(FVertexElement(0, 0, VET_Float4, 0, 16));
        Elements.Add(FVertexElement(1, 0, VET_Float3, 1, 28));
        Elements.Add(FVertexElement(1, 12, VET_Float4, 2, 28));
        if (Textured)
            Elements.Add(FVertexElement(2, 0, VET_Float2, 4, 8));
        auto Declaration = RHI.RHICreateVertexDeclaration(Elements);
        FGraphicsPipelineStateInitializer Pipeline;
        Pipeline.BoundShaderState.VertexDeclarationRHI = Declaration;
        Pipeline.BoundShaderState.VertexShaderRHI = Vertex;
        Pipeline.BoundShaderState.PixelShaderRHI = Pixel;
        Pipeline.PrimitiveType = PT_TriangleList;
        Pipeline.RenderTargetsEnabled = 4;
        for (uint32 Index = 0; Index < 4; ++Index)
            Pipeline.RenderTargetFormats[Index] = PF_R8G8B8A8;
        Pipeline.NumSamples = 1;
        Pipeline.BlendState = Blend;
        Pipeline.RasterizerState = Raster;
        Pipeline.DepthStencilState = Depth;
        auto Native = RHI.RHICreateGraphicsPipelineState(Pipeline);
        const auto Draw = [&](FCommandList &Cmd, const FMaterialConfig &Config, FRHIUniformBuffer *View,
                              FRHIUniformBuffer *Primitive, FRHIUniformBuffer *Uniform) {
            BindPipeline(RHI, Cmd, Pipeline, Native);
            Cmd.SetViewport(0, 0, 0, 64, 64, 1);
            for (uint32 Stream = 0; Stream < 3; ++Stream)
                Cmd.SetStreamSource(Stream, Stream == 2 && !Textured ? nullptr : Streams[Stream].GetReference(), 0);
            const FRHIShaderParameterResource VSResources[] = {{View, 0}, {Primitive, 1}};
            const FRHIShaderParameterResource PSResources[] = {{View, 0}, {Uniform, 1}};
            if (StaticView)
                Cmd.SetStaticUniformBuffers(FUniformBufferStaticBindings(View));
            Cmd.SetShaderParameters(Vertex, {}, {}, MakeArrayView(VSResources + (StaticView ? 1 : 0),
                                                                  StaticView ? 1 : 2), {});
            Cmd.SetShaderParameters(Pixel, {}, {}, MakeArrayView(PSResources + (StaticView ? 1 : 0),
                                                                 StaticView ? 1 : 2), {});
            Cmd.DrawIndexedPrimitive(Config.Index32 ? IB32.GetReference() : IB16.GetReference(), 0, 0, 4, 0, 2, 1);
            if (StaticView)
                Cmd.SetStaticUniformBuffers(FUniformBufferStaticBindings());
        };
        const auto CheckTargets = [&](const FString &Name, FTextureRHIRef(&Targets)[4],
                                      TFunctionRef<FColor(int32, int32)> Want, bool Save) {
            bool OK = true;
            for (uint32 MRT = 0; MRT < 4; ++MRT)
            {
                TArray<FColor> Colors;
                RHI.RHIReadSurfaceData(Targets[MRT], FIntRect(0, 0, 64, 64), Colors, RawReadback());
                OK &= Colors.Num() == 4096;
                for (int32 Y = 0; Y < 64 && Colors.Num() == 4096; ++Y)
                    for (int32 X = 0; X < 64; ++X)
                    {
                        const auto Have = Colors[Y * 64 + X], Expected = MRT ? FColor(0, 0, 0, 0) : Want(X, Y);
                        OK &= FMath::Abs(int32(Have.R) - Expected.R) <= 2 &&
                              FMath::Abs(int32(Have.G) - Expected.G) <= 2 &&
                              FMath::Abs(int32(Have.B) - Expected.B) <= 2 && Have.A == Expected.A;
                        Checked += 4;
                    }
                if (Save && MRT == 0)
                {
                    TArray<uint8> Bytes;
                    for (const auto Color : Colors)
                    {
                        Bytes.Add(Color.R);
                        Bytes.Add(Color.G);
                        Bytes.Add(Color.B);
                        Bytes.Add(Color.A);
                    }
                    check(FFileHelper::SaveArrayToFile(Bytes, *(OutputDirectory / (Material + TEXT("-64x64.rgba")))));
                }
            }
            Record(Name, OK);
        };
        TArray<TPair<FString, FMaterialConfig>> Cases;
        FMaterialConfig Config;
        Cases.Emplace(TEXT("default-index16"), Config);
        Config.Index32 = true;
        Cases.Emplace(TEXT("index32"), Config);
        Config = {};
        Config.Override = true;
        Cases.Emplace(TEXT("uniform-override"), Config);
        Config = {};
        Config.SX = 0.75f;
        Config.SY = 0.5f;
        Config.TX = 0.25f;
        Config.TY = -0.125f;
        Cases.Emplace(TEXT("primitive-transform"), Config);
        Config = {};
        Config.ProjectionX = 0.5f;
        Config.ProjectionY = 0.75f;
        Config.ViewLow = FVector3f(0.25f, -0.125f, 0);
        Cases.Emplace(TEXT("view-projection"), Config);
        Config = {};
        Config.PositionHigh = FVector3f(1048576, -1048576, 0);
        Config.ViewHigh = -Config.PositionHigh;
        Config.ViewLow = FVector3f(0.125f, 0, 0);
        Cases.Emplace(TEXT("large-world-origin"), Config);
        Config = {};
        Config.Exposure = 0.5f;
        Cases.Emplace(TEXT("pre-exposure"), Config);
        for (const auto &Case : Cases)
        {
            const auto ViewBytes = FillConstants(*ViewLayout, Case.Value, true);
            const auto PrimitiveBytes = FillConstants(*PrimitiveLayout, Case.Value, false);
            const auto MaterialBytes =
                FillMaterial(Directory, Material, *MaterialLayout, Case.Value.Override, Images[0], Sampler);
            auto View = RHI.RHICreateUniformBuffer(ViewBytes.GetData(), ViewLayout, UniformBuffer_MultiFrame,
                                                   EUniformBufferValidation::None);
            auto Primitive = RHI.RHICreateUniformBuffer(PrimitiveBytes.GetData(), PrimitiveLayout,
                                                        UniformBuffer_MultiFrame, EUniformBufferValidation::None);
            auto Uniform = RHI.RHICreateUniformBuffer(MaterialBytes.GetData(), MaterialLayout, UniformBuffer_MultiFrame,
                                                      EUniformBufferValidation::None);
            FTextureRHIRef Targets[4];
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FCommandList Cmd(&RHI);
                FRHITexture *Raw[4];
                for (uint32 Index = 0; Index < 4; ++Index)
                {
                    Targets[Index] = Target(RHI, Cmd, 64, 64);
                    Raw[Index] = Targets[Index];
                }
                Cmd.BeginRenderPass(FRHIRenderPassInfo(4, Raw, ERenderTargetActions::Clear_Store), TEXT("MaterialMRT"));
                Draw(Cmd, Case.Value, View, Primitive, Uniform);
                Cmd.EndRenderPass();
            }
            RHI.SubmitCurrent();
            CheckTargets(
                Material + TEXT("-") + Case.Key, Targets,
                [&](int32 X, int32 Y) { return Expected(Material, Case.Value, X, Y); },
                Case.Key == TEXT("default-index16"));
        }
        {
            FMaterialConfig Left, Right;
            Left.SX = Right.SX = 0.5f;
            Left.TX = -0.25f;
            Right.TX = 0.25f;
            Right.Override = !Textured;
            Right.Inverted = Textured;
            const auto ViewBytes = FillConstants(*ViewLayout, Left, true);
            const auto LeftPrimitive = FillConstants(*PrimitiveLayout, Left, false);
            const auto RightPrimitive = FillConstants(*PrimitiveLayout, Right, false);
            const auto LeftMaterial = FillMaterial(Directory, Material, *MaterialLayout, false, Images[0], Sampler);
            const auto RightMaterial =
                FillMaterial(Directory, Material, *MaterialLayout, Right.Override, Images[1], Sampler);
            auto View = RHI.RHICreateUniformBuffer(ViewBytes.GetData(), ViewLayout, UniformBuffer_MultiFrame,
                                                   EUniformBufferValidation::None);
            auto Primitive = RHI.RHICreateUniformBuffer(LeftPrimitive.GetData(), PrimitiveLayout,
                                                        UniformBuffer_MultiFrame, EUniformBufferValidation::None);
            auto Uniform = RHI.RHICreateUniformBuffer(LeftMaterial.GetData(), MaterialLayout, UniformBuffer_MultiFrame,
                                                      EUniformBufferValidation::None);
            FTextureRHIRef Targets[4];
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FCommandList Cmd(&RHI);
                FRHITexture *Raw[4];
                for (uint32 Index = 0; Index < 4; ++Index)
                {
                    Targets[Index] = Target(RHI, Cmd, 64, 64);
                    Raw[Index] = Targets[Index];
                }
                Cmd.BeginRenderPass(FRHIRenderPassInfo(4, Raw, ERenderTargetActions::Clear_Store),
                                    TEXT("MaterialUpdates"));
                Draw(Cmd, Left, View, Primitive, Uniform);
                RHI.RHIUpdateUniformBuffer(Cmd, Primitive, RightPrimitive.GetData());
                RHI.RHIUpdateUniformBuffer(Cmd, Uniform, RightMaterial.GetData());
                Draw(Cmd, Right, View, Primitive, Uniform);
                Cmd.EndRenderPass();
            }
            RHI.SubmitCurrent();
            CheckTargets(
                Material + (Textured ? TEXT("-resource-reference-update-per-draw") : TEXT("-constant-update-per-draw")),
                Targets, [&](int32 X, int32 Y) { return Expected(Material, X < 32 ? Left : Right, X, Y); }, false);
            if (Textured)
            {
                const auto &Shader = RHI.ShaderData(Pixel);
                const auto TextureBinding = Shader.Metadata->GetArrayField(TEXT("spirvBindings"))[2]->AsObject();
                const auto SamplerBinding = Shader.Metadata->GetArrayField(TEXT("spirvBindings"))[3]->AsObject();
                FRHIResource *Resource = nullptr;
                bool FromTable = false;
                FString Error;
                Record(TEXT("resource-table-current-texture"),
                       RHI.ResolveBinding(Shader, *TextureBinding, Resource, FromTable, Error) && FromTable &&
                           Resource == Images[1]);
                Record(TEXT("resource-table-current-sampler"),
                       RHI.ResolveBinding(Shader, *SamplerBinding, Resource, FromTable, Error) && FromTable &&
                           Resource == Sampler);
                const auto Reject = [&](const TCHAR *Name, TFunctionRef<void(FWebGPUShaderData &)> Change,
                                        const FJsonObject &Binding) {
                    FWebGPUShaderData Invalid;
                    Invalid.Metadata = Shader.Metadata;
                    Invalid.Resources = Shader.Resources;
                    Invalid.ResourceTable = Shader.ResourceTable;
                    Change(Invalid);
                    Record(Name, !RHI.ResolveBinding(Invalid, Binding, Resource, FromTable, Error) && !Error.IsEmpty());
                };
                Reject(
                    TEXT("reject-resource-table-unbound-uniform"),
                    [](auto &Invalid) { Invalid.Resources.Remove((1u << 16) | 1); }, *TextureBinding);
                Reject(
                    TEXT("reject-resource-table-layout-hash"),
                    [](auto &Invalid) { Invalid.ResourceTable.ResourceTableLayoutHashes[1] ^= 1; }, *TextureBinding);
                Reject(
                    TEXT("reject-resource-table-missing-layout-hash"),
                    [](auto &Invalid) { Invalid.ResourceTable.ResourceTableLayoutHashes.Reset(); }, *TextureBinding);
                Reject(
                    TEXT("reject-resource-table-offset"),
                    [](auto &Invalid) { Invalid.ResourceTable.TextureMap[1] = 1; }, *TextureBinding);
                Reject(
                    TEXT("reject-resource-table-member-token"),
                    [](auto &Invalid) { Invalid.ResourceTable.TextureMap[2] ^= 1u << 8; }, *TextureBinding);
                Reject(
                    TEXT("reject-resource-table-missing-token"),
                    [](auto &Invalid) { Invalid.ResourceTable.ResourceTableBits = 0; }, *TextureBinding);
                for (const bool NullTexture : {true, false})
                {
                    const auto Bytes = FillMaterial(Directory, Material, *MaterialLayout, false,
                                                    NullTexture ? nullptr : Images[0].GetReference(),
                                                    NullTexture ? Sampler.GetReference() : nullptr);
                    auto Missing = RHI.RHICreateUniformBuffer(Bytes.GetData(), MaterialLayout, UniformBuffer_MultiFrame,
                                                              EUniformBufferValidation::None);
                    Reject(
                        NullTexture ? TEXT("reject-resource-table-null-texture")
                                    : TEXT("reject-resource-table-null-sampler"),
                        [&](auto &Invalid) { Invalid.Resources.Add((1u << 16) | 1, Missing.GetReference()); },
                        NullTexture ? *TextureBinding : *SamplerBinding);
                }
                Reject(
                    TEXT("reject-direct-uniform-wrong-slot"),
                    [&](auto &Invalid) { Invalid.Resources.Add(1u << 16, Uniform.GetReference()); },
                    *Shader.Metadata->GetArrayField(TEXT("spirvBindings"))[0]->AsObject());
                auto WrongBytes = LeftMaterial;
                FRHIResource *WrongResource = Sampler;
                FMemory::Memcpy(WrongBytes.GetData() + MaterialLayout->Resources[0].MemberOffset, &WrongResource,
                                sizeof(WrongResource));
                auto WrongUniform = RHI.RHICreateUniformBuffer(
                    WrongBytes.GetData(), MaterialLayout, UniformBuffer_MultiFrame, EUniformBufferValidation::None);
                Reject(
                    TEXT("reject-resource-table-wrong-rhi-type"),
                    [&](auto &Invalid) { Invalid.Resources.Add((1u << 16) | 1, WrongUniform.GetReference()); },
                    *TextureBinding);
                FTextureRHIRef LifetimeTargets[4], OwnedImage;
                auto OwnedSampler = RHI.RHICreateSamplerState(FSamplerStateInitializerRHI(SF_Point, AM_Wrap, AM_Wrap));
                FUniformBufferRHIRef OwnedUniform;
                FMaterialConfig LifetimeConfig;
                RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
                {
                    FCommandList Cmd(&RHI);
                    OwnedImage = Target(RHI, Cmd, 2, 2);
                    RHI.RHIUpdateTexture2D(Cmd, OwnedImage, 0, FUpdateTextureRegion2D(0, 0, 0, 0, 2, 2), 8, Palette);
                    Cmd.TransitionLocal(RHI,
                                        FRHITransitionInfo(OwnedImage, ERHIAccess::RTV, ERHIAccess::SRVGraphicsPixel));
                    const auto OwnedBytes =
                        FillMaterial(Directory, Material, *MaterialLayout, false, OwnedImage, OwnedSampler);
                    OwnedUniform = RHI.RHICreateUniformBuffer(OwnedBytes.GetData(), MaterialLayout,
                                                              UniformBuffer_MultiFrame, EUniformBufferValidation::None);
                    auto *ImagePointer = OwnedImage.GetReference();
                    auto *SamplerPointer = OwnedSampler.GetReference();
                    OwnedImage.SafeRelease();
                    OwnedSampler.SafeRelease();
                    Record(TEXT("uniform-owns-resources-after-caller-release"),
                           OwnedUniform->GetResourceTable()[0] == ImagePointer &&
                               OwnedUniform->GetResourceTable()[1] == SamplerPointer);
                    FRHITexture *Raw[4];
                    for (uint32 Index = 0; Index < 4; ++Index)
                    {
                        LifetimeTargets[Index] = Target(RHI, Cmd, 64, 64);
                        Raw[Index] = LifetimeTargets[Index];
                    }
                    const auto DefaultPrimitive = FillConstants(*PrimitiveLayout, LifetimeConfig, false);
                    RHI.RHIUpdateUniformBuffer(Cmd, Primitive, DefaultPrimitive.GetData());
                    Cmd.BeginRenderPass(FRHIRenderPassInfo(4, Raw, ERenderTargetActions::Clear_Store),
                                        TEXT("ResourceLifetime"));
                    Draw(Cmd, LifetimeConfig, View, Primitive, OwnedUniform);
                    Cmd.EndRenderPass();
                }
                RHI.SubmitCurrent();
                CheckTargets(
                    TEXT("resource-table-resource-lifetime"), LifetimeTargets,
                    [&](int32 X, int32 Y) { return Expected(Material, LifetimeConfig, X, Y); }, false);
            }
        }
    }
    auto Report = MakeShared<FJsonObject>();
    if (StaticView)
        Record(TEXT("static-view-used-by-real-material-draws"), RHI.StaticUniformResolutions > StartStaticResolutions);
    Report->SetBoolField(TEXT("pass"), Pass);
    Report->SetBoolField(TEXT("staticViewBindingVerified"), StaticView && Pass);
    Report->SetNumberField(TEXT("staticUniformResolutions"), RHI.StaticUniformResolutions - StartStaticResolutions);
    Report->SetStringField(TEXT("profile"), TEXT("WebVertexInput"));
    Report->SetStringField(TEXT("uniformSource"),
                           TEXT("UE runtime layouts, shader metadata, FillUniformBuffer artifacts"));
    Report->SetStringField(TEXT("vertexSource"),
                           TEXT("FLocalVertexFactory compiled shaders; explicit UE float vertex streams"));
    Report->SetBoolField(TEXT("fullLocalVertexFactoryImplemented"), false);
    Report->SetBoolField(TEXT("uniformViewImplemented"), false);
    Report->SetNumberField(TEXT("shaderCount"), 4);
    Report->SetNumberField(TEXT("pipelineCount"), 2);
    Report->SetNumberField(TEXT("draws"), RHI.Draws - StartDraws);
    Report->SetNumberField(TEXT("bindGroups"), RHI.BoundGroups - StartGroups);
    Report->SetNumberField(TEXT("resourceTableBindings"), RHI.ResourceTableBindings - StartTables);
    Report->SetNumberField(TEXT("checkedValues"), Checked);
    Report->SetArrayField(TEXT("checks"), Checks);
    return Report;
}
