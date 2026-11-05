'use strict';
const fs = require('node:fs'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const file = process.argv[2]; assert(file);
const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
assert(capture.pass && capture.chromeTrace);
const runs = capture.runs.map(run => {
  assert.equal(audit(run.trace.file).sha256, run.trace.sha256);
  const events = JSON.parse(fs.readFileSync(run.trace.file, 'utf8')).traceEvents;
  const begin = events.find(event => event.name === 'UE motion trace start');
  const end = events.find(event => event.name === 'UE motion trace end');
  assert(begin && end && end.ts > begin.ts);
  const window = events.filter(event => event.ts >= begin.ts && event.ts <= end.ts);
  const displayed = window.filter(event => event.name === 'Display::FrameDisplayed');
  const times = displayed.map(event => event.ts).sort((a, b) => a - b);
  const intervals = times.slice(1).map((time, i) => (time - times[i]) / 1000).sort((a, b) => a - b);
  assert(intervals.length > 20);
  const reporters = {};
  for (const event of window) {
    if (event.name !== 'PipelineReporter' || event.ph !== 'b') continue;
    const data = event.args.frame_reporter;
    const key = `${event.pid}:${data.layer_tree_host_id}`;
    const states = reporters[key] ||= {};
    states[data.state] = (states[data.state] || 0) + 1;
  }
  const seconds = (end.ts - begin.ts) / 1e6;
  return {mode: run.mode, trace: run.trace, seconds,
    displayCallbacks: {count: displayed.length, perSecond: displayed.length / seconds,
      zeroIntervals: intervals.filter(value => value === 0).length,
      p50: intervals[Math.floor(intervals.length * .5)], p95: intervals[Math.floor(intervals.length * .95)],
      p99: intervals[Math.floor(intervals.length * .99)], max: intervals.at(-1)},
    reporters};
});
const output = file.replace(/\.json$/, '-compositor-analysis.json'); assert(!fs.existsSync(output));
const report = {capture: audit(file), runs,
  boundary: 'Display::FrameDisplayed trace callback timestamps, scoped to this browser trace and marked measurement window. Batched callbacks may share timestamps. They do not identify unique UE frames or physical scanout. Renderer PipelineReporter may describe page/HUD rather than the independent OffscreenCanvas surface; its dropped count is not the game dropped-frame count. Tracing adds overhead and is not normal FPS acceptance.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
