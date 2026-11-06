struct VertexOutput
{
    float4 Position : SV_Position;
    float4 Clip : SV_ClipDistance;
};

VertexOutput Main(uint Vertex : SV_VertexID)
{
    float2 Positions[3] = {float2(-1, -1), float2(3, -1), float2(-1, 3)};
    VertexOutput Out;
    Out.Position = float4(Positions[Vertex], 0.5, 1);
    Out.Clip = float4(Out.Position.x, Out.Position.y, 1 - Out.Position.x, 1 - Out.Position.y);
    return Out;
}
