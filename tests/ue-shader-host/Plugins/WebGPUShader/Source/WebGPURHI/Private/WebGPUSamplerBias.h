#pragma once

#include "WebGPUDynamicRHI.h"

inline bool LowerWebGPUViewSamplerBias(FString& Source, FWebGPUShaderData& Data, FString& Error)
{
    auto IsSharedViewSampler = [](const FWebGPUShaderBinding& Binding)
    {
        return Binding.Descriptor == 0 && Binding.Reflected &&
            (Binding.Name == TEXT("View_MaterialTextureBilinearWrapedSampler") ||
             Binding.Name == TEXT("View_MaterialTextureBilinearClampedSampler") ||
             Binding.Name == TEXT("View_LandscapeWeightmapSampler"));
    };
    if (!Data.Bindings.ContainsByPredicate(IsSharedViewSampler)) return true;
    // Web builds omit ICU, so FRegexMatcher is a stub. Parse generated WGSL declarations directly.
    TArray<FString> Tokens;
    for (int32 Index = 0; Index < Source.Len();)
    {
        if (FChar::IsWhitespace(Source[Index])) { ++Index; continue; }
        if (Source[Index] == TCHAR('/') && Index + 1 < Source.Len() && Source[Index + 1] == TCHAR('/'))
        {
            while (Index < Source.Len() && Source[Index] != TCHAR('\n')) ++Index;
            continue;
        }
        if (Source[Index] == TCHAR('/') && Index + 1 < Source.Len() && Source[Index + 1] == TCHAR('*'))
        {
            int32 Depth = 1;
            Index += 2;
            while (Index < Source.Len() && Depth)
            {
                if (Index + 1 < Source.Len() && Source[Index] == TCHAR('/') && Source[Index + 1] == TCHAR('*')) { ++Depth; Index += 2; }
                else if (Index + 1 < Source.Len() && Source[Index] == TCHAR('*') && Source[Index + 1] == TCHAR('/')) { --Depth; Index += 2; }
                else ++Index;
            }
            continue;
        }
        const int32 Start = Index++;
        if (FChar::IsAlnum(Source[Start]) || Source[Start] == TCHAR('_'))
            while (Index < Source.Len() && (FChar::IsAlnum(Source[Index]) || Source[Index] == TCHAR('_'))) ++Index;
        Tokens.Add(Source.Mid(Start, Index - Start));
    }
    TMap<uint64, FString> Declarations;
    TMap<FString, FString> TextureDimensions;
    int32 AttributeGroup = INDEX_NONE, AttributeBinding = INDEX_NONE;
    for (int32 Index = 0; Index < Tokens.Num(); ++Index)
    {
        if (Index + 4 < Tokens.Num() && Tokens[Index] == TEXT("@") &&
            Tokens[Index + 2] == TEXT("(") && Tokens[Index + 4] == TEXT(")"))
        {
            if (Tokens[Index + 1] == TEXT("group")) AttributeGroup = FCString::Atoi(*Tokens[Index + 3]);
            if (Tokens[Index + 1] == TEXT("binding")) AttributeBinding = FCString::Atoi(*Tokens[Index + 3]);
        }
        if (Tokens[Index] == TEXT("var"))
        {
            if (Index + 3 < Tokens.Num() && Tokens[Index + 2] == TEXT(":"))
            {
                if (AttributeGroup != INDEX_NONE && AttributeBinding != INDEX_NONE)
                    Declarations.Add((uint64(AttributeGroup) << 32) | uint32(AttributeBinding), Tokens[Index + 1]);
                if (Tokens[Index + 3].StartsWith(TEXT("texture_")))
                    TextureDimensions.Add(Tokens[Index + 1], Tokens[Index + 3].Mid(8));
            }
            AttributeGroup = AttributeBinding = INDEX_NONE;
        }
    }
    TMap<FString, int32> Samplers;
    uint32 Group = 0, BindingIndex = 0;
    for (auto& Binding : Data.Bindings)
    {
        if (!IsSharedViewSampler(Binding)) continue;
        const FString* Declaration = Declarations.Find((uint64(Binding.Group) << 32) | Binding.Index);
        if (!Declaration || Samplers.Num() >= 4)
        {
            Error = TEXT("Cannot locate a shared view sampler declaration");
            return false;
        }
        Binding.SamplerBiasSlot = Samplers.Num();
        Samplers.Add(*Declaration, Binding.SamplerBiasSlot);
        Group = Binding.Group;
    }
    if (Samplers.IsEmpty()) return true;
    for (const auto& Binding : Data.Bindings)
        if (Binding.Group == Group) BindingIndex = FMath::Max(BindingIndex, Binding.Index + 1);
    struct FEdit { int32 Start, Count; FString Replacement; };
    TArray<FEdit> Edits;
    int32 Cursor = 0;
    while ((Cursor = Source.Find(TEXT("textureSample"), ESearchCase::CaseSensitive, ESearchDir::FromStart, Cursor)) != INDEX_NONE)
    {
        const int32 Start = Cursor;
        while (Cursor < Source.Len() && FChar::IsAlnum(Source[Cursor])) ++Cursor;
        const FString Function = Source.Mid(Start, Cursor - Start);
        while (Cursor < Source.Len() && FChar::IsWhitespace(Source[Cursor])) ++Cursor;
        if (Cursor >= Source.Len() || Source[Cursor] != TCHAR('(')) continue;
        const int32 Open = Cursor++;
        int32 Depth = 1, ArgumentStart = Cursor;
        TArray<FString> Args;
        for (; Cursor < Source.Len() && Depth; ++Cursor)
        {
            const TCHAR C = Source[Cursor];
            if (C == TCHAR('(') || C == TCHAR('[')) ++Depth;
            else if (C == TCHAR(')') || C == TCHAR(']')) --Depth;
            if ((C == TCHAR(',') && Depth == 1) || !Depth)
            {
                Args.Add(Source.Mid(ArgumentStart, Cursor - ArgumentStart).TrimStartAndEnd());
                ArgumentStart = Cursor + 1;
            }
        }
        if (Depth || Args.Num() < 2) { Error = TEXT("Malformed texture sampling call"); return false; }
        const int32* Slot = Samplers.Find(Args[1]);
        if (!Slot) { Cursor = Open + 1; continue; }
        const FString* Dimension = TextureDimensions.Find(Args[0]);
        if (!Dimension)
        {
            Error = TEXT("Cannot resolve a shared sampler's texture dimension");
            return false;
        }
        const int32 BaseArguments = Dimension->EndsWith(TEXT("_array")) ? 4 : 3;
        const FString Bias = FString::Printf(TEXT("WebViewSamplerBias[%d]"), *Slot);
        FString ReplacementFunction = Function;
        if (Function == TEXT("textureSample"))
        {
            ReplacementFunction = TEXT("textureSampleBias");
            if (Args.Num() < BaseArguments || Args.Num() > BaseArguments + 1) return false;
            Args.Insert(Bias, BaseArguments);
        }
        else if (Function == TEXT("textureSampleBias"))
        {
            // Array textures have a separate array-index argument.
            if (Args.Num() < BaseArguments + 1 || Args.Num() > BaseArguments + 2) return false;
            const int32 BiasIndex = BaseArguments;
            Args[BiasIndex] = TEXT("(") + Args[BiasIndex] + TEXT(" + ") + Bias + TEXT(")");
        }
        else if (Function == TEXT("textureSampleGrad"))
        {
            if (Args.Num() < BaseArguments + 2 || Args.Num() > BaseArguments + 3) return false;
            const int32 LastGradient = BaseArguments + 1;
            for (int32 Index = LastGradient - 1; Index <= LastGradient; ++Index)
                Args[Index] = TEXT("(") + Args[Index] + TEXT(" * exp2(") + Bias + TEXT("))");
        }
        else if (Function == TEXT("textureSampleLevel"))
            continue; // Explicit LOD does not use the sampler's implicit LOD bias.
        else
        {
            Error = TEXT("Unsupported shared sampler operation: ") + Function;
            return false;
        }
        Edits.Add({Start, Cursor - Start, ReplacementFunction + TEXT("(") + FString::Join(Args, TEXT(", ")) + TEXT(")")});
    }
    for (int32 Index = Edits.Num() - 1; Index >= 0; --Index)
    {
        const auto& Edit = Edits[Index];
        for (auto& Binding : Data.Bindings)
            if (Binding.RuntimeStorageFormat && Binding.StorageFormatOffset >= Edit.Start + Edit.Count)
                Binding.StorageFormatOffset += Edit.Replacement.Len() - Edit.Count;
        Source = Source.Left(Edit.Start) + Edit.Replacement + Source.Mid(Edit.Start + Edit.Count);
    }
    Source += FString::Printf(TEXT("\n@group(%u) @binding(%u) var<uniform> WebViewSamplerBias: vec4f;\n"), Group, BindingIndex);
    FWebGPUShaderBinding Uniform;
    Uniform.Name = TEXT("WebViewSamplerBias");
    Uniform.Descriptor = 6;
    Uniform.Group = Group;
    Uniform.Index = BindingIndex;
    Uniform.PaddedSize = 16;
    Uniform.Reflected = true;
    Data.Bindings.Add(MoveTemp(Uniform));
    Data.SamplerBiasGroup = Group;
    return true;
}
