'use strict';
// Model check for the texture atomic mirror synchronization in
// WebGPUDynamicRHI.cpp (SyncTextureAtomicBuffer / RefreshTextureAtomicBuffer).
//
// This file re-states the old and the new copy rules in JavaScript and compares
// both against one logical image. It does not run the engine: keep the rules
// below in step with the C++ when either changes. It checks that the new rules
// are never wrong where the old ones were right, and counts the copies saved.
const assert = require('assert');

const SRV = 1, COPY_SRC = 2, UAV_COMPUTE = 4, UAV_GRAPHICS = 8, RTV = 16, COPY_DEST = 32;
const READ_ONLY = SRV | COPY_SRC, UNKNOWN = 0;
const STATES = [SRV, COPY_SRC, UAV_COMPUTE, UAV_GRAPHICS, UAV_COMPUTE | UAV_GRAPHICS, RTV, COPY_DEST, UNKNOWN];

let seed = 1;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

const create = lazy => ({lazy, texture: 'zero', mirror: 'zero', state: SRV, dirty: false, stale: false, copies: 0});

function transition(model, next) {
  const previous = model.state;
  if (model.lazy) {
    if (model.dirty) { model.texture = model.mirror; ++model.copies; model.dirty = false; model.stale = false; }
    else if (previous === UNKNOWN || (previous & ~READ_ONLY)) model.stale = true;
    if (model.stale && (next & UAV_GRAPHICS)) { model.mirror = model.texture; ++model.copies; model.stale = false; }
  } else {
    if (model.dirty) { model.texture = model.mirror; ++model.copies; model.dirty = false; }
    if (next & (UAV_COMPUTE | UAV_GRAPHICS)) { model.mirror = model.texture; ++model.copies; }
  }
  model.state = next;
}

function atomicWrite(model, value, compute) {
  if (model.lazy && compute && model.stale) { model.mirror = model.texture; ++model.copies; model.stale = false; }
  const seen = model.mirror;
  model.mirror = `atomic${value}(${seen})`;
  model.dirty = true;
  return seen;
}

function run(sequence) {
  let truth = 'zero';
  const before = create(false), after = create(true);
  let beforeCorrect = true, afterCorrect = true;
  for (const [kind, value, compute] of sequence) {
    if (kind === 'transition') { transition(before, value); transition(after, value); }
    else if (kind === 'write') { truth = `write${value}`; before.texture = truth; after.texture = truth; }
    else if (kind === 'atomic') {
      beforeCorrect = atomicWrite(before, value, compute) === truth && beforeCorrect;
      afterCorrect = atomicWrite(after, value, compute) === truth && afterCorrect;
      truth = `atomic${value}(${truth})`;
    } else {
      beforeCorrect = before.texture === truth && beforeCorrect;
      afterCorrect = after.texture === truth && afterCorrect;
    }
  }
  return {beforeCorrect, afterCorrect, beforeCopies: before.copies, afterCopies: after.copies};
}

function randomSequence(length) {
  const sequence = [];
  let state = SRV;
  for (let index = 0; index < length; ++index) {
    const choice = random();
    if (choice < 0.4) { state = STATES[Math.floor(random() * STATES.length)]; sequence.push(['transition', state]); }
    else if (choice < 0.6 && (state & (UAV_COMPUTE | UAV_GRAPHICS | RTV | COPY_DEST))) sequence.push(['write', index]);
    else if (choice < 0.8 && (state & (UAV_COMPUTE | UAV_GRAPHICS))) {
      const both = (state & UAV_COMPUTE) && (state & UAV_GRAPHICS);
      sequence.push(['atomic', index, both ? random() < 0.5 : Boolean(state & UAV_COMPUTE)]);
    } else if (state & READ_ONLY) sequence.push(['read']);
  }
  return sequence;
}

const report = {sequences: 0, bothCorrect: 0, regressions: 0, onlyNewCorrect: 0, copiesBefore: 0, copiesAfter: 0};
for (const start of [1, 99, 20261111]) {
  seed = start;
  for (let index = 0; index < 1000000; ++index) {
    const result = run(randomSequence(1 + Math.floor(random() * 24)));
    ++report.sequences;
    if (result.beforeCorrect && !result.afterCorrect) ++report.regressions;
    if (!result.beforeCorrect && result.afterCorrect) ++report.onlyNewCorrect;
    if (result.beforeCorrect && result.afterCorrect) {
      ++report.bothCorrect;
      report.copiesBefore += result.beforeCopies;
      report.copiesAfter += result.afterCopies;
    }
  }
}

// One virtual shadow frame for the physical page pool: page initialization
// writes the texture, raster uses atomics, merge writes the texture again.
const frame = [['transition', UAV_COMPUTE], ['write', 'init'], ['transition', UAV_GRAPHICS], ['atomic', 'raster', false],
  ['transition', SRV], ['read'], ['transition', UAV_COMPUTE], ['write', 'merge'], ['transition', SRV], ['read']];
report.shadowFrames = run([...frame, ...frame, ...frame]);

// The transition order of RunWebGPUTextureAtomicCases in WebGPUTextureAtomicProbe.h.
report.computeProbe = run([['transition', UAV_COMPUTE], ['write', 9], ['transition', UAV_COMPUTE],
  ['atomic', 'a', true], ['atomic', 'b', true], ['transition', COPY_SRC], ['read'],
  ['transition', UAV_COMPUTE], ['atomic', 'c', true], ['transition', COPY_SRC], ['read'],
  ['transition', UAV_COMPUTE], ['write', 2], ['transition', UAV_COMPUTE], ['atomic', 'd', true],
  ['transition', COPY_SRC], ['read']]);

console.log(JSON.stringify(report, null, 2));
assert.equal(report.regressions, 0, 'The new rules lost data in a sequence the old rules handled');
assert(report.copiesAfter < report.copiesBefore, 'The new rules did not save any copy');
assert(report.shadowFrames.beforeCorrect && report.shadowFrames.afterCorrect);
assert.equal(report.shadowFrames.beforeCopies, 12);
assert.equal(report.shadowFrames.afterCopies, 6);
assert(report.computeProbe.beforeCorrect && report.computeProbe.afterCorrect);
