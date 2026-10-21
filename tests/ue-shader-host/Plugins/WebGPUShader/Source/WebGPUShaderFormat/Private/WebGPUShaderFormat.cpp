#include "WebGPUShaderCode.h"

#include "Dom/JsonObject.h"
#include "GlobalShader.h"
#include "RenderUtils.h"
#include "DataDrivenShaderPlatformInfo.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/IShaderFormatModule.h"
#include "Internationalization/Regex.h"
#include "Misc/CommandLine.h"
#include "Misc/Crc.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/MemoryReader.h"
#include "Serialization/MemoryWriter.h"
#include "ShaderCompilerCommon.h"
#include "ShaderCompilerCore.h"
#include "ShaderConductorContext.h"
#include "ShaderPreprocessTypes.h"
#include "SpirvReflectCommon.h"
#include "VulkanShaderResources.h"

namespace UE::WebGPUShader
{
bool Decode(TConstArrayView<uint8> Bytes, FPayload &Payload, FString &Error)
{
    if (Bytes.Num() < HeaderBytes)
    {
        Error = TEXT("Web shader header truncated");
        return false;
    }
    uint32 Header[7];
    FMemory::Memcpy(Header, Bytes.GetData(), sizeof(Header));
    if (Header[0] != Magic || Header[1] != Schema || Header[2] != HeaderBytes ||
        static_cast<uint64>(HeaderBytes) + Header[5] + Header[6] != static_cast<uint64>(Bytes.Num()))
    {
        Error = TEXT("Web shader magic, schema or lengths invalid");
        return false;
    }
    Payload.Frequency = Header[3];
    Payload.FormatVersion = Header[4];
    const UTF8CHAR *Utf8 = reinterpret_cast<const UTF8CHAR *>(Bytes.GetData() + HeaderBytes);
    Payload.MetadataJson = FString(FUTF8ToTCHAR(Utf8, Header[5]));
    Payload.Wgsl = FString(FUTF8ToTCHAR(Utf8 + Header[5], Header[6]));
    return true;
}
} // namespace UE::WebGPUShader

static TSharedRef<FJsonObject> ReflectBlock(const SpvReflectBlockVariable &Block)
{
    TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetStringField(TEXT("name"), UTF8_TO_TCHAR(Block.name ? Block.name : ""));
    Json->SetNumberField(TEXT("offset"), Block.offset);
    Json->SetNumberField(TEXT("size"), Block.size);
    Json->SetNumberField(TEXT("paddedSize"), Block.padded_size);
    Json->SetNumberField(TEXT("arrayStride"), Block.array.stride);
    Json->SetNumberField(TEXT("matrixStride"), Block.numeric.matrix.stride);
    TArray<TSharedPtr<FJsonValue>> Dimensions, Members;
    for (uint32 Index = 0; Index < Block.array.dims_count; ++Index)
    {
        Dimensions.Add(MakeShared<FJsonValueNumber>(Block.array.dims[Index]));
    }
    for (uint32 Index = 0; Index < Block.member_count; ++Index)
    {
        Members.Add(MakeShared<FJsonValueObject>(ReflectBlock(Block.members[Index])));
    }
    Json->SetArrayField(TEXT("arrayDimensions"), Dimensions);
    Json->SetArrayField(TEXT("members"), Members);
    return Json;
}

