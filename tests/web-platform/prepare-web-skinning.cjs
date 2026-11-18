const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const engine = process.argv[2] || process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const skinning = 'Source/Runtime/Renderer/Private/Skinning/';
const normalize = s => s.replace(/\r\n/g, '\n');
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length - 1, 1, before);
  return text.replace(before, () => after);
}
function extract(text, signature) {
  const start = text.indexOf(signature);
  assert(start >= 0 && text.indexOf(signature, start + 1) === -1, signature);
  const end = text.indexOf('\n}', start);
  assert(end > start);
  return text.slice(start, end + 2);
}
for (const file of ['SkinningSceneExtension.cpp', 'SkinningTransformProvider.cpp']) {
  const relative = skinning + file;
  const destination = path.join(root, '.tools/ue58-web-build-host/Engine', relative);
  let installed = normalize(fs.readFileSync(path.join(engine, relative), 'utf8'));
  const target = normalize(fs.readFileSync(path.join(root, 'reference-engine/Engine', relative), 'utf8'));
  const extension = file === 'SkinningSceneExtension.cpp';
  const type = extension ? 'FSkinningSceneExtension' : 'FSkinningTransformProvider';
  const signature = `bool ${type}::ShouldCreateExtension(FScene& InScene)`;
  const enabled = extract(target, signature);
  assert(enabled.includes('Nanite::IsWebSceneRequested()'));
  installed = replaceOnce(installed, extract(installed, signature), enabled);
  installed = replaceOnce(installed, '#include "SkinningSceneExtension.h"',
    '#include "SkinningSceneExtension.h"\n#if PLATFORM_WEB\n#include "Rendering/NaniteWebScene.h"\n#endif');
  if (extension) {
    const defaultSignature = 'static void GetDefaultSkinningParameters(';
    const defaults = extract(target, defaultSignature);
    assert(defaults.includes('GetDefaultCompressedBoneTransformBuffer') &&
      !defaults.includes('OutParameters = FSkinningSceneParameters()'));
    installed = replaceOnce(installed, extract(installed, defaultSignature), defaults);
    const original = '\t\tconst bool bNaniteEnabled = UseNanite(GetFeatureLevelShaderPlatform(InScene.GetFeatureLevel()));';
    const replacement = '#if PLATFORM_WEB\n        const bool bNaniteEnabled = Nanite::IsWebSceneRequested();\n#else\n' + original + '\n#endif';
    assert(target.includes(replacement));
    installed = replaceOnce(installed, original, replacement);
    const viewSignature = 'void FSkinningSceneExtension::FRenderer::UpdateViewData(FRDGBuilder& GraphBuilder, const FRendererViewDataManager& ViewDataManager)\n{';
    const targetFunction = extract(target, viewSignature);
    assert(targetFunction.startsWith(viewSignature + '\n#if PLATFORM_WEB\n'));
    const end = targetFunction.indexOf('\n#endif');
    assert(end > 0);
    installed = replaceOnce(installed, viewSignature, targetFunction.slice(0, end + '\n#endif'.length));
  }
  // Keep installed private/shared layouts paired. Only transplant the explicitly
  // checked Web gates and default parameters, never the reference implementation.
  assert(fs.realpathSync(destination).toLowerCase().startsWith(root.toLowerCase() + path.sep) &&
    fs.statSync(destination).nlink === 1, 'Skinning output must stay inside the isolated build host');
  fs.chmodSync(destination, 0o666);
  fs.writeFileSync(destination, installed);
}
console.log('Prepared installed-version skinning scene and transform providers for Web Nanite.');
