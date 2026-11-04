#include "WebGPUShaderMetadata.h"
#include "WebGPUShaderRuntimeMetadata.h"
#include "HAL/PlatformFileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/MemoryReader.h"

int32 RunWebShaderMetadataProbe(const FString& Params)
{
    FString Input, Output;
    if (!FParse::Value(*Params, TEXT("Input="), Input) || !FParse::Value(*Params, TEXT("Output="), Output)) return 1;
    TArray<uint8> Corpus;
    if (!FFileHelper::LoadFileToArray(Corpus, *Input)) return 1;
    IFileManager::Get().MakeDirectory(*Output, true);
    TUniquePtr<FArchive> BinaryCorpus(IFileManager::Get().CreateFileWriter(*(Output / TEXT("metadata.cbstream"))));
    if (!BinaryCorpus) return 1;
    FMemoryReader Reader(Corpus, true);
    double JsonSeconds = 0, BinarySeconds = 0, NativeSeconds = 0;
    uint64 NativeAllocatedBytes = 0, DOMAllocatedBytes = 0;
    int32 NativeRejected = 0;
    int32 RuntimeCount = 0;
    int64 JsonBytes = 0, BinaryBytes = 0;
    int32 Count = 0, Rejected = 0;
    int32 LumenBindingChecks = 0;
    TArray<uint8> First;
    const auto CheckLumenBindings = [&](const TSharedPtr<FJsonObject>& Original) {
        auto Root = MakeShared<FJsonObject>(*Original);
        auto Binding = MakeShared<FJsonObject>();
        Binding->SetStringField(TEXT("name"), TEXT("LumenStorage"));
        Binding->SetNumberField(TEXT("descriptorType"), 3);
        Binding->SetNumberField(TEXT("group"), 0);
        Binding->SetNumberField(TEXT("binding"), 0);
        Binding->SetNumberField(TEXT("textureDimension"), 1);
        Binding->SetBoolField(TEXT("textureArrayed"), false);
        Binding->SetBoolField(TEXT("textureMultisampled"), false);
        Binding->SetStringField(TEXT("textureSampleType"), TEXT("float"));
        Binding->SetNumberField(TEXT("storageImageFormat"), 1);
        Root->SetArrayField(TEXT("spirvBindings"), {MakeShared<FJsonValueObject>(Binding)});
        auto Reflected = MakeShared<FJsonObject>();
        Reflected->SetNumberField(TEXT("group"), 0);
        Reflected->SetNumberField(TEXT("binding"), 0);
        Reflected->SetStringField(TEXT("resource_type"), TEXT("ReadWriteStorageTexture"));
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Original->GetStringField(TEXT("webEntry")));
        Entry->SetArrayField(TEXT("bindings"), {MakeShared<FJsonValueObject>(Reflected)});
        Entry->SetArrayField(TEXT("output_variables"), {});
        auto Reflection = MakeShared<FJsonObject>();
        Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(Entry)});
        Root->SetObjectField(TEXT("reflection"), Reflection);
        const auto Parse = [&](UE::WebGPUShader::FRuntimeBinding& Out, bool ExpectedValid = true) {
            TArray<uint8> Bytes;
            UE::WebGPUShader::FRuntimeMetadata Native, Reference;
            if (!UE::WebGPUShader::EncodeMetadata(Root, Bytes)) return false;
            const bool NativeValid = UE::WebGPUShader::DecodeRuntimeMetadata(Bytes, Native);
            const bool ReferenceValid = UE::WebGPUShader::ReadRuntimeMetadata(Root, Reference);
            if (NativeValid != ExpectedValid || ReferenceValid != ExpectedValid) return false;
            ++LumenBindingChecks;
            if (!ExpectedValid) return true;
            if (!(Native == Reference) || Native.Bindings.Num() != 1) return false;
            Out = MoveTemp(Native.Bindings[0]);
            return true;
        };
        UE::WebGPUShader::FRuntimeBinding Parsed;
        if (!Parse(Parsed) || Parsed.RuntimeStorageFormat || Parsed.StorageFormatOffset != INDEX_NONE ||
            Parsed.SampledTextureLoadOnly || Parsed.SingleVectorUniform) return false;
        Binding->SetBoolField(TEXT("runtimeStorageFormat"), true);
        Binding->SetNumberField(TEXT("storageFormatOffset"), 73);
        Binding->SetNumberField(TEXT("storageFormatLength"), 11);
        if (!Parse(Parsed) || !Parsed.RuntimeStorageFormat || Parsed.StorageFormatOffset != 73 ||
            Parsed.StorageFormatLength != 11) return false;
        for (double Offset : {-1.0, 1.5, double(MAX_int32) + 1})
        {
            Binding->SetNumberField(TEXT("storageFormatOffset"), Offset);
            if (!Parse(Parsed, false)) return false;
        }
        Binding->RemoveField(TEXT("storageFormatOffset"));
        if (!Parse(Parsed, false)) return false;
        Binding->SetNumberField(TEXT("storageFormatOffset"), 73);
        Binding->RemoveField(TEXT("storageFormatLength"));
        if (!Parse(Parsed, false)) return false;
        Binding->SetBoolField(TEXT("runtimeStorageFormat"), false);
        Binding->SetNumberField(TEXT("descriptorType"), 2);
        Binding->SetBoolField(TEXT("sampledTextureLoadOnly"), true);
        if (!Parse(Parsed) || !Parsed.SampledTextureLoadOnly || Parsed.StorageFormatOffset != INDEX_NONE) return false;
        Binding->SetNumberField(TEXT("descriptorType"), 7);
        Binding->SetStringField(TEXT("name"), TEXT("View_DistantSkyLightLutBufferSRV"));
        Binding->SetBoolField(TEXT("readOnlyStorage"), true);
        Binding->SetNumberField(TEXT("storageElementStride"), 16);
        Binding->SetNumberField(TEXT("storageElementFormat"), PF_A32B32G32R32F);
        Binding->SetNumberField(TEXT("storageUniformBytes"), 16);
        if (!Parse(Parsed) || !Parsed.SingleVectorUniform ||
            Parsed.SingleVectorUniform != UE::WebGPUShader::IsSingleVectorUniform(*Binding)) return false;
        Binding->SetNumberField(TEXT("storageUniformBytes"), 32);
        if (!Parse(Parsed) || Parsed.SingleVectorUniform) return false;
        Binding->SetNumberField(TEXT("storageUniformBytes"), 16);
        Binding->SetBoolField(TEXT("readOnlyStorage"), false);
        if (!Parse(Parsed) || Parsed.SingleVectorUniform) return false;
        return true;
    };
    const auto Check = [&](FStringView Text, bool Save) {
        TSharedPtr<FJsonObject> Original, Decoded;
        const double JsonStart = FPlatformTime::Seconds();
        if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(FString(Text)), Original)) return false;
        JsonSeconds += FPlatformTime::Seconds() - JsonStart;
        TArray<uint8> Encoded;
        if (!UE::WebGPUShader::EncodeMetadata(Original.ToSharedRef(), Encoded)) return false;
        const double BinaryStart = FPlatformTime::Seconds();
        if (!UE::WebGPUShader::DecodeMetadata(Encoded, Decoded)) return false;
        BinarySeconds += FPlatformTime::Seconds() - BinaryStart;
        if (!FJsonValue::CompareEqual(FJsonValueObject(Original), FJsonValueObject(Decoded))) return false;
        if (Save)
        {
            UE::WebGPUShader::FRuntimeMetadata Native, Reference;
            const double NativeStart = FPlatformTime::Seconds();
            if (!UE::WebGPUShader::DecodeRuntimeMetadata(Encoded, Native)) return false;
            NativeSeconds += FPlatformTime::Seconds() - NativeStart;
            if (!UE::WebGPUShader::ReadRuntimeMetadata(Original, Reference) || !(Native == Reference)) return false;
            NativeAllocatedBytes += sizeof(Native) + Native.GetAllocatedSize();
            DOMAllocatedBytes += Decoded->GetMemoryFootprint();
            ++RuntimeCount;
        }
        if (Save)
        {
            uint32 Size = Encoded.Num();
            *BinaryCorpus << Size;
            BinaryCorpus->Serialize(Encoded.GetData(), Encoded.Num());
            BinaryBytes += Encoded.Num();
            if (First.IsEmpty())
            {
                if (!CheckLumenBindings(Original)) return false;
                First = Encoded;
                for (const TCHAR* Field : {TEXT("shaderPlatformEnum"), TEXT("shaderPlatformPropertiesHash"), TEXT("frequency"),
                    TEXT("webEntry"), TEXT("resourceTable"), TEXT("spirvBindings"), TEXT("ueParameterMap"), TEXT("reflection")})
                {
                    auto InvalidRoot = MakeShared<FJsonObject>(*Original);
                    InvalidRoot->SetField(Field, MakeShared<FJsonValueNull>());
                    TArray<uint8> InvalidBytes;
                    UE::WebGPUShader::FRuntimeMetadata InvalidRuntime;
                    if (!UE::WebGPUShader::EncodeMetadata(InvalidRoot, InvalidBytes) ||
                        UE::WebGPUShader::DecodeRuntimeMetadata(InvalidBytes, InvalidRuntime)) return false;
                    ++NativeRejected;
                }
            }
        }
        return true;
    };
    while (!Reader.AtEnd())
    {
        uint32 Size = 0; Reader << Size;
        if (Reader.IsError() || Size > uint64(Reader.TotalSize() - Reader.Tell()) || Size > MAX_int32) return 1;
        const FString Text(FUTF8ToTCHAR(reinterpret_cast<const ANSICHAR*>(Corpus.GetData() + Reader.Tell()), Size));
        Reader.Seek(Reader.Tell() + Size);
        if (!Check(Text, true)) return 1;
        JsonBytes += Size; ++Count;
    }
    // Unicode, escaped controls, empty containers, booleans, nulls and numbers
    // exercise the typed conversion beyond the mostly ASCII shader corpus.
    if (!Check(TEXT("{\"名称\":\"顶点\\n\\t\\\"\\\\\",\"values\":[null,true,false,{},[],0,-1,0.125,4294967295,9007199254740991,1e100]}"), false)) return 1;
    TSharedPtr<FJsonObject> Invalid;
    for (int32 Size : {0, 1, First.Num() / 2, First.Num() - 1})
    {
        if (UE::WebGPUShader::DecodeMetadata(MakeArrayView(First.GetData(), Size), Invalid)) return 1;
        UE::WebGPUShader::FRuntimeMetadata Runtime;
        if (UE::WebGPUShader::DecodeRuntimeMetadata(MakeArrayView(First.GetData(), Size), Runtime)) return 1;
        ++NativeRejected;
        ++Rejected;
    }
    First.Add(0);
    if (UE::WebGPUShader::DecodeMetadata(First, Invalid)) return 1;
    ++Rejected;
    UE::WebGPUShader::FRuntimeMetadata Runtime;
    if (UE::WebGPUShader::DecodeRuntimeMetadata(First, Runtime)) return 1;
    ++NativeRejected;
    if (BinaryCorpus->IsError() || !BinaryCorpus->Close() || Count == 0) return 1;
    auto Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), true);
    Report->SetNumberField(TEXT("shaderMetadataRoundtrips"), Count);
    Report->SetNumberField(TEXT("runtimeMetadataMatches"), RuntimeCount);
    Report->SetNumberField(TEXT("nativeRuntimeReadMs"), NativeSeconds * 1000);
    Report->SetNumberField(TEXT("nativeRuntimeAllocatedBytes"), double(NativeAllocatedBytes));
    Report->SetNumberField(TEXT("domMemoryFootprintBytes"), double(DOMAllocatedBytes));
    Report->SetNumberField(TEXT("nativeMalformedInputsRejected"), NativeRejected);
    Report->SetNumberField(TEXT("lumenRuntimeBindingChecks"), LumenBindingChecks);
    Report->SetNumberField(TEXT("edgeCaseRoundtrips"), 1);
    Report->SetNumberField(TEXT("malformedInputsRejected"), Rejected);
    Report->SetNumberField(TEXT("jsonBytes"), JsonBytes);
    Report->SetNumberField(TEXT("binaryBytes"), BinaryBytes);
    Report->SetNumberField(TEXT("nativeJsonParseMs"), JsonSeconds * 1000);
    Report->SetNumberField(TEXT("nativeBinaryDecodeMs"), BinarySeconds * 1000);
    FString Json;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json, *(Output / TEXT("metadata-probe.json"))) ? 0 : 1;
}
