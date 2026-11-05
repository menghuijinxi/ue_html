'use strict';
// Diagnostic only. Installed into the actual runtime, including nested pthreads.
function game() {
  if (!ENVIRONMENT_IS_PTHREAD) return;
  const capture = {frames: [], inputs: [], sequence: 0};
  const now = () => performance.timeOrigin + performance.now();
  let current, pendingInputs = [];
  const input = message => {
    if (message?.type !== 'inputs') return;
    pendingInputs.push({sequence: message.sequence, arrived: now(), count: message.events.length,
      first: message.pipelineFirst, last: message.pipelineLast, sent: message.pipelineSent});
  };
  addEventListener('message', ({data}) => {
    if (data.type === 'web-game-command') input(data.message);
    if (data.type === 'web-game-input-channel')
      data.port.addEventListener('message', ({data}) => input(data));
    if (data.type === 'web-pipeline-read') {
      data.port.postMessage(capture); data.port.close();
    }
  });
  MainLoop.preMainLoop.push(() => {
    current = {sequence: ++capture.sequence, begin: now(), inputs: pendingInputs};
    pendingInputs = [];
    const mailbox = globalThis.__webInputMailboxState;
    if (mailbox) current.mailbox = {...mailbox};
  });
  MainLoop.postMainLoop.push(() => {
    current.end = now();
    capture.frames.push(current);
    if (capture.frames.length > 12000) capture.frames.shift();
  });
}
function owner() {
  const capture = globalThis.__webPipelineCapture = {active: false, tasks: [], gpu: []};
  const now = () => performance.timeOrigin + performance.now();
  let queue, nativeFrame;
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await request.apply(this, args); queue = device.queue; return device;
  };
  Object.defineProperty(globalThis, '__webGPUFrameSubmitted', {configurable: true,
    set(value) {nativeFrame = value;},
    get() {return () => {
      nativeFrame?.();
      if (!capture.active) return;
      const frame = {frame: globalThis.__webRHIFrames, submitted: now(),
        game: globalThis.__webEngineFrames, budget: globalThis.__webLocalFrameBudget &&
          {...globalThis.__webLocalFrameBudget}};
      capture.gpu.push(frame);
      queue.onSubmittedWorkDone().then(() => {frame.done = now();});
    };}});
  const immediate = globalThis.setImmediate;
  globalThis.setImmediate = callback => {
    const queued = capture.active ? now() : null;
    return immediate(() => {
      if (queued === null) return callback();
      const task = {queued, begin: now(), before: globalThis.__webRHIFrames || 0};
      try {return callback();}
      finally {task.end = now(); task.after = globalThis.__webRHIFrames || 0; capture.tasks.push(task);}
    });
  };
}
module.exports = {game, owner};
