#pragma once

#include "CoreMinimal.h"

namespace UE::WebGPUShader
{
inline bool IsNaniteAtomicMaxBinding(const FString& Name)
{
    return Name.StartsWith(TEXT("WebNaniteAtomicMax_"));
}

// A discarded scalar compare-store carries (ID, depth) across DXC/SPIR-V without
// dead-store elimination. This intermediate has no executable meaning: every
// reserved resource and operation must be lowered and validated before use.
inline bool LowerNaniteAtomicMax(FString& Source, int32 ExpectedBindings, FString& Error)
{
    if (!ExpectedBindings && !Source.Contains(TEXT("WebNaniteAtomicMax_"))) return true;
    struct FToken { FString Text; int32 Begin, End; };
    struct FEdit { int32 Begin, End; FString Text; };
    TArray<FToken> Tokens;
    for (int32 Index = 0; Index < Source.Len();)
    {
        if (FChar::IsWhitespace(Source[Index])) { ++Index; continue; }
        if (Source.Mid(Index, 2) == TEXT("//"))
        {
            while (Index < Source.Len() && Source[Index] != TEXT('\n')) ++Index;
            continue;
        }
        if (Source.Mid(Index, 2) == TEXT("/*"))
        {
            int32 Depth = 1;
            Index += 2;
            while (Index < Source.Len() && Depth)
            {
                if (Source.Mid(Index, 2) == TEXT("/*")) { ++Depth; Index += 2; }
                else if (Source.Mid(Index, 2) == TEXT("*/")) { --Depth; Index += 2; }
                else ++Index;
            }
            if (Depth) { Error = TEXT("Unclosed WGSL comment"); return false; }
            continue;
        }
        const int32 Begin = Index++;
        if (FChar::IsAlnum(Source[Begin]) || Source[Begin] == TEXT('_'))
            while (Index < Source.Len() && (FChar::IsAlnum(Source[Index]) || Source[Index] == TEXT('_'))) ++Index;
        Tokens.Add({Source.Mid(Begin, Index - Begin), Begin, Index});
    }
    const auto Is = [&](int32 I, const TCHAR* Text) { return Tokens.IsValidIndex(I) && Tokens[I].Text == Text; };
    TArray<FEdit> Edits;
    FString Structures;
    int32 Bindings = 0;
    for (int32 Decl = 0; Decl < Tokens.Num(); ++Decl)
    {
        if (!Is(Decl, TEXT("var")) || !Is(Decl + 1, TEXT("<")) ||
            !Is(Decl + 2, TEXT("storage")) || !Is(Decl + 3, TEXT(",")) ||
            !Is(Decl + 4, TEXT("read_write")) || !Is(Decl + 5, TEXT(">")) ||
            !Tokens.IsValidIndex(Decl + 9) || !IsNaniteAtomicMaxBinding(Tokens[Decl + 6].Text))
            continue;
        if (!Is(Decl + 7, TEXT(":")) || !Is(Decl + 9, TEXT(";")))
        {
            Error = TEXT("Nanite atomic carrier requires a named storage struct");
            return false;
        }
        const FString Name = Tokens[Decl + 6].Text;
        const FString Type = Tokens[Decl + 8].Text;
        int32 Struct = INDEX_NONE;
        for (int32 I = 0; I + 15 < Tokens.Num(); ++I)
            if (Is(I, TEXT("struct")) && Tokens[I + 1].Text == Type) { Struct = I; break; }
        if (Struct == INDEX_NONE || !Is(Struct + 2, TEXT("{")) || !Is(Struct + 4, TEXT(":")) ||
            !Is(Struct + 5, TEXT("array")) || !Is(Struct + 6, TEXT("<")) ||
            !Is(Struct + 7, TEXT("atomic")) || !Is(Struct + 8, TEXT("<")) ||
            !Is(Struct + 9, TEXT("u32")) || !Is(Struct + 10, TEXT(">")) ||
            !Is(Struct + 11, TEXT(">")) || !Is(Struct + 12, TEXT(",")) || !Is(Struct + 13, TEXT("}")))
        {
            Error = TEXT("Nanite atomic carrier must contain only array<atomic<u32>>: ") + Name;
            return false;
        }
        const FString Member = Tokens[Struct + 3].Text;
        const FString AtomicType = FString::Printf(TEXT("WebNanitePackedAtomicBuffer_%d"), Bindings++);
        Structures += TEXT("struct ") + AtomicType + TEXT(" { ") + Member +
            TEXT(": array<atomic<vec2<u32>>>, }\n");
        Edits.Add({Tokens[Decl + 8].Begin, Tokens[Decl + 8].End, AtomicType});
        int32 Stores = 0;
        for (int32 I = 0; I < Tokens.Num(); ++I)
        {
            if (Tokens[I].Text != Name || I == Decl + 6) continue;
            if (!Is(I + 1, TEXT(".")) || !Tokens.IsValidIndex(I + 2) || Tokens[I + 2].Text != Member)
            {
                Error = TEXT("Nanite atomic carrier cannot escape through a pointer or function: ") + Name;
                return false;
            }
            const bool Dimension = (Is(I - 4, TEXT("arrayLength")) && Is(I - 3, TEXT("(")) &&
                Is(I - 2, TEXT("&")) && Is(I - 1, TEXT("(")) && Is(I + 3, TEXT(")")) && Is(I + 4, TEXT(")"))) ||
                (Is(I - 3, TEXT("arrayLength")) && Is(I - 2, TEXT("(")) &&
                 Is(I - 1, TEXT("&")) && Is(I + 3, TEXT(")")));
            if (Dimension) continue;
            if (!Is(I + 3, TEXT("[")) || !Is(I - 6, TEXT("_")) || !Is(I - 5, TEXT("=")) ||
                !Is(I - 4, TEXT("atomicCompareExchangeWeak")) || !Is(I - 3, TEXT("(")) ||
                !Is(I - 2, TEXT("&")) || !Is(I - 1, TEXT("(")))
            {
                Error = TEXT("Nanite atomic carrier only permits discarded compare-stores: ") + Name;
                return false;
            }
            int32 End = I + 4, Depth = 1;
            for (; End < Tokens.Num() && Depth; ++End)
            {
                if (Is(End, TEXT("["))) ++Depth;
                if (Is(End, TEXT("]"))) --Depth;
            }
            if (Depth || !Is(End, TEXT(")")) || !Is(End + 1, TEXT(",")))
            {
                Error = TEXT("Invalid Nanite atomic carrier target: ") + Name;
                return false;
            }
            // Split the two scalar arguments while preserving nested expressions.
            int32 Comma = INDEX_NONE, Close = INDEX_NONE, Nesting = 0;
            for (int32 P = End + 2; P < Tokens.Num(); ++P)
            {
                if (!Nesting && Is(P, TEXT(")"))) { Close = P; break; }
                if (!Nesting && Is(P, TEXT(",")))
                {
                    if (Comma != INDEX_NONE) break;
                    Comma = P;
                }
                if (Is(P, TEXT("(")) || Is(P, TEXT("["))) ++Nesting;
                if (Is(P, TEXT(")")) || Is(P, TEXT("]"))) --Nesting;
                if (Tokens[P].Text == Name || Is(P, TEXT(";")) ||
                    Is(P, TEXT("{")) || Is(P, TEXT("}")) || Nesting < 0)
                {
                    Error = TEXT("Invalid Nanite atomic carrier expression");
                    return false;
                }
            }
            if (Comma <= End + 2 || Close <= Comma + 1 ||
                !Is(Close + 1, TEXT(".")) || !Is(Close + 2, TEXT("old_value")) || !Is(Close + 3, TEXT(";")))
            {
                Error = TEXT("Nanite atomic compare result must be discarded");
                return false;
            }
            const FString Target = Source.Mid(Tokens[I].Begin, Tokens[End].Begin - Tokens[I].Begin).TrimEnd();
            const FString Low = Source.Mid(Tokens[End + 2].Begin, Tokens[Comma].Begin - Tokens[End + 2].Begin);
            const FString High = Source.Mid(Tokens[Comma + 1].Begin, Tokens[Close].Begin - Tokens[Comma + 1].Begin);
            Edits.Add({Tokens[I - 6].Begin, Tokens[Close + 3].End,
                TEXT("atomicStoreMax(&(") + Target + TEXT("), vec2<u32>(") + Low + TEXT(", ") + High + TEXT("));")});
            ++Stores;
        }
        if (!Stores)
        {
            Error = TEXT("Nanite atomic carrier has no recognized stores: ") + Name;
            return false;
        }
    }
    if (Bindings != ExpectedBindings)
    {
        Error = TEXT("Nanite atomic carrier declaration/reflection count mismatch");
        return false;
    }
    if (!Bindings) return true;
    Edits.Sort([](const FEdit& A, const FEdit& B) { return A.Begin > B.Begin; });
    // Insert structs after any enable/requires/diagnostic directives, which must
    // precede declarations. Tint emits existing directives before the first struct.
    int32 Insertion = Source.Len();
    for (int32 I = 0; I < Tokens.Num(); ++I)
        if (Is(I, TEXT("struct")) || Is(I, TEXT("@")) || Is(I, TEXT("var")) || Is(I, TEXT("fn")))
        {
            Insertion = Tokens[I].Begin;
            break;
        }
    for (const FEdit& Edit : Edits)
    {
        Source.RemoveAt(Edit.Begin, Edit.End - Edit.Begin);
        Source.InsertAt(Edit.Begin, Edit.Text);
    }
    Source.InsertAt(Insertion, Structures);
    Source.InsertAt(0, TEXT("enable atomic_vec2u_min_max;\n"));
    return true;
}
}
