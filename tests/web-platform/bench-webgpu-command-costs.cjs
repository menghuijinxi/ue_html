'use strict';
// Diagnostic micro-benchmark: what one WebGPU command pattern costs the browser,
// independent of the engine. Each pattern is repeated many times with trivial GPU
// work (a 16x16 target, one-triangle draws, one-element dispatches). Two numbers
// per pattern unit:
//   wallUs  elapsed time until the queue reports the work done, per unit. This is
//           the slowest stage of the page-to-GPU-process pipeline.
//   gpuProcessUs  time the GPU process main thread spent on the page's command
//           buffer flushes (GpuChannel::ExecuteDeferredRequest in a browser trace),
//           per unit; submitUs is the part inside Dawn's Queue::Submit.
// Use it to rank command patterns, not to predict frame rate.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag'); assert(/^[a-z0-9-]+$/.test(tag || ''), 'usage: bench-webgpu-command-costs.cjs --tag=<name> [--units=64] [--frames=150] [--headed]');
const units = Number(option('units') || 64), frames = Number(option('frames') || 150);
const output = path.join(__dirname, 'results', tag + '.json'); assert(!fs.existsSync(output), 'Use a new result tag');
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), units, frames, patterns: [],
  boundary: 'Synthetic patterns in one Edge page, trivial GPU work. Every frame encodes `units` repetitions of a pattern in one command encoder and submits it. '
    + 'gpuProcessUs comes from a browser trace, which adds overhead to every traced event; compare patterns with each other. Not engine frame-rate evidence.'};

