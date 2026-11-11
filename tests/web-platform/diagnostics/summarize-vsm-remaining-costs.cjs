'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {audit} = require('../content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const base = path.resolve(__dirname, '..'), output = option('out');
assert(output);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const reports = ['on-gpu', 'off-gpu', 'on-cpu', 'off-cpu'].map(key => {
  const file = path.join(base, 'results', option(key), 'result.json'), report = read(file);
  assert(report.pass && !report.errors.length, file);
  return {key, file, report};
});
const catalog = {}, names = {};
for (const {key, report, file} of reports) if (key.endsWith('gpu')) {
  const fileName = path.join(path.dirname(file), 'compute-shaders.json');
  assert.equal(audit(fileName).sha256, report.catalog.sha256);
  Object.assign(catalog, read(fileName));
}
const shaderFacts = {};
for (const [entry, code] of Object.entries(catalog)) {
  const headerLoads = code.split(/\r?\n/).filter(line =>
    /atomicLoad.*(?:OutPage|InOutPage)/.test(line) && /\[[0-3]u\]/.test(line));
  const sparsePoolSync = code.includes('WebShadowPoolAtomicBuffer') && code.includes('PhysicalPageMetaData');
  shaderFacts[entry] = {subgroups: /enable subgroups/.test(code), f16: /enable f16/.test(code),
    ...(headerLoads.length ? {headerLoads} : {}),
    ...(sparsePoolSync ? {sparsePoolSync: code.includes('textureStore(WebShadowPoolTexture') ?
      'buffer-to-texture' : 'texture-to-buffer'} : {})};
}
// RHI specializes storage texture formats to the bound resource at runtime.
const normalize = code => code.trim().replace(/texture_storage_(\w+)<\w+,/g, 'texture_storage_$1<FORMAT,');
const roots = process.argv.filter(arg => arg.startsWith('--shader-root=')).map(arg => arg.slice(14));
assert(roots.length);
for (const root of roots) {
  const files = execFileSync('rg', ['--files', '--no-ignore', root, '-g', 'input.json'],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim().split(/\r?\n/);
  for (const file of files) {
    const metadata = read(file), entry = metadata.metadata?.webEntry;
    if (!catalog[entry] || names[entry]) continue;
    const wgsl = path.join(path.dirname(file), 'output.wgsl');
    if (!fs.existsSync(wgsl)) continue;
    const code = fs.readFileSync(wgsl, 'utf8');
    if (normalize(code) !== normalize(catalog[entry])) continue;
    names[entry] = {name: metadata.shaderName, shader: metadata.shader,
      match: 'entry point and WGSL equal after storage-format normalization',
      metadata: audit(file), wgsl: audit(wgsl)};
  }
}
const average = values => values.reduce((sum, n) => sum + n, 0) / values.length;
function gpuPhase(phase) {
  const groups = {}, frameCount = phase.gpuFrames.length;
  assert(frameCount >= 6);
  for (const {capture} of phase.gpuFrames) {
    assert(capture.entries.length > 0 && capture.entries.length < 1024);
    for (const pass of capture.entries) {
      assert(Number.isFinite(pass.gpuMs));
      const key = pass.pipeline || pass.label;
      const inferredName = shaderFacts[key]?.sparsePoolSync ?
        'FWebSyncVirtualShadowPoolCS/' + shaderFacts[key].sparsePoolSync + ' (resource-signature match)' : key;
      const group = groups[key] ||= {key, name: names[key]?.name || inferredName,
        gpuMs: 0, calls: {}, passes: 0};
      group.gpuMs += pass.gpuMs / frameCount;
      group.passes += 1 / frameCount;
      for (const [name, value] of Object.entries(pass.calls))
        group.calls[name] = (group.calls[name] || 0) + value / frameCount;
    }
  }
  return {name: phase.name, frames: frameCount,
    passSumMs: average(phase.gpuFrames.map(f => f.capture.totalPassMs)),
    spanMs: average(phase.gpuFrames.map(f => {
      const entries = f.capture.entries;
      return Math.max(...entries.map(e => e.gpuStartMs + e.gpuMs)) -
        Math.min(...entries.map(e => e.gpuStartMs));
    })),
    groups: Object.values(groups).sort((a, b) => b.gpuMs - a.gpuMs)};
}
function cpuProfile({file, target}) {
  const p = read(file), nodes = new Map(p.nodes.map(n => [n.id, n])), parents = new Map();
  for (const n of p.nodes) for (const child of n.children || []) parents.set(child, n.id);
  const self = {}, inclusive = {}, categories = {}, tests = {
    idle: /^\(idle\)$/, wait: /_do_futex_wait|emscripten_futex_wait|__pthread_cond_(?:timed)?wait/,
    createGroups: /FWebGPUDynamicRHI::CreateGroups/, setDrawBindings: /FWebGPUDynamicRHI::SetDrawBindings/,
    indirectDraw: /FWebGPUDynamicRHI::RHIDrawIndexedPrimitiveIndirect/,
    commandReplay: /_ueWGPUReplay/, resources: /FWebGPUDynamicRHI::CommitShaderResources/,
    allocation: /FMemory::(Malloc|Realloc|Free)|emscripten_builtin_(malloc|free)/};
  let duration = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const us = p.timeDeltas[i], stack = [];
    duration += us;
    for (let id = p.samples[i]; id !== undefined; id = parents.get(id))
      stack.push(nodes.get(id).callFrame.functionName || '(anonymous)');
    self[stack[0]] = (self[stack[0]] || 0) + us;
    // Recursive occurrences of the same function count once per sample.
    for (const name of new Set(stack)) inclusive[name] = (inclusive[name] || 0) + us;
    const text = stack.join('\n');
    for (const [name, re] of Object.entries(tests))
      if (re.test(name === 'idle' ? stack[0] : text)) categories[name] = (categories[name] || 0) + us;
  }
  const rank = object => Object.entries(object).map(([name, us]) =>
    ({name, ms: us / 1000, percent: us / duration * 100})).sort((a, b) => b.ms - a.ms);
  const allNames = p.nodes.map(n => n.callFrame.functionName).join('\n');
  const role = /FRHIThread::WebPump/.test(allNames) ? 'RHI' :
    /EngineFrame\(void/.test(allNames) ? 'Game' :
    /RenderingThreadMain|FRenderingThread::Run/.test(allNames) ? 'Render' : 'auxiliary';
  return {source: audit(file), target: target.title, role, durationMs: duration / 1000,
    samples: p.samples.length, categories: rank(categories), self: rank(self).slice(0, 25),
    inclusive: rank(inclusive).slice(0, 45)};
}
const result = {date: new Date().toISOString(), pass: true, source: audit(__filename),
  boundary: 'GPU captures split compute passes and use quantized timestamps; they identify hotspots, not production FPS or additive potential gains. CPU captures statistically sample wall time; inclusive stacks/categories overlap. One run per mode, six GPU frames per phase.',
  shaderNames: names, shaderFacts, runs: []};
for (const {key, file, report} of reports) {
  result.runs.push({key, source: audit(file), probe: report.source, package: report.package,
    browser: report.browser, adapter: report.adapter, capabilities: report.capabilities,
    overrides: report.overrides, settings: report.initial.settings, view: report.initial.view,
    prewarm: report.initial.prewarm.counts,
    phases: report.phases.map(phase => key.endsWith('gpu') ? gpuPhase(phase) : ({
      name: phase.name,
      profiles: phase.profiles.map(cpuProfile).filter(p => p.role !== 'auxiliary'),
      frames: phase.after.frames - phase.before.frames,
      rhiWorkMsPerFrame: (phase.after.stages.rhiWorkMilliseconds - phase.before.stages.rhiWorkMilliseconds) /
        (phase.after.stages.rhiFrames - phase.before.stages.rhiFrames)}))});
}
const copiesFile = option('copies');
if (copiesFile) {
  const copies = read(copiesFile);
  assert(copies.pass && !copies.errors.length);
  assert.equal(copies.package.sha256, reports.find(r => r.key === 'on-gpu').report.package.sha256);
  result.ordinaryPassCopyCapture = {source: audit(copiesFile), boundary:
    'Payload byte estimates from copy extents, not allocated memory or isolated copy timing. Names may alias the same physical resource.',
    phases: copies.phases.map(phase => {
      const frames = phase.after.frames - phase.before.frames, resources = {};
      for (const [name, after] of Object.entries(phase.after.shadowCopies)) {
        const before = phase.before.shadowCopies[name] || {};
        resources[name] = Object.fromEntries(Object.entries(after).map(([key, value]) =>
          [key, (value - (before[key] || 0)) / frames]));
      }
      return {name: phase.name, frames, resources};
    })};
}
for (const run of result.runs) {
  assert.equal(run.settings.virtualShadows, run.key.startsWith('on-') ? 1 : 0);
  assert.equal(run.view.width, 1400); assert.equal(run.view.height, 788);
  assert.equal(run.view.outputWidth, 1920); assert.equal(run.view.outputHeight, 1080);
  assert.equal(run.view.antiAliasing, 4);
  assert.equal(run.settings.gi, 1); assert.equal(run.settings.reflections, 1);
  assert.equal(run.settings.virtualTextures, 1); assert.equal(run.prewarm.misses, 0);
  for (const phase of run.phases)
    if (phase.profiles) assert(phase.profiles.some(p => p.role === 'RHI'));
}
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, matchedShaders: Object.keys(names).length,
  capturedComputeShaders: Object.keys(catalog).length,
  runs: result.runs.map(run => ({key: run.key, phases: run.phases.length}))}));
