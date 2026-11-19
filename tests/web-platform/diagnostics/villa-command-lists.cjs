'use strict';

// Observe a few complete frames without inserting commands or waiting on the GPU.
module.exports = function observeVillaCommandLists() {
  const views = new WeakMap(), encoders = new WeakMap(), buffers = new WeakMap();
  let start = Infinity, batches = [];
  const frame = () => globalThis.__webRHIFrames || 0;
  const active = () => frame() >= start && frame() < start + 6;
  function after(prototype, name, inspect) {
    const original = prototype[name];
    prototype[name] = function(...args) {
      const value = original.apply(this, args);
      inspect(this, value, args);
      return value;
    };
  }
  after(GPUTexture.prototype, 'createView', (texture, view) => views.set(view, texture.label));
  const encoder = GPUCommandEncoder.prototype;
  function note(object, label) {
    if (!active()) return;
    let ops = encoders.get(object);
    if (!ops) encoders.set(object, ops = {});
    ops[label] = (ops[label] || 0) + 1;
  }
  after(encoder, 'beginRenderPass', (object, pass, [desc]) => {
    if (active()) note(object, 'render ' + (desc.label || views.get(desc.colorAttachments?.find(Boolean)?.view) ||
      views.get(desc.depthStencilAttachment?.view) || '?'));
  });
  after(encoder, 'beginComputePass', object => note(object, 'compute'));
  for (const [method, src, dst] of [['copyBufferToBuffer',0,2], ['copyTextureToBuffer',0,1],
    ['copyBufferToTexture',0,1], ['copyTextureToTexture',0,1], ['clearBuffer',0], ['resolveQuerySet',0,3]]) {
    const label = value => (value?.texture || value?.buffer || value)?.label || '?';
    after(encoder, method, (object, result, args) => {
      if (active()) note(object, [method, label(args[src]), ...(dst === undefined ? [] : [label(args[dst])])].join(' '));
    });
  }
  after(encoder, 'finish', (object, buffer) => {
    if (active()) buffers.set(buffer, encoders.get(object) || {});
  });
  after(GPUQueue.prototype, 'submit', (queue, result, [commands]) => {
    if (active()) batches.push({frame:frame(), lists:Array.from(commands, buffer => buffers.get(buffer) ?? null)});
  });
  globalThis.__villaCommandLists = {
    start() { batches = []; start = frame() + 16; },
    stop() { start = Infinity; return batches; }
  };
};
