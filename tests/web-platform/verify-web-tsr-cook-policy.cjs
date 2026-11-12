'use strict';
const assert = require('node:assert/strict');
const {validateTSRTileInventory} = require('./cached-cook-validation.cjs');
const entries = {FTSRRejectShadingCS: 48, FTSRDetectThinGeometryCS: 24, FTSRWeightRelaxationCS: 8};
const cook = values => ({mode: 'WebGPU-SM5',
  shaderInventory: {detail: {types: Object.entries(values).map(([name, permutations]) => ({name, permutations}))}}});
validateTSRTileInventory(cook(entries));
for (const [name, count] of Object.entries(entries)) {
  assert.throws(() => validateTSRTileInventory(cook({...entries, [name]: count / 2})),
    /rerun the native Renderer build and Cook/);
  const missing = {...entries}; delete missing[name];
  assert.throws(() => validateTSRTileInventory(cook(missing)), /Cook lacks/);
}
assert.throws(() => validateTSRTileInventory({mode: 'WebGPU-SM5'}), /Cook lacks/);
validateTSRTileInventory({mode: 'WebGPU-ES31'});
console.log(JSON.stringify({pass: true, smallTileOnlyCookRejected: true, missingInventoryRejected: true,
  allThreeConvolutionPassesRequired: true, es31Unchanged: true}));
