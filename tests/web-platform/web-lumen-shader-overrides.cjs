'use strict';
const web = lines => ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU', ...lines, '#endif'].join('\n');
const branch = (before, lines) => ({before,
  after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU', ...lines, '#else', before, '#endif'].join('\n')});
const storage = (before, format) => ({before,
  after: web([`[[vk::image_format("${format}")]] [[vk::ext_decorate(25)]]`]) + '\n' + before});
module.exports = new Map([
  ['Private/Lumen/LumenRadianceCache.usf', [
    branch('groupshared uint4 SharedIdealProbeOffset;', [
      '// Scalar slots keep atomic addresses out of vector components in the SPIR-V reader.',
      'groupshared uint WebSharedIdealProbeOffset[4];']),
    branch('\t\tSharedIdealProbeOffset = 0;', [
      ...[0, 1, 2, 3].map(index => `\t\tWebSharedIdealProbeOffset[${index}] = 0;`)]),
    branch('\t\t\t\t\t\tInterlockedAdd(SharedIdealProbeOffset.w, 1);', [
      '\t\t\t\t\t\tInterlockedAdd(WebSharedIdealProbeOffset[3], 1);']),
    branch(['x', 'y', 'z'].map(axis =>
      `\t\t\t\t\t\tInterlockedAdd(SharedIdealProbeOffset.${axis}, QuantizedIdealProbeOffset.${axis});`).join('\n'), [
      ...['x', 'y', 'z'].map((axis, index) =>
        `\t\t\t\t\t\tInterlockedAdd(WebSharedIdealProbeOffset[${index}], QuantizedIdealProbeOffset.${axis});`)]),
    branch('\t\tfloat NumSamples = SharedIdealProbeOffset.w;', [
      '\t\tfloat NumSamples = WebSharedIdealProbeOffset[3];']),
    branch('\t\t\tfloat3 AccumulatedIdealProbePosition = (SharedIdealProbeOffset.xyz / NumSamples - QuantizeScaleAndBias.y) / QuantizeScaleAndBias.x;', [
      '\t\t\tuint3 IdealProbeOffsetSum = uint3(WebSharedIdealProbeOffset[0], WebSharedIdealProbeOffset[1], WebSharedIdealProbeOffset[2]);',
      '\t\t\tfloat3 AccumulatedIdealProbePosition = (IdealProbeOffsetSum / NumSamples - QuantizeScaleAndBias.y) / QuantizeScaleAndBias.x;']),
  ]],
  ['Private/Lumen/Radiosity/LumenRadiosity.usf', [
    {before: 'RWTexture2D<float3> RWRadiosityAtlas;',
      after: 'RWTexture2D<float3> RWRadiosityAtlas;\n' +
        web(['Texture2D<float3> WebRadiosityHistoryAtlas;'])},
    branch('\t\tfloat3 HistoryRadiosity = RWRadiosityAtlas[RadiosityTexel.AtlasCoord];', [
      '\t\tfloat3 HistoryRadiosity = WebRadiosityHistoryAtlas.Load(int3(RadiosityTexel.AtlasCoord, 0));']),
  ]],
  ['Private/Lumen/LumenSceneDirectLightingCulling.usf', [
    branch('\t\t\twhile (NumPackedLightSamples < MAX_LIGHT_SAMPLES)', [
      '\t\t\t// Keep every reduction barrier in a statically uniform loop.',
      '\t\t\tfor (uint WebLightSampleIteration = 0; WebLightSampleIteration < MAX_LIGHT_SAMPLES; ++WebLightSampleIteration)']),
    {before: '\t\t\t\tif (SelectedPackedSample == 0)\n\t\t\t\t{\n\t\t\t\t\tbreak;\n\t\t\t\t}',
      after: ['#if !(defined(COMPILER_WEBGPU) && COMPILER_WEBGPU)',
        '\t\t\t\tif (SelectedPackedSample == 0)', '\t\t\t\t{', '\t\t\t\t\tbreak;',
        '\t\t\t\t}', '#endif'].join('\n')},
    {before: '\t\t\t\tMergedLightSampleAccumulator.PackedSamples[NumPackedLightSamples] = SelectedPackedSample;\n\t\t\t\t++NumPackedLightSamples;',
      after: '\t\t\t\tMergedLightSampleAccumulator.PackedSamples[NumPackedLightSamples] = SelectedPackedSample;\n' +
        branch('\t\t\t\t++NumPackedLightSamples;', [
          '\t\t\t\tNumPackedLightSamples += SelectedPackedSample != 0 ? 1 : 0;']).after},
    {before: '\t\tValue = SharedScratchMemory[0];\n\t}\n\n\treturn Value;\n}\n\nuint GroupReadThreadFirst',
      after: ['\t\tValue = SharedScratchMemory[0];',
        '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '\t\t// Publish a uniform shared result before another iteration can reuse scratch.',
        '\t\tGroupMemoryBarrierWithGroupSync();', '#endif',
        '\t}', '', '\treturn Value;', '}', '', 'uint GroupReadThreadFirst'].join('\n')},
    {before: '\t\tValue = SharedScratchMemory[0];\n\t}\n\n\treturn Value;\n}\n\n/**',
      after: ['\t\tValue = SharedScratchMemory[0];',
        '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '\t\tGroupMemoryBarrierWithGroupSync();', '#endif',
        '\t}', '', '\treturn Value;', '}', '', '/**'].join('\n')},
  ]],
  ['Private/ShadingModelsSampling.ush', [
    {before: 'FBxDFSample SampleBxDF(const uint TermMask, FGBufferData GBuffer, float3 V, float4 E)\n{',
      after: ['FBxDFSample SampleBxDF(const uint TermMask, FGBufferData GBuffer, float3 V, float4 E)', '{',
        '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '\t// Preserve material sampling without empty switch labels that lower to SPIR-V fallthrough.',
        '\tconst uint ShadingModelID = GBuffer.ShadingModelID;',
        '\tif (ShadingModelID == SHADINGMODELID_HAIR)',
        '\t\treturn SampleHairBxDF(TermMask, GBuffer, V, E);',
        '\tif (ShadingModelID == SHADINGMODELID_DEFAULT_LIT ||',
        ...['SINGLELAYERWATER', 'SUBSURFACE', 'SUBSURFACE_PROFILE', 'PREINTEGRATED_SKIN',
          'CLEAR_COAT', 'TWOSIDED_FOLIAGE', 'CLOTH'].map(name =>
          `\t\tShadingModelID == SHADINGMODELID_${name} ||`),
        '\t\tShadingModelID == SHADINGMODELID_EYE)',
        '\t\treturn SampleDefaultLitBxDF(TermMask, GBuffer, V, E);',
        '\treturn (FBxDFSample)0;', '#else'].join('\n')},
    {before: '\n}\n\nbool SupportsSampleBxDF(uint ShadingModelID)',
      after: '\n#endif\n}\n\nbool SupportsSampleBxDF(uint ShadingModelID)'},
  ]],
  ['Private/Lumen/LumenScene.usf', [
    branch('RWStructuredBuffer<uint2> RWSceneAddOps;', [
      '// Preserve the uint2 readback layout, avoiding atomics on vector components.',
      'RWStructuredBuffer<uint> RWSceneAddOps;']),
    branch('\t\t\t\t\tInterlockedAdd(RWSceneAddOps[0].x, 1, ElementIndex);', [
      '\t\t\t\t\tInterlockedAdd(RWSceneAddOps[0], 1, ElementIndex);']),
    branch('\t\t\t\t\t\tRWSceneAddOps[ElementIndex + 1] = uint2(PrimitiveGroupIndex, asuint(DistanceSquared));', [
      '\t\t\t\t\t\tRWSceneAddOps[2 * (ElementIndex + 1)] = PrimitiveGroupIndex;',
      '\t\t\t\t\t\tRWSceneAddOps[2 * (ElementIndex + 1) + 1] = asuint(DistanceSquared);']),
  ]],
  ['Private/Lumen/LumenScreenProbeGatherScreenData.usf', [
    storage('RWTexture2D<UNORM float> RWScreenProbeDisocclusion;', 'r8'),
    storage('RWTexture2D<float> RWBRDFProbabilityDensityFunction;', 'r16f'),
    {before: 'groupshared uint SharedNumElements;', after:
      'groupshared uint SharedNumElements;\n' + web(['groupshared uint WebSharedNumElementsAtomic;'])},
    {before: '\t\t\t\tSharedNumElements = 0;', after:
      '\t\t\t\tSharedNumElements = 0;\n' + web(['\t\t\t\tWebSharedNumElementsAtomic = 0;'])},
    branch('\t\t\t\tInterlockedAdd(SharedNumElements, 1, Index);', [
      '\t\t\t\tInterlockedAdd(WebSharedNumElementsAtomic, 1, Index);']),
    {before: '\t\t\tuint NumElementsToAccumulate = RoundUpToPowerOfTwo(SharedNumElements);',
      after: web(['\t\t\t// Publish once so loop barriers depend on a uniform shared value.',
        '\t\t\tif (ThreadIndex == 0)', '\t\t\t{',
        '\t\t\t\tSharedNumElements = WebSharedNumElementsAtomic;', '\t\t\t}',
        '\t\t\tGroupMemoryBarrierWithGroupSync();',
        '\t\t\tconst uint WebUniformNumElements = SharedNumElements;',
        '\t\t\tGroupMemoryBarrierWithGroupSync();',
        '\t\t\tuint NumElementsToAccumulate = RoundUpToPowerOfTwo(WebUniformNumElements);'])
        .replace(/\n#endif$/, '\n#else\n\t\t\tuint NumElementsToAccumulate = RoundUpToPowerOfTwo(SharedNumElements);\n#endif')},
  ]],
  ['Private/Lumen/LumenScreenProbeGather.usf', [
    storage('RWTexture2D<uint> RWScreenProbeWorldSpeed;', 'r16ui'),
    storage('RWTexture2D<UNORM float2> RWScreenProbeWorldNormal;', 'rg8'),
    {before: 'RWTexture2D<uint> RWScreenTileAdaptiveProbeHeader;', after:
      web(['RWStructuredBuffer<uint> RWWebAdaptiveProbeHeader;', 'uint WebAdaptiveProbeHeaderWidth;']) +
      '\nRWTexture2D<uint> RWScreenTileAdaptiveProbeHeader;'},
    storage('RWTexture2D<uint> RWScreenTileAdaptiveProbeIndices;', 'r16ui'),
    storage('RWTexture2D<uint> RWAdaptiveProbePlacementMask;', 'r16ui'),
    branch('\t\tInterlockedAdd(RWScreenTileAdaptiveProbeHeader[ScreenTileCoord], 1, TileProbeIndex);', [
      '\t\tInterlockedAdd(RWWebAdaptiveProbeHeader[ScreenTileCoord.y * WebAdaptiveProbeHeaderWidth + ScreenTileCoord.x], 1, TileProbeIndex);']),
  ]],
]);