static bool ValidateResourceOnlyUniform(const FJsonObject &Metadata, const FJsonObject &Parameter)
{
    const int32 Slot = Parameter.GetIntegerField(TEXT("bufferIndex"));
    if (Slot < 0 || Slot >= 32 || Parameter.GetIntegerField(TEXT("size")) != 0 ||
        Parameter.GetIntegerField(TEXT("baseIndex")) != 0)
        return false;
    const auto Table = Metadata.GetObjectField(TEXT("resourceTable"));
    const uint32 Bits = uint32(Table->GetNumberField(TEXT("bits")));
    const auto &Hashes = Table->GetArrayField(TEXT("layoutHashes"));
    if (!(Bits & (1u << Slot)) || !Hashes.IsValidIndex(Slot) || Hashes[Slot]->AsNumber() == 0)
        return false;
    const auto &Resources = Metadata.GetArrayField(TEXT("uniformResourceEntries"));
    const auto &Bindings = Metadata.GetArrayField(TEXT("spirvBindings"));
    const FString UniformName = Parameter.GetStringField(TEXT("name"));
    const int32 HeaderSize = 32 - FMath::CountLeadingZeros(Bits);
    TSet<FString> Mapped;
    for (const TCHAR *MapName : {TEXT("textures"), TEXT("samplers"), TEXT("srvs"), TEXT("uavs")})
    {
        const auto &Stream = Table->GetArrayField(MapName);
        if (Stream.IsEmpty())
            continue;
        if (!Stream.IsValidIndex(Slot) || uint32(Stream.Last()->AsNumber()) != FRHIResourceTableEntry::GetEndOfStreamToken())
            return false;
        int32 Cursor = int32(Stream[Slot]->AsNumber());
        if (Cursor == 0)
            continue;
        if (Cursor < HeaderSize || !Stream.IsValidIndex(Cursor) ||
            FRHIResourceTableEntry::GetUniformBufferIndex(uint32(Stream[Cursor]->AsNumber())) != Slot)
            return false;
        for (; Stream.IsValidIndex(Cursor); ++Cursor)
        {
            const uint32 Token = uint32(Stream[Cursor]->AsNumber());
            if (FRHIResourceTableEntry::GetUniformBufferIndex(Token) != Slot)
                break;
            const auto *ResourceValue = Resources.FindByPredicate([&](const auto &Value) {
                const auto Resource = Value->AsObject();
                return Resource->GetStringField(TEXT("uniformBuffer")) == UniformName &&
                       Resource->GetIntegerField(TEXT("resourceIndex")) == FRHIResourceTableEntry::GetResourceIndex(Token);
            });
            if (!ResourceValue)
                return false;
            const auto Resource = (*ResourceValue)->AsObject();
            const int32 Type = Resource->GetIntegerField(TEXT("type"));
            const FString Name = Resource->GetStringField(TEXT("name"));
            const auto *BindingValue = Bindings.FindByPredicate([&Name](const auto &Value) {
                return Value->AsObject()->GetStringField(TEXT("name")) == Name;
            });
            if (!BindingValue || Mapped.Contains(Name))
                return false;
            const auto Binding = (*BindingValue)->AsObject();
            const int32 Descriptor = Binding->GetIntegerField(TEXT("descriptorType"));
            const bool Compatible =
                (FCString::Strcmp(MapName, TEXT("textures")) == 0 &&
                 (Type == UBMT_TEXTURE || Type == UBMT_RDG_TEXTURE) && Descriptor == 2) ||
                (FCString::Strcmp(MapName, TEXT("samplers")) == 0 && Type == UBMT_SAMPLER && Descriptor == 0) ||
                (FCString::Strcmp(MapName, TEXT("srvs")) == 0 &&
                 (Type == UBMT_SRV || Type == UBMT_RDG_TEXTURE_SRV || Type == UBMT_RDG_TEXTURE_NON_PIXEL_SRV ||
                  Type == UBMT_RDG_BUFFER_SRV) && (Descriptor == 2 || Descriptor == 7)) ||
                (FCString::Strcmp(MapName, TEXT("uavs")) == 0 &&
                 (Type == UBMT_UAV || Type == UBMT_RDG_TEXTURE_UAV || Type == UBMT_RDG_BUFFER_UAV) &&
                 (Descriptor == 3 || Descriptor == 7));
            if (!Compatible || Binding->GetIntegerField(TEXT("binding")) != FRHIResourceTableEntry::GetBindIndex(Token))
                return false;
            Mapped.Add(Name);
        }
    }
    // Unused uniform members need no token; every surviving descriptor does.
    for (const auto &Value : Resources)
    {
        const auto Resource = Value->AsObject();
        const FString Name = Resource->GetStringField(TEXT("name"));
        if (Resource->GetStringField(TEXT("uniformBuffer")) == UniformName &&
            Bindings.ContainsByPredicate([&Name](const auto &Binding) {
                return Binding->AsObject()->GetStringField(TEXT("name")) == Name;
            }) && !Mapped.Contains(Name))
            return false;
    }
    return !Mapped.IsEmpty();
}

bool UE::WebGPUShader::ValidateBindings(const TSharedRef<FJsonObject> &Metadata,
                                      const TSharedPtr<FJsonObject> &Reflection, FString &Error)
{
    const auto Fail = [&Error](const FString &Message) {
        Error = TEXT("Binding contract: ") + Message;
        return false;
    };
    const auto &Entries = Reflection->GetArrayField(TEXT("entry_points"));
    if (Entries.Num() != 1)
        return Fail(TEXT("expected one entry point"));
    const auto Entry = Entries[0]->AsObject();
    if (Entry->GetStringField(TEXT("name")) != Metadata->GetStringField(TEXT("webEntry")))
        return Fail(TEXT("entry point changed"));
    const auto &WebBindings = Entry->GetArrayField(TEXT("bindings"));
    const auto &NativeBindings = Metadata->GetArrayField(TEXT("spirvBindings"));
    if (WebBindings.Num() != NativeBindings.Num())
        return Fail(TEXT("descriptor count changed"));
    for (const auto &Value : NativeBindings)
    {
        const auto Native = Value->AsObject();
        const auto *Found = WebBindings.FindByPredicate([&Native](const auto &Candidate) {
            const auto Web = Candidate->AsObject();
            return Web->GetNumberField(TEXT("group")) == Native->GetNumberField(TEXT("group")) &&
                   Web->GetNumberField(TEXT("binding")) == Native->GetNumberField(TEXT("binding"));
        });
        if (!Found)
            return Fail(TEXT("descriptor location missing"));
        const auto Web = (*Found)->AsObject();
        const int32 Type = Native->GetIntegerField(TEXT("descriptorType"));
        const FString WebType = Web->GetStringField(TEXT("resource_type"));
        const bool Compatible =
            (Type == 0 && WebType == TEXT("Sampler")) || (Type == 2 && WebType == TEXT("SampledTexture")) ||
            (Type == 3 && (WebType == TEXT("ReadWriteStorageTexture") || WebType == TEXT("WriteOnlyStorageTexture"))) ||
            (Type == 6 && WebType == TEXT("UniformBuffer")) ||
            (Type == 7 && (WebType == TEXT("StorageBuffer") || WebType == TEXT("ReadOnlyStorageBuffer")));
        if (!Compatible)
            return Fail(TEXT("descriptor type changed"));
        if (Type == 2)
        {
            const FString SampleType = Native->GetStringField(TEXT("textureSampleType"));
            const FString WebSampleType = Web->GetStringField(TEXT("sampled_kind"));
            if (!((SampleType == TEXT("float") &&
                   (WebSampleType == TEXT("Float") || WebSampleType == TEXT("unknown-filterable"))) ||
                  (SampleType == TEXT("uint") && WebSampleType == TEXT("Uint")) ||
                  (SampleType == TEXT("sint") && WebSampleType == TEXT("Sint"))))
                return Fail(TEXT("sampled texture scalar type changed"));
        }
        if (Type == 6)
        {
            if (Web->GetNumberField(TEXT("size")) > Native->GetNumberField(TEXT("paddedSize")))
                return Fail(TEXT("uniform allocation too small"));
            const bool LayoutMatches =
                Reflection->GetArrayField(TEXT("structures")).ContainsByPredicate([&Native](const auto &Structure) {
                    const auto &WebMembers = Structure->AsObject()->GetArrayField(TEXT("members"));
                    for (const auto &MemberValue : Native->GetArrayField(TEXT("members")))
                    {
                        const auto Member = MemberValue->AsObject();
                        if (!Member->GetArrayField(TEXT("members")).IsEmpty())
                            return false;
                        if (!WebMembers.ContainsByPredicate([&Member](const auto &Candidate) {
                                const auto WebMember = Candidate->AsObject();
                                const double Size = WebMember->GetNumberField(TEXT("size"));
                                return WebMember->GetStringField(TEXT("name")) ==
                                           Member->GetStringField(TEXT("name")) &&
                                       WebMember->GetNumberField(TEXT("offset")) ==
                                           Member->GetNumberField(TEXT("offset")) &&
                                       Size >= Member->GetNumberField(TEXT("size")) &&
                                       Size <= Member->GetNumberField(TEXT("paddedSize"));
                            }))
                            return false;
                    }
                    return true;
                });
            if (!LayoutMatches)
                return Fail(TEXT("uniform member offsets or storage sizes changed"));
        }
    }
    for (const auto &Value : Metadata->GetArrayField(TEXT("ueParameterMap")))
    {
        const auto Parameter = Value->AsObject();
        const int32 Type = Parameter->GetIntegerField(TEXT("type"));
        const FString Name = Type == 0 ? TEXT("$Globals") : Parameter->GetStringField(TEXT("name"));
        const auto *BindingValue = NativeBindings.FindByPredicate(
            [&Name](const auto &Candidate) { return Candidate->AsObject()->GetStringField(TEXT("name")) == Name; });
        if (!BindingValue && Type == int32(EShaderParameterType::UniformBuffer) &&
            ValidateResourceOnlyUniform(*Metadata, *Parameter))
            continue;
        if (!BindingValue)
            return Fail(TEXT("parameter descriptor missing"));
        const auto Binding = (*BindingValue)->AsObject();
        if (Binding->GetNumberField(TEXT("binding")) !=
            Parameter->GetNumberField(Type == 0 || Type == 1 ? TEXT("bufferIndex") : TEXT("baseIndex")))
            return Fail(TEXT("parameter allocation changed"));
        if (Type == 0 &&
            !Binding->GetArrayField(TEXT("members")).ContainsByPredicate([&Parameter](const auto &Candidate) {
                const auto Member = Candidate->AsObject();
                return Member->GetStringField(TEXT("name")) == Parameter->GetStringField(TEXT("name")) &&
                       Member->GetNumberField(TEXT("offset")) == Parameter->GetNumberField(TEXT("baseIndex")) &&
                       Member->GetNumberField(TEXT("size")) == Parameter->GetNumberField(TEXT("size"));
            }))
            return Fail(TEXT("loose parameter layout changed"));
    }
    return true;
}

