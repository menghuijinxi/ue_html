'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {audit} = require('../content-file-metadata.cjs');
const {readPage, writePage, replaceFile, runtimeFiles} = require('../web-pipeline-prewarm-package.cjs');
const {writeVersions} = require('../asset-versions.cjs');
const base = path.resolve(__dirname, '..');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag'), finish = process.argv.includes('--finish');
assert(tag && /^[a-z0-9-]+$/.test(tag), 'Specify a new diagnostic tag');
const suite = assertProjectOutputTree(path.join(base, 'build', tag));
const file = name => assertProjectOutput(path.join(suite, name));
const officialRoot = option('official-root') || 'E:/UE59WebBenchmark/engine-5.9';
const official = path.join(officialRoot, 'Engine/Platforms/Wasm/Build/Template/wasm-prewarm.js');
const packer = path.join(officialRoot, 'Engine/Platforms/Wasm/Build/Tools/web/prewarm_pack.py');
const source = path.resolve(base, 'build', option('source') || 'villa-pso-prune-20261116-c/automatic');
const device = JSON.parse(fs.readFileSync(path.join(base, 'build/villa-tsr-tiles-20261112/pipeline-prewarm.json'))).devices[0].descriptor;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
const binding = Object.fromEntries([['wasm', 'UEWebEngineThreads.wasm'], ['content', 'content.bin'],
  ['config', 'config-files.json']].map(([key, name]) => [key, audit(path.join(source, name)).sha256]));
const listing = [
  {url: 'TriplexHouseVilla/Binaries/Wasm/TriplexHouseVilla.wasm', code: binding.wasm},
  {url: 'TriplexHouseVilla/Content/WebGPUPrewarm-SF_WEBGPU_SM5.json'},
];
const stamp = sha1(['format SF_WEBGPU_SM5', 'code ' + binding.wasm].sort().join('\n'));
const wrapper = 'function runUE59PrewarmPage(window, requestAnimationFrame, localStorage, fetch, navigator) {\n' +
  fs.readFileSync(official, 'utf8') + '\n}\n' +
  'runUE59PrewarmPage(__ue59PrewarmBridge.window, __ue59PrewarmBridge.requestAnimationFrame, ' +
  '__ue59PrewarmBridge.localStorage, __ue59PrewarmBridge.fetch, __ue59PrewarmBridge.navigator);\n';
