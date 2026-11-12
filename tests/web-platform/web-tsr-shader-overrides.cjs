'use strict';

const web = lines => ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU', ...lines, '#endif'].join('\n');
const branch = (before, lines) => ({before,
  after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU', ...lines, '#else', before, '#endif'].join('\n')});
const storage = (before, format) => ({before,
  after: web([`[[vk::image_format("${format}")]] [[vk::ext_decorate(25)]]`]) + '\n' + before});
const readWriteStorage = (before, format) => ({before,
  after: web([`[[vk::image_format("${format}")]]`]) + '\n' + before});
const color = (before, condition = 'CONFIG_SCENE_COLOR_ALPHA') => ({before,
  after: web([`#if ${condition}`, '[[vk::image_format("rgba16f")]]', '#else',
    '[[vk::image_format("r11g11b10f")]]', '#endif', '[[vk::ext_decorate(25)]]']) + '\n' + before});
const historyColor = before => color(before, '!WEB_TSR_HISTORY_R11G11B10');
const directory = 'Private/TemporalSuperResolution/';

module.exports = new Map([
  ['TSRCommon.ush', [
    {before: '#include "../ScreenPass.ush"',
      after: ['#include "../ScreenPass.ush"', web([
        '// Match the platform\'s LDS path instead of the Vulkan compiler\'s wave defaults.',
        ...['ONCE', 'VOTE', 'SHUFFLE'].flatMap(name => [
          `#undef COMPILER_SUPPORTS_WAVE_${name}`, `#define COMPILER_SUPPORTS_WAVE_${name} 0`]),
      ])].join('\n')},
    storage('\tRWTexture2DArray<float4> DebugOutput;', 'rgba16f'),
  ]],
  ['TSRShadingAnalysis.ush', [
    branch('\t\tCurrentGradient.SetElement(ElementIndex, clamp(LocalCurrentGradient * tsr_half(POSITIVE_INFINITY), tsr_half(-1.0), tsr_half(1.0)) * max(abs(LocalCurrentGradient) - LocalInputLumaModification, tsr_half(0.0)));', [
      '\t\t// Preserve the gradient direction without an infinity module constant.',
      '\t\tCurrentGradient.SetElement(ElementIndex, sign(LocalCurrentGradient) * max(abs(LocalCurrentGradient) - LocalInputLumaModification, tsr_half(0.0)));',
    ]),
  ]],
  ['TSRClosestOccluder.ush', [{
    before: '//------------------------------------------------------- HOLE FILLING VELOCITY ENCODING',
    after: [web([
      '// Flatten the array identically in clear, scatter and history reprojection.',
      '#define TSR_ATOMIC_UAV RWStructuredBuffer<uint>',
      '#define TSR_ATOMIC_SRV StructuredBuffer<uint>',
      'uint WebTSRAtomicIndex(uint3 PixelPos)',
      '{',
      '\tuint2 Extent = uint2(InputInfo_Extent);',
      '\treturn (PixelPos.z * Extent.y + PixelPos.y) * Extent.x + PixelPos.x;',
      '}',
      'bool WebTSRAtomicInBounds(uint3 PixelPos)',
      '{',
      '\treturn all(PixelPos.xy < uint2(InputInfo_Extent)) && PixelPos.z < (IsOrthoProjection() ? 2u : 1u);',
      '}',
      'void WebTSRAtomicMax(RWStructuredBuffer<uint> Output, uint3 PixelPos, uint Value, out uint Original)',
      '{',
      '\tOriginal = 0;',
      '\tif (WebTSRAtomicInBounds(PixelPos))',
      '\t\tInterlockedMax(Output[WebTSRAtomicIndex(PixelPos)], Value, Original);',
      '}',
      'void WebTSRAtomicMax(RWStructuredBuffer<uint> Output, uint3 PixelPos, uint Value)',
      '{',
      '\tuint Original;',
      '\tWebTSRAtomicMax(Output, PixelPos, Value, Original);',
      '}',
      'uint WebTSRAtomicLoad(StructuredBuffer<uint> Input, uint3 PixelPos)',
      '{',
      '\treturn WebTSRAtomicInBounds(PixelPos) ? Input[WebTSRAtomicIndex(PixelPos)] : 0u;',
      '}',
    ]), '#if !(defined(COMPILER_WEBGPU) && COMPILER_WEBGPU)',
    '#define TSR_ATOMIC_UAV globallycoherent RWTexture2DArray<uint>',
    '#define TSR_ATOMIC_SRV Texture2DArray<uint>', '#endif', '',
    '//------------------------------------------------------- HOLE FILLING VELOCITY ENCODING'].join('\n'),
  }, {
    before: 'void ScatterClosestOccluder(globallycoherent RWTexture2DArray<uint> PrevAtomicOutput,',
    after: 'void ScatterClosestOccluder(TSR_ATOMIC_UAV PrevAtomicOutput,',
  }, {
    before: '\tTexture2DArray<uint> PrevAtomicTextureArray,',
    after: '\tTSR_ATOMIC_SRV PrevAtomicTextureArray,',
  },
  ...[
    ['tsr_ushort3(PixelPos, 0)', 'PrevClosestDepth0, /* out */ PreviousDepth0'],
    ['tsr_ushort3(PixelPos, 1)', 'PrevClosestDepth1'],
    ['tsr_ushort3(PixelPos, 0)', 'PrevClosestDepth'],
  ].map(([coordinate, values]) => branch(
    `\t\t\tInterlockedMax(PrevAtomicOutput[${coordinate}], ${values});`,
    [`\t\t\tWebTSRAtomicMax(PrevAtomicOutput, ${coordinate}, ${values});`])),
  ...[0, 1].map(layer => branch(
    `${layer ? '\t\t\t' : '\t\t'}HistoryClosestDeviceZSamples${layer}[i] = PrevAtomicTextureArray[uint3(PixelPos, ${layer})];`,
    [`${layer ? '\t\t\t' : '\t\t'}HistoryClosestDeviceZSamples${layer}[i] = WebTSRAtomicLoad(PrevAtomicTextureArray, uint3(PixelPos, ${layer}));`])),
  ]],
  ['TSRClearPrevTextures.usf', [
    branch('RWTexture2DArray<uint> PrevAtomicOutput;', ['RWStructuredBuffer<uint> WebPrevAtomicOutput;']),
    ...[0, 1].map(layer => branch(
      `${layer ? '\t\t\t\t' : '\t\t\t'}PrevAtomicOutput[uint3(InputPixelPos, ${layer})] = 0;`,
      [`${layer ? '\t\t\t\t' : '\t\t\t'}if (WebTSRAtomicInBounds(uint3(InputPixelPos, ${layer})))`,
        `${layer ? '\t\t\t\t\t' : '\t\t\t\t'}WebPrevAtomicOutput[WebTSRAtomicIndex(uint3(InputPixelPos, ${layer}))] = 0;`])),
  ]],
  ['TSRDilateVelocity.usf', [
    branch('globallycoherent RWTexture2DArray<uint> PrevAtomicOutput;',
      ['RWStructuredBuffer<uint> WebPrevAtomicOutput;', '#define PrevAtomicOutput WebPrevAtomicOutput']),
    storage('RWTexture2D<float2> ClosestDepthOutput;', 'rg32f'),
    storage('RWTexture2DArray<uint> ReprojectionFieldOutput;', 'r32ui'),
    storage('RWTexture2DArray<uint> R8Output;', 'r32ui'),
    {before: 'RWTexture2D<float3>\tVelocityFlattenOutput;',
      after: web(['#if WEB_TSR_VELOCITY_RGBA32', '[[vk::image_format("rgba32f")]]', '#else',
        '[[vk::image_format("r11g11b10f")]]', '#endif', '[[vk::ext_decorate(25)]]']) +
        '\nRWTexture2D<float3>\tVelocityFlattenOutput;'},
    storage('RWTexture2DArray<float4> VelocityTileArrayOutput;', 'rgba16f'),
  ]],
  ['TSRDecimateHistory.usf', [
    branch('Texture2DArray<uint> PrevAtomicTextureArray;',
      ['StructuredBuffer<uint> WebPrevAtomicBuffer;', '#define PrevAtomicTextureArray WebPrevAtomicBuffer']),
    storage('RWTexture2DArray<tsr_half4> ReprojectedHistoryGuideOutput;', 'rgba16f'),
    storage('RWTexture2DArray<tsr_half4> ReprojectedHistoryMoireOutput;', 'rgba8'),
    storage('    RWTexture2DArray<tsr_half> ReprojectedHistoryCoverageOutput;', 'r8'),
    storage('RWTexture2DArray<uint> ReprojectionFieldOutput;', 'r32ui'),
    storage('RWTexture2D<tsr_half2> DecimateMaskOutput;', 'rg8'),
  ]],
  ['TSRConvolutionNetworkPass.ush', [{
    before: '\t#define GROUP_TILE_SIZE 32',
    after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU && !WEB_TSR_LARGE_TILE',
      '\t// The 256-invocation fallback retains the same filter halo as the large tile.',
      '\t#define GROUP_TILE_SIZE 16', '#else', '\t#define GROUP_TILE_SIZE 32', '#endif'].join('\n'),
    count: 2,
  }]],
  ['TSRConvolutionNetwork.ush', [{
    before: 'groupshared uint SharedAtomic;',
    after: 'groupshared uint SharedAtomic;\n' + web(['groupshared uint WebTSRAnyThreadResult;']),
  }, {
    before: '#if WAVE_COUNT_X == 1 && WAVE_COUNT_Y == 1 && COMPILER_SUPPORTS_WAVE_VOTE',
    after: [
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU', '{',
      '\tGroupMemoryBarrierWithGroupSync();',
      '\tif (GGroupThreadIndex == 0)', '\t\tSharedAtomic = 0;',
      '\tGroupMemoryBarrierWithGroupSync();',
      '\tInterlockedOr(SharedAtomic, X ? 1u : 0u);',
      '\tGroupMemoryBarrierWithGroupSync();',
      '\tif (GGroupThreadIndex == 0)', '\t\tWebTSRAnyThreadResult = SharedAtomic;',
      '\t// Tint recognizes this barrier/load/barrier as workgroupUniformLoad.',
      '\tGroupMemoryBarrierWithGroupSync();',
      '\tuint Result = WebTSRAnyThreadResult;',
      '\tGroupMemoryBarrierWithGroupSync();', '\treturn Result != 0;', '}',
      '#elif WAVE_COUNT_X == 1 && WAVE_COUNT_Y == 1 && COMPILER_SUPPORTS_WAVE_VOTE',
    ].join('\n'),
  }]],
  ['TSRMeasureCoverage.usf', [
    storage('RWTexture2DArray<float> ThinGeometryCoverageOutput;', 'r8'),
  ]],
  ['TSRMeasureFlickeringLuma.usf', [
    storage('RWTexture2DArray<tsr_half> FlickeringLumaOutput;', 'r8'),
  ]],
  ['TSRRejectShading.usf', [
    branch('\ttsr_tensor_half bResurrectedPixelIsCloser = saturate((TotalMatchDiff - tsr_tensor_half::Const(tsr_half(0.05 * 3.0 * 9.0))) * tsr_tensor_half::Const(tsr_half(POSITIVE_INFINITY)));', [
      '\ttsr_tensor_half bResurrectedPixelIsCloser = select(TotalMatchDiff > tsr_tensor_half::Const(tsr_half(0.05 * 3.0 * 9.0)), tsr_tensor_half::Const(1.0), tsr_tensor_half::Const(0.0));',
    ]),
    storage('RWTexture2DArray<tsr_half4_resource> HistoryGuideOutput;', 'rgba16f'),
    storage('RWTexture2DArray<tsr_half4_resource> HistoryMoireOutput;', 'rgba8'),
    storage('RWTexture2D<tsr_half4_resource>  HistoryRejectionOutput;', 'rgba8'),
    storage('RWTexture2DArray<uint>  ReprojectionFieldOutput;', 'r32ui'),
    historyColor('RWTexture2D<tsr_halfC_resource>  InputSceneColorOutput;'),
    storage('RWTexture2D<tsr_half_resource>   InputSceneColorLdrLumaOutput;', 'r8'),
    storage('RWTexture2D<tsr_ushort_resource> AntiAliasMaskOutput;', 'r32ui'),
  ]],
  ['TSRDetectThinGeometry.usf', [
    branch('\t\t\t\ttsr_tensor_half bDecay = bDark * saturate((DecayProbability - Noise) * tsr_tensor_half::Const(tsr_half(POSITIVE_INFINITY)));', [
      '\t\t\t\ttsr_tensor_half bDecay = bDark * select(Noise < DecayProbability, tsr_tensor_half::Const(1.0), tsr_tensor_half::Const(0.0));',
    ]),
    storage('RWTexture2DArray<tsr_half> HistoryCoverageOutput;', 'r8'),
    readWriteStorage('RWTexture2DArray<tsr_ushort> R8Output;', 'r32ui'),
  ]],
  ['TSRWeightRelaxation.usf', [
    readWriteStorage('RWTexture2DArray<tsr_ushort> R8Output;', 'r32ui'),
    storage('RWTexture2DArray<tsr_half> HistoryCoverageOutput;', 'r8'),
  ]],
  ['TSRSpatialAntiAliasing.usf', [
    storage('RWTexture2D<tsr_ushort2> AntiAliasingOutput;', 'rg32ui'),
  ]],
  ['TSRSpatialAntiAliasing.ush', [{
    before: 'float BilinearSampleAAInput(Texture2D<float> Texture, float2 KernelCenterUV, float2 UVOffset, const bool bIsNegativeDirection)',
    after: [web([
      'float WebTSRBilinearAAInput(Texture2D<float> Texture, float2 UV)', '{',
      '\tuint Width, Height;', '\tTexture.GetDimensions(Width, Height);',
      '\tfloat2 Position = UV * float2(Width, Height) - 0.5;',
      '\tint2 Base = int2(floor(Position));', '\tint2 Maximum = int2(Width, Height) - 1;',
      '\tfloat2 Fraction = frac(Position);',
      '\tfloat A = Texture.Load(int3(clamp(Base, int2(0, 0), Maximum), 0));',
      '\tfloat B = Texture.Load(int3(clamp(Base + int2(1, 0), int2(0, 0), Maximum), 0));',
      '\tfloat C = Texture.Load(int3(clamp(Base + int2(0, 1), int2(0, 0), Maximum), 0));',
      '\tfloat D = Texture.Load(int3(clamp(Base + int2(1, 1), int2(0, 0), Maximum), 0));',
      '\treturn lerp(lerp(A, B, Fraction.x), lerp(C, D, Fraction.x), Fraction.y);', '}',
    ]), '', 'float BilinearSampleAAInput(Texture2D<float> Texture, float2 KernelCenterUV, float2 UVOffset, const bool bIsNegativeDirection)'].join('\n'),
  }, branch('\treturn Texture.SampleLevel(GlobalBilinearClampedSampler, SampleUV, 0);',
    ['\treturn WebTSRBilinearAAInput(Texture, SampleUV);']),
  branch('\t\tTexture.SampleLevel(GlobalBilinearClampedSampler, dpv_lo(SampleUV), 0),\n\t\tTexture.SampleLevel(GlobalBilinearClampedSampler, dpv_hi(SampleUV), 0));', [
    '\t\tWebTSRBilinearAAInput(Texture, dpv_lo(SampleUV)),',
    '\t\tWebTSRBilinearAAInput(Texture, dpv_hi(SampleUV)));',
  ])]],
  ['TSRUpdateHistory.usf', [
    historyColor('RWTexture2DArray<tsr_halfC> HistoryColorOutput;'),
    storage('RWTexture2DArray<tsr_halfM> HistoryMetadataOutput;', 'r8'),
    color('RWTexture2DArray<tsr_halfC> SceneColorOutputMip1;', '!WEB_TSR_OUTPUT_R11G11B10'),
  ]],
  ['TSRResolveHistory.usf', [
    branch('\t\t\ttsr_halfC MinColor = tsr_half(POSITIVE_INFINITY);', [
      '\t\t\ttsr_halfC MinColor = tsr_half(3.402823466e+38f);',
    ]),
    color('RWTexture2D<tsr_halfC> SceneColorOutputMip0;'),
    color('RWTexture2D<tsr_halfC> SceneColorOutputMip1;'),
  ]],
  ['TSRVisualize.usf', [
    storage('RWTexture2D<tsr_half4> Output;', 'rgba16f'),
  ]],
].map(([file, replacements]) => [directory + file, replacements]));
