'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const file = process.argv[2];
assert(file);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
assert(report.pass);
const quantiles = values => {
  values.sort((a, b) => a - b);
  return {count: values.length, min: values[0], median: values[Math.floor(values.length / 2)],
    p95: values[Math.floor(values.length * 0.95)], max: values.at(-1)};
};
const output = {pass: true, source: audit(__filename), input: audit(file), runs: [],
  boundary: 'GT loop entry intervals and real uploaded velocity constants. Empirical counter alignment is reported explicitly; it is not a direct read of CPU DeltaRealTime, motion blur Amount or TargetFPS.'};
for (const run of report.runs) {
  const frames = new Map(run.gameClock.frames.map(frame => [frame.sequence, frame]));
  const afterWarmup = run.gameClock.frames.filter(frame => frame.sequence > 90 && frame.interval !== null);
  const samples = run.probe.samples;
  const moving = samples.filter(sample => {
    const matrix = sample.view.View_ClipToPrevClip;
    return Math.abs(matrix[12]) + Math.abs(matrix[13]) > 0.00001;
  });
  const alignments = [-1, 0, 1].map(shift => ({GTSequenceMinusCapturedRHIFrame: shift,
    scaleTimesInterval: quantiles(samples.map(sample => {
      const frame = frames.get(sample.frame + shift);
      return frame && sample.globals.VelocityScale[0] * frame.interval;
    }).filter(Number.isFinite))}));
  output.runs.push({folder: run.folder, settings: run.settings, frameBridge: run.frameBridge,
    scale: run.summary, intervalsAfter90FramesMs: quantiles(afterWarmup.map(v => v.interval)),
    GTIntervalsUnder8ms: afterWarmup.filter(v => v.interval < 8).length,
    movingSamples: moving.length, movingScaleOver500: moving.filter(v => v.globals.VelocityScale[0] > 500).length,
    alignments, examples: samples.filter(v => v.globals.VelocityScale[0] > 1000).slice(0, 8).map(sample => ({
      capturedRHIFrame: sample.frame, scaleX: sample.globals.VelocityScale[0],
      empiricallyAlignedGTFrame: frames.get(sample.frame - 1)}))});
}
const destination = file.replace(/\.json$/, '-analysis.json');
assert(destination !== file && !fs.existsSync(destination), 'Preserve earlier analysis');
fs.writeFileSync(destination, JSON.stringify(output, null, 2));
console.log(JSON.stringify({destination, runs: output.runs.map(({folder, scale, intervalsAfter90FramesMs,
  GTIntervalsUnder8ms, movingSamples, movingScaleOver500, frameBridge}) =>
  ({folder, scale, intervalsAfter90FramesMs, GTIntervalsUnder8ms, movingSamples, movingScaleOver500, frameBridge}))}));
