'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const observe = require('./web-game-clock-observer.cjs');
const runtime = process.argv[2];
assert(runtime, 'Pass the rebuilt runtime JS');
const text = fs.readFileSync(runtime, 'utf8');
const marker = text.indexOf('const v = (growMemViews(), HEAPF64).subarray');
assert(marker >= 0);
const begin = text.lastIndexOf('=> {', marker) - '($0, $1) '.length;
const end = text.indexOf('\n  },', marker) + 4;
const capture = vm.runInNewContext('(' + text.slice(begin, end) + ')', {
  growMemViews() {}, HEAPF64: new Float64Array(64), HEAPF32: new Float32Array(128),
});
assert.equal(typeof capture, 'function');
const heap = new ArrayBuffer(512), messages = [], handlers = [];
const game = vm.createContext({
  ENVIRONMENT_IS_PTHREAD: true, performance, MainLoop: {preMainLoop: [], postMainLoop: []},
  addEventListener: (_, handler) => handlers.push(handler), postMessage: value => messages.push(structuredClone(value)),
  HEAPF64: new Float64Array(heap), HEAPF32: new Float32Array(heap), growMemViews() {},
});
vm.runInContext('(' + observe.toString() + ')()', game);
for (let i = 0; i < 23; ++i) game.HEAPF64[8 + i] = i + 0.25;
for (let i = 0; i < 16; ++i) game.HEAPF32[80 + i] = i * 0.5;
vm.runInContext('(' + text.slice(begin, end) + ')(64n, 320n)', game);
assert.equal(messages.length, 1);
const sample = messages[0].sample;
assert.equal(sample.frame, 0.25);
assert.deepEqual(sample.previousRotation, [20.25, 21.25, 22.25]);
assert.deepEqual(sample.clipToPrevClip, Array.from({length: 16}, (_, i) => i * 0.5));
game.HEAPF64.fill(0); game.HEAPF32.fill(0);
assert.equal(sample.frame, 0.25, 'Capture must own its values after the source view expires');
let reply;
handlers[0]({data: {type: 'web-game-clock-read', port: {
  postMessage: value => {reply = structuredClone(value);}, close() {},
}}});
assert.equal(reply.motionBlurCPU.length, 1, 'Reply must be cloneable despite the diagnostic push hook');
const workerHandlers = [], worker = {addEventListener: (_, handler) => workerHandlers.push(handler)};
const owner = vm.createContext({ENVIRONMENT_IS_PTHREAD: false,
  PThread: {unusedWorkers: [worker], pthreads: {}, allocateUnusedWorker: () => worker}});
vm.runInContext('(' + observe.toString() + ')()', owner);
workerHandlers[0]({data: messages[0]});
assert.equal(owner.__webMotionBlurCPU[0].frame, sample.frame);
console.log('PASS: actual compiled CPU capture, wasm64 pointers, immediate copies and cloneable pthread transport');
