#pragma once

#include "WebGPUShaderDeclarations.h"

inline const TCHAR* WebGPUDepthAtlasBilinearWGSL = TEXT(R"WGSL(
fn WebDepthAtlasBilinear(tex: texture_2d<f32>, uv: vec2f, lod: f32) -> vec4f {
    let level = i32(lod);
    let size = vec2i(textureDimensions(tex, level));
    let position = uv * vec2f(size) - vec2f(0.5);
    let base = vec2i(floor(position));
    let weight = fract(position);
    let limit = size - vec2i(1);
    let a = textureLoad(tex, clamp(base, vec2i(0), limit), level);
    let b = textureLoad(tex, clamp(base + vec2i(1, 0), vec2i(0), limit), level);
    let c = textureLoad(tex, clamp(base + vec2i(0, 1), vec2i(0), limit), level);
    let d = textureLoad(tex, clamp(base + vec2i(1), vec2i(0), limit), level);
    return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
}
)WGSL");

inline bool LowerWebGPUDepthAtlasSampling(FString& Source, FWebGPUShaderData& Data, FString& Error)
{
    const auto* Atlas = Data.Bindings.FindByPredicate([](const auto& Binding) {
        return Binding.Descriptor == 2 && Binding.Name == TEXT("LumenCardScene_DepthAtlas");
    });
    if (!Atlas || !Data.Bindings.ContainsByPredicate([](const auto& Binding) {
        return Binding.Descriptor == 0 && (Binding.Name == TEXT("VulkanGlobalBilinearClampedSampler") ||
            Binding.Name == TEXT("GlobalBilinearClampedSampler"));
    })) return true;
    const auto Declarations = ParseWebGPUShaderDeclarations(Source);
    const auto* Texture = Declarations.Find((uint64(Atlas->Group) << 32) | Atlas->Index);
    if (!Texture || Texture->Type != TEXT("texture_2d"))
    {
        Error = TEXT("Lumen card depth atlas must be a 2D sampled texture");
        return false;
    }
    TSet<FString> Samplers;
    for (const auto& Binding : Data.Bindings)
        if (Binding.Descriptor == 0 && (Binding.Name == TEXT("VulkanGlobalBilinearClampedSampler") ||
            Binding.Name == TEXT("GlobalBilinearClampedSampler")))
            if (const auto* Declaration = Declarations.Find((uint64(Binding.Group) << 32) | Binding.Index))
                Samplers.Add(Declaration->Name);
    const auto Tokens = TokenizeWebGPUShader(Source);
    struct FEdit { int32 Start, End; FString Replacement; };
    TArray<FEdit> Edits;
    for (int32 Index = 0; Index + 2 < Tokens.Num(); ++Index)
    {
        if (Tokens[Index].Text != TEXT("textureSampleLevel") || Tokens[Index + 1].Text != TEXT("(") ||
            Tokens[Index + 2].Text != Texture->Name) continue;
        int32 Depth = 1, ArgumentStart = Tokens[Index + 2].Offset, End = Index + 2;
        TArray<FString> Args;
        for (; End < Tokens.Num() && Depth; ++End)
        {
            const auto& Token = Tokens[End];
            if (Token.Text == TEXT("(") || Token.Text == TEXT("[")) ++Depth;
            else if (Token.Text == TEXT(")") || Token.Text == TEXT("]")) --Depth;
            if ((Token.Text == TEXT(",") && Depth == 1) || !Depth)
            {
                Args.Add(Source.Mid(ArgumentStart, Token.Offset - ArgumentStart).TrimStartAndEnd());
                ArgumentStart = Token.End;
            }
        }
        if (Args.Num() < 2 || !Samplers.Contains(Args[1])) continue;
        if (Depth || Args.Num() != 4)
        {
            Error = TEXT("Unsupported Lumen depth atlas bilinear sampling arguments");
            return false;
        }
        Edits.Add({Tokens[Index].Offset, Tokens[End - 1].End,
            TEXT("WebDepthAtlasBilinear(") + Args[0] + TEXT(", ") + Args[2] + TEXT(", ") + Args[3] + TEXT(")")});
        Index = End - 1;
    }
    for (int32 Index = Edits.Num() - 1; Index >= 0; --Index)
    {
        const auto& Edit = Edits[Index];
        for (auto& Binding : Data.Bindings)
            if (Binding.RuntimeStorageFormat && Binding.StorageFormatOffset >= Edit.End)
                Binding.StorageFormatOffset += Edit.Replacement.Len() - (Edit.End - Edit.Start);
        Source = Source.Left(Edit.Start) + Edit.Replacement + Source.Mid(Edit.End);
    }
    if (!Edits.IsEmpty()) Source += WebGPUDepthAtlasBilinearWGSL;
    return true;
}
