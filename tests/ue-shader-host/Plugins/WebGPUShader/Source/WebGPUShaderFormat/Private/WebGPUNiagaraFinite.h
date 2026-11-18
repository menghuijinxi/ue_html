#pragma once

#include "CoreMinimal.h"
#include "Internationalization/Regex.h"

namespace UE::WebGPUShader
{
// Classify the IEEE exponent as integer bits. Tint cannot import the IsNan /
// IsInf operations emitted for HLSL isfinite. This also preserves signed zero
// and subnormals without relying on floating-point comparisons with NaNs.
static constexpr TCHAR NiagaraFiniteHLSL[] = TEXT(R"WEBGPU(
bool WebGPUNiagaraIsFinite(float V) { return (asuint(V) & 0x7f800000u) != 0x7f800000u; }
bool2 WebGPUNiagaraIsFinite(float2 V) { return (asuint(V) & 0x7f800000u) != 0x7f800000u; }
bool3 WebGPUNiagaraIsFinite(float3 V) { return (asuint(V) & 0x7f800000u) != 0x7f800000u; }
bool4 WebGPUNiagaraIsFinite(float4 V) { return (asuint(V) & 0x7f800000u) != 0x7f800000u; }
)WEBGPU");

inline void LowerNiagaraFiniteChecks(FString& Source)
{
    const FRegexPattern Pattern(TEXT("\\bisfinite\\s*\\("));
    FRegexMatcher Match(Pattern, Source);
    TArray<int32> Offsets;
    while (Match.FindNext()) Offsets.Add(Match.GetMatchBeginning());
    for (int32 Index = Offsets.Num() - 1; Index >= 0; --Index)
    {
        Source.RemoveAt(Offsets[Index], 8, EAllowShrinking::No);
        Source.InsertAt(Offsets[Index], TEXT("WebGPUNiagaraIsFinite"));
    }
    if (!Offsets.IsEmpty()) Source.InsertAt(0, NiagaraFiniteHLSL);
}
}
