'use strict';

const web = lines => ['#if defined(COMPILER_WEBGPU) && COMPILER_WEBGPU', ...lines, '#endif'].join('\n');
const storage = (name, writeOnly = false) => {
  const before = `RWTexture3D<float4> ${name};`;
  return {before, after: web([`[[vk::image_format("rgba16f")]]${writeOnly ? ' [[vk::ext_decorate(25)]]' : ''}`]) + '\n' + before};
};
const radialClip = '\t\tclip(1.0f / (LightData.InvRadius * LightData.InvRadius) - dot(LightVector, LightVector));';
const directionalClip = '\t\tclip(DistToNear);\n\t\tclip(DistToFar);';
module.exports = new Map([
  ['Private/TranslucentLightInjectionShaders.usf', [
    ...['RWAmbient0', 'RWDirectional0', 'RWAmbient1', 'RWDirectional1'].map(name => storage(name, true)),
    ...['RWTranslucencyLightingVolumeAmbient', 'RWTranslucencyLightingVolumeDirectional'].map(name => storage(name)),
    {before: radialClip, after: ['#if WEB_VOLUME_INJECTION',
      '\t\tif (1.0f / (LightData.InvRadius * LightData.InvRadius) - dot(LightVector, LightVector) < 0.0f)',
      '\t\t{', '\t\t\treturn;', '\t\t}', '#else', radialClip, '#endif'].join('\n')},
    {before: directionalClip, after: ['#if WEB_VOLUME_INJECTION',
      '\t\tif (DistToNear < 0.0f || DistToFar < 0.0f)', '\t\t{', '\t\t\treturn;', '\t\t}',
      '#else', directionalClip, '#endif'].join('\n')},
    {before: '#endif // ClearTranslucentLightingVolumeCS',
      after: '#endif // ClearTranslucentLightingVolumeCS\n\n#include "WebTranslucencyVolume.ush"'},
  ]],
  ['Private/TranslucentLightingShaders.usf', [
    ...['RWTranslucencyLightingVolumeAmbient', 'RWTranslucencyLightingVolumeDirectional',
      'RWTranslucencySpecularDirection'].map(name => storage(name, true)),
    {before: '\n\n#endif // FEATURE_LEVEL', after: '\n#include "WebTranslucencyVolume.ush"\n\n#endif // FEATURE_LEVEL'},
  ]],
]);
