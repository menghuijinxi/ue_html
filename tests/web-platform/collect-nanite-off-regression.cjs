'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {auditMemory} = require('./audit-wasm-memory.cjs');
const defaults = require('./web-accepted-defaults.cjs');
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/^\uFEFF/, ''));
const output = path.join(__dirname, 'evidence/nanite-off-regression-20261111');
fs.mkdirSync(output, {recursive: true});
const archived = [];
function archive(file) {
  const source = path.resolve(__dirname, file), name = `${archived.length}-${path.basename(file)}.gz`;
  const destination = path.join(output, name);
  fs.writeFileSync(destination, zlib.gzipSync(fs.readFileSync(source), {level: 9}));
  const item = {source: audit(source), archive: audit(destination)}; archived.push(item); return item;
}
function configurations(folder) {
  const result = {};
  for (const file of read('build/' + folder + '/config-files.json')) {
    let section = '';
    for (const line of Buffer.from(file.data, 'base64').toString().split(/\r?\n/)) {
      const header = line.match(/^\[([^\]]+)\]/);
      if (header) {section = header[1]; continue;}
      const value = line.match(/^\s*([^;#\s][^=]*)=(.*)$/);
      if (value) result[file.path + ' ' + section + ' ' + value[1]] = value[2];
    }
  }
  return result;
}
const oldFolder = 'villa-default-20261107', newFolder = 'villa-nanite-off-20261111';
const oldConfig = configurations(oldFolder), newConfig = configurations(newFolder);
const configDifferences = [...new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)])]
  .filter(k => oldConfig[k] !== newConfig[k]).map(key => ({key, old: oldConfig[key] ?? null, current: newConfig[key] ?? null}));
