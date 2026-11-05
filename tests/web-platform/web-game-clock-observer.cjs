'use strict';
// Installed only by the diagnostic probe inside the actual pthread runtime.
module.exports = function observeGameClock() {
  if (!ENVIRONMENT_IS_PTHREAD) {
    const samples = globalThis.__webMotionBlurCPU = [], attached = new WeakSet();
    const attach = worker => {
      if (attached.has(worker)) return worker;
      attached.add(worker);
      worker.addEventListener('message', event => {
        if (event.data.type !== 'web-motion-blur-cpu') return;
        samples.push(event.data.sample);
        if (samples.length > 600) samples.shift();
      });
      return worker;
    };
    for (const worker of [...PThread.unusedWorkers, ...Object.values(PThread.pthreads)]) attach(worker);
    const allocate = PThread.allocateUnusedWorker;
    PThread.allocateUnusedWorker = function() {return attach(allocate.call(this));};
    return;
  }
  const samples = globalThis.__webMotionBlurCPU = [];
  samples.push = function(sample) {
    postMessage({type: 'web-motion-blur-cpu', sample});
    return Array.prototype.push.call(this, sample);
  };
  const state = globalThis.__webGameClock = {frames: [], sequence: 0};
  let current, previous, lastRAF, inputCount = 0;
  const now = () => performance.timeOrigin + performance.now();
  addEventListener('message', event => {
    if (event.data.type === 'web-game-clock-read') {
      event.data.port.postMessage({...state, mailbox: globalThis.__webInputMailboxState,
        motionBlurCPU: Array.from(globalThis.__webMotionBlurCPU || [])});
      event.data.port.close(); return;
    }
    if (event.data.type === 'web-game-raf') lastRAF = event.data.timestamp;
    if (event.data.type === 'web-game-frame-channel') {
      event.data.port.addEventListener('message', event => {
        if (event.data.type === 'frame') lastRAF = event.data.timestamp;
      });
    }
    if (event.data.type === 'web-game-command' && event.data.message.type === 'inputs')
      inputCount += event.data.message.events.length;
  });
  MainLoop.preMainLoop.push(() => {
    const start = now();
    current = {sequence: ++state.sequence, start, interval: previous === undefined ? null : start - previous,
      rafTimestamp: lastRAF, inputCount};
    inputCount = 0; previous = start;
  });
  MainLoop.postMainLoop.push(() => {
    if (!current) return;
    current.end = now(); current.duration = current.end - current.start;
    state.frames.push(current);
    if (state.frames.length > 1200) state.frames.shift();
    current = null;
  });
};
