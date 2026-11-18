'use strict';
// Diagnostic analysis of a --trace run of probe-nanite-off-regression.cjs.
// Reports how busy the browser GPU process is decoding WebGPU commands during
// the traced window, and what overlaps the longest frame intervals inside it.
// Tracing itself slows the frame; use ratios and attribution, not frame rate.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const tag = process.argv[2]; assert(/^[a-z0-9-]+$/.test(tag || ''), 'usage: analyze-gpu-process-trace.cjs <result tag>');
const directory = path.join(__dirname, 'results', tag);
const reportFile = path.join(directory, 'report.json'), report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert(report.trace && report.runs.length === 1, 'Expected a single traced run');
const run = report.runs[0], phase = run.phases[0];
const traceFile = phase.trace.file;
let text = fs.readFileSync(traceFile, 'utf8'), trace;
try { trace = JSON.parse(text); } catch (e) { trace = JSON.parse(text.trim().replace(/,\s*$/, '') + ']}'); }
text = null;
const events = trace.traceEvents || trace;
const threads = {}, processes = {};
for (const e of events) {
  if (e.ph === 'M' && e.name === 'thread_name') threads[e.pid + ':' + e.tid] = e.args.name;
  if (e.ph === 'M' && e.name === 'process_name') processes[e.pid] = e.args.name;
}
const mark = events.find(e => e.name === 'UE motion trace window'); assert(mark, 'Trace window mark missing');
const windowMs = report.traceSeconds * 1000 - 500;
const begin = mark.ts, end = begin + windowMs * 1000;
// The worker clock and trace clock meet at the window mark.
const toTrace = t => mark.ts + (t - phase.traceWindowMark) * 1000;
const frames = phase.frames.filter(f => f[1] >= phase.traceWindowMark && f[1] <= phase.traceWindowMark + windowMs);
assert(frames.length > 50);
const complete = events.filter(e => e.ph === 'X' && e.ts >= begin && e.ts <= end);
const total = name => complete.filter(e => e.name === name).reduce((sum, e) => sum + e.dur, 0) / 1000;
const summary = {tag, nanite: run.nanite?.enabled, cvar: run.cvar, windowMs, frames: frames.length, tracedFps: frames.length * 1000 / windowMs, gpuProcess: {}};
for (const name of ['WebGPUDecoderImpl::HandleDawnCommands', 'GpuChannel::ExecuteDeferredRequest']) {
  const ms = total(name);
  summary.gpuProcess[name] = {totalMs: ms, perFrameMs: ms / frames.length, shareOfWall: ms / windowMs};
}
const commands = complete.filter(e => e.name === 'WebGPUDecoderImpl::HandleDawnCommands');
summary.gpuProcess.commandBlocks = commands.length;
summary.gpuProcess.blocksOver8Ms = commands.filter(e => e.dur > 8000).map(e => e.dur / 1000).sort((a, b) => b - a);
// Longest submitted-frame intervals inside the window and what ran during them.
const intervals = [];
for (let i = 1; i < frames.length; i++) intervals.push({from: frames[i - 1][1], to: frames[i][1], ms: frames[i][1] - frames[i - 1][1],
  rhiMs: frames[i][3] - frames[i - 1][3], renderMs: frames[i][5] === undefined ? undefined : frames[i][5] - frames[i - 1][5], gameMs: frames[i][4]});
const long = events.filter(e => e.ph === 'X' && e.dur > 3000);
summary.longFrames = intervals.filter(v => v.ms > 30).sort((a, b) => b.ms - a.ms).slice(0, 8).map(v => {
  const s = toTrace(v.from), e = toTrace(v.to);
  const overlap = x => (Math.min(e, x.ts + x.dur) - Math.max(s, x.ts)) / 1000;
  const gpu = long.filter(x => x.name === 'WebGPUDecoderImpl::HandleDawnCommands' && overlap(x) > 0).reduce((sum, x) => sum + overlap(x), 0);
  const gpuAll = commands.filter(x => overlap(x) > 0).reduce((sum, x) => sum + overlap(x), 0);
  const top = long.filter(x => overlap(x) > 3 && !/RunTask|Edge_RunTask|ThreadController/.test(x.name))
    .map(x => ({ms: overlap(x), name: x.name, thread: (processes[x.pid] || x.pid) + '/' + (threads[x.pid + ':' + x.tid] || x.tid)}))
    .sort((a, b) => b.ms - a.ms).slice(0, 5);
  return {tourSeconds: (v.from - phase.traceMark) / 1000, intervalMs: v.ms, renderMs: v.renderMs, rhiMs: v.rhiMs, gameMs: v.gameMs,
    gpuCommandMs: gpuAll, gpuCommandMsInLongBlocks: gpu, top};
});
summary.intervalsOver30Ms = intervals.filter(v => v.ms > 30).length;
summary.source = audit(__filename); summary.report = audit(reportFile); summary.trace = audit(traceFile);
summary.boundary = 'Diagnostic. The trace adds overhead and covers only the recorded window of the first interior tour. '
  + 'HandleDawnCommands is the GPU-process main thread decoding and executing WebGPU commands; it excludes driver and GPU execution.';
fs.writeFileSync(path.join(directory, 'gpu-process.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({tag, nanite: summary.nanite, frames: summary.frames, tracedFps: +summary.tracedFps.toFixed(1),
  handleDawnPerFrameMs: +summary.gpuProcess['WebGPUDecoderImpl::HandleDawnCommands'].perFrameMs.toFixed(2),
  handleDawnShare: +summary.gpuProcess['WebGPUDecoderImpl::HandleDawnCommands'].shareOfWall.toFixed(3),
  blocksOver8Ms: summary.gpuProcess.blocksOver8Ms.map(v => +v.toFixed(1)), intervalsOver30Ms: summary.intervalsOver30Ms}));
for (const f of summary.longFrames) console.log('  long', f.tourSeconds.toFixed(2) + 's', f.intervalMs.toFixed(1) + 'ms', 'render', f.renderMs?.toFixed(1), 'rhi', f.rhiMs.toFixed(1),
  'game', f.gameMs.toFixed(1), 'gpuCmd', f.gpuCommandMs.toFixed(1), '|', f.top.map(t => t.ms.toFixed(0) + 'ms ' + t.name.slice(0, 40) + '@' + t.thread.slice(0, 24)).join('; ').slice(0, 300));
