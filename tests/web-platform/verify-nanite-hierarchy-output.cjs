'use strict';
const assert = require('node:assert/strict');

// Independent CPU oracle reads packed page fields directly. It does not reuse
// shader output, generated WGSL, or the GPU hierarchy traversal algorithm.
module.exports = function verifyHierarchy(result, pages, active) {
  assert.equal(result.cullInputRejections, active.length * 11);
  assert.equal(result.culling.length, active.length * 7 + (result.step === 1 && result.active instanceof Array ? 6 : 0));
  for (const c of result.culling) {
    const resource = active.find(r => r.page === c.page); assert(resource);
    const pageOffset = c.page * 32768, clusterCount = pages.readUInt32LE(pageOffset) & 65535;
    assert.equal(clusterCount, 15);
    const expected = [];
    let triangles = 0;
    for (let i = 0; i < clusterCount; ++i) {
      const field = (vector, component) => pageOffset + 16 + (vector * clusterCount + i) * 16 + component * 4;
      if (!(pages.readUInt32LE(field(4, 3)) & 4)) continue;
      let visible = true;
      for (let plane = 0; plane < 6; ++plane) {
        let distance = c.planes[plane * 4 + 3];
        for (let axis = 0; axis < 3; ++axis) {
          const normal = c.planes[plane * 4 + axis];
          distance += normal * pages.readFloatLE(field(3, axis)) + Math.abs(normal) * pages.readFloatLE(field(4, axis));
        }
        if (distance < 0) visible = false;
      }
      if (!visible) continue;
      expected.push((c.page << 8) | i);
      triangles += pages.readUInt32LE(field(0, 1)) & 255;
    }
    assert.equal(c.keys.length, c.capacity);
    if (c.name.startsWith('synthetic-') && c.name !== 'synthetic-two-levels') {
      const errors = {'synthetic-depth-limit':4, 'synthetic-invalid-node':2, 'synthetic-cycle':4,
        'synthetic-skinned':8, 'synthetic-queue-overflow':16};
      assert.equal(c.state[1], errors[c.name], c.name);
      if (c.name !== 'synthetic-queue-overflow') {
        assert.equal(c.state[0], 0); assert.equal(c.state[3], 0);
      } else {
        assert.equal(c.state[0], 16); assert.equal(c.state[3], 1920);
      }
    } else {
      assert.equal(c.state[0], expected.length, c.name);
      assert.equal(c.state[1], c.name === 'capacity' ? 1 : 0, c.name);
      assert.equal(c.state[3], triangles, c.name);
      const keys = c.keys.slice(0, Math.min(c.capacity, c.state[0])).sort((a,b) => a-b);
      assert.equal(new Set(keys).size, keys.length);
      if (c.name === 'capacity') assert(keys.every(k => expected.includes(k)));
      else assert.deepEqual(keys, expected, c.name);
      if (['all', 'synthetic-two-levels'].includes(c.name)) {
        assert.equal(expected.length, 8); assert.equal(triangles, 960);
      }
      if (['outside', 'sixth-plane'].includes(c.name)) assert.equal(expected.length, 0);
      if (['partial', 'rotated'].includes(c.name)) assert(expected.length > 0 && expected.length < 8);
    }
    for (const value of c.keys.slice(Math.min(c.capacity, c.state[0]))) assert.equal(value, 0xffffffff, c.name + ' unused output');
  }
};
