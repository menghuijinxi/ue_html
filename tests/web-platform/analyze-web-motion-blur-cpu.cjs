'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const file = process.argv[2];
assert(file);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
assert(report.pass);
const stats = values => {
  values.sort((a, b) => a - b);
  return {count: values.length, min: values[0], median: values[Math.floor(values.length / 2)],
    p95: values[Math.floor(values.length * 0.95)], max: values.at(-1)};
};
const output = {pass: true, source: audit(__filename), input: audit(file), runs: [],
  boundary: 'Exact CPU/uniform frame matching and fixed-depth camera-motion proxy. Proxy is not a velocity texture readback or final-image blur measurement; visual acceptance remains separate.'};
for (const run of report.runs) {
  const byFrame = new Map(run.motionBlurCPU.map(c => [c.frame, c]));
  const matched = run.probe.samples.map(gpu => {
    const cpu = byFrame.get(gpu.frame);
    assert(cpu, 'Missing CPU frame');
    assert.deepEqual(cpu.scale, gpu.globals.VelocityScale);
    assert.deepEqual(cpu.clipToPrevClip, gpu.view.View_ClipToPrevClip);
    assert.equal(cpu.max, gpu.globals.VelocityMax[0]);
    assert.equal(cpu.pendingFrame, cpu.frame);
    assert.equal(cpu.previousFrame, cpu.frame - 1);
    const previous = byFrame.get(cpu.frame - 1);
    assert(previous);
    assert.equal(cpu.realTime - previous.realTime, cpu.deltaRealTime);
    assert.deepEqual(cpu.previousOrigin, previous.origin);
    assert.deepEqual(cpu.previousRotation, previous.rotation);
    assert.equal(cpu.targetFPS, 30);
    assert.equal(cpu.amount, 0.5);
    assert(Math.abs(cpu.timeScale - (1 / cpu.targetFPS) / cpu.deltaRealTime) < 0.00001);
    const m = cpu.clipToPrevClip, z = 0.5, w = m[11] * z + m[15];
    const radius = Math.min(cpu.max, Math.hypot((m[8] * z + m[12]) / w * cpu.scale[0],
      (m[9] * z + m[13]) / w * cpu.scale[1]));
    return {frame: cpu.frame, deltaMs: cpu.deltaRealTime * 1000, scaleX: cpu.scale[0], radius,
      moving: Math.abs(m[12]) + Math.abs(m[13]) > 0.00001,
      origin: cpu.origin, previousOrigin: cpu.previousOrigin,
      rotation: cpu.rotation, previousRotation: cpu.previousRotation};
  });
  const moving = matched.filter(v => v.moving);
  output.runs.push({folder: run.folder, settings: run.settings, uniformsMatched: matched.length,
    CPUFrames: run.motionBlurCPU.length, targetFPS: 30, amount: 0.5,
    frameTimeAndCameraHistory: 'All captured frames exactly match prior CPU frame',
    scales: run.summary, deltaMs: stats(matched.map(v => v.deltaMs)),
    intervalsUnder8ms: matched.filter(v => v.deltaMs < 8).length,
    movingSamples: moving.length, movingScaleOver500: moving.filter(v => v.scaleX > 500).length,
    centerCameraRadiusProxy: stats(moving.map(v => v.radius)),
    radiusProxyOver20px: moving.filter(v => v.radius > 20).length,
    shortMovingExamples: moving.filter(v => v.deltaMs < 8).slice(0, 6)});
}
const destination = file.replace('.json', '-cpu-analysis.json');
assert(destination !== file && !fs.existsSync(destination), 'Preserve previous analysis');
fs.writeFileSync(destination, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.runs));
