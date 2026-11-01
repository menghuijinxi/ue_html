'use strict';

// Summarize saved experiments without starting a browser or changing project settings.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const directory = path.join(__dirname, 'results');
const prefix = process.argv.find(arg => arg.startsWith('--prefix='))?.slice(9) || 'binding-groups-v4';
assert(/^[a-z0-9-]+$/.test(prefix));
const file = name => path.join(directory, name);
const read = name => JSON.parse(fs.readFileSync(file(name), 'utf8').replace(/^\uFEFF/, ''));
const evidence = name => ({file: name, sha256: crypto.createHash('sha256')
  .update(fs.readFileSync(file(name))).digest('hex')});
const rounded = value => Number(value.toFixed(4));
const weighted = (runs, name, getter) => {
  const selected = runs.filter(run => run.name === name);
  return selected.reduce((sum, run) => sum + getter(run) * run.counterFrames, 0) /
    selected.reduce((sum, run) => sum + run.counterFrames, 0);
};
const report = {date: new Date().toISOString(), prefix, inputs: [], settingsOverrides: []};
for (const tag of ['validation', 'normal']) {
  const name = `project-gameplay-${prefix}-${tag}.json`, value = read(name);
  assert(value.pass && !value.settingsOverrides.length);
  if (tag === 'validation') report.testStarted = value.date;
  report.inputs.push(evidence(name));
  report[tag] = value.runs.map(run => {
    assert(!run.errors.length);
    return {seconds: value.seconds, firstFrame: run.samples[0].frame,
      lastFrame: run.samples.at(-1).frame, maxTravelCm: run.maxTravelCm,
      maxTurnDegrees: run.maxTurnDegrees, bindings: run.samples.at(-1).bindings};
  });
}
assert(report.validation[0].bindings.groupPreparationValidated > 1000);
assert(report.normal[0].bindings.groupPreparationHits > 1000);
for (const kind of ['toggle', 'release']) {
  const name = `${prefix}-${kind}-abba.json`;
  if (!fs.existsSync(file(name))) continue;
  const value = read(name);
  assert(value.pass && value.runs.length === 4 && !value.settingsOverrides.length);
  report.inputs.push(evidence(name));
  const keys = Object.keys(value.runs[0].perFrame);
  report[kind] = {fps: value.fps, improvementPercent: value.improvementPercent,
    frameMs: Object.fromEntries(Object.entries(value.fps).map(([key, fps]) => [key, rounded(1000 / fps)])),
    rhiWorkMsPerFrame: value.rhiWorkMsPerFrame,
    runs: value.runs.map(run => ({name: run.name, ...run.baseline})),
    perFrame: Object.fromEntries(['baseline', 'candidate'].map(label => [label,
      Object.fromEntries(keys.map(key => [key, rounded(weighted(value.runs, label, run => run.perFrame[key]))]))]))};
}
report.profiles = {};
const selected = {groups: /FWebGPUDynamicRHI::CreateGroups\(/,
  drawBindings: /FWebGPUDynamicRHI::SetDrawBindings\(/,
  resolveBindings: /FWebGPUDynamicRHI::ResolveDrawBinding\(/,
  resourceTables: /FWebGPUDynamicRHI::CommitShaderResources\(/,
  vertexBufferBridge: /^_wgpuRenderPassEncoderSetVertexBuffer$/,
  createGroupBridge: /^_wgpuDeviceCreateBindGroup$/};
for (const mode of ['off', 'on']) {
  const name = `performance-capture-${prefix}-${mode}-profile.json`;
  if (!fs.existsSync(file(name))) continue;
  const value = read(name);
  assert(value.pass && !value.errors.length);
  report.inputs.push(evidence(name));
  const worker = value.profiles.find(profile => profile.summary.role === 'RHI');
  assert(worker);
  report.inputs.push(evidence(worker.file));
  const profile = read(worker.file), nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  const costs = Object.fromEntries(Object.keys(selected).map(key => [key,
    {selfMs: 0, inclusiveMs: 0, inclusiveMsInGapsOver50ms: 0}]));
  let longGapMs = 0, largestGapMs = 0;
  for (let index = 0; index < profile.samples.length; ++index) {
    const ms = profile.timeDeltas[index] / 1000, names = [];
    largestGapMs = Math.max(largestGapMs, ms);
    if (ms > 50) longGapMs += ms;
    for (let id = profile.samples[index]; id !== undefined; id = parents.get(id))
      names.push(nodes.get(id).callFrame.functionName);
    for (const [key, pattern] of Object.entries(selected)) {
      if (pattern.test(names[0])) costs[key].selfMs += ms;
      if (names.some(name => pattern.test(name))) {
        costs[key].inclusiveMs += ms;
        if (ms > 50) costs[key].inclusiveMsInGapsOver50ms += ms;
      }
    }
  }
  for (const cost of Object.values(costs)) {
    cost.inclusiveMsExcludingGapsOver50ms = cost.inclusiveMs - cost.inclusiveMsInGapsOver50ms;
    for (const key of Object.keys(cost)) cost[key + 'PerFrame'] = rounded(cost[key] / value.profileMeasurement.frames);
  }
  report.profiles[mode] = {normal: value.baseline, sampled: value.profileMeasurement,
    costs, samplingGaps: {longGapMs, largestGapMs},
    apiCallsPerFrame: Object.fromEntries(Object.entries(value.capture.calls).map(([key, count]) =>
      [key, rounded(count / value.capture.frames.length)])),
    gpuPassSumsMs: value.gpuFrames.map(frame => rounded(frame.totalPassMs)),
    boundary: 'CPU samples and API counts come from separate instrumented windows. Inclusive costs overlap; gap exclusion is diagnostic, not corrected timing.'};
}
const shadowFile = `project-gameplay-${prefix}-validation.log`;
report.inputs.push(evidence(shadowFile));
const latest = new Map(), shadows = [], stats = [];
let pending;
for (const line of fs.readFileSync(file(shadowFile), 'utf8').split('\n')) {
  if (line.includes('P3_WEB_SHADOW_SUBMISSION ')) {
    const record = Object.fromEntries([...line.matchAll(/([A-Za-z]+)=(-?\d+(?:x\d+)?)/g)]
      .map(([, key, value]) => [key, value.includes('x') ? value : Number(value)]));
    shadows.push(record);
    latest.set(`${record.light}/${record.split}/${record.mode}`, record);
  }
  const header = line.match(/Instancing stats for WebShadow light=(\d+) split=(-?\d+) mode=(\d+)/);
  if (header) pending = latest.get(`${header[1]}/${header[2]}/${header[3]}`);
  const counts = line.match(/(\d+) Mesh Draw Commands in (\d+) instancing state buckets/);
  if (counts && pending) { stats.push({...pending, before: Number(counts[1]), after: Number(counts[2])}); pending = null; }
}
assert(shadows.length > 0 && stats.length > 0);
const firstFrame = Math.min(...shadows.map(record => record.frame));
const first = stats.filter(record => record.frame === firstFrame);
const summarize = records => ({passes: records.length,
  before: records.reduce((sum, record) => sum + record.before, 0),
  after: records.reduce((sum, record) => sum + record.after, 0)});
report.shadows = {sampledSubmissions: shadows.length, statistics: stats.length,
  csmCacheValues: [...new Set(shadows.map(record => record.csmCache))],
  localCacheValues: [...new Set(shadows.map(record => record.localCache))], firstFrame,
  directional: first.filter(record => record.directional),
  firstFrameDirectional: summarize(first.filter(record => record.directional)),
  firstFrameLocal: summarize(first.filter(record => !record.directional)),
  records: stats,
  boundaries: ['Counts are UE mesh command setup statistics, not GPU time or exact browser API counts.',
    'RenderDepth input arrays have already moved into the pass; cachedCommands/dynamicElements are not caster counts.',
    'Cache modes: 0 movable only; 1 static only; 2 CSM scrolling; 3 uncached.',
    'A disabled CSM cache does not produce cache invalidation events. Local cache invalidation reasons are not fully instrumented.']};
const environment = `${prefix}-environment.jsonl`;
if (fs.existsSync(file(environment))) {
  report.inputs.push(evidence(environment));
  const rows = fs.readFileSync(file(environment), 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line.replace(/^\uFEFF/, ''))).filter(row => row.utc >= report.testStarted);
  report.environment = {start: rows[0]?.utc, end: rows.at(-1)?.utc, samples: rows.length,
    blockers: rows.filter(row => row.blockers.length),
    boundary: 'Process inventory excludes known game/build interference; ordinary background apps and system scheduling remain.'};
}
if (process.argv.includes('--images')) {
  const {PNG} = require('pngjs');
  const imageName = index => `performance-capture-${prefix}-toggle-abba-${index}-${index === 0 || index === 3 ? 'baseline' : 'candidate'}-scene.png`;
  const images = [0, 1, 2, 3].map(index => PNG.sync.read(fs.readFileSync(file(imageName(index)))));
  report.inputs.push(...[0, 1, 2, 3].map(index => evidence(imageName(index))));
  report.images = [[0, 1], [2, 3], [0, 3]].map(([left, right]) => {
    const a = images[left], b = images[right];
    assert(a.width === b.width && a.height === b.height);
    let sum = 0;
    for (let index = 0; index < a.data.length; index++) if (index % 4 !== 3) sum += Math.abs(a.data[index] - b.data[index]);
    return {left: imageName(left), right: imageName(right), width: a.width, height: a.height,
      meanAbsoluteRGBError: sum / (a.width * a.height * 3)};
  });
}
report.pass = true;
const output = file(`${prefix}-analysis.json`);
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, toggle: report.toggle?.fps, release: report.release?.fps,
  shadowDirectional: report.shadows.firstFrameDirectional, shadowLocal: report.shadows.firstFrameLocal, output}));
