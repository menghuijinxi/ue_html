'use strict';

// Re-analyze saved idle captures; this does not launch or instrument the game.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = path.join(__dirname, 'results');
const prefix = process.argv.find(arg => arg.startsWith('--prefix='))?.slice(9) || 'idle-20261101';
if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw Error('Invalid result prefix');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const evidence = name => ({file: name, sha256: crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(directory, name))).digest('hex')});
const rounded = value => Number(value.toFixed(4));
const analysisName = `${prefix}-analysis.json`;
const previous = read(analysisName);
const selected = {
  groups: /FWebGPUDynamicRHI::CreateGroups\(/,
  drawBindings: /FWebGPUDynamicRHI::SetDrawBindings\(/,
  vertexBufferBridge: /^_wgpuRenderPassEncoderSetVertexBuffer$/,
  psoHash: /FDynamicRHI::RHIComputeStatePrecachePSOHash\(/,
  copyOwnerWrapper: /WebGPUForward<&wgpuCommandEncoderCopyBufferToBuffer/,
};

function profileCosts(profile, frames) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  const costs = Object.fromEntries(Object.keys(selected).map(key => [key,
    {selfMs: 0, inclusiveMs: 0, selfSamples: 0, selfMsInGapsOver50ms: 0}]));
  let longGapSamples = 0, longGapMs = 0, largestGapMs = 0;
  for (let index = 0; index < (profile.samples || []).length; index++) {
    const ms = profile.timeDeltas[index] / 1000;
    largestGapMs = Math.max(largestGapMs, ms);
    if (ms > 50) { longGapSamples++; longGapMs += ms; }
    const names = [];
    for (let id = profile.samples[index]; id !== undefined; id = parents.get(id))
      names.push(nodes.get(id).callFrame.functionName);
    for (const [key, pattern] of Object.entries(selected)) {
      if (pattern.test(names[0])) {
        costs[key].selfMs += ms;
        costs[key].selfSamples++;
        if (ms > 50) costs[key].selfMsInGapsOver50ms += ms;
      }
      // Count a sample once even when a matching function appears twice on its stack.
      if (names.some(name => pattern.test(name))) costs[key].inclusiveMs += ms;
    }
  }
  for (const value of Object.values(costs)) {
    value.selfMsPerFrame = rounded(value.selfMs / frames);
    value.inclusiveMsPerFrame = rounded(value.inclusiveMs / frames);
    value.selfMsInGapsOver50ms = rounded(value.selfMsInGapsOver50ms);
    delete value.selfMs; delete value.inclusiveMs;
  }
  return {costs, samplingGaps: {longGapSamples, longGapMs: rounded(longGapMs), largestGapMs: rounded(largestGapMs)}};
}

function captureSummary(tag) {
  const filename = `performance-capture-${prefix}-${tag}-profile.json`;
  const capture = read(filename);
  const frames = capture.capture.frames.length;
  const passes = new Map();
  for (const pass of capture.capture.passes) {
    const value = passes.get(pass.label) || {passes: 0, draws: 0};
    value.passes++;
    for (const [name, count] of Object.entries(pass.calls)) if (name.startsWith('draw')) value.draws += count;
    passes.set(pass.label, value);
  }
  const rows = [...passes].map(([label, value]) => ({label,
    passesPerFrame: rounded(value.passes / frames), drawsPerFrame: value.draws / frames}));
  const allDraws = rows.reduce((sum, row) => sum + row.drawsPerFrame, 0);
  const shadowDraws = rows.filter(row => /^(WholeSceneShadowmap|ShadowDepthAtlas|CachedShadowDepthMap|WebCubeShadowFace)/.test(row.label))
    .reduce((sum, row) => sum + row.drawsPerFrame, 0);
  return {tag, source: evidence(filename), captureFrames: frames,
    apiCallsPerFrame: Object.fromEntries(Object.entries(capture.capture.calls).map(([key, value]) => [key, rounded(value / frames)])),
    allDrawsPerFrame: rounded(allDraws), shadowDepthDrawsPerFrame: rounded(shadowDraws),
    shadowDepthDrawPercent: rounded(shadowDraws / allDraws * 100),
    passes: rows.sort((a, b) => b.drawsPerFrame - a.drawsPerFrame).map(row => ({...row, drawsPerFrame: rounded(row.drawsPerFrame)})),
    gpuPassSumsMs: capture.gpuFrames.map(frame => rounded(frame.totalPassMs)),
    profiles: capture.profiles.filter(profile => ['RHI', 'Draw / Render', 'Game'].includes(profile.summary.role))
      .map(profile => ({role: profile.summary.role, source: evidence(profile.file),
        ...profileCosts(read(profile.file), capture.profileMeasurement.frames)}))};
}

const result = {derivedAt: new Date().toISOString(), analysisSource: evidence(analysisName),
  boundaries: ['Saved captures only; no new FPS measurements.',
    'API and CPU captures are separate, instrumented windows; pass counts use presented frame boundaries.',
    'Inclusive sample times overlap. Long gaps are flagged, retained, and cannot establish function latency.',
    'GPU values sum three sampled frames of timestamped passes, excluding copies and gaps; not full GPU frame time.'],
  comparisons: previous.comparisons.map(row => ({id: row.id, fps: row.fps,
    rhiWorkMsPerFrame: row.rhiWorkMsPerFrame, improvementPercent: row.improvementPercent})),
  captures: ['resource-tables-baseline', 'resource-tables-candidate', 'gpuscene-candidate', 'parallel-recording-baseline']
    .map(captureSummary)};
const output = path.join(directory, `${prefix}-bottlenecks.json`);
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({output, captures: result.captures.map(capture => ({tag: capture.tag,
  draws: capture.allDrawsPerFrame, shadowDepthPercent: capture.shadowDepthDrawPercent}))}, null, 2));
