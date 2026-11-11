#include "../../../reference-engine/Engine/Shaders/Shared/VirtualShadowMapDefinitions.h"
#include "../../../reference-engine/Engine/Shaders/Private/VirtualShadowMaps/WebVirtualShadowPoolSync.ush"

RWTexture2DArray<uint> WebShadowPoolTexture : register(u0);
RWStructuredBuffer<uint> WebShadowPoolAtomicBuffer : register(u1);
StructuredBuffer<uint> PageFlags : register(t2);
cbuffer Params : register(b3) { uint2 PoolSize; uint MaxPhysicalPages; };

[numthreads(16, 16, 1)]
void MainCS(uint2 ThreadId : SV_GroupThreadID, uint3 GroupId : SV_GroupID)
{
	if (GroupId.x < MaxPhysicalPages)
	{
		WebSyncVirtualShadowPage(WebShadowPoolTexture, WebShadowPoolAtomicBuffer,
			PoolSize, ThreadId, GroupId.x, GroupId.z, PageFlags[GroupId.x]);
	}
}
