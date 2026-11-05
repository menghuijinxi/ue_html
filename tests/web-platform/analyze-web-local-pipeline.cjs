'use strict';
const fs = require('node:fs'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const file = process.argv[2]; assert(file);
const capture = JSON.parse(fs.readFileSync(file, 'utf8')); assert(capture.pass);
function stats(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  return {count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
    p99: sorted[Math.floor(sorted.length * .99)], max: sorted.at(-1)};
}
const report = {pass: true, capture: audit(file), runs: capture.runs.map(run => {
  const p = run.pipeline; assert(p);
  const g = p.game.frames, measured = g.filter(frame => frame.inputs.length);
  const intervals = g.slice(1).map((frame, index) => frame.begin - g[index].begin);
  const inputWait = measured.flatMap(frame => frame.inputs.map(input => frame.begin - input.first));
  const inputs = measured.flatMap(frame => frame.inputs);
  return {mode: run.mode, inputMode: capture.inputMode, submission: run.result, page: run.display,
    gameIntervals: stats(intervals), gameWork: stats(g.map(frame => frame.end - frame.begin)),
    rhiTaskWork: stats(p.tasks.map(task => task.end - task.begin)),
    rhiTaskWait: stats(p.tasks.map(task => task.begin - task.queued)),
    framesPerTask: stats(p.tasks.map(task => task.after - task.before)),
    gpuFeedback: stats(p.gpu.map(frame => frame.done - frame.submitted)),
    inputToTick: stats(inputWait), inputToArrival: stats(inputs.map(input => input.arrived - input.first)),
    arrivalToTick: stats(measured.flatMap(frame => frame.inputs.map(input => frame.begin - input.arrived))),
    mailboxInputAgeAtTick: stats(g.filter(frame => frame.mailbox?.lastSampledAt).map(frame => frame.begin - frame.mailbox.lastSampledAt)),
    gameFramesWithoutInput: g.filter(frame => frame.inputs.length === 0).length,
    intervalsUnder4ms: intervals.filter(ms => ms < 4).length, intervalsOver25ms: intervals.filter(ms => ms > 25).length,
    budget: run.after.budget};
}), boundary: 'Diagnostic wrappers add overhead. Input timestamps end at Game tick entry, not native input consumption or physical display. GPU feedback includes browser callback delivery. Page FPS only samples submission progress at rAF. Normal performance acceptance requires an uninstrumented run.'};
const output = file.replace(/\.json$/, '-pipeline-analysis.json'); assert(!fs.existsSync(output));
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
for (const run of report.runs) console.log(JSON.stringify(run));
