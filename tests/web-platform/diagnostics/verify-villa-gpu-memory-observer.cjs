'use strict';
require('../project-output.cjs').initializeProjectOutput();
const assert = require('node:assert/strict'), vm = require('node:vm');
const observe = require('./villa-gpu-memory-observer.cjs');
const context = vm.createContext({FinalizationRegistry});
vm.runInContext(`
  class GPUBuffer {destroy() {}}
  class GPUTexture {destroy() {}}
  class GPUDevice {
    createBuffer(descriptor) {if (descriptor.fail) throw Error('Native allocation failed'); return new GPUBuffer();}
    createTexture(descriptor) {if (descriptor.fail) throw Error('Native allocation failed'); return new GPUTexture();}
  }
  globalThis.GPUBuffer = GPUBuffer; globalThis.GPUTexture = GPUTexture; globalThis.GPUDevice = GPUDevice;
  (${observe.toString()})();
  globalThis.device = new GPUDevice();
`, context);
const evaluate = source => vm.runInContext(source, context);
evaluate(`globalThis.pool = device.createTexture({label: 'Shadow.Virtual.PhysicalPagePool', format: 'r32uint',
  size: {width: 16384, height: 4096, depthOrArrayLayers: 2}})`);
assert.equal(evaluate('__villaGPUResources.textureBytes'), 512 * 1024 ** 2);
evaluate(`globalThis.hdr = device.createTexture({format: 'rgba16float', size: [2048, 2048, 6]})`);
assert.equal(evaluate('__villaGPUResources.textureBytes'), 704 * 1024 ** 2);
evaluate(`globalThis.bc = device.createTexture({format: 'bc1-rgba-unorm', size: [5, 7], mipLevelCount: 3});
  globalThis.volume = device.createTexture({format: 'r8unorm', size: [4, 4, 4], mipLevelCount: 3, dimension: '3d'});
  globalThis.msaa = device.createTexture({format: 'rgba8unorm', size: [2, 3], sampleCount: 4});
  globalThis.buffer = device.createBuffer({size: 536871168, usage: 140});`);
assert.equal(evaluate('__villaGPUResources.textureBytes'), 704 * 1024 ** 2 + 48 + 73 + 96);
assert.equal(evaluate('__villaGPUResources.bufferBytes'), 536871168);
assert.equal(evaluate('__villaGPUResources.textureCount'), 5);
assert.equal(evaluate('__villaGPUResources.largest[0].kind'), 'buffer');
assert.throws(() => evaluate("device.createBuffer({size: 99, fail: true})"), /Native allocation failed/);
assert.throws(() => evaluate("device.createTexture({fail: true})"), /Native allocation failed/);
assert.equal(evaluate('__villaGPUResources.bufferCount'), 1);
evaluate('for (const resource of [pool, hdr, bc, volume, msaa, buffer]) {resource.destroy(); resource.destroy();}');
for (const name of ['textureBytes', 'bufferBytes', 'textureCount', 'bufferCount'])
  assert.equal(evaluate('__villaGPUResources.' + name), 0);
assert.equal(evaluate('__villaGPUResources.largest.length'), 0);
assert.equal(evaluate('Object.keys(__villaGPUResources.unknownFormats).length'), 0);
console.log(JSON.stringify({pass: true, coverage: ['array layers', 'HDR', 'compressed mip blocks',
  '3D mip depth', 'MSAA', 'failed allocation', 'idempotent destruction', 'largest resources']}));
