'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
assert.equal(process.argv.length, 4, 'Expected browser GPU report and output report');
const input = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => audit(item.file).sha256 === item.sha256;
const gpu = read(input);
assert(gpu.pass && gpu.modules.length >= 31 && gpu.pipelines.length === gpu.modules.length);
assert(gpu.sourceFiles.every(valid));
const cases = gpu.modules.map(item => {
  assert(!item.errors.length && item.sourceFiles.every(valid));
  const metadataFile = item.sourceFiles.find(file => path.basename(file.file) === 'input.json').file;
  const converted = read(metadataFile);
  assert.equal(converted.shaderName, 'FStochasticLightingTileClassificationMarkCS');
  const permutation = Number(converted.shader.match(/\/(\d+):/)[1]);
  const storage = converted.metadata.spirvBindings.filter(binding => binding.storageTextureAccess);
  assert(storage.length <= 8, `Permutation ${permutation} exceeds WebGPU's storage texture limit`);
  for (const binding of storage) {
    const format = binding.name === 'RWEncodedHistoryScreenCoord' ? 36 :
      /^(RWClosureTexture|RWLumenTileBitmask|RWMegaLightsTileBitmask|RWLumenPackedPixelData|RWMegaLightsPackedPixelData)$/.test(binding.name) ? 39 : 0;
    if (format) assert.equal(binding.storageImageFormat, format);
  }
  return {permutation, storageTextures: storage.map(binding => binding.name)};
}).sort((a, b) => a.permutation - b.permutation);
for (const permutation of [79, 335]) {
  const selected = cases.find(item => item.permutation === permutation);
  assert(selected && selected.storageTextures.length === 7);
  assert(!selected.storageTextures.some(name => name.endsWith('2x1')));
  assert(selected.storageTextures.includes('RWDownsampledSceneDepth2x2') &&
    selected.storageTextures.includes('RWDownsampledWorldNormal2x2'));
}
assert.deepEqual(cases.find(item => item.permutation === 2)?.storageTextures.slice().sort(),
  ['RWDownsampledSceneDepth2x1', 'RWDownsampledWorldNormal2x1']);
const root = path.resolve(__dirname, '../..');
const report = {
  date: new Date().toISOString(), pass: true, completeLumenScene: false,
  modules: gpu.modules.length, pipelines: gpu.pipelines.length,
  maxStorageTextures: Math.max(...cases.map(item => item.storageTextures.length)),
  rendererOverrides: [], extraSceneTextureBytes: 0, cases,
  sourceReports: [audit(input)],
  sourceFiles: [audit(__filename),
    audit(path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/StochasticLighting/StochasticLighting.cpp')),
    audit(path.join(root, 'reference-engine/Engine/Shaders/Private/StochasticLighting/StochasticLightingTileClassification.usf'))],
  boundary: 'Actual converted shader bindings and browser compute pipeline creation. Split output pixels, full-scene FPS and peak VRAM require separate execution checks.',
};
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, modules: report.modules,
  maxStorageTextures: report.maxStorageTextures, output}));
