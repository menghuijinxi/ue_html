#include "../../../reference-engine/Engine/Shaders/Private/VirtualShadowMaps/WebVirtualShadowDepth.ush"

[[vk::binding(0, 0)]] RWStructuredBuffer<uint> DepthBuffer;
[[vk::binding(1, 0)]] cbuffer Parameters
{
    uint2 PoolExtent;
    uint LayerCount;
    uint Layer;
    uint InvalidCoordinate;
};

struct VertexOutput
{
    float4 Position : SV_Position;
    nointerpolation uint Instance : TEXCOORD0;
};

VertexOutput VS(uint Vertex : SV_VertexID, uint Instance : SV_InstanceID)
{
    VertexOutput Output;
    Output.Position = float4(Vertex == 1 ? 3 : -1, Vertex == 2 ? 3 : -1, 0.5, 1);
    Output.Instance = Instance;
    return Output;
}

void PS(VertexOutput Input)
{
    uint3 Address = uint3(uint2(Input.Position.xy), Layer);
    if (InvalidCoordinate == 1) Address.x = PoolExtent.x;
    if (InvalidCoordinate == 2) Address.y = PoolExtent.y;
    if (InvalidCoordinate == 3) Address.z = LayerCount;
    // Three overlapping draws must keep the largest depth, independent of ordering.
    uint Depth = asuint(InvalidCoordinate ? 1.0f :
        Input.Instance == 0 ? 0.75f : Input.Instance == 1 ? 0.25f : 0.5f);
    WebStoreVirtualShadowDepth(DepthBuffer, PoolExtent, LayerCount, Address, Depth);
}
