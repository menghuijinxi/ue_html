'use strict';
const assert = require('node:assert/strict');
const {createWebPipelineCache} = require('./web-pipeline-prewarm.js');
function fakeDevice() {
  const calls = [], device = {calls};
  for (const name of ['createShaderModule', 'createBindGroupLayout', 'createPipelineLayout',
    'createRenderPipeline', 'createComputePipeline']) {
    device[name] = descriptor => {
      const value = {name, descriptor, unique: calls.length}; calls.push(value); return value;
    };
    if (name.endsWith('Pipeline') && name !== 'createPipelineLayout')
      device[name + 'Async'] = async descriptor => device[name](descriptor);
  }
  // Native asynchronous calls must not reenter the wrapper under test.
  for (const kind of ['Render', 'Compute']) {
    const sync = device['create' + kind + 'Pipeline'];
    device['create' + kind + 'PipelineAsync'] = async descriptor => sync(descriptor);
  }
  return device;
}
const pack = {
  modules: [{id: 1, descriptor: {code: 'shader-a'}}],
  layouts: [
    {id: 2, $gpu: 'bindGroupLayout', descriptor: {entries: [{binding: 0, visibility: 4, buffer: {type: 'uniform'}}]}},
    {id: 3, $gpu: 'pipelineLayout', descriptor: {bindGroupLayouts: [{$gpu: 'bindGroupLayout', id: 2}]}}
  ],
  descriptors: [{kind: 'compute', descriptor: {layout: {$gpu: 'pipelineLayout', id: 3},
    compute: {module: {$gpu: 'module', id: 1}, entryPoint: 'main', constants: {size: 1}}}}]
};
(async () => {
  const device = fakeDevice(), cache = createWebPipelineCache(device);
  await cache.replay(pack, 2);
  const module = device.createShaderModule({label: 'engine-name', code: 'shader-a'});
  const bgl = device.createBindGroupLayout({entries: [{visibility: 4, buffer: {type: 'uniform'}, binding: 0}]});
  const layout = device.createPipelineLayout({bindGroupLayouts: [bgl]});
  const descriptor = {compute: {constants: {size: 1}, entryPoint: 'main', module}, layout};
  const warm = device.createComputePipeline(descriptor);
  assert.equal(await device.createComputePipelineAsync({...descriptor, label: 'new-label'}), warm);
  assert.equal(cache.counts.hits, 2);
  assert.equal(cache.counts.misses, 0);
  assert.equal(cache.counts.modules, 1);
  for (const changed of [
    {...descriptor, compute: {...descriptor.compute, constants: {size: 1, label: 2}}},
    {...descriptor, compute: {...descriptor.compute, constants: {size: 2}}},
    {...descriptor, compute: {...descriptor.compute, entryPoint: 'different'}},
    {...descriptor, compute: {...descriptor.compute, module: device.createShaderModule({code: 'shader-b'})}},
    {...descriptor, layout: device.createPipelineLayout({bindGroupLayouts: []})}
  ]) assert.notEqual(device.createComputePipeline(changed), warm);
  assert.equal(cache.counts.misses, 5);
  const second = fakeDevice(), secondCache = createWebPipelineCache(second);
  await secondCache.replay(pack, 1);
  assert.equal(secondCache.counts.hits, 0);
  assert.notEqual(second.calls.at(-1), warm, 'Never reuse pipelines across devices');
  const rejected = fakeDevice();
  rejected.createComputePipelineAsync = async () => {throw new Error('compiler rejected');};
  const rejectedCache = createWebPipelineCache(rejected);
  await assert.rejects(rejectedCache.replay(pack, 2), /compiler rejected/);
  assert.equal(rejectedCache.counts.ready, 0);
  assert.throws(() => device.createPipelineLayout({bindGroupLayouts: [new Date()]}), /Unknown/);
  console.log('PASS: exact descriptors, shader/layout identity, constants, device isolation, rejected compilation');
})().catch(error => {console.error(error); process.exitCode = 1;});
