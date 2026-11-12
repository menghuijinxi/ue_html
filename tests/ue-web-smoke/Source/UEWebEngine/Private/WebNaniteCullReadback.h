#pragma once

#include "RenderGraphUtils.h"

// Readback APIs have no source-offset argument. Copy only this instance's
// logical range when hierarchy results reside in a shared atlas.
inline FRDGBufferRef WebNaniteCullReadbackRange(FRDGBuilder& Graph, FRDGBufferRef Source, uint32 Offset, uint32 Words)
{
    check(Source && uint64(Offset) + Words <= Source->Desc.NumElements);
    if (Offset == 0 && Words == Source->Desc.NumElements) return Source;
    auto* Range = Graph.CreateBuffer(FRDGBufferDesc::CreateStructuredDesc(4, Words), TEXT("Nanite.Web.TestCullRange"));
    AddCopyBufferPass(Graph, Range, 0, Source, uint64(Offset) * 4, uint64(Words) * 4);
    return Range;
}