class FWebGPUShaderFormat final : public IShaderFormat
{
  public:
    FWebGPUShaderFormat()
    {
        FDataDrivenShaderPlatformInfo::Initialize();
        Native = FModuleManager::LoadModuleChecked<IShaderFormatModule>(TEXT("VulkanShaderFormat")).GetShaderFormat();
    }

    virtual void GetSupportedFormats(TArray<FName> &Formats) const override
    {
        Formats.Add(UE::WebGPUShader::ES31Format);
        Formats.Add(UE::WebGPUShader::SM5Format);
    }

    virtual uint32 GetVersion(FName Format) const override
    {
        uint32 Version = HashCombine(Native->GetVersion(NativeFormat(Format)), UE::WebGPUShader::Schema);
        Version = HashCombine(
            Version,
            FCrc::StrCrc32(TEXT("WebGPUShaderFormat-20261021-v18-FullCloudDensity-StructuredView-Tint-v20261009.190412")));
        const EShaderPlatform Platform = ShaderFormatToLegacyShaderPlatform(Format);
        return Platform != SP_NumPlatforms && FDataDrivenShaderPlatformInfo::IsValid(Platform)
                   ? HashCombine(Version, FDataDrivenShaderPlatformInfo::GetShaderPlatformPropertiesHash(Platform))
                   : Version;
    }

    virtual const TCHAR *GetPlatformIncludeDirectory() const override
    {
        return TEXT("Vulkan");
    }

    virtual void AppendToKeyString(FString &Key) const override
    {
        Key += TEXT("_WebGPUShaderSchema1_DefaultTemplateSkyStructuredView16_Tint20261009.190412_Uncompressed1");
    }

    virtual void ModifyShaderCompilerInput(FShaderCompilerInput &Input) const override
    {
        const FName WebFormat = Input.ShaderFormat;
        Input.ShaderFormat = NativeFormat(WebFormat);
        Native->ModifyShaderCompilerInput(Input);
        Input.ShaderFormat = WebFormat;
        // Loose Web archives use the engine's uncompressed entry format; no browser Oodle decoder is required.
        Input.CompressionFormat = NAME_None;
        Input.Environment.SetDefine(TEXT("COMPILER_WEBGPU"), 1);
    }

