#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Serialization/CompactBinary.h"
#include "Serialization/CompactBinaryValidation.h"

namespace UE::WebGPUShader
{
struct FStorageContract
{
    enum class EPacking { Other, VertexFetch, UNorm8x4 };
    bool ReadOnlyValid = false, ReadOnly = false, FormatValid = false, StrideValid = false, SlotValid = false;
    double Format = 0, Stride = 0, Slot = -1;
    EPacking Packing = EPacking::Other;
    bool operator==(const FStorageContract&) const = default;
};

struct FRuntimeBinding
{
    FString Name;
    uint32 Descriptor = 0, Group = 0, Index = 0, PaddedSize = 0, StorageImageFormat = 0;
    int32 VertexFetchFormatSlot = INDEX_NONE;
    double TextureDimension = -1;
    bool TextureArrayed = false, TextureMultisampled = false, TextureContractValid = false;
    bool SamplerComparison = false, Reflected = false, DepthTexture = false;
    FString TextureSampleType, StorageTextureAccess;
    FStorageContract StorageContract;
    bool operator==(const FRuntimeBinding&) const = default;
};

struct FRuntimeParameter
{
    FString Name;
    uint32 Type = 0, BufferIndex = 0, BaseIndex = 0;
    bool operator==(const FRuntimeParameter&) const = default;
};
struct FRuntimeMember
{
    FString Name, UniformBuffer;
    uint32 ResourceIndex = 0, Type = 0;
    bool operator==(const FRuntimeMember&) const = default;
};
struct FRuntimeMetadata
{
    uint32 Schema = 0, Platform = 0, PropertiesHash = 0, Version = 0, Frequency = 0, ResourceBits = 0, OutputMask = 0;
    FString PlatformName, FormatName, Entry;
    bool Verified = false;
    TArray<uint32> Textures, Samplers, SRVs, UAVs, LayoutHashes;
    TArray<FRuntimeBinding> Bindings;
    TArray<FRuntimeParameter> Parameters;
    TArray<FRuntimeMember> Members;
    bool operator==(const FRuntimeMetadata&) const = default;
    uint64 GetAllocatedSize() const
    {
        uint64 Bytes = PlatformName.GetAllocatedSize() + FormatName.GetAllocatedSize() + Entry.GetAllocatedSize() +
            Textures.GetAllocatedSize() + Samplers.GetAllocatedSize() + SRVs.GetAllocatedSize() + UAVs.GetAllocatedSize() +
            LayoutHashes.GetAllocatedSize() + Bindings.GetAllocatedSize() + Parameters.GetAllocatedSize() + Members.GetAllocatedSize();
        for (const auto& B : Bindings) Bytes += B.Name.GetAllocatedSize() + B.TextureSampleType.GetAllocatedSize() + B.StorageTextureAccess.GetAllocatedSize();
        for (const auto& P : Parameters) Bytes += P.Name.GetAllocatedSize();
        for (const auto& M : Members) Bytes += M.Name.GetAllocatedSize() + M.UniformBuffer.GetAllocatedSize();
        return Bytes;
    }
};

// A non-owning reader. The binary branch never constructs JSON nodes, field-name
// strings, or a second owning tree. The JSON branch is the legacy/test oracle.
class FMetadataField
{
    mutable FCbFieldView Binary; // UE views retain accessor error state.
    const FJsonValue* Json = nullptr;
    bool IsBinary = true;
public:
    explicit FMetadataField(FCbFieldView Field) : Binary(Field) {}
    explicit FMetadataField(const FJsonValue* Value) : Json(Value), IsBinary(false) {}
    bool IsObject() const { return IsBinary ? Binary.IsObject() : Json && Json->Type == EJson::Object; }
    bool IsArray() const { return IsBinary ? Binary.IsArray() : Json && Json->Type == EJson::Array; }
    FMetadataField operator[](const ANSICHAR* Name) const
    {
        if (IsBinary) return FMetadataField(IsObject() ? Binary.AsObjectView()[FUtf8StringView(Name)] : FCbFieldView());
        if (!IsObject()) return FMetadataField(static_cast<const FJsonValue*>(nullptr));
        const auto* Found = Json->AsObject()->Values.Find(UTF8_TO_TCHAR(Name));
        return FMetadataField(Found ? Found->Get() : nullptr);
    }
    bool Number(double& Out) const
    {
        if (IsBinary) { if (!Binary.IsFloat() && !Binary.IsInteger()) return false; Out = Binary.AsDouble(); return true; }
        return Json && Json->TryGetNumber(Out);
    }
    bool UInt(uint32& Out) const
    {
        double Value;
        if (!Number(Value) || !FMath::IsFinite(Value) || Value < 0 || Value > MAX_uint32 || Value != FMath::FloorToDouble(Value)) return false;
        Out = uint32(Value); return true;
    }
    bool Bool(bool& Out) const
    {
        if (IsBinary) { if (!Binary.IsBool()) return false; Out = Binary.AsBool(); return true; }
        return Json && Json->TryGetBool(Out);
    }
    bool String(FString& Out) const
    {
        if (IsBinary) { if (!Binary.IsString()) return false; Out = FString(Binary.AsString()); return true; }
        return Json && Json->TryGetString(Out);
    }
    template <typename Function> bool Each(Function&& Callback) const
    {
        if (!IsArray()) return false;
        if (IsBinary) { for (FCbFieldView Child : Binary.AsArrayView()) if (!Callback(FMetadataField(Child))) return false; }
        else { for (const auto& Child : Json->AsArray()) if (!Callback(FMetadataField(Child.Get()))) return false; }
        return true;
    }
};

inline bool ReadRuntimeMetadata(FMetadataField Root, FRuntimeMetadata& Out)
{
    Out = {};
    if (!Root.IsObject() || !Root["schema"].UInt(Out.Schema) || !Root["shaderPlatformEnum"].UInt(Out.Platform) ||
        !Root["shaderPlatformPropertiesHash"].UInt(Out.PropertiesHash) || !Root["formatVersion"].UInt(Out.Version) ||
        !Root["frequency"].UInt(Out.Frequency) || !Root["shaderPlatform"].String(Out.PlatformName) ||
        !Root["format"].String(Out.FormatName) || !Root["webEntry"].String(Out.Entry) ||
        !Root["bindingContractVerified"].Bool(Out.Verified) || !Out.Verified) return false;
    const auto Table = Root["resourceTable"];
    const auto Numbers = [&](const ANSICHAR* Name, TArray<uint32>& Values) {
        return Table[Name].Each([&](FMetadataField Field) { uint32 Value; if (!Field.UInt(Value)) return false; Values.Add(Value); return true; });
    };
    if (!Table["bits"].UInt(Out.ResourceBits) || !Numbers("textures", Out.Textures) || !Numbers("samplers", Out.Samplers) ||
        !Numbers("srvs", Out.SRVs) || !Numbers("uavs", Out.UAVs) || !Numbers("layoutHashes", Out.LayoutHashes)) return false;
    if (!Root["ueParameterMap"].Each([&](FMetadataField Field) {
        FRuntimeParameter P;
        if (!Field["name"].String(P.Name) || !Field["type"].UInt(P.Type)) return false;
        if (!(P.Type == 1 ? Field["bufferIndex"].UInt(P.BufferIndex) : Field["baseIndex"].UInt(P.BaseIndex))) return false;
        Out.Parameters.Add(MoveTemp(P)); return true;
    })) return false;
    if (!Root["uniformResourceEntries"].Each([&](FMetadataField Field) {
        FRuntimeMember M;
        if (!Field["name"].String(M.Name) || !Field["uniformBuffer"].String(M.UniformBuffer) ||
            !Field["resourceIndex"].UInt(M.ResourceIndex) || !Field["type"].UInt(M.Type)) return false;
        Out.Members.Add(MoveTemp(M)); return true;
    })) return false;
    if (!Root["spirvBindings"].Each([&](FMetadataField Field) {
        FRuntimeBinding B;
        if (!Field["name"].String(B.Name) || !Field["descriptorType"].UInt(B.Descriptor) ||
            !Field["group"].UInt(B.Group) || B.Group >= 32 || !Field["binding"].UInt(B.Index)) return false;
        if ((B.Descriptor == 6 || B.Name == TEXT("$Globals")) && !Field["paddedSize"].UInt(B.PaddedSize)) return false;
        double Slot;
        if (Field["vertexFetchFormatSlot"].Number(Slot))
        { if (!FMath::IsFinite(Slot) || Slot < 0 || Slot > 3 || Slot != FMath::FloorToDouble(Slot)) return false; B.VertexFetchFormatSlot = int32(Slot); }
        B.TextureContractValid = Field["textureDimension"].Number(B.TextureDimension) && Field["textureArrayed"].Bool(B.TextureArrayed) &&
            Field["textureMultisampled"].Bool(B.TextureMultisampled) && Field["textureSampleType"].String(B.TextureSampleType);
        if ((B.Descriptor == 2 || B.Descriptor == 3) && !B.TextureContractValid) return false;
        Field["samplerComparison"].Bool(B.SamplerComparison);
        if (B.Descriptor == 3 && !Field["storageImageFormat"].UInt(B.StorageImageFormat)) return false;
        Field["storageTextureAccess"].String(B.StorageTextureAccess);
        auto& C = B.StorageContract;
        if (B.Descriptor == 7)
        {
            C.ReadOnlyValid = Field["readOnlyStorage"].Bool(C.ReadOnly);
            C.FormatValid = Field["storageElementFormat"].Number(C.Format);
            C.StrideValid = Field["storageElementStride"].Number(C.Stride);
            C.SlotValid = Field["vertexFetchFormatSlot"].Number(C.Slot);
            FString Packing; Field["storagePacking"].String(Packing);
            C.Packing = Packing == TEXT("vertex-fetch") ? FStorageContract::EPacking::VertexFetch :
                Packing == TEXT("unorm8x4") ? FStorageContract::EPacking::UNorm8x4 : FStorageContract::EPacking::Other;
        }
        Out.Bindings.Add(MoveTemp(B)); return true;
    })) return false;
    bool First = true;
    if (!Root["reflection"]["entry_points"].Each([&](FMetadataField Entry) {
        if (First)
        {
            if (!Entry["bindings"].Each([&](FMetadataField Field) {
                uint32 Group, Index; FString Type;
                if (!Field["group"].UInt(Group) || !Field["binding"].UInt(Index) || !Field["resource_type"].String(Type)) return false;
                for (auto& B : Out.Bindings) if (B.Group == Group && B.Index == Index) { B.Reflected = true; B.DepthTexture = Type == TEXT("DepthTexture"); }
                return true;
            })) return false;
            First = false;
        }
        FString Name;
        if (!Entry["name"].String(Name)) return false;
        if (Name == Out.Entry && !Entry["output_variables"].Each([&](FMetadataField Field) {
            double Location;
            if (Field["location"].Number(Location))
            { if (!FMath::IsFinite(Location) || Location < 0 || Location != FMath::FloorToDouble(Location)) return false;
              if (Location < 32) Out.OutputMask |= 1u << uint32(Location); }
            return true;
        })) return false;
        return true;
    })) return false;
    for (const auto& B : Out.Bindings) if (!B.Reflected) return false;
    return !First;
}

inline bool DecodeRuntimeMetadata(TConstArrayView<uint8> Bytes, FRuntimeMetadata& Out)
{
    if (Bytes.IsEmpty() || ValidateCompactBinary(MakeMemoryView(Bytes),
        ECbValidateMode::Default | ECbValidateMode::Padding) != ECbValidateError::None) return false;
    return ReadRuntimeMetadata(FMetadataField(FCbFieldView(Bytes.GetData())), Out);
}
inline bool ReadRuntimeMetadata(const TSharedPtr<FJsonObject>& Object, FRuntimeMetadata& Out)
{
    const FJsonValueObject Root(Object);
    return ReadRuntimeMetadata(FMetadataField(&Root), Out);
}
} // namespace UE::WebGPUShader
