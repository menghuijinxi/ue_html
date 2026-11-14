RWStructuredBuffer<uint4> Output;

// Match the engine's first-miss / all-hit SMRT stopping rules. Different groups
// exercise coherent, mixed, divergent-light and partial-viewport active lanes.
[numthreads(8, 8, 1)]
void MainCS(uint Index : SV_GroupIndex, uint3 Group : SV_GroupID)
{
    const uint OriginalFirst = WaveReadLaneFirst(Index);
    const uint Lane = WaveGetLaneIndex();
    if (Group.x == 4u && Index >= 49u)
    {
        Output[Group.x * 64u + Index] = uint4(0u, 0u, OriginalFirst, Lane);
        return;
    }
    const bool Adaptive = Group.x != 5u;
    const bool Miss = Group.x == 0u || Group.x == 4u || Group.x == 5u ||
        (Group.x >= 2u && (Lane & 1u) != 0u);
    const bool Trace = Group.x != 3u || (Lane & 1u) != 0u;
    uint Rays = 0u, Misses = 0u;
    if (Trace)
    {
        for (uint Ray = 0u; Ray < 8u; ++Ray)
        {
            ++Rays;
            Misses += Miss ? 1u : 0u;
            if (Adaptive)
            {
                if (Ray == 0u)
                {
                    if (WaveActiveAllTrue(Miss)) break;
                }
                else if (Ray >= 1u)
                {
                    if (WaveActiveAllTrue(Misses == 0u)) break;
                }
            }
        }
    }
    Output[Group.x * 64u + Index] = uint4(Rays, Misses, OriginalFirst, Lane);
}