    virtual bool PreprocessShader(const FShaderCompilerInput &Input, const FShaderCompilerEnvironment &Environment,
                                  FShaderPreprocessOutput &Output) const override
    {
        FShaderCompilerInput NativeInput = Input;
        NativeInput.ShaderFormat = NativeFormat(Input.ShaderFormat);
        const bool Succeeded = Native->PreprocessShader(NativeInput, Environment, Output);
        if (Succeeded)
        {
            // View's installed native metadata declares a texel buffer; Web uses a float4 storage array.
            FString Source(Output.GetSourceView());
            const FRegexPattern Declaration(
                TEXT("\\bBuffer<float4>\\s+View_MobileDistantSkyLightLutBufferSRV\\s*;"));
            FRegexMatcher Match(Declaration, Source);
            if (Match.FindNext())
            {
                Source.InsertAt(Match.GetMatchBeginning(), TEXT("Structured"));
                Output.EditSource() = FAnsiString(Source);
            }
        }
        return Succeeded;
    }

    virtual void CompilePreprocessedShader(const FShaderCompilerInput &Input,
                                           const FShaderPreprocessOutput &Preprocessed,
                                           FShaderCompilerOutput &Output) const override
    {
        RecordCookInventory(Input);
        const bool bCloudShader = Input.GenerateShaderName().Contains(TEXT("FCloudRenderViewPS"));
        if (bCloudShader)
        {
            FFileHelper::SaveStringToFile(FString(Preprocessed.GetSourceView()),
                *(NewDiagnosticDirectory() / TEXT("cloud-preprocessed.hlsl")));
        }
        FShaderCompilerInput NativeInput = Input;
        NativeInput.ShaderFormat = NativeFormat(Input.ShaderFormat);
        Native->CompilePreprocessedShader(NativeInput, Preprocessed, Output);
        if (!Output.bSucceeded)
        {
            FString Errors;
            for (const FShaderCompilerError& Diagnostic : Output.Errors)
                Errors += Diagnostic.StrippedErrorMessage + TEXT("\n");
            RecordFailure(Input, TEXT("Native compilation: ") + Errors, FString());
            return;
        }

        FString Error, DiagnosticDirectory;
        TArray<uint8> Payload;
        if (!Convert(Input, Output, Payload, Error, DiagnosticDirectory))
        {
            FFileHelper::SaveStringToFile(FString(Preprocessed.GetSourceView()),
                *(DiagnosticDirectory / TEXT("preprocessed.hlsl")));
            Output.bSucceeded = false;
            FShaderCompilerError Diagnostic;
            Diagnostic.StrippedErrorMessage = TEXT("WebGPU conversion: ") + Error;
            Output.Errors.Add(MoveTemp(Diagnostic));
            Output.ShaderCode = FShaderCode();
            RecordFailure(Input, Error, DiagnosticDirectory);
            return;
        }
        const FShaderCodeReader NativeReader(Output.ShaderCode.GetReadView());
        FShaderCodePackedResourceCounts Counts{};
        const FShaderCodePackedResourceCounts *NativeCounts =
            NativeReader.FindOptionalData<FShaderCodePackedResourceCounts>();
        if (NativeCounts)
            Counts = *NativeCounts;
        Output.ShaderCode = FShaderCode();
        Output.ShaderCode.GetWriteAccess() = MoveTemp(Payload);
        if (NativeCounts)
            Output.ShaderCode.AddOptionalData(Counts);
    }

  private:
    const IShaderFormat *Native;
    static FName NativeFormat(FName Format)
    {
        check(Format == UE::WebGPUShader::ES31Format || Format == UE::WebGPUShader::SM5Format);
        return Format == UE::WebGPUShader::ES31Format ? FName(TEXT("SF_VULKAN_ES31")) : FName(TEXT("SF_VULKAN_SM5"));
    }

    static FString NewDiagnosticDirectory()
    {
        FString Root = FPlatformMisc::GetEnvironmentVariable(TEXT("WEBGPU_INTERMEDIATE_DIR"));
        if (Root.IsEmpty())
            Root = FPaths::ProjectIntermediateDir() / TEXT("WebGPUShader");
        const FString Directory = Root / FGuid::NewGuid().ToString();
        IFileManager::Get().MakeDirectory(*Directory, true);
        return Directory;
    }

