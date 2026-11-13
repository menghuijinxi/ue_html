'use strict';
const {initializeProjectOutput, assertProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {readPage} = require('../web-pipeline-prewarm-package.cjs');
const {audit} = require('../content-file-metadata.cjs');
const base = path.resolve(__dirname, '..');
const folders = {
  old: 'villa-vsm-sampling-adaptive-20261112',
  off: 'villa-added-optimizations-off-20261112',
  plain: 'villa-web-optimizations-off-20261112',
};
const output = assertProjectOutput(path.join(base, 'results/villa-package-parameters-20261113.json'));
const normalized = code => code.replaceAll('\r\n', '\n').trim().replace(/\bmain_[a-f0-9_]+\b/g, 'main');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function systemSettings(text) {
  let section = '';
  const result = {};
  for (const line of text.split(/\r?\n/).map(value => value.trim())) {
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {section = header[1]; continue;}
    const setting = line.match(/^([^=]+)=(.*)$/);
    if (section === 'SystemSettings' && setting) result[setting[1].trim()] = setting[2].trim();
  }
  return result;
}
const loaded = Object.fromEntries(Object.entries(folders).map(([name, folder]) => {
  const directory = path.join(base, 'build', folder), page = readPage(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'asset-versions.json')));
  for (const file of ['index.html', 'config-files.json', 'web-engine-worker.js', 'pipeline-prewarm.json',
    page.assets.runtime, page.assets.wasm.url, 'web-engine-host.js', 'web-content-worker.js',
    'web-content-io.js', 'web-pipeline-prewarm.js'])
    assert.equal(audit(path.join(directory, file)).sha256, manifest[file].sha256);
  assert.equal(page.assets.wasm.sha256, manifest[page.assets.wasm.url].sha256);
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config-files.json')));
  const ini = config.find(file => file.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
  const worker = fs.readFileSync(path.join(directory, 'web-engine-worker.js'), 'utf8');
  let overrides;
  if (name === 'old') {
    assert(worker.includes('r.Shadow.Virtual.SMRT.AdaptiveRayCount=1\\n'));
    overrides = {'r.Shadow.Virtual.SMRT.AdaptiveRayCount': 1};
  } else {
    const state = worker.match(/globalThis\.__villaOptimizationIsolation = (\{[^\n]+\});/);
    assert(state);
    const isolation = JSON.parse(state[1]);
    assert.equal(isolation.mode, name);
    overrides = isolation.overrides;
  }
  const settings = Object.assign(systemSettings(Buffer.from(ini.data, 'base64').toString()),
    Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, String(value)])));
  const corpus = JSON.parse(fs.readFileSync(path.join(directory, 'pipeline-prewarm.json')));
  const content = JSON.parse(fs.readFileSync(path.join(directory, 'content-files.json')));
  return [name, {folder, directory, page, manifest, config, settings, overrides, corpus, content, worker}];
}));
const {old, off, plain} = loaded;
const packages = Object.fromEntries(Object.entries(loaded).map(([name, item]) => {
  const {versions, wasm, pipelinePrewarm, ...runtime} = item.page.assets;
  return [name, {folder: item.folder, manifest: audit(path.join(item.directory, 'asset-versions.json')),
    arguments: item.page.args, runtime, wasm: {sha256: wasm.sha256, size: wasm.size},
    versions, content: item.content.pack.sha256, config: pipelinePrewarm.config,
    effectiveWebSystemSettings: item.settings, startupOverrides: item.overrides,
    prewarm: {modules: item.corpus.modules.length, layouts: item.corpus.layouts.length,
      pipelines: item.corpus.descriptors.length, sha256: pipelinePrewarm.sha256,
      startupOverridesRecorded: false, boundary: name === 'old' ?
        'Old diagnostic substitutes two shader modules before replay; this is not a formal release capture.' :
        'Replays the enabled-optimization corpus; startup overrides are not a matching capture.'}}];
}));
const sharedRuntime = ['gameFrameClock', 'pageFrameBudget', 'inputBridge', 'pageFrameMaxFPS',
  'localFrameBudget', 'localFrameBudgetMode', 'reuseReplayScratch', 'renderSizing', 'fixedRenderSize'];
for (const field of sharedRuntime) {
  assert.deepEqual(off.page.assets[field], old.page.assets[field]);
  assert.deepEqual(plain.page.assets[field], old.page.assets[field]);
}
const sharedFiles = ['web-engine-host.js', 'web-content-worker.js', 'web-content-io.js', 'web-pipeline-prewarm.js'];
for (const file of sharedFiles)
  for (const item of [off, plain]) assert.equal(item.manifest[file].sha256, old.manifest[file].sha256);
