'use strict';
const assert = require('node:assert/strict');
const transform = (p, m) => [0,1,2,3].map(col => p.reduce((s, v, row) => s + v * m[row * 4 + col], 0));

// Use all eight corners transformed to homogeneous clip space, independently
// of the engine's plane extraction/pullback and shader center/extent test.
module.exports = function verifySceneCull(result, page, previous) {
  const {step, entries} = result;
  assert.equal(result.rejected, 0);
  assert.equal(entries.length, [2,2,2,2,2,1,0,2,0,2][step-1]);
  // Hidden-in-game components in this runtime drop their scene proxy entirely;
  // registration must disappear and return when the proxy is recreated.
  assert.equal(result.registered, [2,2,2,2,2,1,0,2,0,2][step-1]);
  assert.equal(result.skipped, 0);
  assert.equal(result.perspective, ![5,6,7].includes(step));
  assert(result.worldToClip.length === 16 && result.worldToClip.every(Number.isFinite));
  for (const entry of entries) {
    assert.equal(entry.state[1], 0);
    assert(entry.localToWorld.length === 16 && entry.localToWorld.every(Number.isFinite));
    const count = page.readUInt32LE(0) & 65535, expected = [];
    let triangles = 0;
    for (let cluster = 0; cluster < count; ++cluster) {
      const offset = (v, c) => 16 + (v * count + cluster) * 16 + c * 4;
      if (!(page.readUInt32LE(offset(4,3)) & 4)) continue;
      const corners = [];
      for (let corner = 0; corner < 8; ++corner) {
        const p = [0,1,2].map(axis => page.readFloatLE(offset(3,axis)) +
          ((corner >> axis) & 1 ? 1 : -1) * page.readFloatLE(offset(4,axis)));
        corners.push(transform(transform([...p,1], entry.localToWorld), result.worldToClip));
      }
      const distances = p => [p[3]+p[0],p[3]-p[0],p[3]+p[1],p[3]-p[1],p[2],p[3]-p[2]];
      if ([0,1,2,3,4,5].some(plane => corners.every(p => distances(p)[plane] < -1e-5))) continue;
      expected.push((entry.page << 8) | cluster); triangles += page.readUInt32LE(offset(0,1)) & 255;
    }
    assert.equal(entry.state[0], expected.length, `step ${step} component ${entry.component}`);
    assert.equal(entry.state[3], triangles);
    assert.deepEqual(entry.keys.slice(0, expected.length).sort((a,b) => a-b), expected);
    assert(entry.keys.slice(expected.length).every(k => k === 0xffffffff));
    if ([1,8,10].includes(step)) assert.equal(expected.length, 8);
    if (step === 2) assert.equal(expected.length, entry.component ? 0 : 8);
    if (step === 3 && entry.component === 1) assert(expected.length > 0 && expected.length < 8);
    if (step === 4) assert.equal(expected.length, 0);
    if (step === 10) assert.notEqual(entry.id, previous[0].entries[0].id);
    else if (step > 1) assert.equal(entry.id, previous[0].entries[0].id);
  }
};