    static void RecordCookInventory(const FShaderCompilerInput& Input)
    {
        if (!FParse::Param(FCommandLine::Get(), TEXT("WebGPUCook")))
            return;
        static FCriticalSection Mutex;
        static TSet<FName> RecordedFormats;
        FScopeLock Lock(&Mutex);
        if (RecordedFormats.Contains(Input.ShaderFormat))
            return;
        RecordedFormats.Add(Input.ShaderFormat);
        const EShaderPlatform Platform = Input.Target.GetPlatform();
        TSharedRef<FJsonObject> Inventory = MakeShared<FJsonObject>();
        Inventory->SetStringField(TEXT("format"), Input.ShaderFormat.ToString());
        Inventory->SetStringField(TEXT("platform"), FDataDrivenShaderPlatformInfo::GetPlatformName(Platform).ToString());
        Inventory->SetNumberField(TEXT("platformEnum"), Platform);
        Inventory->SetNumberField(TEXT("propertiesHash"), FDataDrivenShaderPlatformInfo::GetShaderPlatformPropertiesHash(Platform));
        Inventory->SetBoolField(TEXT("mobile"), IsMobilePlatform(Platform));
        Inventory->SetBoolField(TEXT("supportsGeometryShaders"), RHISupportsGeometryShaders(Platform));
        Inventory->SetBoolField(TEXT("gpuSceneEnabled"), UseGPUScene(Platform));
        TSharedRef<FJsonObject> MaterialPolicy = MakeShared<FJsonObject>();
        MaterialPolicy->SetBoolField(TEXT("dbuffer"), IsUsingDBuffers(Platform));
        MaterialPolicy->SetBoolField(TEXT("substrateBlendable"), Substrate::IsSubstrateBlendableGBufferEnabled(Platform));
        MaterialPolicy->SetBoolField(TEXT("mobileDeferred"), IsMobileDeferredShadingEnabled(Platform));
        MaterialPolicy->SetBoolField(TEXT("fullDepthPrepass"), MobileUsesFullDepthPrepass(Platform));
        Inventory->SetObjectField(TEXT("materialPolicy"), MaterialPolicy);
        TSharedRef<FJsonObject> Settings = MakeShared<FJsonObject>();
        const TCHAR* SettingNames[] = {
            TEXT("r.Mobile.ShadingPath"), TEXT("r.MobileHDR"), TEXT("r.Mobile.AntiAliasing"),
            TEXT("r.Mobile.DBuffer"), TEXT("r.Mobile.EarlyZPass"), TEXT("r.Substrate"),
            TEXT("r.Mobile.SupportsGen4TAA"), TEXT("r.Mobile.AllowFramebufferFetch"),
            TEXT("r.Mobile.Forward.EnableLocalLights"), TEXT("r.Mobile.Forward.EnableClusteredReflections"),
            TEXT("r.Mobile.DisableVertexFog"), TEXT("r.SupportSkyAtmosphere"), TEXT("r.SupportLocalFogVolumes"),
            TEXT("r.VolumetricCloud.Support"), TEXT("r.VolumetricCloud"), TEXT("r.VolumetricRenderTarget"),
            TEXT("r.VolumetricCloud.DisableCompute"), TEXT("r.VolumetricCloud.ShadowMap"),
            TEXT("r.VolumetricCloud.SkyAO"), TEXT("r.VolumetricCloud.Shadow.SampleAtmosphericLightShadowmap"),
            TEXT("r.VolumetricCloud.HighQualityAerialPerspective"),
            TEXT("r.VolumetricFog"), TEXT("r.AllowStaticLighting"), TEXT("r.VirtualTextures"),
            TEXT("landscape.SupportGPUCulling"), TEXT("r.Mobile.SupportGPUScene"),
            TEXT("r.GPUSkin.UseSceneExtension")
        };
        const FName TargetPlatform = FDataDrivenShaderPlatformInfo::GetPlatformName(Platform);
        for (const TCHAR* Name : SettingNames)
        {
            IConsoleVariable* Variable = IConsoleManager::Get().FindConsoleVariable(Name);
            TSharedRef<FJsonObject> Values = MakeShared<FJsonObject>();
            if (Variable)
            {
                Values->SetStringField(TEXT("host"), Variable->GetString());
#if ALLOW_OTHER_PLATFORM_CONFIG
                TSharedPtr<IConsoleVariable> Target = Variable->GetPlatformValueVariable(TargetPlatform);
                if (Target)
                    Values->SetStringField(TEXT("target"), Target->GetString());
#endif
            }
            Settings->SetObjectField(Name, Values);
        }
        Inventory->SetObjectField(TEXT("settings"), Settings);
        TArray<TSharedPtr<FJsonValue>> Types;
        uint32 RegisteredTypes = 0, CompiledTypes = 0, Permutations = 0;
        for (TLinkedList<FShaderType*>::TIterator Iterator(FShaderType::GetTypeList()); Iterator; ++Iterator)
        {
            FGlobalShaderType* Type = (*Iterator)->GetGlobalShaderType();
            if (!Type)
                continue;
            ++RegisteredTypes;
            uint32 Count = 0;
            Type->ForEachCompiledPermutation(Platform, EShaderPermutationFlags::None, [&Count](int32) {
                ++Count;
                return true;
            });
            TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("name"), Type->GetName());
            Item->SetStringField(TEXT("source"), Type->GetShaderFilename());
            Item->SetNumberField(TEXT("frequency"), Type->GetFrequency());
            Item->SetNumberField(TEXT("permutations"), Count);
            Types.Add(MakeShared<FJsonValueObject>(Item));
            CompiledTypes += Count != 0;
            Permutations += Count;
        }
        Inventory->SetArrayField(TEXT("types"), Types);
        Inventory->SetNumberField(TEXT("registeredTypes"), RegisteredTypes);
        Inventory->SetNumberField(TEXT("compiledTypes"), CompiledTypes);
        Inventory->SetNumberField(TEXT("permutations"), Permutations);
        Inventory->SetStringField(TEXT("boundary"), TEXT("Read-only enumeration of the loaded native shader types using their real Cook permutation predicates. No jobs are filtered, altered or counted as successfully compiled."));
        FString Json;
        FJsonSerializer::Serialize(Inventory, TJsonWriterFactory<>::Create(&Json));
        FString Root = FPlatformMisc::GetEnvironmentVariable(TEXT("WEBGPU_INTERMEDIATE_DIR"));
        check(!Root.IsEmpty());
        IFileManager::Get().MakeDirectory(*Root, true);
        FFileHelper::SaveStringToFile(Json, *(Root / TEXT("inventory.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
        UE_LOG(LogTemp, Display, TEXT("WEB_SHADER_INVENTORY: format=%s types=%u/%u permutations=%u mobile=%d"),
            *Input.ShaderFormat.ToString(), CompiledTypes, RegisteredTypes, Permutations, IsMobilePlatform(Platform));
    }

    static void RecordFailure(const FShaderCompilerInput& Input, const FString& Error, FString Directory)
    {
        if (Directory.IsEmpty())
            Directory = NewDiagnosticDirectory();
        TSharedRef<FJsonObject> Diagnostic = MakeShared<FJsonObject>();
        Diagnostic->SetStringField(TEXT("shader"), Input.GenerateShaderName());
        Diagnostic->SetStringField(TEXT("shaderName"), Input.ShaderName);
        Diagnostic->SetStringField(TEXT("description"), Input.DebugDescription);
        Diagnostic->SetStringField(TEXT("source"), Input.VirtualSourceFilePath);
        Diagnostic->SetStringField(TEXT("entryPoint"), Input.EntryPointName);
        Diagnostic->SetStringField(TEXT("format"), Input.ShaderFormat.ToString());
        Diagnostic->SetStringField(TEXT("error"), Error);
        FString Json;
        FJsonSerializer::Serialize(Diagnostic, TJsonWriterFactory<>::Create(&Json));
        FFileHelper::SaveStringToFile(Json, *(Directory / TEXT("failure.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
        UE_LOG(LogTemp, Warning, TEXT("WEB_SHADER_FAILURE: %s; %s; artifacts=%s; %s"),
            *Input.GenerateShaderName(), *Input.DebugDescription, *Directory, *Error);
        if (FParse::Param(FCommandLine::Get(), TEXT("WebGPUStopOnShaderError")))
            FPlatformMisc::RequestExitWithStatus(true, 3, TEXT("WebGPUStopOnShaderError"));
    }

    bool Convert(const FShaderCompilerInput &Input, FShaderCompilerOutput &NativeOutput, TArray<uint8> &Payload,
                 FString &Error, FString &DiagnosticDirectory) const
    {
        DiagnosticDirectory = NewDiagnosticDirectory();
        const TConstArrayView<uint8> Code = NativeOutput.ShaderCode.GetReadView();
        TArray<uint8> NativeBytes(Code.GetData(), NativeOutput.ShaderCode.GetShaderCodeSize());
        FMemoryReader Reader(NativeBytes, true);
        FVulkanShaderHeader Header;
        FShaderResourceTable Table;
        uint32 SpirvSize = 0;
        Reader << Header << Table << SpirvSize;
        if (Reader.IsError() || SpirvSize % 4 || SpirvSize > NativeBytes.Num() - Reader.Tell())
        {
            Error = TEXT("Invalid native Vulkan payload");
            return false;
        }
        TArray<uint32> Spirv;
        Spirv.SetNumUninitialized(SpirvSize / 4);
        Reader.Serialize(Spirv.GetData(), SpirvSize);
        spv_reflect::ShaderModule Reflection(SpirvSize, Spirv.GetData());
        if (Reflection.GetResult() != SPV_REFLECT_RESULT_SUCCESS)
        {
            Error = TEXT("SPIR-V reflection failed");
            return false;
        }
        TSharedRef<FJsonObject> Metadata = MakeShared<FJsonObject>();
        Metadata->SetNumberField(TEXT("schema"), UE::WebGPUShader::Schema);
        Metadata->SetStringField(TEXT("format"), Input.ShaderFormat.ToString());
        Metadata->SetStringField(TEXT("nativeFormat"), NativeInputFormat(Input.ShaderFormat));
        Metadata->SetNumberField(TEXT("formatVersion"), GetVersion(Input.ShaderFormat));
        Metadata->SetNumberField(TEXT("frequency"), Input.Target.GetFrequency());
        const EShaderPlatform Platform = Input.Target.GetPlatform();
        Metadata->SetNumberField(TEXT("shaderPlatformEnum"), Platform);
        Metadata->SetStringField(TEXT("shaderPlatform"), FDataDrivenShaderPlatformInfo::GetName(Platform).ToString());
        Metadata->SetNumberField(TEXT("shaderPlatformPropertiesHash"),
                                 FDataDrivenShaderPlatformInfo::GetShaderPlatformPropertiesHash(Platform));
        Metadata->SetStringField(TEXT("webEntry"), UTF8_TO_TCHAR(Reflection.GetEntryPointName()));
        Metadata->SetNumberField(TEXT("packedGlobalsSize"), Header.PackedGlobalsSize);
        uint32 Count = 0;
        Reflection.EnumerateDescriptorBindings(&Count, nullptr);
        TArray<SpvReflectDescriptorBinding *> NativeBindings;
        NativeBindings.SetNumUninitialized(Count);
        Reflection.EnumerateDescriptorBindings(&Count, NativeBindings.GetData());
        TArray<TSharedPtr<FJsonValue>> Bindings, Parameters, Resources;
        for (const SpvReflectDescriptorBinding *Binding : NativeBindings)
        {
            TSharedRef<FJsonObject> Json = ReflectBlock(Binding->block);
            Json->SetStringField(TEXT("name"), UTF8_TO_TCHAR(Binding->name ? Binding->name : ""));
            Json->SetNumberField(TEXT("group"), Binding->set);
            Json->SetNumberField(TEXT("binding"), Binding->binding);
            Json->SetNumberField(TEXT("descriptorType"), Binding->descriptor_type);
            if (Binding->descriptor_type == SPV_REFLECT_DESCRIPTOR_TYPE_SAMPLED_IMAGE ||
                Binding->descriptor_type == SPV_REFLECT_DESCRIPTOR_TYPE_STORAGE_IMAGE)
            {
                Json->SetNumberField(TEXT("textureDimension"), Binding->image.dim);
                Json->SetBoolField(TEXT("textureArrayed"), Binding->image.arrayed != 0);
                Json->SetBoolField(TEXT("textureMultisampled"), Binding->image.ms != 0);
                if (Binding->descriptor_type == SPV_REFLECT_DESCRIPTOR_TYPE_STORAGE_IMAGE)
                    Json->SetNumberField(TEXT("storageImageFormat"), Binding->image.image_format);
                const auto *Type = Binding->type_description;
                if (!Type || Type->traits.numeric.scalar.width != 32 ||
                    !(Type->type_flags & (SPV_REFLECT_TYPE_FLAG_FLOAT | SPV_REFLECT_TYPE_FLAG_INT)))
                {
                    Error = TEXT("Sampled texture scalar type is not supported");
                    return false;
                }
                Json->SetStringField(TEXT("textureSampleType"),
                                     (Type->type_flags & SPV_REFLECT_TYPE_FLAG_FLOAT) ? TEXT("float")
                                     : Type->traits.numeric.scalar.signedness         ? TEXT("sint")
                                                                                      : TEXT("uint"));
            }
            if (Binding->descriptor_type == SPV_REFLECT_DESCRIPTOR_TYPE_STORAGE_BUFFER)
            {
                const auto &Block = Binding->block;
                const bool ReadOnly = (Block.decoration_flags & SPV_REFLECT_DECORATION_NON_WRITABLE) ||
                                      (Block.member_count == 1 &&
                                       (Block.members[0].decoration_flags & SPV_REFLECT_DECORATION_NON_WRITABLE));
                Json->SetBoolField(TEXT("readOnlyStorage"), ReadOnly);
                if (Block.member_count == 1)
                {
                    const auto &Element = Block.members[0];
                    const auto *Type = Element.type_description;
                    if (Type && Type->traits.array.dims_count == 1 && Type->traits.array.dims[0] == 0 &&
                        Element.offset == 0 && Type->traits.array.stride > 0)
                        Json->SetNumberField(TEXT("storageElementStride"), Type->traits.array.stride);
                    if (Type && (Type->type_flags & SPV_REFLECT_TYPE_FLAG_INT) &&
                        !(Type->type_flags & (SPV_REFLECT_TYPE_FLAG_MATRIX | SPV_REFLECT_TYPE_FLAG_STRUCT)) &&
                        Type->traits.numeric.scalar.width == 32 && Type->traits.numeric.scalar.signedness == 0 &&
                        Type->traits.array.dims_count == 1 && Type->traits.array.dims[0] == 0 && Element.offset == 0 &&
                        Element.member_count == 0)
                    {
                        if (!(Type->type_flags & SPV_REFLECT_TYPE_FLAG_VECTOR) && Type->traits.array.stride == 4)
                            Json->SetNumberField(TEXT("storageElementFormat"), PF_R32_UINT);
                        else if ((Type->type_flags & SPV_REFLECT_TYPE_FLAG_VECTOR) &&
                                 Type->traits.numeric.vector.component_count == 4 && Type->traits.array.stride == 16)
                            Json->SetNumberField(TEXT("storageElementFormat"), PF_R32G32B32A32_UINT);
                    }
                    if (Type && (Type->type_flags & SPV_REFLECT_TYPE_FLAG_FLOAT) &&
                        (Type->type_flags & SPV_REFLECT_TYPE_FLAG_VECTOR) &&
                        !(Type->type_flags & (SPV_REFLECT_TYPE_FLAG_MATRIX | SPV_REFLECT_TYPE_FLAG_STRUCT)) &&
                        Type->traits.numeric.scalar.width == 32 && Type->traits.numeric.vector.component_count == 4 &&
                        Type->traits.array.dims_count == 1 && Type->traits.array.dims[0] == 0 &&
                        Type->traits.array.stride == 16 && Element.offset == 0 && Element.member_count == 0)
                        Json->SetNumberField(TEXT("storageElementFormat"), PF_A32B32G32R32F);
                }
            }
            Bindings.Add(MakeShared<FJsonValueObject>(Json));
        }
        // The native backend removes static-only UBs from its per-shader parameter map.
        // Retain their stable layout hashes and slots in Web metadata for RHI static binding.
        FShaderParameterMap WebParameters = NativeOutput.ParameterMap;
        for (const auto& Uniform : Input.Environment.UniformBufferMap)
        {
            if (!EnumHasAnyFlags(Uniform.Value.BindingFlags, EUniformBufferBindingFlags::Static) ||
                !Uniform.Value.LayoutHash || WebParameters.GetParameterMap().Contains(Uniform.Key))
                continue;
            const int32 Slot = Table.ResourceTableLayoutHashes.IndexOfByKey(Uniform.Value.LayoutHash);
            if (Slot != INDEX_NONE)
                WebParameters.AddParameterAllocation(*Uniform.Key, Slot, 0, 0, EShaderParameterType::UniformBuffer);
        }
        for (const auto &Parameter : WebParameters.GetParameterMap())
        {
            TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
            Json->SetStringField(TEXT("name"), Parameter.Key);
            Json->SetNumberField(TEXT("bufferIndex"), Parameter.Value.BufferIndex);
            Json->SetNumberField(TEXT("baseIndex"), Parameter.Value.BaseIndex);
            Json->SetNumberField(TEXT("size"), Parameter.Value.Size);
            Json->SetNumberField(TEXT("type"), static_cast<uint8>(Parameter.Value.Type));
            Parameters.Add(MakeShared<FJsonValueObject>(Json));
        }
        for (const FUniformResourceEntry &Resource : Input.Environment.ResourceTableMap.Resources)
        {
            if (!WebParameters.GetParameterMap().Contains(FString(Resource.GetUniformBufferName())))
                continue;
            TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
            Json->SetStringField(TEXT("name"), Resource.UniformBufferMemberName);
            Json->SetStringField(TEXT("uniformBuffer"), FString(Resource.GetUniformBufferName()));
            Json->SetNumberField(TEXT("resourceIndex"), Resource.ResourceIndex);
            Json->SetNumberField(TEXT("type"), Resource.Type);
            Resources.Add(MakeShared<FJsonValueObject>(Json));
        }
        Metadata->SetArrayField(TEXT("spirvBindings"), Bindings);
        Metadata->SetArrayField(TEXT("ueParameterMap"), Parameters);
        Metadata->SetArrayField(TEXT("uniformResourceEntries"), Resources);
        const auto Values = [](const TArray<uint32> &Numbers) {
            TArray<TSharedPtr<FJsonValue>> Json;
            for (uint32 Number : Numbers)
                Json.Add(MakeShared<FJsonValueNumber>(Number));
            return Json;
        };
        TSharedRef<FJsonObject> TableJson = MakeShared<FJsonObject>();
        TableJson->SetNumberField(TEXT("bits"), Table.ResourceTableBits);
        TableJson->SetArrayField(TEXT("textures"), Values(Table.TextureMap));
        TableJson->SetArrayField(TEXT("samplers"), Values(Table.SamplerMap));
        TableJson->SetArrayField(TEXT("srvs"), Values(Table.ShaderResourceViewMap));
        TableJson->SetArrayField(TEXT("uavs"), Values(Table.UnorderedAccessViewMap));
        TableJson->SetArrayField(TEXT("layoutHashes"), Values(Table.ResourceTableLayoutHashes));
        Metadata->SetObjectField(TEXT("resourceTable"), TableJson);

        CrossCompiler::FShaderConductorContext Context;
        const ANSICHAR *Passes[] = {"--strip-reflect"};
        if (!Context.OptimizeSpirv(Spirv, Passes, UE_ARRAY_COUNT(Passes)))
        {
            Context.FlushErrors(NativeOutput.Errors);
            Error = TEXT("Reflection extension stripping failed");
            return false;
        }
        FString Tools = FPlatformMisc::GetEnvironmentVariable(TEXT("WEBGPU_TINT_DIR"));
        if (Tools.IsEmpty() || !FPaths::FileExists(Tools / TEXT("tint.exe")) ||
            !FPaths::FileExists(Tools / TEXT("tint_info.exe")))
        {
            Error = TEXT("WEBGPU_TINT_DIR must point to pinned Tint tools");
            return false;
        }
        const FString SpirvPath = DiagnosticDirectory / TEXT("input.spv"), WgslPath = DiagnosticDirectory / TEXT("output.wgsl");
        TSharedRef<FJsonObject> InputDiagnostic = MakeShared<FJsonObject>();
        InputDiagnostic->SetStringField(TEXT("shader"), Input.GenerateShaderName());
        InputDiagnostic->SetStringField(TEXT("shaderName"), Input.ShaderName);
        InputDiagnostic->SetStringField(TEXT("description"), Input.DebugDescription);
        InputDiagnostic->SetObjectField(TEXT("metadata"), Metadata);
        FString InputJson;
        FJsonSerializer::Serialize(InputDiagnostic, TJsonWriterFactory<>::Create(&InputJson));
        FFileHelper::SaveStringToFile(InputJson, *(DiagnosticDirectory / TEXT("input.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
        FFileHelper::SaveArrayToFile(MakeArrayView(reinterpret_cast<const uint8 *>(Spirv.GetData()), Spirv.Num() * 4),
                                     *SpirvPath);
        int32 ExitCode = -1;
        FString StandardOut, StandardError, Wgsl;
        const bool Executed = FPlatformProcess::ExecProcess(
            *(Tools / TEXT("tint.exe")),
            *FString::Printf(TEXT("\"%s\" --format wgsl -o \"%s\""), *SpirvPath, *WgslPath), &ExitCode, &StandardOut,
            &StandardError);
        if (!Executed || ExitCode != 0 || !FFileHelper::LoadFileToString(Wgsl, *WgslPath))
        {
            Error = StandardOut + StandardError;
            return false;
        }
        StandardOut.Reset();
        StandardError.Reset();
        FPlatformProcess::ExecProcess(*(Tools / TEXT("tint_info.exe")),
                                      *FString::Printf(TEXT("--json \"%s\""), *WgslPath), &ExitCode, &StandardOut,
                                      &StandardError);
        TSharedPtr<FJsonObject> WebReflection;
        if (ExitCode != 0 || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(StandardOut), WebReflection))
        {
            Error = TEXT("WGSL reflection failed: ") + StandardError;
            return false;
        }
        Metadata->SetObjectField(TEXT("reflection"), WebReflection);
        if (!UE::WebGPUShader::ValidateBindings(Metadata, WebReflection, Error))
            return false;
        Metadata->SetBoolField(TEXT("bindingContractVerified"), true);
        FString MetadataJson;
        FJsonSerializer::Serialize(Metadata, TJsonWriterFactory<>::Create(&MetadataJson));
        const FTCHARToUTF8 MetadataUtf8(*MetadataJson), WgslUtf8(*Wgsl);
        FMemoryWriter Writer(Payload, true);
        uint32 Fields[] = {UE::WebGPUShader::Magic,
                           UE::WebGPUShader::Schema,
                           UE::WebGPUShader::HeaderBytes,
                           static_cast<uint32>(Input.Target.GetFrequency()),
                           GetVersion(Input.ShaderFormat),
                           static_cast<uint32>(MetadataUtf8.Length()),
                           static_cast<uint32>(WgslUtf8.Length())};
        Writer.Serialize(Fields, sizeof(Fields));
        Writer.Serialize(const_cast<ANSICHAR *>(MetadataUtf8.Get()), MetadataUtf8.Length());
        Writer.Serialize(const_cast<ANSICHAR *>(WgslUtf8.Get()), WgslUtf8.Length());
        return !Writer.IsError();
    }

    static FString NativeInputFormat(FName WebFormat)
    {
        return NativeFormat(WebFormat).ToString();
    }
};

class FWebGPUShaderFormatModule final : public IShaderFormatModule
{
  public:
    virtual IShaderFormat *GetShaderFormat() override
    {
        if (!Format)
            Format = MakeUnique<FWebGPUShaderFormat>();
        return Format.Get();
    }

  private:
    TUniquePtr<FWebGPUShaderFormat> Format;
};

IMPLEMENT_MODULE(FWebGPUShaderFormatModule, WebGPUShaderFormat);
