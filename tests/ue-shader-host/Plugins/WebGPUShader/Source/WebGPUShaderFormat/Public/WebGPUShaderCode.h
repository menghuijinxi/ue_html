#pragma once

#include "CoreMinimal.h"

class FJsonObject;

namespace UE::WebGPUShader
{
inline constexpr uint32 Magic = 0x53475057; // WPGS in little endian.
inline constexpr uint32 Schema = 1;
inline constexpr uint32 HeaderBytes = 28;
inline const FName ES31Format(TEXT("SF_WEBGPU_ES31"));
inline const FName SM5Format(TEXT("SF_WEBGPU_SM5"));

struct FPayload
{
    uint32 Frequency = 0;
    uint32 FormatVersion = 0;
    FString MetadataJson;
    FString Wgsl;
};

WEBGPUSHADERFORMAT_API bool Decode(TConstArrayView<uint8> Bytes, FPayload &Payload, FString &Error);
WEBGPUSHADERFORMAT_API bool ValidateBindings(const TSharedRef<FJsonObject> &Metadata,
                                           const TSharedPtr<FJsonObject> &Reflection, FString &Error);
} // namespace UE::WebGPUShader