assert.deepEqual(configDifferences, [{key: '/Engine/Platforms/Web/Config/WebEngine.ini SystemSettings r.Nanite', old: null, current: '0'}]);
const packageAudit = [oldFolder, newFolder].map(folder => {
  const base = path.join(__dirname, 'build', folder), html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
  const assets = JSON.parse(html.match(/const localRuntimeAssets = (\{[^\n]+\});/)[1]);
  for (const [key, value] of Object.entries(defaults.runtimeAssets)) assert.equal(assets[key], value, key);
  const wasm = audit(path.join(base, 'UEWebEngineThreads.wasm'));
  const memory = auditMemory(wasm.file);
  assert.equal(memory.memories[0].addressBits, 32); assert(memory.memories[0].shared);
  assert.equal(wasm.sha256, assets.wasm.sha256);
  return {folder, wasm, memory, runtimeAssets: Object.fromEntries(Object.keys(defaults.runtimeAssets).map(k => [k, assets[k]])),
    manifest: archive('build/' + folder + '/asset-versions.json'), config: archive('build/' + folder + '/config-files.json')};
});
const build = read('results/web-engine-full-thread-build-results.json');
assert(build.pass && build.buildSucceeded && build.fullLinkVerified && !build.trace && !build.simd && build.lowerMemory64);
assert.equal(build.allocator, 'mimalloc');
assert(build.products.some(p => p.sha256 === packageAudit[1].wasm.sha256));
const compileFlags = {};
for (const object of build.objects) {
  assert.equal(audit(object.response.file).sha256, object.response.sha256);
  const flags = fs.readFileSync(object.response.file, 'utf8').match(/(?<!\S)-O[0-3sz](?=\s|$)/g) || [];
  assert.equal(flags.length, 1);
  (compileFlags[flags[0]] ||= []).push(path.basename(object.response.file));
}
assert.deepEqual(Object.fromEntries(Object.entries(compileFlags).map(([k,v]) => [k, v.length])), {'-O2':445, '-O1':1});
const response = fs.readFileSync(build.linkResponse.file, 'utf8');
assert.equal(audit(build.linkResponse.file).sha256, build.linkResponse.sha256);
assert(response.includes('-sMALLOC=mimalloc') && response.includes('-sMEMORY64=2'));
function lowestRollingLow(times) {
  let lowest = Infinity;
  for (let end = times[0] + 5000; end <= times.at(-1); end += 250) {
    const values = times.slice(1).flatMap((t, i) => t > end - 5000 && t <= end ? [t - times[i]] : []);
    if (values.length < 100) continue;
    const tail = values.toSorted((a,b) => b-a).slice(0, Math.ceil(values.length * .01));
    lowest = Math.min(lowest, 1000 * tail.length / tail.reduce((a,b) => a+b, 0));
  }
  return lowest;
}
const runs = [];
for (const suffix of ['a','d']) {
  const folder = 'results/nanite-off-regression-20261111-' + suffix, report = read(folder + '/report.json');
  assert(report.pass);
  assert.equal(audit(path.join(__dirname, folder, 'source.cjs')).sha256, report.source.sha256);
  for (const run of report.runs) {
    assert(run.pass); assert.deepEqual(run.errors, []);
    const log = fs.readFileSync(path.join(__dirname, folder, run.index + '-' + run.mode + '.log'), 'utf8');
    for (const [key, value] of Object.entries(defaults.settings))
      assert(log.includes('Set CVar [[' + key + ':' + value + ']]'), key + ' was not applied');
    const phases = run.phases.map(p => {
      const delta = (o,k) => p.after[o][k] - p.before[o][k];
      assert(!p.before.stages.parallelCommandRecording && !p.before.stages.parallelRHITranslation);
      assert(p.before.occlusion.groupCacheEnabled && p.before.occlusion.bindingPlanEnabled && p.before.occlusion.reuseComputePass);
      assert.equal(p.before.occlusion.groupAccessRevalidation, 2);
      const diagnosticFrames = delta('occlusion','sampleFrame');
      return {name: p.name, ...p.result, lowestRolling5sLow: lowestRollingLow(p.times),
        camera: p.before.camera, view: p.before.view, diagnosticFrames,
        drawsPerDiagnosticFrame: delta('occlusion','draws') / diagnosticFrames,
        preparedBindingsPerDiagnosticFrame: delta('occlusion','bindingEntriesPrepared') / diagnosticFrames,
        boundsRejectedPerDiagnosticFrame: delta('history','boundsRejected') / delta('history','frame'),
        runtimeAsyncPipelines: delta('optimization','runtimeAsyncRequested'),
        createdGraphicsPipelines: delta('optimization','graphicsPipelines'), createdComputePipelines: delta('optimization','computePipelines')};
    });
    runs.push({sequence: suffix, mode: run.mode, browser: run.browser, phases});
  }
  for (const file of fs.readdirSync(path.join(__dirname, folder))) archive(folder + '/' + file);
}
const failedControls = [];
for (const suffix of ['b','c']) {
  const folder = 'results/nanite-off-regression-20261111-' + suffix, r = read(folder + '/report.json');
  assert(!r.pass);
  failedControls.push({sequence: suffix, failure: r.failure, errors: r.runs[0].errors,
    result: suffix === 'c' ? 'Old Cook lacks required new global shaders; runtime-only crossover is not a valid performance sample.' :
      'Browser closed before startup completed while large runtime files were intercepted; no performance sample.'});
  for (const file of fs.readdirSync(path.join(__dirname, folder))) archive(folder + '/' + file);
}
const before = read('results/nanite-full-scene-inventory.json'), after = read('results/nanite-full-scene-conversion.json');
const fallbackChanges = read('results/nanite-full-scene-conversion-verified.json').fallbackChanges;
const weightedTriangles = d => d.meshes.reduce((s,m) => s + m.fallbackTriangles * m.components, 0);
const result = {date: new Date().toISOString(), auditPassed: true, performanceAccepted: false,
  configDifferences, appliedSettings: defaults.settings, packageAudit,
  build: {date:build.date, allocator:build.allocator, trace:build.trace, simd:build.simd, lowerMemory64:build.lowerMemory64,
    compileFlags, linkOptimization:build.linkOptimization,
    note:'Final-link O0 is not C++ O0. The pre-Nanite November 6 addressing build also used default final-link O0; its binary is not asserted identical to the November 7 package.'},
  geometry: {changedMeshes:fallbackChanges, weightedLOD0Before:weightedTriangles(before), weightedLOD0After:weightedTriangles(after),
    note:'Sum over scene instances, not visible triangles per frame. Does not quantify FPS attribution.'},
  runs, failedControls,
  conclusion: 'Accepted switches are present and applied; current C++ objects remain optimized. The retained scene flag causes bounds-history invalidation and additional ordinary draws with Nanite off. Removing it is diagnostic only and removes a correctness safeguard, not an accepted fix. Geometry also changed. These short routes do not explain all earlier run-to-run variation or establish reproduction/resolution of the user-reported 19 low.',
  archived};
for (const file of ['collect-nanite-off-regression.cjs', 'probe-nanite-off-regression.cjs', 'web-accepted-defaults.cjs',
  'results/web-engine-full-thread-build-results.json', 'results/villa-address32-runtime-20261106-build.json',
  'results/nanite-full-scene-conversion-verified.json', 'results/villa-legacy-new-runtime-20261111-package.json',
  'results/villa-legacy-new-runtime-20261111-package.cjs']) archive(file);
archive(build.linkResponse.file);
for (const f of ['../..//reference-engine/Engine/Source/Runtime/Renderer/Private/RendererScene.cpp',
  '../..//reference-engine/Engine/Source/Runtime/Renderer/Private/SceneOcclusion.cpp']) archive(f);
fs.writeFileSync(path.join(__dirname, 'evidence/nanite-off-regression-20261111.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({auditPassed:true, performanceAccepted:false, runs:runs.length, archived:archived.length}));
