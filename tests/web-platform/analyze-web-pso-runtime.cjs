'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const tag = process.argv[2];
assert(/^[a-z0-9-]+$/.test(tag));
const root = path.join(__dirname, 'results'), prefix = path.join(root, tag);
function csv(line) {
  const fields = []; let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {if (quoted && line[i + 1] === '"') {field += c; i++;} else quoted = !quoted;}
    else if (c === ',' && !quoted) {fields.push(field); field = '';}
    else field += c;
  }
  fields.push(field); return fields;
}
function stats(input) {
  const a = [...input].sort((a, b) => a - b);
  assert(a.length);
  return {count: a.length, sum: a.reduce((x, y) => x + y, 0), mean: a.reduce((x, y) => x + y, 0) / a.length,
    median: a[Math.floor(a.length / 2)], p95: a[Math.floor(a.length * .95)], max: a.at(-1)};
}
(async () => {
  const capture = JSON.parse(fs.readFileSync(prefix + '.json'));
  assert(capture.pass && capture.psoBindings && capture.captures.length >= 2);
  const report = {date: new Date().toISOString(), tag, pass: false, runs: [],
    boundary: 'CPU trace enabled. Per-frame CPU sums may overlap between threads and are not GPU duration. Lookup can include creation in general; captures assert zero pipeline creation.',
    settings: capture.before.settings, view: capture.before.view, baseline: capture.baseline};
  for (let i = 0; i < capture.captures.length; i++) {
    const sample = capture.captures[i], events = [], ticks = [], missingEnds = [];
    assert.equal(sample.pso.delta.graphicsCreated + sample.pso.delta.computeCreated, 0);
    const lines = readline.createInterface({input: fs.createReadStream(prefix + `-${i}.events.csv`), crlfDelay: Infinity});
    for await (const line of lines) {
      const c = csv(line);
      if (!/^\d+$/.test(c[0])) continue;
      const e = {thread: c[1], name: c[3], start: +c[4], end: +c[5], ms: +c[6] * 1000};
      if (!Number.isFinite(e.end) || !Number.isFinite(e.ms)) {missingEnds.push(e.name); continue;}
      assert(e.end >= e.start);
      if (e.name === 'FEngineLoop::Tick') ticks.push(e);
      if (e.name.startsWith('WebPSO_')) events.push(e);
    }
    ticks.sort((a, b) => a.start - b.start);
    assert(ticks.length > 30 && events.length > 1000);
    // Drop the two edge frames. Partition by consecutive game-frame starts to
    // include the pipelined RT/RHI work without pretending thread sums are serial.
    const frames = ticks.slice(1, -1).map((e, j) => ({start: e.start, end: ticks[j + 2].start, values: {}}));
    const eligible = events.filter(e => e.start >= frames[0].start && e.end <= frames.at(-1).end);
    const groups = {};
    for (const name of [...new Set(eligible.map(e => e.name))].sort()) {
      const matching = eligible.filter(e => e.name === name);
      for (const e of matching) {
        // Trace is already time sorted within threads; use binary search for GT bins.
        let lo = 0, hi = frames.length;
        while (lo < hi) {const mid = (lo + hi) >>> 1; if (frames[mid].start <= e.start) lo = mid + 1; else hi = mid;}
        const frame = frames[lo - 1]; if (frame) frame.values[name] = (frame.values[name] || 0) + e.ms;
      }
      groups[name] = {calls: matching.length, threads: [...new Set(matching.map(e => e.thread))],
        callUs: stats(matching.map(e => e.ms * 1000)), perFrameMs: stats(frames.map(f => f.values[name] || 0))};
    }
    for (const name of ['WebPSO_CacheLookupGraphics', 'WebPSO_CacheLookupCompute', 'WebPSO_ResolveGraphics',
      'WebPSO_ResolveCompute', 'WebPSO_BindGraphicsOwner', 'WebPSO_BindComputeOwner']) assert(groups[name]);
    const allPerFrameMs = stats(frames.map(f => Object.values(f.values).reduce((s, n) => s + n, 0)));
    const delta = sample.pso.delta, actualCalls = delta.graphicsBinds + delta.computeBinds + delta.bundleBinds;
    const jsMs = delta.graphicsBindsMs + delta.computeBindsMs + delta.bundleBindsMs;
    report.runs.push({file: sample.file, frames: frames.length, missingEnds, groups, allPerFrameMs,
      gameFrameIntervalMs: stats(frames.map(f => (f.end - f.start) * 1000)),
      actualJSAPI: {delta, framesIncludingTraceExport: sample.frames, calls: actualCalls,
        meanCallUs: jsMs / actualCalls * 1000, cpuMsPerPresentedFrame: jsMs / sample.frames}, captureFps: sample.fps});
  }
  report.pass = true;
  fs.writeFileSync(prefix + '-analysis.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(e => {console.error(e); process.exitCode = 1;});
