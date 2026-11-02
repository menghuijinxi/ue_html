#pragma once

#include "Dom/JsonObject.h"
#include "Serialization/CompactBinary.h"
#include "Serialization/CompactBinaryValidation.h"
#include "Serialization/CompactBinaryWriter.h"

namespace UE::WebGPUShader
{
// Cook stores UE Compact Binary. The existing binding code consumes an owning
// DOM, built directly from typed fields without JSON text or tokenization.
inline bool WriteMetadataValue(FCbWriter& Writer, const FJsonValue& Value, int32 Depth)
{
    if (Depth > 128) return false;
    switch (Value.Type)
    {
    case EJson::Null: Writer.AddNull(); return true;
    case EJson::Boolean: Writer.AddBool(Value.AsBool()); return true;
    case EJson::Number: Writer.AddFloat(Value.AsNumber()); return true;
    case EJson::String: Writer.AddString(FStringView(Value.AsString())); return true;
    case EJson::Array:
        Writer.BeginArray();
        for (const auto& Child : Value.AsArray())
            if (!Child || !WriteMetadataValue(Writer, *Child, Depth + 1)) return false;
        Writer.EndArray(); return true;
    case EJson::Object:
        Writer.BeginObject();
        for (const auto& Field : Value.AsObject()->Values)
        {
            const FTCHARToUTF8 Name(*Field.Key);
            Writer.SetName(FUtf8StringView(Name.Get(), Name.Length()));
            if (!Field.Value || !WriteMetadataValue(Writer, *Field.Value, Depth + 1)) return false;
        }
        Writer.EndObject(); return true;
    default: return false;
    }
}

inline bool EncodeMetadata(const TSharedRef<FJsonObject>& Object, TArray<uint8>& Bytes)
{
    FCbWriter Writer;
    if (!WriteMetadataValue(Writer, FJsonValueObject(Object), 0) || Writer.GetSaveSize() > MAX_int32)
        return false;
    Bytes.SetNumUninitialized(int32(Writer.GetSaveSize()));
    Writer.Save(MakeMemoryView(Bytes));
    return true;
}

inline TSharedPtr<FJsonValue> ReadMetadataValue(FCbFieldView Field, int32 Depth)
{
    if (Depth > 128) return nullptr;
    if (Field.IsNull()) return MakeShared<FJsonValueNull>();
    if (Field.IsBool()) return MakeShared<FJsonValueBoolean>(Field.AsBool());
    if (Field.IsFloat() || Field.IsInteger()) return MakeShared<FJsonValueNumber>(Field.AsDouble());
    if (Field.IsString()) return MakeShared<FJsonValueString>(FString(Field.AsString()));
    if (Field.IsArray())
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (FCbFieldView Child : Field.AsArrayView())
        {
            auto Value = ReadMetadataValue(Child, Depth + 1);
            if (!Value) return nullptr;
            Values.Add(MoveTemp(Value));
        }
        return MakeShared<FJsonValueArray>(MoveTemp(Values));
    }
    if (Field.IsObject())
    {
        auto Object = MakeShared<FJsonObject>();
        for (FCbFieldView Child : Field.AsObjectView())
        {
            auto Value = ReadMetadataValue(Child, Depth + 1);
            if (!Value) return nullptr;
            Object->SetField(FString(Child.GetName()), MoveTemp(Value));
        }
        return MakeShared<FJsonValueObject>(MoveTemp(Object));
    }
    return nullptr;
}

inline bool DecodeMetadata(TConstArrayView<uint8> Bytes, TSharedPtr<FJsonObject>& Object)
{
    Object.Reset();
    // Validate lengths/types before constructing views into untrusted bytes.
    // Duplicate/non-empty field names are guaranteed by the Cook writer.
    if (Bytes.IsEmpty() || ValidateCompactBinary(MakeMemoryView(Bytes),
        ECbValidateMode::Default | ECbValidateMode::Padding) != ECbValidateError::None)
        return false;
    FCbFieldView Root(Bytes.GetData());
    if (!Root.IsObject()) return false;
    const auto Value = ReadMetadataValue(Root, 0);
    if (!Value) return false;
    Object = Value->AsObject();
    return Object.IsValid();
}
} // namespace UE::WebGPUShader
