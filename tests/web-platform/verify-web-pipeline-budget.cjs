'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
(async () => {
  const tasks = [], listeners = [], completed = [], errors = [];
  const owner = vm.createContext({SharedArrayBuffer, Int32Array, Atomics, performance,
    setImmediate() {}, addEventListener() {}, postMessage: value => errors.push(value)});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'web-engine-worker.js'), 'utf8'), owner);
  const budget = vm.runInContext('createWebLocalFrameBudget(3, "pipeline")', owner);
  const queue = {onSubmittedWorkDone: () => new Promise(resolve => completed.push(resolve))};
  let library;
  const game = vm.createContext({ENVIRONMENT_IS_PTHREAD: true, Map, Set, Int32Array, SharedArrayBuffer, Atomics,
    performance, MainLoop: {preMainLoop: []}, Module: {}, postMessage() {},
    addToLibrary: value => {library = value;},
    addEventListener: (name, listener) => listeners.push(listener),
    MessageChannel: class {
      constructor() {this.port1 = {}; this.port2 = {postMessage: data =>
        tasks.push(() => this.port1.onmessage({data}))};}
    }});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js'), 'utf8'), game);
  library.$WebThreadBridge();
  const send = data => listeners.forEach(listener => listener({data}));
  const flush = () => {let n = 0; while (tasks.length) {assert(++n < 50); tasks.shift()();}};
  let frames = 0;
  const tick = () => {for (const pre of game.MainLoop.preMainLoop) pre(); frames++;};
  // A startup tick can precede attachment. It must consume a slot too.
  tick();
  budget.attach({postMessage: data => tasks.push(() => send(data))}); flush();
  send({type: 'web-game-local-clock', paused: false});
  for (let n = 0; n < 4; n++) {game.requestAnimationFrame(tick); flush();}
  assert.equal(frames, 3, 'Unsubmitted Game/Render work must consume the frame budget');
  // Submitting existing work must not free any slot.
  budget.submit(queue); budget.submit(queue); budget.submit(queue); flush();
  assert.equal(frames, 3);
  completed[0](); await Promise.resolve(); flush();
  assert.equal(frames, 4, 'One completion must permit only one new Game frame');
  completed[1](); await Promise.resolve(); flush();
  assert.equal(frames, 5);
  const id = game.requestAnimationFrame(() => assert.fail('Cancelled frame ran'));
  game.cancelAnimationFrame(id); flush();
  completed[2](); await Promise.resolve(); flush();
  game.requestAnimationFrame(tick); flush();
  assert.equal(frames, 6, 'A cancelled callback must not consume a credit');
  game.requestAnimationFrame(tick); flush();
  assert.equal(frames, 6);
  send({type: 'web-game-local-clock', paused: true});
  budget.submit(queue); completed[3](); await Promise.resolve(); flush();
  assert.equal(frames, 6);
  send({type: 'web-game-local-clock', paused: false}); flush();
  assert.equal(frames, 7);
  assert.equal(errors.length, 0);
  console.log('PASS: pre-submission pipeline budget, bootstrap, one completion/one slot, cancel and resume');
})().catch(error => {console.error(error); process.exitCode = 1;});
