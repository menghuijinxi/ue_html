'use strict';
// Wall-clock phases remain separate from overlapping async request latencies.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const input = process.argv[2]; assert(input, 'Usage: node analyze-web-startup-phases.cjs capture.json');
const capture = JSON.parse(fs.readFileSync(input, 'utf8'));
const sum = values => values.reduce((a, b) => a + b, 0);
const round = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
function union(intervals) {
  let end = -Infinity, duration = 0;
  for (const [a, b] of intervals.sort((a, b) => a[0] - b[0])) {
    if (b > end) {duration += b - Math.max(a, end); end = b;}
  }
  return duration;
}
function cpuWindow(profile, from, to) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n])), parents = new Map(), self = new Map(), inclusive = new Map();
  for (const node of nodes.values()) for (const child of node.children || []) parents.set(child, node.id);
  let at = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    const next = at + profile.timeDeltas[i], overlap = Math.max(0, Math.min(next, to) - Math.max(at, from)); at = next;
    if (!overlap) continue;
    const id = profile.samples[i]; self.set(id, (self.get(id) || 0) + overlap);
    for (let x = id; x !== undefined; x = parents.get(x)) inclusive.set(x, (inclusive.get(x) || 0) + overlap);
  }
  const rank = values => [...values].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id, us]) =>
    ({milliseconds: round(us / 1000), ...nodes.get(id).callFrame}));
  return {durationMs: round((to - from) / 1000), self: rank(self), inclusive: rank(inclusive)};
}
const result = {input: path.resolve(input), capturePassed: capture.pass, folder: capture.folder,
  boundaries: ['Times are relative to page navigation, in milliseconds.',
    'Async latency includes scheduling and callback delivery; totals across requests overlap.',
    'Early canvas work may be the engine loading frame. First game-loop frame uses RHI present counter >= 2.',
    'GPU queue completion is not monitor scanout. Loader visibility is a separate milestone.',
    'CPU sampling and native tracing perturb startup; compare untraced runs for wall time.'], runs: []};
for (const run of capture.runs) {
  if (!run.owner || !run.page) continue;
  const origin = run.page.timeOrigin, marks = [...run.owner.marks, ...run.page.marks].sort((a, b) => a.at - b.at);
  const mark = name => marks.find(x => x.name === name)?.at;
  const events = run.owner.events, event = name => events.find(e => e.name === name);
  const milestone = Object.fromEntries(marks.filter(m => !m.name.startsWith('page.stage.') ||
    /engine-script-loading|engine-starting|running/.test(m.name)).map(m => [m.name, round(m.at - origin)]));
  const phases = [];
  const phase = (name, start, end) => {if (Number.isFinite(start) && Number.isFinite(end))
    phases.push({name, startMs: round(start - origin), endMs: round(end - origin), durationMs: round(end - start)});};
  const mount = event('io.mount'), wasm = events.find(e => /^wasm.instantiate/.test(e.name));
  phase('page to engine script', origin, mark('page.stage.engine-script-loading'));
  phase('WASM instantiate (includes asset wait)', wasm?.start, wasm?.end);
  phase('content mount (includes pack verification)', mount?.start, mount?.end);
  phase('runtime ready to engine ready', mark('wasm.runtimeInitialized'), mark('log.P3_ENGINE_READY'));
  for (const name of ['PreInit', 'Init', 'threadWitness', 'firstTick'])
    phase('native.' + name, mark('native.' + name + '.begin'), mark('native.' + name + '.end'));
  phase('engine ready to first game frame submitted', mark('log.P3_ENGINE_READY'), mark('gpu.firstGameFrameSubmitted'));
  phase('game frame submit to GPU queue completed', mark('gpu.firstGameFrameSubmitted'), mark('gpu.firstGameFrameCompleted'));
  phase('engine ready to PSO-ready message', mark('log.P3_ENGINE_READY'), mark('page.psoReady'));
  phase('navigation to visible scene (two RAF after loader hidden)', origin, mark('page.visibleTwoRAF'));
  const pipelineTypes = [...new Set(run.owner.pipelines.map(x => x.name))];
  const pipelines = pipelineTypes.map(name => {
    const ps = run.owner.pipelines.filter(x => x.name === name);
    return {name, count: ps.length, failed: ps.filter(x => x.success === false).length, pending: ps.filter(x => !x.end).length,
      firstStartMs: round(Math.min(...ps.map(x => x.start)) - origin), lastEndMs: round(Math.max(...ps.map(x => x.end || x.callEnd)) - origin),
      requestLatencySumMs: round(sum(ps.map(x => (x.end || x.callEnd) - x.start))),
      synchronousCallSumMs: round(sum(ps.map(x => x.callEnd - x.start))),
      activeUnionMs: round(union(ps.filter(x => x.end).map(x => [x.start, x.end])))};
  });
  const psoAsync = run.owner.pipelines.filter(p => p.name.endsWith('Async'));
  const longestLag = [...run.owner.lags].sort((a, b) => b.delayMs - a.delayMs)[0];
  const analyzed = {index: run.index, io: run.state.io, milestones: milestone, phases, pipelines,
    asyncPipelineSpanMs: round(Math.max(...psoAsync.map(x => x.end || x.callEnd)) - Math.min(...psoAsync.map(x => x.start))),
    moduleCount: run.owner.modules.length, moduleChars: sum(run.owner.modules.map(x => x.chars)),
    moduleJSCallSumMs: round(sum(run.owner.modules.map(x => x.end - x.start))),
    longestOwnerLag: {...longestLag, startMs: round(longestLag.start - origin), endMs: round(longestLag.end - origin)},
    asyncPipelinesDuringOwnerLag: {
      requests: psoAsync.filter(p => p.start >= longestLag.start && p.start < longestLag.end).length,
      activeUnionMs: round(union(psoAsync.filter(p => p.end > longestLag.start && p.start < longestLag.end)
        .map(p => [Math.max(p.start, longestLag.start), Math.min(p.end, longestLag.end)])))},
    settings: run.state.settings, errors: [...run.errors, ...run.owner.errors], dropped: run.owner.dropped + run.page.dropped};
  if (run.cpuProfile && run.browserMetrics) {
    const navigation = run.browserMetrics.find(x => x.name === 'NavigationStart')?.value;
    assert(navigation > 0, 'CPU clock calibration requires CDP NavigationStart');
    const offsetMs = origin - navigation * 1000, profile = JSON.parse(fs.readFileSync(run.cpuProfile));
    const from = (longestLag.start - offsetMs) * 1000, to = (longestLag.end - offsetMs) * 1000;
    assert(from >= profile.startTime && to <= profile.endTime, 'Lag window must be inside CPU profile');
    analyzed.cpuClockOffsetMs = offsetMs;
    analyzed.ownerLagCPU = cpuWindow(profile, from, to);
    const ready = mark('log.P3_ENGINE_READY');
    analyzed.ownerStartupCPU = cpuWindow(profile, profile.startTime, (ready - offsetMs) * 1000);
  }
  result.runs.push(analyzed);
}
const output = input.replace(/\.json$/, '') + '-analysis.json';
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({output, runs: result.runs.map(r => ({index: r.index, phases: r.phases, lagMs: r.longestOwnerLag.delayMs,
  lagCPU: r.ownerLagCPU?.inclusive.filter(x => /Deserialize|LoadShader/.test(x.functionName)), pipelines: r.pipelines}))}, null, 2));
