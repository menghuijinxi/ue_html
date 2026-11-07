RWStructuredBuffer<uint> Output;
StructuredBuffer<uint> Input;
groupshared uint Shared[32];

[numthreads(32, 1, 1)]
void ValidBarrier(uint Index : SV_GroupIndex)
{
    Shared[Index] = Input[Index];
    GroupMemoryBarrierWithGroupSync();
    Output[Index] = Shared[(Index + 1) % 32];
}

[numthreads(32, 1, 1)]
void InvalidBarrier(uint Index : SV_GroupIndex)
{
    if ((Index & 1) != 0) return;
    Shared[Index] = Input[Index];
    GroupMemoryBarrierWithGroupSync();
    Output[Index] = Shared[(Index + 2) % 32];
}

[numthreads(32, 1, 1)]
void ActiveLanes(uint Index : SV_GroupIndex)
{
    if (Index < Input[0])
        Output[Index] = WaveReadLaneAt(WavePrefixSum(Index), 0);
}
