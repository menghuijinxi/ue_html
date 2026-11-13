'use strict';
// Diagnostic: per-frame self and total time of every event name on the browser
// GPU process main thread inside the traced window of a --trace run of
// probe-nanite-off-regression.cjs. With the gpu.dawn category this separates
// command decoding, validation, encoder finish and backend submission.
// Tracing slows the frame; compare event shares between runs, not frame rate.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const tag = process.argv[2], top = Number(process.argv[3] || 40);
assert(/^[a-z0-9-]+$/.test(tag || ''), 'usage: analyze-gpu-process-events.cjs <result tag> [rows]');
const directory = path.join(__dirname, 'results', tag), report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
const phase = report.runs[0].phases[0];
let text = fs.readFileSync(phase.trace.file, 'utf8'), trace;
try { trace = JSON.parse(text); } catch (e) { trace = JSON.parse(text.trim().replace(/,\s*$/, '') + ']}'); }
text = null;
const events = trace.traceEvents || trace;
const mark = events.find(e => e.name === 'UE motion trace window'); assert(mark, 'Trace window mark missing');
const windowMs = report.traceSeconds * 1000 - 500, begin = mark.ts, end = begin + windowMs * 1000;
const frames = phase.frames.filter(f => f[1] >= phase.traceWindowMark && f[1] <= phase.traceWindowMark + windowMs).length;
// The thread that decodes WebGPU commands.
const decode = events.find(e => e.ph === 'X' && e.name === 'WebGPUDecoderImpl::HandleDawnCommands'); assert(decode);
const list = events.filter(e => e.ph === 'X' && e.pid === decode.pid && e.tid === decode.tid && e.ts >= begin && e.ts + e.dur <= end)
  .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
const self = new Map(), total = new Map(), count = new Map(), stack = [];
const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
for (const e of list) {
  while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
  // Self time: remove this event's time from its parent.
  if (stack.length) add(self, stack.at(-1).name, -e.dur);
  add(self, e.name, e.dur); add(count, e.name, 1);
  if (!stack.some(s => s.name === e.name)) add(total, e.name, e.dur);
  stack.push(e);
}
const rows = [...total].map(([name, us]) => ({name, totalMs: us / 1000 / frames, selfMs: (self.get(name) || 0) / 1000 / frames, perFrame: count.get(name) / frames}))
  .sort((a, b) => b.selfMs - a.selfMs);
const summary = {tag, nanite: report.runs[0].nanite?.enabled, cvar: report.runs[0].cvar, frames, windowMs, rows,
  boundary: 'Browser GPU process main thread only, events fully inside the traced window. Self time excludes nested traced events; untraced work stays in its parent.'};
fs.writeFileSync(path.join(directory, 'gpu-process-events.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(tag, 'frames', frames);
for (const r of rows.slice(0, top)) console.log(r.selfMs.toFixed(3).padStart(8), r.totalMs.toFixed(3).padStart(8), r.perFrame.toFixed(1).padStart(8), ' ', r.name.slice(0, 80));