// Runs in the page.
async function bench({units, frames}) {
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  const device = await adapter.requestDevice();
  const errors = []; device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const target = device.createTexture({size: [16, 16], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT}).createView();
  const shader = device.createShaderModule({code: `
    @group(0) @binding(0) var<uniform> tint : vec4f;
    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
      return vec4f(f32(i32(i & 1u) * 2 - 1) * 0.5, f32(i32(i >> 1u) * 2 - 1) * 0.5, 0.0, 1.0); }
    @fragment fn fs() -> @location(0) vec4f { return tint; }`});
  const computeShader = device.createShaderModule({code: `
    @group(0) @binding(0) var<storage, read_write> data : array<u32>;
    @compute @workgroup_size(1) fn cs() { data[0] = data[0] + 1u; }`});
  const pipelines = [0, 1].map(() => device.createRenderPipeline({layout: 'auto', vertex: {module: shader, entryPoint: 'vs'},
    fragment: {module: shader, entryPoint: 'fs', targets: [{format: 'rgba8unorm'}]}}));
  const compute = device.createComputePipeline({layout: 'auto', compute: {module: computeShader, entryPoint: 'cs'}});
  const uniform = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  const tints = pipelines.map(p => [0, 1].map(() => device.createBindGroup({layout: p.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: uniform}}]})));
  const storage = device.createBuffer({size: 65536, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC});
  const copyTarget = device.createBuffer({size: 65536, usage: GPUBufferUsage.COPY_DST});
  const computeGroups = [0, 1].map(() => device.createBindGroup({layout: compute.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: storage}}]}));
  const index = device.createBuffer({size: 16, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(index, 0, new Uint16Array([0, 1, 2, 0]));
  const argsBuffer = (words, count) => {
    const buffer = device.createBuffer({size: count * words.length * 4, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE});
    const data = new Uint32Array(count * words.length); for (let i = 0; i < count; i++) data.set(words, i * words.length);
    device.queue.writeBuffer(buffer, 0, data); return buffer;
  };
  const sharedDraw = argsBuffer([3, 1, 0, 0], units), sharedIndexed = argsBuffer([3, 1, 0, 0, 0], units), sharedDispatch = argsBuffer([1, 1, 1], units);
  const distinctDraw = Array.from({length: units}, () => argsBuffer([3, 1, 0, 0], 1));
  const small = new Uint8Array(64), large = new Uint8Array(16384);
  const attachment = {colorAttachments: [{view: target, loadOp: 'load', storeOp: 'store'}]};
  const begin = e => { const p = e.beginRenderPass(attachment); p.setPipeline(pipelines[0]); p.setBindGroup(0, tints[0][0]); return p; };
  // Each pattern encodes `units` repetitions into the encoder `e`.
  const patterns = {
    'empty encoder (floor)': () => {},
    'render pass + draw, one pass each': e => { for (let i = 0; i < units; i++) { const p = begin(e); p.draw(3); p.end(); } },
    'render pass + drawIndirect, one pass each, distinct buffers': e => { for (let i = 0; i < units; i++) { const p = begin(e); p.drawIndirect(distinctDraw[i], 0); p.end(); } },
    'render pass + drawIndirect, one pass each, shared buffer': e => { for (let i = 0; i < units; i++) { const p = begin(e); p.drawIndirect(sharedDraw, i * 16); p.end(); } },
    'render pass + drawIndexedIndirect, one pass each, shared buffer': e => { for (let i = 0; i < units; i++) { const p = begin(e); p.setIndexBuffer(index, 'uint16'); p.drawIndexedIndirect(sharedIndexed, i * 20); p.end(); } },
    'render pass + drawIndexed, one pass each': e => { for (let i = 0; i < units; i++) { const p = begin(e); p.setIndexBuffer(index, 'uint16'); p.drawIndexed(3); p.end(); } },
    'one pass: draw': e => { const p = begin(e); for (let i = 0; i < units; i++) p.draw(3); p.end(); },
    'one pass: drawIndirect, shared buffer': e => { const p = begin(e); for (let i = 0; i < units; i++) p.drawIndirect(sharedDraw, i * 16); p.end(); },
    'one pass: drawIndirect, distinct buffers': e => { const p = begin(e); for (let i = 0; i < units; i++) p.drawIndirect(distinctDraw[i], 0); p.end(); },
    'one pass: setBindGroup + draw': e => { const p = begin(e); for (let i = 0; i < units; i++) { p.setBindGroup(0, tints[0][i & 1]); p.draw(3); } p.end(); },
    'one pass: setPipeline + setBindGroup + draw': e => { const p = begin(e); for (let i = 0; i < units; i++) { p.setPipeline(pipelines[i & 1]); p.setBindGroup(0, tints[i & 1][0]); p.draw(3); } p.end(); },
    'compute pass + dispatch, one pass each': e => { for (let i = 0; i < units; i++) { const p = e.beginComputePass(); p.setPipeline(compute); p.setBindGroup(0, computeGroups[0]); p.dispatchWorkgroups(1); p.end(); } },
    'one compute pass: setBindGroup + dispatch': e => { const p = e.beginComputePass(); p.setPipeline(compute); for (let i = 0; i < units; i++) { p.setBindGroup(0, computeGroups[i & 1]); p.dispatchWorkgroups(1); } p.end(); },
    'one compute pass: dispatchIndirect, shared buffer': e => { const p = e.beginComputePass(); p.setPipeline(compute); p.setBindGroup(0, computeGroups[0]); for (let i = 0; i < units; i++) p.dispatchWorkgroupsIndirect(sharedDispatch, i * 12); p.end(); },
    'alternating compute pass and render pass with draw': e => { for (let i = 0; i < units; i++) {
      const c = e.beginComputePass(); c.setPipeline(compute); c.setBindGroup(0, computeGroups[0]); c.dispatchWorkgroups(1); c.end(); const p = begin(e); p.draw(3); p.end(); } },
    'queue.writeBuffer 64 bytes': () => { for (let i = 0; i < units; i++) device.queue.writeBuffer(storage, (i * 64) % 32768, small); },
    'queue.writeBuffer 16 KiB': () => { for (let i = 0; i < units; i++) device.queue.writeBuffer(storage, 0, large); },
    'copyBufferToBuffer 256 bytes': e => { for (let i = 0; i < units; i++) e.copyBufferToBuffer(storage, 0, copyTarget, (i * 256) % 32768, 256); },
    'clearBuffer 256 bytes': e => { for (let i = 0; i < units; i++) e.clearBuffer(copyTarget, (i * 256) % 32768, 256); },
    'createBindGroup': () => { for (let i = 0; i < units; i++) device.createBindGroup({layout: compute.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: storage}}]}); },
    'createBuffer 256 bytes + destroy': () => { for (let i = 0; i < units; i++) device.createBuffer({size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}).destroy(); },
  };
  const frame = body => { const e = device.createCommandEncoder(); body(e); device.queue.submit([e.finish()]); };
  const results = [];
  for (const [name, body] of Object.entries(patterns)) {
    for (let i = 0; i < 10; i++) frame(body);
    await device.queue.onSubmittedWorkDone();
    performance.mark('bench:begin:' + name); const start = performance.now();
    for (let i = 0; i < frames; i++) frame(body);
    const encoded = performance.now();
    await device.queue.onSubmittedWorkDone();
    const end = performance.now(); performance.mark('bench:end:' + name);
    results.push({name, encodeMs: encoded - start, wallMs: end - start});
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const info = adapter.info || {};
  return {results, errors, adapter: {vendor: info.vendor, architecture: info.architecture, description: info.description}};
}

