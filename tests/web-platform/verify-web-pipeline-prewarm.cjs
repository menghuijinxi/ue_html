'use strict';
require('./project-output.cjs').initializeProjectOutput();
const assert = require('node:assert/strict');
const {createWebPipelineCache, prepareWebPipelinePrewarm} = require('./web-pipeline-prewarm.js');
const {isWebPipelinePrecacheReady} = require('./web-engine-host.js');
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
  const readyState = {__webEngineFrames: 30, __webPipelinePrewarm: {adopted: true, ready: true},
    __webPSOPrecache: {enabled: true, active: 0},
    __webOptimizationRHI: {asyncPrecacheRequested: 2, asyncPrecacheCompleted: 2}};
  assert(isWebPipelinePrecacheReady({pipelinePrewarm: {}}, [], readyState));
  assert(isWebPipelinePrecacheReady({}, ['-WebPSOPrecacheTest'], readyState));
  assert(isWebPipelinePrecacheReady({pipelinePrewarm: {}}, ['-WebPSOPrecacheTest'], readyState));
  for (const changed of [
    {__webEngineFrames: 29}, {__webPipelinePrewarm: {adopted: true, ready: false}},
    {__webPipelinePrewarm: {adopted: false, ready: true}},
    {__webPipelinePrewarm: {adopted: true, ready: true, error: 'compilation failed'}},
    {__webPSOPrecache: {enabled: true, active: 1}},
    {__webPSOPrecache: {enabled: false, active: 0}},
    {__webOptimizationRHI: {asyncPrecacheRequested: 2, asyncPrecacheCompleted: 1}}
  ]) assert(!isWebPipelinePrecacheReady({pipelinePrewarm: {}}, ['-WebPSOPrecacheTest'],
    {...readyState, ...changed}), 'Hybrid startup must wait for both sources');
  assert(!isWebPipelinePrecacheReady({}, [], {__webEngineFrames: 60}),
    'A package without either prewarm source must not claim precache readiness');
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
  const early = fakeDevice();
  const nativeCreate = early.createComputePipelineAsync;
  let finish;
  early.createComputePipelineAsync = descriptor => new Promise(resolve => {
    finish = async () => resolve(await nativeCreate(descriptor));
  });
  const earlyCache = createWebPipelineCache(early), replaying = earlyCache.replay(pack, 2);
  const earlyModule = early.createShaderModule({code: 'shader-a'});
  const earlyGroup = early.createBindGroupLayout(pack.layouts[0].descriptor);
  const earlyLayout = early.createPipelineLayout({bindGroupLayouts: [earlyGroup]});
  const earlyDescriptor = {compute: {...descriptor.compute, module: earlyModule}, layout: earlyLayout};
  const waiting = early.createComputePipelineAsync(earlyDescriptor);
  assert.equal(earlyCache.counts.pendingHits, 1);
  assert.equal(earlyCache.counts.misses, 0);
  const synchronous = early.createComputePipeline(earlyDescriptor);
  assert.equal(earlyCache.counts.syncWhilePending, 1);
  assert(synchronous, 'A synchronous miss must still create a real pipeline');
  await finish(); await replaying;
  assert.equal(await waiting, early.createComputePipeline(earlyDescriptor));
  assert.notEqual(await waiting, synchronous);
  assert.equal(early.calls.filter(call => call.name === 'createComputePipeline').length, 2);
  const savedGlobals = Object.fromEntries(['GPUAdapter', 'navigator', 'fetch'].map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let resolveCompile, rejectCompile, createdDevice;
  class Adapter {
    async requestDevice() {
      createdDevice = Object.assign(fakeDevice(), {features: new Set(), limits: {},
        lost: new Promise(() => {}), addEventListener() {}, destroy() {this.destroyed = true;}});
      const native = createdDevice.createComputePipelineAsync;
      createdDevice.createComputePipelineAsync = d => new Promise((resolve, reject) => {
        resolveCompile = async () => resolve(await native(d)); rejectCompile = reject;
      });
      return createdDevice;
    }
  }
  const lifecyclePack = {...pack, version: 1, wasm: 'wasm', content: 'content', config: 'config',
    devices: [{descriptor: {requiredFeatures: [], requiredLimits: {}}}]};
  const bytes = Buffer.from(JSON.stringify(lifecyclePack));
  const assets = {wasm: {sha256: 'wasm'}, pipelinePrewarm: {url: 'fixture',
    sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
    content: 'content', config: 'config', handoff: 'overlap'}};
  try {
    for (const [name, value] of Object.entries({GPUAdapter: Adapter,
      navigator: {gpu: {requestAdapter: async () => new Adapter()}},
      fetch: async () => ({ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer})}))
      Object.defineProperty(globalThis, name, {configurable: true, value});
    const prepared = await prepareWebPipelinePrewarm(assets);
    assert(!prepared.state.ready, 'Device must be available before compilation finishes in overlap mode');
    assert.equal(prepared.take({}), createdDevice);
    assert.equal(prepared.take({}), null, 'Device can only be adopted once');
    assert.equal(prepared.state.mode, 'overlapping');
    await resolveCompile(); await prepared.completed;
    assert(prepared.state.ready && prepared.state.adopted);
    assert.equal(prepared.state.mode, 'active');
    const failed = await prepareWebPipelinePrewarm(assets);
    rejectCompile(new Error('late compile failure'));
    await assert.rejects(failed.completed, /late compile failure/);
    assert.equal(failed.state.mode, 'failed'); assert(createdDevice.destroyed);
    assert.equal(failed.take({}), null);
    let resolved = false;
    const blocking = prepareWebPipelinePrewarm({...assets,
      pipelinePrewarm: {...assets.pipelinePrewarm, handoff: 'complete'}}).then(value => {resolved = true; return value;});
    const prior = resolveCompile;
    while (resolveCompile === prior) await new Promise(resolve => setImmediate(resolve));
    assert(!resolved, 'Default mode must keep waiting for complete replay');
    await resolveCompile();
    assert((await blocking).state.ready);
  } finally {
    for (const [name, descriptor] of Object.entries(savedGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  console.log('PASS: exact descriptors, device isolation, in-flight reuse, sync fallback, early adoption, completion/failure gates');
})().catch(error => {console.error(error); process.exitCode = 1;});
