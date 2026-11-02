#include "WebGPUShaderMetadata.h"
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
    double JsonSeconds = 0, BinarySeconds = 0;
    int64 JsonBytes = 0, BinaryBytes = 0;
    int32 Count = 0, Rejected = 0;
    TArray<uint8> First;
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
            uint32 Size = Encoded.Num();
            *BinaryCorpus << Size;
            BinaryCorpus->Serialize(Encoded.GetData(), Encoded.Num());
            BinaryBytes += Encoded.Num();
            if (First.IsEmpty()) First = Encoded;
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
        ++Rejected;
    }
    First.Add(0);
    if (UE::WebGPUShader::DecodeMetadata(First, Invalid)) return 1;
    ++Rejected;
    if (BinaryCorpus->IsError() || !BinaryCorpus->Close() || Count == 0) return 1;
    auto Report = MakeShared<FJsonObject>();
    Report->SetBoolField(TEXT("pass"), true);
    Report->SetNumberField(TEXT("shaderMetadataRoundtrips"), Count);
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
