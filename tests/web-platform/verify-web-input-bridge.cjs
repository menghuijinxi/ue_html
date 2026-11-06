'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {MessageChannel} = require('node:worker_threads');
const {WebInputBridge, WebInputMailbox} = require('./web-engine-host.js');
const {performanceModes} = require('./web-performance-modes.cjs');
const channels = [];

(async () => {
  const hostSource = fs.readFileSync(path.join(__dirname, 'web-engine-host.js'), 'utf8');
  function selectClock(search, assets = {}, args = []) {
    const reachedWorker = new Error('Selection complete');
    const environment = vm.createContext({
      URLSearchParams, location: {search},
      Worker: class {constructor() {throw reachedWorker;}},
    });
    vm.runInContext(hostSource, environment);
    const engine = {arguments: args, canvas: {transferControlToOffscreen() {}}};
    assert.throws(() => environment.startWebEngineWorker({
      assets: {versions: {}, ...assets}, module: engine,
    }), error => error === reachedWorker);
    return engine.arguments;
  }
  const defaultArgs = selectClock('');
  assert(defaultArgs.includes('-WebOcclusionMode=history'));
  assert(!defaultArgs.includes('-WebGameLocalClock'));
  assert(defaultArgs.includes('-WebRHIWake=priority'));
  const ownerArgs = selectClock('?clock=owner&occlusion=control&rhiwake=channel');
  assert(!ownerArgs.includes('-WebGameLocalClock'));
  assert(ownerArgs.includes('-WebOcclusionMode=control'));
  assert(ownerArgs.includes('-WebRHIWake=channel'));
  assert(!selectClock('', {gameFrameBridge: 'page-raf'}).includes('-WebGameLocalClock'),
    'Diagnostic page rAF must not also select the local clock');
  assert(!selectClock('', {localFrameBudget: 3, localFrameBudgetMode: 'pipeline'},
    ['-WebGameLocalClock']).includes('-WebGameLocalClock'),
    'Inherited local flags and a stored pipeline budget must not enable local scheduling');
  const publishedDefaults = performanceModes();
  assert.equal(publishedDefaults.modes.clock, 'owner');
  assert.equal(new URLSearchParams(publishedDefaults.query).get('clock'), 'owner');
  assert(!selectClock(publishedDefaults.query).includes('-WebGameLocalClock'));
  assert(selectClock(performanceModes({clock: 'local'}).query).includes('-WebGameLocalClock'));
  assert(!selectClock('', {}, ['-WebFrameScheduler=2']).includes('-WebGameLocalClock'));
  assert(selectClock('?clock=page&framebudget=3').includes('-WebFrameScheduler=3'));
  assert(selectClock('?clock=page').includes('-WebFrameScheduler=3'));
  for (const value of ['0','5','1.5','invalid'])
    assert.throws(()=>selectClock('?clock=page&framebudget='+value),/Invalid owner completion frame budget/);
  assert.throws(()=>selectClock('?clock=owner&framebudget=3'),/framebudget requires clock=page/);
  assert.throws(() => selectClock('?clock=local', {gameFrameBridge: 'page-raf'}),
    /Choose one frame clock experiment/);
  for (const value of ['-1', '9', '1.5', 'invalid'])
    assert.throws(() => selectClock('?gpuahead=' + value), /Invalid local GPU frame budget/);
  assert(selectClock('?clock=local&gpuahead=4').includes('-WebGameLocalClock'));
  assert(selectClock('?clock=local&gpuahead=3&gpumode=pipeline').includes('-WebGameLocalClock'));
  assert.throws(() => selectClock('?gpumode=invalid'), /Invalid local GPU budget mode/);
  assert.throws(() => selectClock('?input=invalid'), /Invalid browser input mode/);
  for (const value of ['owner-forwarded', 'direct-game-thread', 'shared-mailbox'])
    assert(!selectClock('?input=' + value).includes('-WebGameLocalClock'));

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
    MessageChannel: class {
      constructor() {
        const channel = new MessageChannel();
        channels.push(channel);
        return channel;
      }
    },
    MainLoop: {preMainLoop: []},
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
  const framesChannel = new MessageChannel(), requests = [], delivered = [];
  channels.push(framesChannel);
  framesChannel.port2.on('message', message => requests.push(message));
  handlers[0]({data: {type: 'web-game-frame-channel', port: framesChannel.port1}});
  const frame = game.requestAnimationFrame(timestamp => delivered.push(timestamp));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(requests.map(v => v.type), ['frame-ready', 'frame-request']);
  framesChannel.port2.postMessage({type: 'frame', id: frame, timestamp: 123.5});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(delivered, [123.5]);
  const cancelled = game.requestAnimationFrame(() => assert.fail('Cancelled frame ran'));
  game.cancelAnimationFrame(cancelled);
  framesChannel.port2.postMessage({type: 'frame', id: cancelled, timestamp: 130});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requests.at(-1).type, 'frame-cancel');
  const mailbox = new WebInputMailbox(() => true);
  handlers[0]({data: {type: 'web-game-input-mailbox', buffer: mailbox.buffer}});
  const count = received.length;
  mailbox.push([5, 2, 0, 10, 20, 0, 0, 0, 0]);
  mailbox.push([8, 0, 0, 14, 20, 4, 0, 0, 0]);
  mailbox.push([6, 2, 0, 14, 20, 0, 0, 0, 0]);
  assert.equal(received.length, count, 'Mailbox must be sampled at frame entry');
  game.MainLoop.preMainLoop[0]();
  assert.deepEqual(Array.from(received.at(-1).events, v => v[0]), [5, 8, 6]);
  assert.equal(Atomics.load(mailbox.header, 0), Atomics.load(mailbox.header, 1));
  // Repeated ring wraps must retain exact displacement totals and release order.
  for (let batch = 0; batch < 8; batch++) {
    for (let i = 0; i < 200; i++) mailbox.push([8, 0, 0, i, 0, 1, -1, 0, 0]);
    game.MainLoop.preMainLoop[0]();
    assert.equal(received.at(-1).events.length, 200);
    assert.equal(received.at(-1).events.reduce((sum, v) => sum + v[5], 0), 200);
  }
  for (let i = 0; i < 257; i++) mailbox.push([8, 0, 0, i, 0, 1, 0, 0, 0]);
  game.MainLoop.preMainLoop[0]();
  assert.deepEqual(Array.from(received.at(-1).events, v => v[0]), [12, 13]);
  assert.equal(game.__webInputMailboxState.overflowResets, 1);
  Atomics.store(mailbox.header, 0, -2); Atomics.store(mailbox.header, 1, -2);
  mailbox.push([8, 0, 0, 1, 0, 2, 0, 0, 0]);
  mailbox.push([6, 2, 0, 1, 0, 0, 0, 0, 0]);
  mailbox.push([12, 0, 0, 0, 0, 0, 0, 0, 0]);
  game.MainLoop.preMainLoop[0]();
  assert.deepEqual(Array.from(received.at(-1).events, v => v[0]), [8, 6, 12]);
  assert.equal(Atomics.load(mailbox.header, 1), 1);
  // The merged local scheduler must retain cancellation and hidden-page pauses.
  const clockStates = [];
  game.postMessage = message => clockStates.push(message);
  handlers[0]({data: {type: 'web-game-local-clock', paused: false}});
  let localFrames = 0;
  game.requestAnimationFrame(() => localFrames++);
  const localCancelled = game.requestAnimationFrame(() => assert.fail('Cancelled local frame ran'));
  game.cancelAnimationFrame(localCancelled);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(localFrames, 1);
  handlers[0]({data: {type: 'web-game-local-clock', paused: true}});
  game.requestAnimationFrame(() => localFrames++);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(localFrames, 1, 'Hidden local clock must stay paused');
  handlers[0]({data: {type: 'web-game-local-clock', paused: false}});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(localFrames, 2, 'Resume must deliver a pending frame exactly once');
  assert.deepEqual(clockStates.map(value => value.paused), [false, true, false]);
  direct.dispose();
  channel.port2.close();
  legacy.dispose();
  console.log('PASS: input/frame MessagePorts, shared queue wrap/overflow, local clock pause/resume, cancellation and bounded backpressure');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => channels.forEach(channel => {channel.port1.close(); channel.port2.close();}));
