#pragma once

#include "WebGPUDynamicRHI.h"

struct FWebGPUShaderDeclaration
{
    FString Name, Type, Format;
    int32 FormatOffset = INDEX_NONE;
};

struct FWebGPUShaderToken { FString Text; int32 Offset, End; };

inline TArray<FWebGPUShaderToken> TokenizeWebGPUShader(const FString& Source)
{
    // Web builds omit ICU. Keep byte offsets while lexing generated WGSL without regex.
    TArray<FWebGPUShaderToken> Tokens;
    for (int32 Index = 0; Index < Source.Len();)
    {
        if (FChar::IsWhitespace(Source[Index])) { ++Index; continue; }
        const auto Pair = [&](TCHAR A, TCHAR B) {
            return Index + 1 < Source.Len() && Source[Index] == A && Source[Index + 1] == B;
        };
        if (Pair('/', '/'))
        {
            while (Index < Source.Len() && Source[Index] != TCHAR('\n')) ++Index;
            continue;
        }
        if (Pair('/', '*'))
        {
            int32 Depth = 1;
            Index += 2;
            while (Index < Source.Len() && Depth)
            {
                if (Pair('/', '*')) { ++Depth; Index += 2; }
                else if (Pair('*', '/')) { --Depth; Index += 2; }
                else ++Index;
            }
            continue;
        }
        const int32 Start = Index++;
        if (FChar::IsAlnum(Source[Start]) || Source[Start] == TCHAR('_'))
            while (Index < Source.Len() && (FChar::IsAlnum(Source[Index]) || Source[Index] == TCHAR('_'))) ++Index;
        Tokens.Add({Source.Mid(Start, Index - Start), Start, Index});
    }
    return Tokens;
}

inline TMap<uint64, FWebGPUShaderDeclaration> ParseWebGPUShaderDeclarations(const FString& Source)
{
    const auto Tokens = TokenizeWebGPUShader(Source);
    TMap<uint64, FWebGPUShaderDeclaration> Declarations;
    int32 Group = INDEX_NONE, Binding = INDEX_NONE;
    for (int32 Index = 0; Index < Tokens.Num(); ++Index)
    {
        if (Index + 4 < Tokens.Num() && Tokens[Index].Text == TEXT("@") &&
            Tokens[Index + 2].Text == TEXT("(") && Tokens[Index + 4].Text == TEXT(")"))
        {
            if (Tokens[Index + 1].Text == TEXT("group")) Group = FCString::Atoi(*Tokens[Index + 3].Text);
            if (Tokens[Index + 1].Text == TEXT("binding")) Binding = FCString::Atoi(*Tokens[Index + 3].Text);
        }
        if (Tokens[Index].Text == TEXT("var"))
        {
            int32 Name = Index + 1;
            if (Tokens.IsValidIndex(Name) && Tokens[Name].Text == TEXT("<"))
            {
                while (Tokens.IsValidIndex(Name) && Tokens[Name].Text != TEXT(">")) ++Name;
                ++Name;
            }
            if (Group != INDEX_NONE && Binding != INDEX_NONE && Index + 3 < Tokens.Num() &&
                Tokens.IsValidIndex(Name + 2) && Tokens[Name + 1].Text == TEXT(":"))
            {
                FWebGPUShaderDeclaration Entry;
                Entry.Name = Tokens[Name].Text;
                Entry.Type = Tokens[Name + 2].Text;
                if (Entry.Type.StartsWith(TEXT("texture_storage_")) && Tokens.IsValidIndex(Name + 4) &&
                    Tokens[Name + 3].Text == TEXT("<"))
                {
                    Entry.Format = Tokens[Name + 4].Text;
                    Entry.FormatOffset = Tokens[Name + 4].Offset;
                }
                Declarations.Add((uint64(Group) << 32) | uint32(Binding), MoveTemp(Entry));
            }
            Group = Binding = INDEX_NONE;
        }
    }
    return Declarations;
}

inline bool PrepareWebGPUPackedShadowMaskFormat(const FString& Source, FWebGPUShaderData& Data, FString& Error)
{
    if (Data.Frequency != SF_Compute) return true;
    auto* Binding = Data.Bindings.FindByPredicate([](const auto& Entry) {
        return Entry.Name == TEXT("OutShadowMaskBits") && Entry.Descriptor == 3;
    });
    if (!Binding) return true;
    const auto Declarations = ParseWebGPUShaderDeclarations(Source);
    const auto* Declaration = Declarations.Find((uint64(Binding->Group) << 32) | Binding->Index);
    if (!Declaration || Declaration->Type != TEXT("texture_storage_2d") ||
        Declaration->Format != TEXT("rgba32uint") || Binding->StorageImageFormat != 30 ||
        Binding->StorageTextureAccess != TEXT("write"))
    {
        Error = TEXT("Packed VSM mask must expose a write-only rgba32uint storage declaration");
        return false;
    }
    Binding->RuntimeStorageFormat = true;
    Binding->StorageFormatOffset = Declaration->FormatOffset;
    Binding->StorageFormatLength = Declaration->Format.Len();
    Data.StorageFormatSource = Source;
    return true;
}