const configChanges = old.config.flatMap(file => {
  const other = off.config.find(value => value.path === file.path);
  assert(other);
  if (file.data === other.data) return [];
  const a = new Set(Buffer.from(file.data, 'base64').toString().split(/\r?\n/));
  const b = new Set(Buffer.from(other.data, 'base64').toString().split(/\r?\n/));
  return [{path: file.path, removedLines: [...a].filter(line => !b.has(line)),
    addedLines: [...b].filter(line => !a.has(line))}];
});
assert.equal(configChanges.length, 1);
const oldFiles = new Map(old.content.files.map(file => [file.path, file]));
assert.equal(oldFiles.size, off.content.files.length);
const changedContent = off.content.files.filter(file => {
  assert(oldFiles.has(file.path));
  return oldFiles.get(file.path).sha256 !== file.sha256;
}).map(file => ({path: file.path, oldSize: oldFiles.get(file.path).size, newSize: file.size}));
assert.equal(changedContent.length, 2);
const replacementLine = old.worker.split('\n').find(line => line.startsWith('})([{'));
assert(replacementLine?.endsWith('],true);'));
const replacements = JSON.parse(replacementLine.slice(3, -7));
const effectiveOldModules = old.corpus.modules.map(module => {
  const code = module.descriptor.code, variant = replacements.find(value => code.includes('fn ' + value.entry + '('));
  if (!variant) return module;
  const replacement = variant.replacements.find(value =>
    value.original === code.replaceAll('\r\n', '\n').trim());
  assert(replacement);
  return {...module, descriptor: {...module.descriptor, code: replacement.adaptive}};
});
const moduleMaps = [effectiveOldModules, off.corpus.modules].map(modules =>
  new Map(modules.map(module => [sha(normalized(module.descriptor.code)), module])));
const uniqueModules = moduleMaps.map((modules, index) => [...modules].filter(([hash]) =>
  !moduleMaps[1 - index].has(hash)).map(([hash, module]) => ({sha256: hash,
    entry: module.descriptor.code.match(/fn (main_\w+)\(/)?.[1],
    workgroups: module.descriptor.code.match(/@workgroup_size\([^)]*\)/g),
    atomicHeaderUniform: module.descriptor.code.includes('WebTextureHeaders')})));
const effectiveSettingDifferences = [...new Set(Object.values(loaded).flatMap(item =>
  Object.keys(item.settings)))].filter(key => Object.values(loaded).some(item =>
  item.settings[key] !== old.settings[key])).map(key => ({
  key, values: Object.fromEntries(Object.entries(loaded).map(([name, item]) => [name, item.settings[key] ?? null])),
}));
const linkFiles = ['web-engine-full-thread-20261111-153625', 'web-engine-full-thread-20261112-142909']
  .map(name => path.join(base, 'results', name + '.log.link.rsp'));
const linkFlags = linkFiles.map(file => fs.readFileSync(file, 'utf8').split(/\r?\n/)
  .map(line => line.trim()).filter(line => line.startsWith('-') &&
    !line.startsWith('-L') && !line.startsWith('-l') && !line.startsWith('-o')));
assert.deepEqual(linkFlags[1], linkFlags[0]);
const report = {date: new Date().toISOString(), pass: true, diagnosticOnly: true, source: audit(__filename),
  packages, sharedRuntime, sharedFiles, configChanges, changedContent, effectiveSettingDifferences,
  historicalLinkFlags: {sources: linkFiles.map(audit), identical: true, flags: linkFlags[0],
    boundary: 'Archived response files from the matching build times; does not reconstruct every object compile.'},
  effectiveOldPrewarmVsNewRecordedPrewarm: {oldUnique: moduleMaps[0].size, newUnique: moduleMaps[1].size,
    sharedNormalizedModules: [...moduleMaps[0].keys()].filter(key => moduleMaps[1].has(key)).length,
    oldOnly: uniqueModules[0], newOnly: uniqueModules[1],
    boundary: 'Compares recorded prewarm modules, not dispatch counts. New off/plain startup paths create ' +
      'additional small-tile and non-header pipelines not represented by the enabled-optimization corpus.'},
  boundary: 'Static package/config audit establishes differences, not a causal performance result. ' +
    'Historical package files are only read. Startup overrides are applied after original config verification.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, changedContent, effectiveSettingDifferences,
  shaderComparison: report.effectiveOldPrewarmVsNewRecordedPrewarm}, null, 2));
