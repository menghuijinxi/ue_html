'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const directory = path.join(__dirname, 'results');
const prefix = process.argv.find(arg => arg.startsWith('--prefix='))?.slice(9) || 'local-lights-20261102';
assert(/^[a-z0-9-]+$/.test(prefix));
const file = name => path.join(directory, name);
const read = name => JSON.parse(fs.readFileSync(file(name), 'utf8').replace(/^\uFEFF/, ''));
const evidence = name => ({file: name, sha256: crypto.createHash('sha256')
  .update(fs.readFileSync(file(name))).digest('hex')});
const rounded = value => Number(value.toFixed(4));
const abbaName = `${prefix}-abba.json`, abba = read(abbaName);
assert(abba.pass && abba.localLightsComparison && abba.runs.length === 4);
const report = {date: new Date().toISOString(), prefix, inputs: [evidence(abbaName)],
  originalLights: 'baseline', localLightsHidden: 'candidate',
  fps: abba.fps, improvementPercent: abba.improvementPercent,
  frameMs: Object.fromEntries(Object.entries(abba.fps).map(([name, fps]) => [name, rounded(1000 / fps)])),
  rhiWorkMsPerFrame: abba.rhiWorkMsPerFrame,
  runs: abba.runs.map(run => ({name: run.name, ...run.baseline, lighting: run.lighting,
    diagnosticOverrides: run.diagnosticOverrides, restoredLighting: run.restoredLighting})), captures: {}};
for (const run of abba.runs) {
  assert.equal(run.restoredLighting.mode, 0);
  for (const key of ['aoLevels', 'reflectionMode', 'shadowQuality'])
    assert.equal(run.lighting[key], run.lighting.original[key]);
}
report.perFrame = Object.fromEntries(['baseline', 'candidate'].map(name => {
  const runs = abba.runs.filter(run => run.name === name);
  const frames = runs.reduce((sum, run) => sum + run.counterFrames, 0);
  return [name, Object.fromEntries(Object.keys(runs[0].perFrame).map(key => [key,
    rounded(runs.reduce((sum, run) => sum + run.perFrame[key] * run.counterFrames, 0) / frames)]))];
}));
for (const mode of ['on', 'off']) {
  const name = `performance-capture-${prefix}-${mode}-profile.json`;
  if (!fs.existsSync(file(name))) continue;
  const value = read(name);
  assert(value.pass && !value.errors.length && value.restoredLighting.mode === 0);
  assert.equal(value.before.lighting.mode, mode === 'off' ? 2 : 0);
  report.inputs.push(evidence(name));
  const frames = value.capture.frames.length, passes = new Map();
  for (const pass of value.capture.passes) {
    const entry = passes.get(pass.label) || {passes: 0, draws: 0, cpuMs: 0};
    entry.passes++;
    entry.cpuMs += pass.cpuMs;
    for (const [key, count] of Object.entries(pass.calls)) if (key.startsWith('draw')) entry.draws += count;
    passes.set(pass.label, entry);
  }
  const rows = [...passes].map(([label, value]) => ({label, passesPerFrame: value.passes / frames,
    drawsPerFrame: value.draws / frames, cpuMsPerFrame: value.cpuMs / frames})).sort((a, b) => b.drawsPerFrame - a.drawsPerFrame);
  const totalDraws = rows.reduce((sum, row) => sum + row.drawsPerFrame, 0);
  const shadowDraws = rows.filter(row => /^(WholeSceneShadowmap|ShadowDepthAtlas|CachedShadowDepthMap|WebCubeShadowFace)/.test(row.label))
    .reduce((sum, row) => sum + row.drawsPerFrame, 0);
  report.captures[mode] = {normalWindow: value.baseline, captureFrames: frames,
    allDrawsPerFrame: rounded(totalDraws), shadowDrawsPerFrame: rounded(shadowDraws),
    apiCallsPerFrame: Object.fromEntries(Object.entries(value.capture.calls).map(([key, count]) => [key, rounded(count / frames)])),
    gpuPassSumsMs: value.gpuFrames.map(frame => rounded(frame.totalPassMs)),
    passes: rows.map(row => ({label: row.label, passesPerFrame: rounded(row.passesPerFrame),
      drawsPerFrame: rounded(row.drawsPerFrame), cpuMsPerFrame: rounded(row.cpuMsPerFrame)})),
    cpuReports: value.profiles.filter(profile => ['RHI', 'Game', 'Draw / Render'].includes(profile.summary.role))
      .map(profile => ({role: profile.summary.role, file: profile.file}))};
}
if (report.captures.on && report.captures.off) {
  const {on, off} = report.captures;
  for (const label of ['ShadowDepthAtlas', 'WebCubeShadowFace', 'CachedShadowDepthMap']) {
    assert(on.passes.some(pass => pass.label === label));
    assert(!off.passes.some(pass => pass.label === label && pass.drawsPerFrame > 0), label + ' must disappear');
  }
  const directional = capture => capture.passes.find(pass => pass.label === 'WholeSceneShadowmap');
  assert(Math.abs(directional(on).drawsPerFrame - directional(off).drawsPerFrame) < 2);
  report.reduction = {drawsPerFrame: rounded(on.allDrawsPerFrame - off.allDrawsPerFrame),
    shadowDrawsPerFrame: rounded(on.shadowDrawsPerFrame - off.shadowDrawsPerFrame),
    shadowFractionOfRemovedDraws: rounded((on.shadowDrawsPerFrame - off.shadowDrawsPerFrame) /
      (on.allDrawsPerFrame - off.allDrawsPerFrame))};
}
const environmentName = `${prefix}-environment.jsonl`;
if (fs.existsSync(file(environmentName))) {
  const rows = fs.readFileSync(file(environmentName), 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line.replace(/^\uFEFF/, ''))).filter(row => row.utc >= abba.date);
  report.inputs.push(evidence(environmentName));
  report.environment = {start: rows[0]?.utc, end: rows.at(-1)?.utc, samples: rows.length,
    blockers: rows.filter(row => row.blockers.length)};
}
report.boundaries = ['Component visibility is a temporary diagnostic; local lighting and local dynamic shadows are removed together.',
  'Directional light, skylight, baked lightmaps and precomputed reflection captures remain.',
  'Normal ABBA FPS and instrumented API/CPU/GPU windows are separate.',
  'GPU pass sums exclude copies and gaps; they are not full GPU frame time.',
  'Restoration uses the existing engine diagnostic interface and preserves original per-component visibility.'];
report.pass = true;
const output = file(`${prefix}-analysis.json`);
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, fps: report.fps, improvementPercent: report.improvementPercent,
  captures: Object.fromEntries(Object.entries(report.captures).map(([mode, value]) => [mode,
    {draws: value.allDrawsPerFrame, shadowDraws: value.shadowDrawsPerFrame}])), output}));
