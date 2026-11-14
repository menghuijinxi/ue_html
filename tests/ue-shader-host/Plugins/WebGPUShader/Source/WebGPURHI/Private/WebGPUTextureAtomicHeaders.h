#pragma once

#include "WebGPUShaderDeclarations.h"

// The 256-byte mirror prefix is immutable CPU metadata. Keep texel atomics and
// coordinate bounds checks intact, but read dimensions through a uniform.
inline uint32 LowerWebGPUTextureAtomicHeaders(FString& Source, FWebGPUShaderData& Data, uint32 UniformLimit = 12)
{
    using EPacking = FWebGPUStorageContract::EPacking;
    if (!Data.Bindings.ContainsByPredicate([](const auto& B) {
        return B.StorageContract.Packing == EPacking::TextureUIntAtomic;
    })) return 0;
    uint32 UniformCount = 0;
    for (const auto& B : Data.Bindings) UniformCount += B.Descriptor == 6 || B.SingleVectorUniform;
    if (UniformCount >= UniformLimit) return 0;
    const auto Declarations = ParseWebGPUShaderDeclarations(Source);
    const auto Tokens = TokenizeWebGPUShader(Source);
    const auto Is = [&](int32 I, const TCHAR* Text) {
        return Tokens.IsValidIndex(I) && Tokens[I].Text == Text;
    };
    struct FEdit { int32 Begin, End; FString Text; };
    TArray<FEdit> Edits;
    TArray<int32> Sources;
    const int32 OriginalBindings = Data.Bindings.Num();
    for (int32 BindingIndex = 0; BindingIndex < OriginalBindings; ++BindingIndex)
    {
        const auto& Binding = Data.Bindings[BindingIndex];
        if (Binding.Descriptor != 7 || Binding.StorageContract.Packing != EPacking::TextureUIntAtomic) continue;
        const auto* Declaration = Declarations.Find((uint64(Binding.Group) << 32) | Binding.Index);
        if (!Declaration) continue;
        const FString Uniform = FString::Printf(TEXT("WebTextureHeaders[%d]"), Sources.Num());
        const int32 Before = Edits.Num();
        for (int32 I = 0; I + 9 < Tokens.Num(); ++I)
        {
            if (!Is(I, TEXT("atomicLoad")) || !Is(I + 1, TEXT("(")) || !Is(I + 2, TEXT("&"))) continue;
            const bool Parenthesis = Is(I + 3, TEXT("("));
            const int32 Name = I + (Parenthesis ? 4 : 3);
            if (Tokens[Name].Text != Declaration->Name || !Is(Name + 1, TEXT(".")) ||
                !Is(Name + 3, TEXT("[")) || !Is(Name + 5, TEXT("]")) ||
                !Is(Name + 6, TEXT(")")) || (Parenthesis && !Is(Name + 7, TEXT(")")))) continue;
            const FString& Index = Tokens[Name + 4].Text;
            if (Index != TEXT("0u") && Index != TEXT("1u") && Index != TEXT("2u") && Index != TEXT("3u")) continue;
            const int32 End = Name + (Parenthesis ? 7 : 6);
            Edits.Add({Tokens[I].Offset, Tokens[End].End, Uniform + TEXT("[") + Index + TEXT("]")});
            I = End;
        }
        if (Edits.Num() == Before) continue;
        Sources.Add(BindingIndex);
    }
    if (Sources.IsEmpty()) return 0;
    Edits.Sort([](const auto& A, const auto& B) { return A.Begin > B.Begin; });
    for (const auto& Edit : Edits)
    {
        for (auto& B : Data.Bindings)
            if (B.RuntimeStorageFormat && B.StorageFormatOffset >= Edit.End)
                B.StorageFormatOffset += Edit.Text.Len() - (Edit.End - Edit.Begin);
        Source.RemoveAt(Edit.Begin, Edit.End - Edit.Begin);
        Source.InsertAt(Edit.Begin, Edit.Text);
    }
    FWebGPUShaderBinding Header;
    Header.Name = TEXT("WebTextureHeaders");
    Header.Group = Data.Bindings[Sources[0]].Group;
    for (const auto& B : Data.Bindings)
        if (B.Group == Header.Group) Header.Index = FMath::Max(Header.Index, B.Index + 1);
    Header.Descriptor = 6;
    Header.PaddedSize = Sources.Num() * 16;
    Header.Reflected = true;
    Header.TextureAtomicHeaders = true;
    Source += FString::Printf(TEXT("\n@group(%u) @binding(%u) var<uniform> WebTextureHeaders: array<vec4<u32>, %d>;\n"),
        Header.Group, Header.Index, Sources.Num());
    Data.TextureAtomicHeadersGroup = Header.Group;
    Data.TextureAtomicHeaderSources = MoveTemp(Sources);
    Data.Bindings.Add(MoveTemp(Header));
    return Data.TextureAtomicHeaderSources.Num();
}
