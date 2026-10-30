const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const engine = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const stock = path.join(engine, 'Shaders');
const output = path.join(root, '.tools/ue58-web-cook-shaders');
const overrides = new Map([
  ['Private/MaterialTemplate.ush', [{
    before: '#if COMPILER_DXC && (COMPILER_VULKAN || COMPILER_GLSL_ES3_1) && (!RAYHITGROUPSHADER) && (!IS_NANITE_PASS)',
    after: ['// WebGPU keeps D3D front-face semantics when using the Vulkan compiler.',
      '#if COMPILER_DXC && (COMPILER_VULKAN || COMPILER_GLSL_ES3_1) && (!RAYHITGROUPSHADER) && (!IS_NANITE_PASS) && !(defined(COMPILER_WEBGPU) && COMPILER_WEBGPU)'].join('\n'),
  }]],
  ['Private/DistanceFieldLightingPost.usf', [{
    before: '#include "ScreenPass.ush"\n',
    after: ['#include "ScreenPass.ush"', '',
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '#define DFAO_SCREEN_INTERPOLATION noperspective', '#else',
      '#define DFAO_SCREEN_INTERPOLATION', '#endif', ''].join('\n'),
  }, {
    before: 'in float4 UVAndScreenPos : TEXCOORD0',
    after: 'in DFAO_SCREEN_INTERPOLATION float4 UVAndScreenPos : TEXCOORD0', count: 4,
  }, {
    before: '\tfloat4 EncodedVelocity = Texture2DSampleLevel(VelocityTexture, VelocityTextureSampler, FullResTexel, 0);',
    after: [
      '\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '\t// WebGPU UNORM16 velocity is unfilterable. Preserve the bilinear clamp sample with texel loads.',
      '\tuint VelocityWidth, VelocityHeight;',
      '\tVelocityTexture.GetDimensions(VelocityWidth, VelocityHeight);',
      '\tfloat2 VelocityTexel = FullResTexel * float2(VelocityWidth, VelocityHeight) - .5f;',
      '\tint2 VelocityCorner = int2(floor(VelocityTexel));',
      '\tint2 VelocityMax = int2(VelocityWidth, VelocityHeight) - 1;',
      '\tfloat2 VelocityWeight = frac(VelocityTexel);',
      '\tfloat4 Velocity00 = VelocityTexture.Load(int3(clamp(VelocityCorner, int2(0, 0), VelocityMax), 0));',
      '\tfloat4 Velocity10 = VelocityTexture.Load(int3(clamp(VelocityCorner + int2(1, 0), int2(0, 0), VelocityMax), 0));',
      '\tfloat4 Velocity01 = VelocityTexture.Load(int3(clamp(VelocityCorner + int2(0, 1), int2(0, 0), VelocityMax), 0));',
      '\tfloat4 Velocity11 = VelocityTexture.Load(int3(clamp(VelocityCorner + int2(1, 1), int2(0, 0), VelocityMax), 0));',
      '\tfloat4 EncodedVelocity = lerp(lerp(Velocity00, Velocity10, VelocityWeight.x),',
      '\t\tlerp(Velocity01, Velocity11, VelocityWeight.x), VelocityWeight.y);',
      '\t#else',
      '\tfloat4 EncodedVelocity = Texture2DSampleLevel(VelocityTexture, VelocityTextureSampler, FullResTexel, 0);',
      '\t#endif',
    ].join('\n'),
  }]],
  ['Private/DistanceFieldScreenGridLighting.usf', [{
    before: '#include "Substrate/Substrate.ush"\n',
    after: ['#include "Substrate/Substrate.ush"', '',
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '#define DFAO_SCREEN_INTERPOLATION noperspective', '#else',
      '#define DFAO_SCREEN_INTERPOLATION', '#endif', ''].join('\n'),
  }, {
    before: 'in float4 UVAndScreenPos : TEXCOORD0, ',
    after: 'in DFAO_SCREEN_INTERPOLATION float4 UVAndScreenPos : TEXCOORD0,',
  }, ...['RWDistanceFieldNormal', 'RWDistanceFieldBentNormal'].map(name => ({
    before: `RWTexture2D<float4> ${name};`,
    after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '[[vk::image_format("rgba16f")]] [[vk::ext_decorate(25)]]', '#endif',
      `RWTexture2D<float4> ${name};`].join('\n'),
  }))]],
  ['Private/DistanceFieldStreaming.usf', [{
    before: 'Buffer<float> BrickUploadData;',
    after: [
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      'StructuredBuffer<uint> BrickUploadData;',
      'float LoadDistanceFieldUpload(uint Index)',
      '{',
      '\treturn float((BrickUploadData[Index >> 2] >> ((Index & 3u) * 8u)) & 255u) / 255.0f;',
      '}',
      '#else',
      'Buffer<float> BrickUploadData;',
      'float LoadDistanceFieldUpload(uint Index)',
      '{',
      '\treturn BrickUploadData[Index];',
      '}',
      '#endif',
    ].join('\n'),
  }, {
    before: '= BrickUploadData[UploadDataReadIndex];',
    after: '= LoadDistanceFieldUpload(UploadDataReadIndex);',
  }, {
    before: 'RWTexture3D<UNORM float> RWDistanceFieldBrickAtlas;',
    after: [
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '[[vk::image_format("r8")]] [[vk::ext_decorate(25)]]', '#endif',
      'RWTexture3D<UNORM float> RWDistanceFieldBrickAtlas;',
    ].join('\n'),
  }]],
  ...['GlobalDistanceFieldCompositeObjects', 'GlobalDistanceFieldHeightfields'].map(name =>
    [`Private/DistanceField/${name}.usf`, ['RWPageAtlasTexture', 'RWCoverageAtlasTexture'].map(variable => ({
      before: `RWTexture3D<UNORM float> ${variable};`,
      after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU', '[[vk::image_format("r8")]]',
        '#endif', `RWTexture3D<UNORM float> ${variable};`].join('\n'),
    }))]),
  ['Private/DistanceField/GlobalDistanceFieldMip.usf', [{
    before: 'RWTexture3D<float> RWMipTexture;',
    after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '[[vk::image_format("r8")]] [[vk::ext_decorate(25)]]', '#endif',
      'RWTexture3D<float> RWMipTexture;'].join('\n'),
  }]],
  ['Private/TemporalAA.usf', [...['OutComputeTex_0', 'OutComputeTexDownsampled', 'OutComputeTex_1'].map(name => {
    const indent = name === 'OutComputeTex_1' ? '\t' : '';
    const declaration = `${indent}RWTexture2D<float4> ${name};`;
    return {before: declaration, after: [
      `${indent}#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU`,
      `${indent}[[vk::image_format("rgba16f")]] [[vk::ext_decorate(25)]]`,
      `${indent}#endif`, declaration].join('\n')};
  }), {
    before: '\t\tOutputPayload.CocRadius = isnan(OutputPayload.CocRadius) ? 0.0 : OutputPayload.CocRadius;',
    after: [
      '\t\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '\t\t\t// Preserve the NaN guard without an unsupported WGSL floating-point classification.',
      '\t\t\tbool InvalidCoc = (asuint(OutputPayload.CocRadius) & 0x7FFFFFFFu) > 0x7F800000u;',
      '\t\t\tOutputPayload.CocRadius = InvalidCoc ? 0.0 : OutputPayload.CocRadius;',
      '\t\t#else',
      '\t\t\tOutputPayload.CocRadius = isnan(OutputPayload.CocRadius) ? 0.0 : OutputPayload.CocRadius;',
      '\t\t#endif',
    ].join('\n'),
  }]],
  ['Private/HeightFogPixelShader.usf', [{
    before: '\tfloat LightShaftMask = Texture2DSample(OcclusionTexture, OcclusionSampler, OcclusionTexCoord).x;',
    after: [
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '\tfloat LightShaftMask = Texture2DSampleLevel(OcclusionTexture, OcclusionSampler, OcclusionTexCoord, 0).x;',
      '#else', '\tfloat LightShaftMask = Texture2DSample(OcclusionTexture, OcclusionSampler, OcclusionTexCoord).x;',
      '#endif',
    ].join('\n'),
  }]],
  ['Private/ReflectionEnvironmentPixelShader.usf',
    [
      '\tfloat4 ReflectionInput = Texture2DSample(ReflectionTexture, ReflectionTextureSampler, BufferUV);',
      '\t\tReflectionInput = Texture2DSample(ReflectionTexture, ReflectionTextureSampler, BufferUV);',
      '\t\t\tSSRReflection = Texture2DSample(ReflectionTexture, ReflectionTextureSampler, BufferUV);',
    ].map(before => ({before, after: [
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      before.replace('Texture2DSample(', 'Texture2DSampleLevel(').replace('BufferUV);', 'BufferUV, 0);'),
      '#else', before, '#endif',
    ].join('\n')}))],
  ['Private/LightGridCommon.ush', [{
    before: '#define LIGHT_GRID_USES_16BIT_BUFFERS (PLATFORM_SUPPORTS_BUFFER_LOAD_TYPE_CONVERSION && !SHADING_PATH_MOBILE)',
    after: [
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '#define LIGHT_GRID_USES_16BIT_BUFFERS 0', '#else',
      '#define LIGHT_GRID_USES_16BIT_BUFFERS (PLATFORM_SUPPORTS_BUFFER_LOAD_TYPE_CONVERSION && !SHADING_PATH_MOBILE)',
      '#endif',
    ].join('\n'),
  }]],
  ['Private/ShadingModels.ush', [{
    before: 'FDirectLighting IntegrateBxDF( FGBufferData GBuffer, half3 N, half3 V, FAreaLight AreaLight, FShadowTerms Shadow )\n{',
    after: [
      'FDirectLighting IntegrateBxDF( FGBufferData GBuffer, half3 N, half3 V, FAreaLight AreaLight, FShadowTerms Shadow )',
      '{', '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '\t// Tint\'s SPIR-V reader cannot import the shared return blocks generated for this switch.',
      '\t[branch] if (GBuffer.ShadingModelID == SHADINGMODELID_DEFAULT_LIT',
      '\t\t|| GBuffer.ShadingModelID == SHADINGMODELID_SINGLELAYERWATER',
      '\t\t|| GBuffer.ShadingModelID == SHADINGMODELID_THIN_TRANSLUCENT)',
      '\t\treturn DefaultLitBxDF( GBuffer, N, V, AreaLight, Shadow );',
      ...[
        ['SUBSURFACE', 'Subsurface'], ['PREINTEGRATED_SKIN', 'PreintegratedSkin'],
        ['CLEAR_COAT', 'ClearCoat'], ['SUBSURFACE_PROFILE', 'SubsurfaceProfile'],
        ['TWOSIDED_FOLIAGE', 'TwoSided'], ['HAIR', 'Hair'], ['CLOTH', 'Cloth'], ['EYE', 'Eye'],
      ].flatMap(([id, fn]) => [
        `\t[branch] if (GBuffer.ShadingModelID == SHADINGMODELID_${id})`,
        `\t\treturn ${fn}BxDF( GBuffer, N, V, AreaLight, Shadow );`,
      ]),
      '#if SUBSTRATE_ENABLED',
      '\t[branch] if (GBuffer.ShadingModelID == SHADINGMODELID_SUBSTRATE_TOON)',
      '\t\treturn ToonBxDF( GBuffer, N, V, AreaLight, Shadow );',
      '#endif', '\treturn (FDirectLighting)0;', '#else',
    ].join('\n'),
  }, {
    before: '\t\t\treturn (FDirectLighting)0;\n\t}\n}',
    after: '\t\t\treturn (FDirectLighting)0;\n\t}\n#endif\n}',
  }]],
  ['Private/ShadowProjectionPixelShader.usf', [{
    before: '\tfloat LightSpacePixelDepthForOpaque = min(ShadowZ, 0.99999f);',
    after: [
      '\tfloat LightSpacePixelDepthForOpaque = min(ShadowZ, 0.99999f);',
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU && SHADING_PATH_MOBILE && !MODULATED_SHADOWS',
      '\t// Account for receiver-plane depth variation across the mobile PCF footprint.',
      '\tfloat3 ReceiverDx = ddx(float3(ShadowPosition.xy, ShadowZ));',
      '\tfloat3 ReceiverDy = ddy(float3(ShadowPosition.xy, ShadowZ));',
      '\tfloat Det = ReceiverDx.x * ReceiverDy.y - ReceiverDx.y * ReceiverDy.x;',
      '\tfloat SafeDet = abs(Det) > 1.0e-12f ? Det : (Det >= 0 ? 1.0e-12f : -1.0e-12f);',
      '\tfloat2 DepthGradient = float2(ReceiverDy.y * ReceiverDx.z - ReceiverDx.y * ReceiverDy.z,',
      '\t\tReceiverDx.x * ReceiverDy.z - ReceiverDy.x * ReceiverDx.z) / SafeDet;',
      '#if MOBILE_SHADOW_QUALITY == 3',
      '\tconst float FilterRadius = 2.5f;',
      '#elif MOBILE_SHADOW_QUALITY == 2',
      '\tconst float FilterRadius = 1.5f;',
      '#else',
      '\tconst float FilterRadius = 0.5f;',
      '#endif',
      '\tif (LightPositionOrDirection.w == 0)',
      '\t\tLightSpacePixelDepthForOpaque -= min(dot(abs(DepthGradient), ShadowBufferSize.zw) * FilterRadius, 0.001f);',
      '#endif',
    ].join('\n'),
  }]],
  ['Private/MobileBasePassPixelShader.usf', [{
    before: '\t\thalf GatheredAmbientOcclusion = ScreenSpaceShadowMaskSample.a;',
    after: [
      '\t\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '\t\t\thalf GatheredAmbientOcclusion = Texture2DSample(MobileBasePass.AmbientOcclusionTexture, MobileBasePass.AmbientOcclusionSampler, BufferUV).r;',
      '\t\t#else', '\t\t\thalf GatheredAmbientOcclusion = ScreenSpaceShadowMaskSample.a;',
      '\t\t#endif',
    ].join('\n'),
  }]],
  ['Private/LightGridInjection.usf', [{
    before: '#include "WaveOpUtil.ush"',
    after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '// WGSL subgroup operations require uniform flow; use ordinary atomic allocation.',
      '#undef COMPILER_SUPPORTS_WAVE_VOTE', '#define COMPILER_SUPPORTS_WAVE_VOTE 0',
      '#endif', '#include "WaveOpUtil.ush"'].join('\n'),
  }]],
  ['Private/PostProcessMobile.usf', [
    ...[['RWBuffer', 'UAV'], ['RWBuffer', 'OutputUIntBuffer'], ['Buffer', 'LogLuminanceWeightBuffer'],
      ['RWBuffer', 'RWHistogramBuffer'], ['Buffer', 'HistogramBuffer']].map(([type, name]) => {
      const declaration = `${type}<uint> ${name};`;
      return {before: declaration, after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        `${type === 'Buffer' ? 'StructuredBuffer' : 'RWStructuredBuffer'}<uint> ${name};`,
        '#else', declaration, '#endif'].join('\n')};
    }),
    {before: '\t\tUNROLL for (uint i = 0; i < ThreadGroupSize; ++i)', after: [
      '\t\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU', '\t\tLOOP', '\t\t#else',
      '\t\tUNROLL', '\t\t#endif', '\t\tfor (uint i = 0; i < ThreadGroupSize; ++i)'
    ].join('\n')},
    {before: '\t\tWriteToHistogramBuffer(GroupIndex, NormalizeFactor);', after: [
      '\t\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU && LOW_SHARED_COMPUTE_MEMORY',
      '\t\tWriteToHistogramBuffer(GroupIndex * 2, NormalizeFactor);', '\t\t#else',
      '\t\tWriteToHistogramBuffer(GroupIndex, NormalizeFactor);', '\t\t#endif'
    ].join('\n')},
  ]],
  ['Private/PostProcessHistogramCommon.ush', [
    {before: 'float GetHistogramBucket(Buffer<uint> HistogramBuffer, uint BucketIndex)', after: [
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '#define HISTOGRAM_BUFFER_TYPE StructuredBuffer<uint>',
      '#else', '#define HISTOGRAM_BUFFER_TYPE Buffer<uint>', '#endif', '',
      'float GetHistogramBucket(HISTOGRAM_BUFFER_TYPE HistogramBuffer, uint BucketIndex)'
    ].join('\n')},
    {before: 'float ComputeHistogramSum(Buffer<uint> HistogramBuffer)',
      after: 'float ComputeHistogramSum(HISTOGRAM_BUFFER_TYPE HistogramBuffer)'},
    {before: '// @param MinFractionSum e.g. ComputeHistogramSum() * 0.5f for 50% percentil',
      after: '#undef HISTOGRAM_BUFFER_TYPE\n\n// @param MinFractionSum e.g. ComputeHistogramSum() * 0.5f for 50% percentil'},
  ]],
  ...['Private/PostProcessCombineLUTs.usf', 'Private/PostProcessCombineLUTsInner.usf'].map(file => {
    const declaration = 'RWTexture3D<float4> RWOutputTexture;';
    return [file, [{before: declaration, after: [
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '[[vk::image_format("rgba16f")]] [[vk::ext_decorate(25)]]', '#endif', declaration
    ].join('\n')}]];
  }),
  ['Private/SkyAtmosphere.usf', [
    ...[
      'RWTexture2D<float4> TransmittanceLutUAV;',
      'RWTexture2D<float4> MultiScatteredLuminanceLutUAV;',
    ].map(declaration => ({
      before: `#if SHADING_PATH_MOBILE\n${declaration}`,
      after: `#if SHADING_PATH_MOBILE || (defined(COMPILER_WEBGPU) && COMPILER_WEBGPU)\n${declaration}`,
    })),
    ...[
      'TransmittanceLutUAV[int2(PixPos)] = float4(transmittance, 0.0f);',
      'MultiScatteredLuminanceLutUAV[int2(PixPos)] = float4(L * Atmosphere.MultiScatteringFactor, 0.0f);',
    ].map(assignment => ({
      before: `#if SHADING_PATH_MOBILE\n\t${assignment}`,
      after: `#if SHADING_PATH_MOBILE || (defined(COMPILER_WEBGPU) && COMPILER_WEBGPU)\n\t${assignment}`,
    })),
    ...['TransmittanceLutUAV', 'MultiScatteredLuminanceLutUAV', 'SkyViewLutUAV',
      'CameraAerialPerspectiveVolumeUAV', 'CameraAerialPerspectiveVolumeMieOnlyUAV',
      'CameraAerialPerspectiveVolumeRayOnlyUAV'].map(name => {
      const declaration = `RWTexture${name.startsWith('Camera') ? '3D' : '2D'}<float4> ${name};`;
      return {before: declaration, after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '[[vk::image_format("rgba16f")]] [[vk::ext_decorate(25)]]', '#endif', declaration].join('\n')};
    }),
    ...[['Buffer', 'UniformSphereSamplesBuffer'], ['RWBuffer', 'MobileDistantSkyLightLutBufferUAV']]
      .map(([type, name]) => {
        const declaration = `${type}<float4> ${name};`;
        return {before: '\n' + declaration, after: '\n' + [
          '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
          `${type === 'Buffer' ? 'StructuredBuffer' : 'RWStructuredBuffer'}<float4> ${name};`,
          '#else', declaration, '#endif'].join('\n')};
      }),
  ]],
  ['Private/VolumetricRenderTarget.usf', [{
    before: '#if SUBSTRATE_GBUFFER_FORMAT==1',
    after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU && SHADING_PATH_MOBILE',
      '\t// Mobile forward uses the same conservative depth handling as desktop forward.',
      '\tconst bool bIsWaterPixel = true;', '#elif SUBSTRATE_GBUFFER_FORMAT==1'].join('\n'),
  }, {
    before: '\t// ==> This path is when compute shader is disable and so no minmax depth texture is available. It is also used by VRT.Mode=1 for upsampling based on front depth only.',
    after: [
      '\t// ==> This path is when compute shader is disable and so no minmax depth texture is available. It is also used by VRT.Mode=1 for upsampling based on front depth only.',
      '', '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '\t// Reprojected sky samples must not blend over newly visible opaque geometry.',
      '\tconst bool bAllCloudSamplesBehindSurface = all(float4(VolumeFrontDepth0.x, VolumeFrontDepth1.x,',
      '\t\tVolumeFrontDepth2.x, VolumeFrontDepth3.x) > (PixelDistanceFromViewKm + 0.00001f));',
      '\tif (!bIsWaterPixel && bAllCloudSamplesBehindSurface)', '\t{',
      '\t\tclip(-1.0f);', '\t\treturn;', '\t}', '#endif',
    ].join('\n'),
  }]],
  ['Private/ReflectionEnvironmentShaders.usf',
    ['OutTextureMipColor', 'OutCubeFaces'].map(name => {
      const declaration = `RWTexture2DArray<float4> ${name};`;
      return {before: declaration, after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '[[vk::image_format("rgba16f")]] [[vk::ext_decorate(25)]]', '#endif', declaration].join('\n')};
    })],
  ['Private/DeferredDecal.usf', [
    {
      before: '\tclip(OSPosition.xyz + 1.0f);\n\tclip(1.0f - OSPosition.xyz);',
      after: [
        '\t#if !defined(COMPILER_WEBGPU) || !COMPILER_WEBGPU',
        '\tclip(OSPosition.xyz + 1.0f);', '\tclip(1.0f - OSPosition.xyz);', '\t#endif',
      ].join('\n'),
    },
    {
      before: '\tCalcPixelMaterialInputs(MaterialParameters, PixelMaterialInputs);',
      after: [
        '\tCalcPixelMaterialInputs(MaterialParameters, PixelMaterialInputs);',
        '\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '\t// Keep implicit texture derivatives in uniform control flow before discarding.',
        '\tclip(OSPosition.xyz + 1.0f);', '\tclip(1.0f - OSPosition.xyz);', '\t#endif',
      ].join('\n'),
    },
  ]],
  ['Private/SceneCapturePixelShader.usf', [{
    before: '\tFGBufferData GBufferData = GetGBufferData(Input.UV);',
    after: [
      '\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU && SHADING_PATH_MOBILE',
      '\t// Mobile forward has no GBuffer normal. Keep zero finite instead of normalizing it.',
      '\tFGBufferData GBufferData = GetGBufferData(Input.UV, false);',
      '\tGBufferData.WorldNormal *= rsqrt(max(dot(GBufferData.WorldNormal, GBufferData.WorldNormal), 1.0e-8f));',
      '\t#else', '\tFGBufferData GBufferData = GetGBufferData(Input.UV);', '\t#endif',
    ].join('\n'),
  }]],
  ['Private/ScreenSpaceShadows.usf', [{
    before: '\tUpsampleShadowFactors(SVPos, ScissorRectMinAndSize, OneOverDownsampleFactor, 0, POSITIVE_INFINITY, ShadowFactorsTexture, ShadowFactorsSampler, ShadowFactorsUVBilinearMax, Output, SceneDepth);',
    after: [
      '\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      '\t// WGSL requires a finite depth bound.',
      '\tUpsampleShadowFactors(SVPos, ScissorRectMinAndSize, OneOverDownsampleFactor, 0, 3.402823466e+38f, ShadowFactorsTexture, ShadowFactorsSampler, ShadowFactorsUVBilinearMax, Output, SceneDepth);',
      '\t#else',
      '\tUpsampleShadowFactors(SVPos, ScissorRectMinAndSize, OneOverDownsampleFactor, 0, POSITIVE_INFINITY, ShadowFactorsTexture, ShadowFactorsSampler, ShadowFactorsUVBilinearMax, Output, SceneDepth);',
      '\t#endif',
    ].join('\n'),
  }]],
  ['Private/PostProcessTonemap.usf', [
    {
      before: '\t\thalf UniformGrainNPSign = clamp(UniformGrainNP * POSITIVE_INFINITY, half(-1.0), half(1.0));',
      after: [
        '\t\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '\t\t// WGSL cannot represent an infinite constant. Zero grain contributes no dither.',
        '\t\thalf UniformGrainNPSign = sign(UniformGrainNP);',
        '\t\t#else',
        '\t\thalf UniformGrainNPSign = clamp(UniformGrainNP * POSITIVE_INFINITY, half(-1.0), half(1.0));',
        '\t\t#endif',
      ].join('\n'),
    },
  ]],
  ['Private/ClearReplacementShaders.usf', [
    {
      before: '\t\tRWBuffer        <VALUE_TYPE> ClearResource;',
      after: [
        '\t\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '\t\t\tRWStructuredBuffer<VALUE_TYPE> ClearResource;',
        '\t\t#else', '\t\t\tRWBuffer<VALUE_TYPE> ClearResource;', '\t\t#endif',
      ].join('\n'),
      count: 2,
    },
  ]],
  ['Private/ByteBuffer.usf', [
    {
      before: '\tBuffer<float4>\t\t\t\t\tSrcBuffer;',
      after: [
        '\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '\t\tStructuredBuffer<float4> SrcBuffer;',
        '\t#else', '\t\tBuffer<float4> SrcBuffer;', '\t#endif',
      ].join('\n'),
    },
    {
      before: '\tRWBuffer<float4>\t\t\t\tDstBuffer;',
      after: [
        '\t#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        '\t\tRWStructuredBuffer<float4> DstBuffer;',
        '\t#else', '\t\tRWBuffer<float4> DstBuffer;', '\t#endif',
      ].join('\n'),
    },
  ]],
  ['Private/CopyUIntBuffer.usf', [
    {
      before: ['Buffer<uint> SourceData;', '', 'RWBuffer<uint> DestData0;',
        'RWBuffer<uint> DestData1;', 'RWBuffer<uint> DestData2;'].join('\n'),
      after: [
        '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        'StructuredBuffer<uint> SourceData;',
        'RWStructuredBuffer<uint> DestData0;', 'RWStructuredBuffer<uint> DestData1;',
        'RWStructuredBuffer<uint> DestData2;',
        '#else', 'Buffer<uint> SourceData;', 'RWBuffer<uint> DestData0;',
        'RWBuffer<uint> DestData1;', 'RWBuffer<uint> DestData2;', '#endif',
      ].join('\n'),
    },
  ]],
  ['Private/UpdateTextureShaders.usf', [
    {
      before: 'Buffer<int> SrcBuffer;\nRWTexture3D<int4> DestTexture3D;',
      after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        'StructuredBuffer<int> SrcBuffer;',
        '// SPIR-V NonReadable: the update shader only writes the destination.',
        '[[vk::ext_decorate(25)]] RWTexture3D<int4> DestTexture3D;',
        '#else', 'Buffer<int> SrcBuffer;', 'RWTexture3D<int4> DestTexture3D;', '#endif'].join('\n'),
    },
    {
      before: 'Buffer<uint4> SrcCopyBuffer;\nRWBuffer<uint4> DestBuffer;',
      after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        'StructuredBuffer<uint4> SrcCopyBuffer;', 'RWStructuredBuffer<uint4> DestBuffer;',
        '#else', 'Buffer<uint4> SrcCopyBuffer;', 'RWBuffer<uint4> DestBuffer;', '#endif'].join('\n'),
    },
    {
      before: 'Buffer<COMPONENT_TYPE> TSrcBuffer;\nRWTexture2D<COMPONENT_TYPE> TDestTexture;',
      after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
        'StructuredBuffer<COMPONENT_TYPE> TSrcBuffer;',
        '[[vk::ext_decorate(25)]] RWTexture2D<COMPONENT_TYPE> TDestTexture;',
        '#else', 'Buffer<COMPONENT_TYPE> TSrcBuffer;',
        'RWTexture2D<COMPONENT_TYPE> TDestTexture;', '#endif'].join('\n'),
    },
  ]],
  ...['Private/RendererUtils.usf', 'Private/Tools/SetupIndirectArgs.usf'].map((file, index) => {
    const name = index === 0 ? 'OutIndirectArgsBuffer' : 'IndirectDispatchArgsOut';
    const before = `RWBuffer<uint> ${name};`;
    return [file, [{before, after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      `RWStructuredBuffer<uint> ${name};`, '#else', before, '#endif'].join('\n')}]];
  }),
  ...['Private/ComputeGenerateMips.usf', 'Private/PostProcessSubsurfaceTile.usf'].map(file => {
    const before = 'Buffer<uint> ConditionBuffer;\nRWBuffer<uint> RWIndirectDispatchArgsBuffer;';
    return [file, [{before, after: ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU',
      'StructuredBuffer<uint> ConditionBuffer;', 'RWStructuredBuffer<uint> RWIndirectDispatchArgsBuffer;',
      '#else', before, '#endif'].join('\n')}]];
  }),
  ['Public/Platform.ush', [{
    before: '#endif // #ifndef DISPATCH_INDIRECT_UINT_COUNT',
    after: ['#endif // #ifndef DISPATCH_INDIRECT_UINT_COUNT', '',
      '#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU && FEATURE_LEVEL < FEATURE_LEVEL_SM5',
      'void WriteDispatchIndirectArgs(RWStructuredBuffer<uint> RWIndirectDispatchArgsBuffer, in uint InIndex, in uint InIndirectArgX, in uint InIndirectArgY, in uint InIndirectArgZ)',
      '{',
      '\tRWIndirectDispatchArgsBuffer[DISPATCH_INDIRECT_UINT_COUNT * InIndex + 0] = InIndirectArgX;',
      '\tRWIndirectDispatchArgsBuffer[DISPATCH_INDIRECT_UINT_COUNT * InIndex + 1] = InIndirectArgY;',
      '\tRWIndirectDispatchArgsBuffer[DISPATCH_INDIRECT_UINT_COUNT * InIndex + 2] = InIndirectArgZ;',
      '}', '#endif'].join('\n'),
  }]],
]);
const reportFile = path.join(__dirname, 'results/web-cook-shader-sources.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const audit = file => ({file, sha256: sha(fs.readFileSync(file))});
const normalize = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/[ \t\n]*$/, '\n');

