'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {MessageChannel} = require('node:worker_threads');
const {WebInputBridge} = require('./web-engine-host.js');
const channels = [];

(async () => {
  const sent = [], frames = [];
  const legacy = new WebInputBridge({
    send: message => sent.push(message), schedule: callback => frames.push(callback),
    focused: () => true, trace: true,
  });
  legacy.push([5, 2, 0, 10, 20, 0, 0, 0, 0]);
  legacy.push([8, 0, 0, 11, 20, 1, 0, 0, 0]);
  legacy.push([8, 0, 0, 13, 20, 2, 0, 0, 0]);
  legacy.push([8, 0, 0, 16, 20, 3, 0, 0, 0]);
  assert.equal(sent.length, 0);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(sent[0].events.map(v => [v[0], v[5]]), [[5, 0], [8, 1], [8, 5]]);
  legacy.push([6, 2, 0, 16, 20, 0, 0, 0, 0]);
  assert.equal(frames.length, 0, 'Backpressure must wait for the outstanding batch');
  legacy.acknowledge({type: 'input-ack', sequence: 999});
  assert.equal(frames.length, 0, 'A stale acknowledgement must not release backpressure');
  legacy.acknowledge({type: 'input-ack'});
  frames.shift()();
  assert.equal(sent[1].events[0][0], 6);
  legacy.acknowledge({type: 'input-ack'});

  legacy.push([2, 65, 97, 0, 0, 0, 0, 0, 0]);
  frames.shift()();
  for (let i = 0; i < 257; i++) legacy.push([2, 65, 97, 0, 0, 0, 0, 0, 0]);
  legacy.acknowledge({type: 'input-ack'});
  frames.shift()();
  assert.deepEqual(sent.at(-1).events.slice(0, 2).map(v => v[0]), [12, 13]);
  assert(legacy.state.maxQueue <= 256);

  const channel = new MessageChannel(), received = [], handlers = [];
  channels.push(channel);
  let library;
  const game = vm.createContext({
    ENVIRONMENT_IS_PTHREAD: true, Map, performance,
    addToLibrary: value => {library = value;},
    addEventListener: (name, callback) => {assert.equal(name, 'message'); handlers.push(callback);},
    postMessage: () => assert.fail('Direct input must not return via the owner'),
    Module: {_WebInvokeGameCommand: () => received.push(game.__webPendingGameCommand)},
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js'), 'utf8'), game);
  library.$WebThreadBridge();
  const direct = new WebInputBridge({
    send: () => assert.fail('Direct input must bypass the RHI owner'),
    schedule: queueMicrotask, focused: () => true, trace: true,
  });
  direct.connect(channel.port1);
  direct.push([5, 2, 0, 1, 1, 0, 0, 0, 0]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received.length, 0, 'Wait for the GT handshake');
  handlers[0]({data: {type: 'web-game-input-channel', port: channel.port2}});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(received.length, 1);
  direct.push([8, 0, 0, 3, 1, 2, 0, 0, 0]);
  direct.push([6, 2, 0, 3, 1, 0, 0, 0, 0]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(received[1].events.map(v => v[0]), [8, 6]);
  assert.equal(direct.state.acknowledged, 2);
  assert(direct.state.trace.every(v => Number.isFinite(v.enqueuedAt)));
  assert.equal(direct.state.mode, 'direct-game-thread');
  direct.dispose();
  channel.port2.close();
  legacy.dispose();
  console.log('PASS: real MessagePort handshake, direct delivery, ordered release, coalescing and bounded backpressure');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => channels.forEach(channel => {channel.port1.close(); channel.port2.close();}));
