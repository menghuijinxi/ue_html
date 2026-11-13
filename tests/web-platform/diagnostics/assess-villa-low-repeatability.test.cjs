'use strict';
const {initializeProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const test = require('node:test'), assert = require('node:assert/strict');
const {assess, low} = require('./assess-villa-low-repeatability.cjs');
const order = ['old', 'liveoff', 'liveoff', 'old', 'old', 'liveoff'];

function report(intervals) {
  return {pass: true, lean: true, foreground: true, runs: intervals.map((interval, index) => {
    const times = Array.from({length: Math.floor(60000 / interval) + 1}, (_, frame) => frame * interval);
    return {name: order[index], index: index + 1, phases: [{kind: 'input', yawTravel: 100,
      summary: {low1: low(times)}, before: {prewarm: {counts: {misses: 0}}},
      after: {player: {active: true}, prewarm: {counts: {misses: 0}}},
      capture: {times, creations: []}, samples: Array.from({length: 60}, () => ({
        page: {hidden: false, focused: true, live: {submitted: {seconds: 5, low: 1000 / interval}}}})),
      canvasBox: {width: 1280}}]};
  })};
}

test('repeatable degradation in both orders enables version bisection', () => {
  assert(assess(report([25, 40, 40, 25, 25, 40])).usableForBisection);
});
test('a large aggregate gap cannot hide a contradictory pair', () => {
  const result = assess(report([25, 40, 40, 25, 40, 25]));
  assert(result.medianWholeRunDrop > .1);
  assert(!result.usableForBisection);
});
test('run-order drift and equal releases do not enable bisection', () => {
  assert(!assess(report([25, 26, 40, 41, 55, 56])).usableForBisection);
  assert(!assess(report([25, 25, 25, 25, 25, 25])).usableForBisection);
});
test('hidden and incomplete runs are rejected; pipeline compilation is retained', () => {
  const hidden = report([25, 40, 40, 25, 25, 40]);
  hidden.runs[0].phases[0].samples[0].page.hidden = true;
  assert.throws(() => assess(hidden), /visible foreground/);
  const incomplete = report([25, 40, 40, 25, 25, 40]); incomplete.pass = false;
  assert.throws(() => assess(incomplete));
  const unsampled = report([25, 40, 40, 25, 25, 40]);
  unsampled.runs[0].phases[0].samples = [];
  assert.throws(() => assess(unsampled), /visible foreground/);
  assert.throws(() => low([0, 20, 20, 40]));
  const compiling = report([25, 40, 40, 25, 25, 40]);
  compiling.runs[0].phases[0].capture.creations.push('createComputePipeline');
  const result = assess(compiling);
  assert.equal(result.runs.length, 6);
  assert(!result.allWindowsPrewarmed);
  assert.deepEqual(result.runs[0].pipelineCreations, ['createComputePipeline']);
});
