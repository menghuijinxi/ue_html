const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const engine = process.argv[2] || process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const relative = 'Source/Runtime/Renderer/Private/Skinning/SkinningSceneExtension.cpp';
const output = path.join(root, '.tools/ue58-web-build-host/Engine', relative);
const installed = fs.readFileSync(path.join(engine, relative), 'utf8');
const target = fs.readFileSync(path.join(root, 'reference-engine/Engine', relative), 'utf8');
const functionPattern = /^static void GetDefaultSkinningParameters\([^\r\n]*\)\r?\n\{[\s\S]*?^\}/gm;
const installedFunctions = [...installed.matchAll(functionPattern)];
const targetFunctions = [...target.matchAll(functionPattern)];
assert.equal(installedFunctions.length, 1);
assert.equal(targetFunctions.length, 1);
const webFunction = targetFunctions[0][0];
assert(webFunction.includes('#if PLATFORM_WEB') &&
  webFunction.includes('OutParameters = FSkinningSceneParameters();'));
assert(fs.realpathSync(output).toLowerCase().startsWith(root.toLowerCase() + path.sep) &&
  fs.statSync(output).nlink === 1,
  'Skinning output must stay inside the isolated build host');
// Keep the installed implementation paired with its private and shared shader headers.
// Copy-Item can preserve the installed source's read-only attribute on a repeated preparation.
fs.chmodSync(output, 0o666);
fs.writeFileSync(output, installed.replace(functionPattern, () => webFunction));
console.log('Prepared installed-version skinning implementation with the target Web default parameters.');