function prepare() {
  const overrideFiles = [];
  for (const [relative, replacements] of overrides) {
    const override = path.join(root, 'reference-engine/Engine/Shaders', relative);
    let expected = normalize(fs.readFileSync(path.join(stock, relative)));
    for (const {before, after, count = 1} of replacements) {
      assert.equal(expected.split(before).length - 1, count, `Unexpected native declarations: ${relative}`);
      expected = expected.replaceAll(before, after);
    }
    assert.equal(normalize(fs.readFileSync(override)), expected,
      `Only the declared WebGPU branches may differ: ${relative}`);
    overrideFiles.push(path.join(stock, relative), override);
  }
  fs.mkdirSync(output, {recursive: true});
  assert.equal(fs.realpathSync(output), path.resolve(output), 'Shader snapshot must be local');
  const files = [];
  function copy(directory = '') {
    for (const entry of fs.readdirSync(path.join(stock, directory), {withFileTypes: true})) {
      assert(!entry.isSymbolicLink(), `Unexpected source link: ${entry.name}`);
      const name = path.join(directory, entry.name);
      const destination = path.join(output, name);
      if (fs.existsSync(destination)) {
        const info = fs.lstatSync(destination);
        assert(!info.isSymbolicLink() && (!info.isFile() || info.nlink === 1),
          `Refusing to overwrite a linked shader snapshot: ${destination}`);
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(destination, {recursive: true});
        copy(name);
      } else if (entry.isFile()) {
        const overridden = overrides.has(name.replaceAll('\\', '/'));
        const source = overridden ? path.join(root, 'reference-engine/Engine/Shaders', name) : path.join(stock, name);
        const bytes = fs.readFileSync(source);
        const hash = sha(bytes);
        if (!fs.existsSync(destination) || sha(fs.readFileSync(destination)) !== hash) {
          fs.writeFileSync(destination, bytes);
        }
        files.push({relative: name.replaceAll('\\', '/'), sha256: hash,
          origin: overridden ? 'target-webgpu-override' : 'installed-copy'});
      }
    }
  }
  copy();
  const report = {date: new Date().toISOString(), pass: true, output,
    sourceFiles: [__filename, ...overrideFiles].map(audit),
    files, installedEngineUnmodified: audit(path.join(stock, 'Private/PostProcessTonemap.usf')),
    installedInputs: [...overrides.keys()].map(relative => audit(path.join(stock, relative))),
    boundary: 'Independent native Cook shader snapshot. Audited overrides contain WebGPU decal ordering, finite math, structured buffers, explicit atmosphere/sky-capture storage image formats and indirect arguments. Other files are installed-source copies, not a complete 5.8.3 shader snapshot.'};
  const previous = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
  if (!previous || JSON.stringify({...previous, date: null}) !== JSON.stringify({...report, date: null})) {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  }
  return {directory: output, report: audit(reportFile), files: files.length};
}

module.exports = prepare;
if (require.main === module) console.log(JSON.stringify(prepare(), null, 2));
