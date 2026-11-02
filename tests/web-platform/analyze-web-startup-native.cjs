'use strict';
const fs = require('node:fs'), readline = require('node:readline'), assert = require('node:assert/strict');
const captureFile = process.argv[2], csv = process.argv[3];
assert(captureFile && csv, 'Usage: node analyze-web-startup-native.cjs capture.json events.csv [run-index]');
const capture = JSON.parse(fs.readFileSync(captureFile)), runIndex = Number(process.argv[4] ?? 0);
assert(Number.isInteger(runIndex) && runIndex >= 0 && runIndex < capture.runs.length, 'Invalid capture run index');
const run = capture.runs[runIndex];
const marks = run.owner.marks, initMark = marks.find(m => m.name === 'native.Init.begin'); assert(initMark);
const stack = new Map(), scopes = [], aggregate = new Map();
let gameThread, rhiThread;
(async () => {
  for await (const line of readline.createInterface({input: fs.createReadStream(csv)})) {
    if (!/^\d+,/.test(line)) continue;
    const parts = line.split(','), thread = parts[0], name = parts.slice(3, -4).join(',').replace(/^"|"$/g, '').replaceAll('""', '"');
    const [start, end, duration, depth] = parts.slice(-4).map(Number);
    if (parts[1] === 'GameThread') gameThread = thread;
    else if (parts[1] === 'RHIThread') rhiThread = thread;
    else continue;
    const ancestors = stack.get(thread) || []; stack.set(thread, ancestors);
    while (ancestors.length && ancestors.at(-1).depth >= depth) ancestors.pop();
    const scope = {thread, name, start, end, duration, exclusive: duration, depth};
    if (ancestors.length) ancestors.at(-1).exclusive -= duration;
    ancestors.push(scope); scopes.push(scope);
  }
  const init = scopes.find(s => s.thread === gameThread && s.name === 'WebStartup_Init'); assert(init && gameThread && rhiThread);
  const offset = initMark.at - init.start * 1000;
  const nativePhases = ['WebStartup_PreInit', 'WebStartup_Init'].map(name => scopes.find(s => s.name === name));
  for (const scope of scopes) {
    const key = scope.thread + ':' + scope.name;
    const row = aggregate.get(key) || {thread: scope.thread, name: scope.name, count: 0, inclusiveMs: 0, exclusiveMs: 0, maxMs: 0};
    aggregate.set(key, row); row.count++; row.inclusiveMs += scope.duration * 1000;
    row.exclusiveMs += Math.max(0, scope.exclusive) * 1000; row.maxMs = Math.max(row.maxMs, scope.duration * 1000);
  }
  const origin = run.page.timeOrigin, lag = [...run.owner.lags].sort((a, b) => b.delayMs - a.delayMs)[0];
  const lagStart = (lag.start - offset) / 1000, lagEnd = (lag.end - offset) / 1000;
  const shaderNames = ['WebShader_Load', 'WebShader_MetadataJSON', 'WebShader_MetadataBinary', 'WebShader_CreateModule'];
  const shaderLag = shaderNames.map(name => ({name, count: scopes.filter(s => s.thread === rhiThread && s.name === name && s.end > lagStart && s.start < lagEnd).length,
    milliseconds: scopes.filter(s => s.thread === rhiThread && s.name === name).reduce((total, s) => total + Math.max(0, Math.min(s.end, lagEnd) - Math.max(s.start, lagStart)) * 1000, 0)}));
  const output = csv.replace(/\.events\.csv$/, '-native-analysis.json');
  const result = {captureFile, runIndex, csv, offset, phases: nativePhases.map(s => ({name: s.name,
    startMs: s.start * 1000 + offset - origin, endMs: s.end * 1000 + offset - origin, durationMs: s.duration * 1000})),
    shaderLag, totals: [...aggregate.values()].sort((a, b) => b.exclusiveMs - a.exclusiveMs),
    longGameScopes: scopes.filter(s => s.thread === gameThread && s.duration > .1).map(s => ({name: s.name, startMs: s.start * 1000 + offset - origin,
      endMs: s.end * 1000 + offset - origin, durationMs: s.duration * 1000, exclusiveMs: Math.max(0, s.exclusive) * 1000})),
    boundaries: ['Per-thread wall durations include waits; cross-thread totals cannot be added as startup time.',
      'Largest lag window aligned by native.Init.begin and WebStartup_Init. Native marks capture the caller timestamp before proxy delivery.']};
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({output, phases: result.phases, shaderLag, top: result.totals.slice(0, 14)}, null, 2));
})().catch(e => {console.error(e); process.exitCode = 1;});
