'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const verified = item => {
  assert.equal(audit(item.file).sha256, item.sha256, `Evidence changed: ${item.file}`);
  return item;
};
const load = name => {
  const tag = option(name);
  assert(/^[a-z0-9-]+$/.test(tag), `Require --${name}=report-tag`);
  const file = path.join(results, tag + '.json');
  const data = read(file);
  data.cases.forEach(item => verified(item.image));
  return {audit: audit(file), data};
};

(async () => {
  const before = load('before'), after = load('after'), reference = load('reference');
  const native = option('native'), nativeInput = option('native-input');
  const packageFile = option('package-report'), output = option('output');
  assert(native && nativeInput && packageFile && output);
  assert(!fs.existsSync(output), 'Preserve prior evidence with a fresh output path');
  assert.equal(before.data.pass, false);
  assert.match(before.data.failure, /Batched shadow rendering differs/);
  assert(after.data.pass && reference.data.pass);
  assert.deepEqual(before.data.camera, after.data.camera);
  assert.deepEqual(reference.data.camera, after.data.camera);
  const nativeCase = read(nativeInput).cases.find(item => item.name === 'desk');
  assert(nativeCase);
  assert.deepEqual(['x', 'y', 'z', 'pitch', 'yaw'].map(key => nativeCase[key]), after.data.camera);
  assert.equal(nativeCase.fov, 90);
  assert.deepEqual(after.data.settings, {});
  assert.deepEqual(reference.data.settings, {'r.InstanceCulling.AllowBatchedBuildRenderingCommands': 0});
  const names = after.data.cases.map(item => item.entry.name);
  assert.deepEqual(names, ['baseline', 'uncached', 'recached']);
  for (const item of after.data.cases) {
    assert.deepEqual(item.state.errors, []);
    assert.deepEqual(item.state.losses, []);
    assert.equal(item.state.lighting.giMethod, 1);
    assert.equal(item.state.lighting.reflectionMethod, 1);
    assert.equal(item.state.lighting.antiAliasing, 4);
    for (let face = 0; face < 6; ++face) assert(item.state.cubeCopies[face] > 0);
    if (item.entry.name !== 'uncached') {
      assert(item.state.lighting.shadowCacheEnabled);
      assert.equal(item.comparisons.length, 2);
      assert(item.comparisons.every(region => region.meanAbsoluteError <= region.limit));
    }
  }
  const packaged = read(packageFile);
  assert(packaged.pass);
  packaged.products.forEach(verified);
  const build = read(verified(packaged.build).file);
  assert(build.pass && build.buildSucceeded && build.exitCode === 0 && build.fullLinkAttempted);
  const cookPayload = ['content.bin', 'content-files.json', 'config-files.json'].map(name => {
    const first = before.data.products.find(item => path.basename(item.file) === name);
    const last = after.data.products.find(item => path.basename(item.file) === name);
    assert(first && last);
    assert.equal(first.sha256, last.sha256, `Cook payload changed: ${name}`);
    return verified(last);
  });
  const cases = after.data.cases.map(item => ({
    name: item.entry.name, image: item.image, state: item.state, comparisons: item.comparisons,
  }));
  const tiles = [
    {label: 'Before', file: before.data.cases[0].image.file},
    {label: 'UE desktop reference', file: native},
    {label: 'Fixed - cache and batching enabled', file: after.data.cases[0].image.file},
  ];
  const layers = [];
  for (const [index, tile] of tiles.entries()) {
    layers.push({input: await sharp(tile.file).resize(800, 450).toBuffer(), left: index * 800, top: 34});
    layers.push({input: Buffer.from(`<svg width="800" height="34"><text x="14" y="23" fill="white" font-family="Arial" font-size="18">${tile.label}</text></svg>`),
      left: index * 800, top: 0});
  }
  const image = path.join(results, path.basename(output, '.json') + '-comparison.png');
  await sharp({create: {width: 2400, height: 484, channels: 4, background: '#202124'}})
    .composite(layers).png().toFile(image);
  const report = {
    date: new Date().toISOString(), pass: true,
    cause: 'Six-pass cube shadows used stack-local instance culling results and copied batch offsets before deferred MergeBatches filled them. Draws read the first batch instead of their own instance and indirect argument ranges.',
    fix: 'Allocate the shared culling output in RDG memory and read its finalized offsets at draw execution. Per-face parameters still declare the shared resource dependencies.',
    source: audit(__filename), package: audit(packageFile), build: packaged.build,
    rendererSource: audit(path.resolve(__dirname, '../../reference-engine/Engine/Source/Runtime/Renderer/Private/ShadowDepthRendering.cpp')),
    camera: after.data.camera, cookPayload,
    regressionBefore: {report: before.audit, pass: false, comparisons: before.data.cases[0].comparisons},
    synchronousReference: {report: reference.audit, image: reference.data.cases[0].image},
    regressionAfter: {report: after.audit, pass: true, settings: after.data.settings, cases},
    nativeInput: audit(nativeInput), nativeImage: audit(native), comparisonImage: audit(image),
    boundary: 'Tests use an isolated Edge GPU process pinned to 0xffff0000 to avoid the separately documented host shader compiler crash. This fixes the reproduced foyer shadow artifact; it is not proof of full native parity, performance, mobile support, or a browser crash repair. Cook and shaders are reused byte for byte; only the runtime changed.',
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({pass: true, output, image}));
})().catch(error => {console.error(error); process.exitCode = 1;});
