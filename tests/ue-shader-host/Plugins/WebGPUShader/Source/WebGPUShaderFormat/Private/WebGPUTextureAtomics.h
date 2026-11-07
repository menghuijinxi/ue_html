#pragma once

#include "Internationalization/Regex.h"

namespace UE::WebGPUShader
{
inline const TCHAR* TextureAtomicNames[] = {
    TEXT("OutPageRequestFlags"),
    TEXT("OutPageReceiverMasks"),
    TEXT("InOutPageRequestFlags"),
    TEXT("InOutPageReceiverMasks"),
    TEXT("ShadowDepthPass_OutDepthBufferArray")
};

inline bool IsTextureAtomicBinding(const FString& Name)
{
    for (const TCHAR* Candidate : TextureAtomicNames)
        if (Name == Candidate) return true;
    return Name.StartsWith(TEXT("OutPageFlagMips_")) || Name.StartsWith(TEXT("OutPageReceiverMaskMips_"));
}

inline void LowerTextureAtomics(FString& Source)
{
    TArray<FString> Names;
    FRegexMatcher Declarations(FRegexPattern(TEXT("\\bRWTexture2D(Array)?\\s*<\\s*uint\\s*>\\s+(\\w+)")), Source);
    struct FDeclaration { int32 Begin, End; FString Name; };
    TArray<FDeclaration> Changes;
    while (Declarations.FindNext())
    {
        const FString Name = Declarations.GetCaptureGroup(2);
        // These three aliases are the VSM helpers taking a page-table UAV.
        if (!IsTextureAtomicBinding(Name) && Name != TEXT("OutPageFlagMip") &&
            Name != TEXT("OutPageReceiverMaskMip") && Name != TEXT("PageTableTexture")) continue;
        Changes.Add({Declarations.GetMatchBeginning(), Declarations.GetMatchEnding(), Name});
        Names.AddUnique(Name);
    }
    if (Names.IsEmpty()) return;
    for (int32 Index = Changes.Num() - 1; Index >= 0; --Index)
    {
        const auto& Change = Changes[Index];
        Source.RemoveAt(Change.Begin, Change.End - Change.Begin);
        Source.InsertAt(Change.Begin, TEXT("RWStructuredBuffer<uint> ") + Change.Name);
    }
    for (const FString& Name : Names)
    {
        int32 Cursor = 0;
        while ((Cursor = Source.Find(Name, ESearchCase::CaseSensitive, ESearchDir::FromStart, Cursor)) != INDEX_NONE)
        {
            const int32 Begin = Cursor;
            Cursor += Name.Len();
            if ((Begin && (FChar::IsAlnum(Source[Begin - 1]) || Source[Begin - 1] == TEXT('_'))) ||
                (Cursor < Source.Len() && (FChar::IsAlnum(Source[Cursor]) || Source[Cursor] == TEXT('_')))) continue;
            while (Cursor < Source.Len() && FChar::IsWhitespace(Source[Cursor])) ++Cursor;
            if (Cursor == Source.Len() || Source[Cursor] != TEXT('[')) continue;
            const int32 IndexBegin = ++Cursor;
            int32 Depth = 1;
            while (Cursor < Source.Len() && Depth)
            {
                if (Source[Cursor] == TEXT('[')) ++Depth;
                if (Source[Cursor] == TEXT(']')) --Depth;
                ++Cursor;
            }
            checkf(!Depth, TEXT("Unbalanced texture atomic index"));
            const FString Coordinate = Source.Mid(IndexBegin, Cursor - IndexBegin - 1);
            int32 Call = Begin;
            while (Call && FChar::IsWhitespace(Source[Call - 1])) --Call;
            bool Atomic = Call && Source[Call - 1] == TEXT('(');
            int32 OperationEnd = Atomic ? Call - 1 : Call;
            while (OperationEnd && FChar::IsWhitespace(Source[OperationEnd - 1])) --OperationEnd;
            int32 OperationBegin = OperationEnd;
            while (OperationBegin && FChar::IsAlpha(Source[OperationBegin - 1])) --OperationBegin;
            const FString Operation = Source.Mid(OperationBegin, OperationEnd - OperationBegin);
            Atomic &= Operation.StartsWith(TEXT("Interlocked"));
            FString Replacement;
            int32 ReplaceBegin = Begin;
            if (Atomic)
            {
                ReplaceBegin = OperationBegin;
                Replacement = TEXT("WebTexture") + Operation + TEXT("(") + Name + TEXT(", ") + Coordinate;
            }
            else
            {
                int32 Next = Cursor;
                while (Next < Source.Len() && FChar::IsWhitespace(Source[Next])) ++Next;
                if (Next + 1 < Source.Len() && Source[Next] == TEXT('=') && Source[Next + 1] != TEXT('='))
                {
                    const int32 End = Source.Find(TEXT(";"), ESearchCase::CaseSensitive, ESearchDir::FromStart, Next);
                    checkf(End != INDEX_NONE, TEXT("Unterminated virtual shadow texture store"));
                    Replacement = TEXT("WebTextureStore(") + Name + TEXT(", ") + Coordinate + TEXT(", ") +
                        Source.Mid(Next + 1, End - Next - 1) + TEXT(")");
                    Cursor = End;
                }
                else
                    Replacement = TEXT("WebTextureLoad(") + Name + TEXT(", ") + Coordinate + TEXT(")");
            }
            Source.RemoveAt(ReplaceBegin, Cursor - ReplaceBegin);
            Source.InsertAt(ReplaceBegin, Replacement);
            Cursor = ReplaceBegin + Replacement.Len();
        }
    }
    // Explicit bounds checks preserve texture loads/stores. A robust buffer
    // access alone could clamp an invalid texture coordinate to a valid texel.
    FString Helpers;
    for (int32 Dimension : {2, 3})
    {
        const FString P = FString::Printf(TEXT("uint%d"), Dimension);
        Helpers += TEXT("bool WebTextureAddress(RWStructuredBuffer<uint> b, ") + P +
            TEXT(" p, out uint i) { i = 64u + p.x + b[2] * (p.y") +
            (Dimension == 3 ? TEXT(" + b[1] * p.z") : TEXT("")) +
            TEXT("); return p.x < b[0] && p.y < b[1]") +
            (Dimension == 3 ? TEXT(" && p.z < b[3]") : TEXT("")) + TEXT("; }\n");
        Helpers += TEXT("uint WebTextureLoad(RWStructuredBuffer<uint> b, ") + P +
            TEXT(" p) { uint i; if (WebTextureAddress(b,p,i)) return b[i]; return 0u; }\n");
        Helpers += TEXT("void WebTextureStore(RWStructuredBuffer<uint> b, ") + P +
            TEXT(" p, uint v) { uint i; if (WebTextureAddress(b,p,i)) b[i]=v; }\n");
        for (const TCHAR* Op : {TEXT("Or"), TEXT("Max"), TEXT("Min"), TEXT("Add")})
        {
            const FString Function = TEXT("WebTextureInterlocked") + FString(Op);
            Helpers += TEXT("void ") + Function + TEXT("(RWStructuredBuffer<uint> b, ") + P +
                TEXT(" p, uint v, out uint previous) { previous=0u; uint i; if(WebTextureAddress(b,p,i)) Interlocked") +
                Op + TEXT("(b[i],v,previous); }\n");
            Helpers += TEXT("void ") + Function + TEXT("(RWStructuredBuffer<uint> b, ") + P +
                TEXT(" p, uint v) { uint previous; ") + Function + TEXT("(b,p,v,previous); }\n");
        }
    }
    Source.InsertAt(0, Helpers);
}
}