let report;
function currentFormat(pack) {
  const resources = new Map([...pack.modules.map(item => [item.id, 'module']),
    ...pack.bgls.map(item => [item.id, 'bindGroupLayout']),
    ...pack.layouts.map(item => [item.id, 'pipelineLayout'])]);
  const convert = value => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(convert);
    if (typeof value.$ === 'string' && Object.keys(value).length === 1) {
      assert(resources.has(value.$));
      return {$gpu: resources.get(value.$), id: value.$};
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, convert(child)]));
  };
  const entry = item => ({$gpu: resources.get(item.id), id: item.id, descriptor: convert(item.desc)});
  return {version: 1, ...binding, devices: [{id: 1, descriptor: device}],
    modules: pack.modules.map(entry), layouts: [...pack.bgls, ...pack.layouts].map(entry),
    descriptors: pack.pipelines.map(item => ({id: item.id, deviceId: 1, kind: item.kind, descriptor: convert(item.desc)}))};
}
function clone(mode, capture = false) {
  const folder = assertProjectOutputTree(path.join(suite, mode));
  assert(!fs.existsSync(folder), 'Preserve previous diagnostic packages');
  fs.mkdirSync(folder);
  const mutable = new Set(['index.html', 'asset-versions.json', ...runtimeFiles]);
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    if (!entry.isFile() || entry.name === 'pipeline-prewarm.json') continue;
    const target = assertProjectOutput(path.join(folder, entry.name));
    if (mutable.has(entry.name)) fs.copyFileSync(path.join(source, entry.name), target);
    else fs.linkSync(path.join(source, entry.name), target);
  }
  const page = readPage(folder);
  delete page.assets.releaseDefaults;
  delete page.assets.pipelinePrewarm;
  page.assets.diagnosticOnly = true;
  for (const name of runtimeFiles) {
    replaceFile(path.join(folder, name), fs.readFileSync(path.join(base, name)));
    page.assets.versions[name] = audit(path.join(folder, name)).sha256;
  }
  if (mode !== 'automatic') {
    page.args = page.args.filter(arg => arg !== '-WebPSOPrecacheTest' && !arg.startsWith('-WebPSOPrecacheConcurrency='));
    page.assets.pipelinePrewarm = {capture, url: 'ue59-pack.json', ...binding, device, listing, handoff: 'overlap'};
    if (!capture) {
      const pack = JSON.parse(fs.readFileSync(file('ue59-pack.json')));
      assert.deepEqual(pack.diagnosticBinding, binding);
      replaceFile(path.join(folder, 'ue59-pack.json'), JSON.stringify(pack));
      page.assets.pipelinePrewarm.sha256 = audit(path.join(folder, 'ue59-pack.json')).sha256;
    }
    if (mode === 'recorded') {
      const pack = currentFormat(JSON.parse(fs.readFileSync(file('ue59-pack.json'))));
      replaceFile(path.join(folder, 'pipeline-prewarm.json'), JSON.stringify(pack));
      page.assets.pipelinePrewarm = {url: 'pipeline-prewarm.json',
        sha256: audit(path.join(folder, 'pipeline-prewarm.json')).sha256,
        content: binding.content, config: binding.config, handoff: 'complete'};
    } else {
      replaceFile(path.join(folder, 'web-pipeline-prewarm.js'), fs.readFileSync(path.join(__dirname, 'ue59-prewarm-bridge.js')));
      replaceFile(path.join(folder, 'ue59-prewarm-source.js'), wrapper);
      for (const name of ['web-pipeline-prewarm.js', 'ue59-prewarm-source.js'])
        page.assets.versions[name] = audit(path.join(folder, name)).sha256;
    }
  }
  // Query belongs to the Worker URL because the unmodified UE59 script reads location.search.
  const worker = path.join(folder, 'web-engine-host.js');
  if (capture) {
    const text = fs.readFileSync(worker, 'utf8');
    assert(text.includes("new Worker('web-engine-worker.js?v='"));
    replaceFile(worker, text.replace("new Worker('web-engine-worker.js?v='",
      "new Worker('web-engine-worker.js?prewarm=capture&prewarm_capture_s=6&v='"));
    page.assets.versions['web-engine-host.js'] = audit(worker).sha256;
  }
  page.assets.psoStartupExperiment = {mode, automatic: mode === 'automatic', captureFree: mode === 'automatic',
    sourceImplementation: mode === 'automatic' ? 'Current UE automatic collectors' :
      mode === 'recorded' ? 'Current replay, UE59-collected descriptors' : 'UE59 wasm-prewarm.js unmodified body',
    captureOnly: capture};
  writePage(folder, page);
  writeVersions(folder, fs.readdirSync(folder).map(name => audit(path.join(folder, name))));
  return {folder: tag + '/' + mode, automatic: mode === 'automatic', captureFree: mode === 'automatic',
    expected: {indirectDrawReuse: 2, vsmPageOptimization: 3},
    files: Object.fromEntries(['UEWebEngineThreads.wasm', 'content.bin', 'config-files.json', 'index.html']
      .map(name => [name, audit(path.join(folder, name))]))};
}
if (!finish) {
  assert(!fs.existsSync(suite), 'Preserve diagnostic suites; choose a new tag');
  fs.mkdirSync(suite);
  report = {date: new Date().toISOString(), pass: false, diagnosticOnly: true, source,
    binding, stamp, listing, device, official: audit(official), packer: audit(packer),
    boundary: 'Current engine/Cook/quality. UE59 capture and replay source body unchanged; page events, frame callback and persistent storage are bridged to Worker. Device request uses current RHI features/limits and is checked at adoption. No UE59 RHI skipped-draw fallback, no manual camera capture. Full replay with persisted return-visit scheduling. Strict replay-completion gate retained. Recorded control replays the same collected descriptors with the current implementation.'};
  report.capture = clone('capture', true);
  report.variants = {automatic: {...clone('automatic'), label: '当前无记录自动收集'}};
} else {
  report = JSON.parse(fs.readFileSync(file('suite.json')));
  assert.equal(report.official.sha256, audit(official).sha256);
  assert.equal(report.packer.sha256, audit(packer).sha256);
  assert.deepEqual(report.binding, binding, 'Source package changed during capture');
  const packed = JSON.parse(fs.readFileSync(file('ue59-pack.json')));
  assert.equal(packed.stamp, stamp); assert.equal(packed.captured.captures, 2);
  assert(packed.pipelines.length > 0);
  report.variants.recorded = {...clone('recorded'), label: '当前重放 · 同一采集', pipelines: packed.pipelines.length};
  report.variants.ue59 = {...clone('ue59'), label: '5.9 自动采集与重放', pipelines: packed.pipelines.length};
  report.pack = audit(file('ue59-pack.json'));
  report.packCounts = Object.fromEntries(['modules', 'bgls', 'layouts', 'pipelines'].map(name => [name, packed[name].length]));
  report.pass = true;
  let html = fs.readFileSync(path.join(base, 'villa-git-history-live.html'), 'utf8')
    .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="/">')
    .replaceAll('Triplex Villa · Git 版本对照', 'Triplex Villa · 5.9 预热对照')
    .replace(/<div class="modes"[\s\S]*?<\/div>/, '<div class="modes" role="radiogroup" aria-label="预热模式">' +
      Object.entries(report.variants).map(([mode, variant], index) =>
        '<label><input type="radio" name="mode" value="' + mode + '"' + (!index ? ' checked' : '') +
        '><span>' + variant.label + '</span></label>').join('') + '</div>')
    .replace('<script src="villa-git-history-live.js"></script>',
      '<script>globalThis.__villaHistoryVariants=' + JSON.stringify(report.variants) + ';</script>')
    .replace('<span id="quality">', '<span>加载 <b id="startup-ms">待确认</b></span>' +
      '<span>PSO <b id="automatic-pso">等待</b></span><span id="quality">')
    .replace('</html>', '<script src="diagnostics/villa-pso-startup-live.js"></script></html>');
  replaceFile(file('comparison.html'), html);
}
replaceFile(file('suite.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, suite, capture: report.capture.folder, counts: report.packCounts}));
