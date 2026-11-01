#pragma once

#include "Internationalization/Regex.h"

namespace UE::WebGPUShader
{
// Keep the mesh's packed storage. A tiny RHI-owned uniform describes the SRV
// format, which can vary between meshes sharing the same material shader.
inline const TCHAR* VertexFetchNames[] = {
    TEXT("LocalVF_VertexFetch_TexCoordBuffer"),
    TEXT("LocalVF_VertexFetch_PackedTangentsBuffer"),
    TEXT("LocalVF_VertexFetch_ColorComponentsBuffer"),
    TEXT("GPUSkinPassThroughVFLooseParameters_PreSkinnedTangentBuffer")
};

inline void LowerVertexFetch(FString& Source)
{
    FString Functions;
    for (int32 Slot = 0; Slot < UE_ARRAY_COUNT(VertexFetchNames); ++Slot)
    {
        const FString Name = VertexFetchNames[Slot];
        FRegexMatcher Declaration(FRegexPattern(TEXT("\\bBuffer\\s*<\\s*float([24])\\s*>\\s+") + Name + TEXT("\\s*;")), Source);
        if (!Declaration.FindNext()) continue;
        const bool UV = Declaration.GetCaptureGroup(1) == TEXT("2");
        Source.RemoveAt(Declaration.GetMatchBeginning(), Declaration.GetMatchEnding() - Declaration.GetMatchBeginning());
        Source.InsertAt(Declaration.GetMatchBeginning(), TEXT("ByteAddressBuffer ") + Name + TEXT(";"));
        const FString Function = TEXT("WebFetch_") + Name;
        int32 Cursor = 0;
        while ((Cursor = Source.Find(Name, ESearchCase::CaseSensitive, ESearchDir::FromStart, Cursor)) != INDEX_NONE)
        {
            const int32 Begin = Cursor;
            Cursor += Name.Len();
            // Uniform declarations and unindexed references are left intact.
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
            checkf(!Depth, TEXT("Unbalanced vertex fetch index"));
            const FString Replacement = Function + TEXT("(") + Source.Mid(IndexBegin, Cursor - IndexBegin - 1) + TEXT(")");
            Source.RemoveAt(Begin, Cursor - Begin);
            Source.InsertAt(Begin, Replacement);
            Cursor = Begin + Replacement.Len();
        }
        FString Body = FString::Printf(TEXT("float%s %s(uint i) { uint f = WebVertexFetchFormatCodes[%d]; "),
            UV ? TEXT("2") : TEXT("4"), *Function, Slot);
        Body += FString::Printf(TEXT("uint bytes; %s.GetDimensions(bytes); uint stride = %s; if (i >= bytes / stride) return 0; "),
            *Name, UV ? TEXT("f == 1u ? 4u : 8u") : TEXT("(f == 3u || f == 5u) ? 4u : (f == 4u ? 8u : 16u)"));
        if (UV)
        {
            // Format codes are backend-local, not EPixelFormat ordinals.
            Body += FString::Printf(TEXT("if (f == 1u) { uint w = %s.Load(i * 4u); return float2(f16tof32(w & 65535u), f16tof32(w >> 16u)); } return asfloat(%s.Load2(i * 8u)); }\n"), *Name, *Name);
        }
        else
        {
            Body += FString::Printf(TEXT("if (f == 3u) { uint w = %s.Load(i * 4u); return max(float4(int(w << 24u) >> 24, int(w << 16u) >> 24, int(w << 8u) >> 24, int(w) >> 24) / 127.0f, -1.0f); } "), *Name);
            Body += FString::Printf(TEXT("if (f == 4u) { uint2 w = %s.Load2(i * 8u); return max(float4(int(w.x << 16u) >> 16, int(w.x) >> 16, int(w.y << 16u) >> 16, int(w.y) >> 16) / 32767.0f, -1.0f); } "), *Name);
            Body += FString::Printf(TEXT("if (f == 5u) { uint w = %s.Load(i * 4u); return float4(w & 255u, (w >> 8u) & 255u, (w >> 16u) & 255u, w >> 24u) / 255.0f; } if (f == 7u) return float4(0,0,0,0); return asfloat(%s.Load4(i * 16u)); }\n"), *Name, *Name);
        }
        // Functions must follow their resource declaration and precede uses.
        const FString ResourceDeclaration = TEXT("ByteAddressBuffer ") + Name + TEXT(";");
        const int32 AfterDeclaration = Source.Find(ResourceDeclaration) + ResourceDeclaration.Len();
        Source.InsertAt(AfterDeclaration, TEXT("\n") + Body);
        Functions += Name;
    }
    if (!Functions.IsEmpty())
        Source.InsertAt(0, TEXT("cbuffer WebVertexFetchFormats { uint4 WebVertexFetchFormatCodes; };\n"));
}
}