(async () => {
  let context;
  try {
    context = await chromium.launchPersistentContext(`G:/UE_HTML/ue_html/tests/web-platform/results/browser-profiles/${tag}`, {
      channel: 'msedge', headless: !process.argv.includes('--headed'), viewport: {width: 640, height: 360}, deviceScaleFactor: 1});
    // A page on the local origin, so WebGPU has a secure context; nothing is loaded from the server.
    await context.route('http://127.0.0.1:8765/__webgpu-command-bench', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>WebGPU command bench</title>'}));
    const page = context.pages()[0]; await page.goto('http://127.0.0.1:8765/__webgpu-command-bench');
    const cdp = await context.newCDPSession(page);
    const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    // The command decoding events are in a category that is off by default.
    await cdp.send('Tracing.start', {categories: 'blink.user_timing,gpu,gpu.dawn,disabled-by-default-gpu.dawn,disabled-by-default-gpu.decoder,disabled-by-default-gpu.debug', transferMode: 'ReturnAsStream'});
    const result = await page.evaluate(bench, {units, frames});
    await cdp.send('Tracing.end');
    const {stream} = await done; const chunks = [];
    for (;;) { const chunk = await cdp.send('IO.read', {handle: stream, size: 1024 * 1024}); chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8')); if (chunk.eof) break; }
    await cdp.send('IO.close', {handle: stream});
    const trace = JSON.parse(Buffer.concat(chunks).toString('utf8')), events = trace.traceEvents || trace;
    const marks = new Map(events.filter(e => typeof e.name === 'string' && e.name.startsWith('bench:')).map(e => [e.name, e.ts]));
    // All GPU-process work for a flush of the page's command buffer, and the part of it spent in Dawn's backend submit.
    const decode = events.filter(e => e.ph === 'X' && e.name === 'GpuChannel::ExecuteDeferredRequest');
    const submit = events.filter(e => e.ph === 'X' && e.name === 'Queue::Submit');
    const inside = (list, a, b) => list.reduce((sum, e) => sum + Math.max(0, Math.min(b, e.ts + e.dur) - Math.max(a, e.ts)), 0) / 1000;
    if (decode.length <= 100) {
      // Show what the trace did contain, to find the right event or category.
      const names = new Map(); for (const e of events) if (e.ph === 'X') names.set(e.cat + ' | ' + e.name, (names.get(e.cat + ' | ' + e.name) || 0) + 1);
      console.error([...names].sort((x, y) => y[1] - x[1]).slice(0, 25).map(v => v[1] + ' ' + v[0]).join('\n'));
    }
    assert(decode.length > 100, 'GPU process command events missing from the trace');
    assert.deepEqual(result.errors, []); report.adapter = result.adapter;
    const floor = {};
    for (const r of result.results) {
      const a = marks.get('bench:begin:' + r.name), b = marks.get('bench:end:' + r.name); assert(a && b, 'Trace marks missing for ' + r.name);
      const row = {name: r.name, wallMsPerFrame: r.wallMs / frames, encodeMsPerFrame: r.encodeMs / frames, gpuProcessMsPerFrame: inside(decode, a, b) / frames,
        submitMsPerFrame: inside(submit, a, b) / frames};
      if (r.name.includes('floor')) Object.assign(floor, row);
      // Per unit, after removing the cost of an empty encoder and submit.
      row.wallUs = (row.wallMsPerFrame - (floor.wallMsPerFrame || 0)) * 1000 / units;
      row.encodeUs = (row.encodeMsPerFrame - (floor.encodeMsPerFrame || 0)) * 1000 / units;
      row.gpuProcessUs = (row.gpuProcessMsPerFrame - (floor.gpuProcessMsPerFrame || 0)) * 1000 / units;
      row.submitUs = (row.submitMsPerFrame - (floor.submitMsPerFrame || 0)) * 1000 / units;
      report.patterns.push(row);
    }
    report.pass = true;
    for (const r of report.patterns) console.log(r.gpuProcessUs.toFixed(2).padStart(9), r.submitUs.toFixed(2).padStart(9), r.wallUs.toFixed(2).padStart(9), r.encodeUs.toFixed(2).padStart(9), ' ', r.name);
    console.log('columns per unit, in microseconds: GPU process total, of which backend submit, wall, page encode');
  } catch (e) { report.failure = e.stack; process.exitCode = 1; console.error(e.stack); }
  finally { await context?.close(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({pass: report.pass, output})); }
})();
