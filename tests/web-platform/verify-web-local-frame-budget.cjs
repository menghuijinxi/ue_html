'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real owner/GT boundary with deterministic GPU completions and
// asynchronous message queues, including a completion racing the waiter store.
(async () => {
  const messages = [], tasks = [], listeners = [], completions = [], failures = [];
  const owner = vm.createContext({SharedArrayBuffer, Int32Array, Atomics, performance,
    setImmediate() {}, addEventListener() {}, postMessage: message => failures.push(message)});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'web-engine-worker.js'), 'utf8'), owner);
  const create = vm.runInContext('createWebLocalFrameBudget', owner);
  assert.throws(() => create(0));
  assert.throws(() => create(1.5));
  assert.throws(() => create(9));
  const budget = create(2);
  const queue = {onSubmittedWorkDone: () => new Promise((resolve, reject) => completions.push({resolve, reject}))};
  let library, race;
  const game = vm.createContext({
    ENVIRONMENT_IS_PTHREAD: true, Map, Set, Int32Array, SharedArrayBuffer, performance,
    Atomics: {...Atomics, load: Atomics.load, exchange: Atomics.exchange,
      store(array, index, value) {
        const result = Atomics.store(array, index, value);
        if (index === 2 && value === 1 && race) {const callback = race; race = null; callback();}
        return result;
      }},
    MainLoop: {preMainLoop: []}, Module: {},
    addToLibrary(value) {library = value;},
    postMessage: message => messages.push(message),
    addEventListener(type, listener) {listeners.push(listener);},
    MessageChannel: class {
      constructor() {this.port1 = {}; this.port2 = {postMessage: data =>
        tasks.push(() => this.port1.onmessage({data}))};}
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js'), 'utf8'), game);
  library.$WebThreadBridge();
  const send = data => listeners.forEach(listener => listener({data}));
  const flush = () => {let count = 0; while (tasks.length) {assert(++count < 50, 'Busy loop'); tasks.shift()();}};
  const worker = {postMessage: message => tasks.push(() => send(message))};
  budget.attach(worker); flush();
  send({type: 'web-game-local-clock', paused: false});
  budget.submit(queue); budget.submit(queue);
  let frames = 0;
  game.requestAnimationFrame(() => frames++);
  flush();
  assert.equal(frames, 0, 'A full GPU queue must stop the next Game tick');
  assert.equal(Atomics.load(budget.state, 2), 1);
  completions[0].resolve(); await Promise.resolve(); flush();
  assert.equal(frames, 1, 'GPU completion must wake the parked Game tick');
  assert.equal(budget.diagnostics.wakes, 1);
  completions[1].resolve(); await Promise.resolve(); flush();
  assert.equal(budget.diagnostics.wakes, 1, 'No cross-worker wake when Game is not parked');
  budget.submit(queue); budget.submit(queue);
  const cancelled = game.requestAnimationFrame(() => assert.fail('Cancelled tick ran'));
  flush(); game.cancelAnimationFrame(cancelled);
  send({type: 'web-game-local-clock', paused: true});
  game.requestAnimationFrame(() => frames++);
  completions[2].resolve(); await Promise.resolve(); flush();
  assert.equal(frames, 1, 'GPU completion must not resume a hidden tab');
  send({type: 'web-game-local-clock', paused: false});
  send({type: 'web-game-local-clock', paused: true});
  send({type: 'web-game-local-clock', paused: false});
  flush();
  assert.equal(frames, 2, 'Pause/resume must not duplicate a pending tick');
  completions[3].resolve(); await Promise.resolve(); flush();
  // The unsigned distance must survive signed counter wrap.
  Atomics.store(budget.state, 0, -2147483648); Atomics.store(budget.state, 1, 2147483646);
  game.requestAnimationFrame(() => frames++); flush();
  assert.equal(frames, 2);
  Atomics.store(budget.state, 1, 2147483647);
  send({type: 'web-game-local-ready'}); flush();
  assert.equal(frames, 3);
  Atomics.store(budget.state, 0, 20); Atomics.store(budget.state, 1, 18);
  race = () => {Atomics.store(budget.state, 1, 19); Atomics.exchange(budget.state, 2, 0);};
  game.requestAnimationFrame(() => frames++); flush();
  assert.equal(frames, 4, 'A completion racing the waiter store must not lose a wake');
  budget.submit(queue);
  completions[4].reject(new Error('GPU lost')); await Promise.resolve(); await Promise.resolve();
  assert.equal(failures.length, 1, 'GPU failures must reach the host');
  assert.match(failures[0].message, /GPU lost/);
  console.log('PASS: real local-clock GPU backpressure, wake race, wrap, cancellation, visibility and errors');
})().catch(error => {console.error(error); process.exitCode = 1;});
