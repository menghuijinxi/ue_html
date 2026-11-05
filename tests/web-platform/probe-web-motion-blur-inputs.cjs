'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const uniformLayouts = require('./web-wgsl-uniform-layout.cjs');
const option = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag');
assert(tag && /^[a-z0-9-]+$/.test(tag));
const pacedOnly = process.argv.includes('--lumen-paced-only');
const inputBridgeTag = option('input-bridge-tag');
assert(!inputBridgeTag || /^[a-z0-9-]+$/.test(inputBridgeTag));
const conversion = path.resolve(option('conversion') ||
  path.join(__dirname, 'build/web-project-triplex-project-desktop-cook/20261102-132137/ShaderConversion'));
const entries = {};
for (const item of fs.readdirSync(conversion, {withFileTypes: true}).filter(v => v.isDirectory())) {
  const input = path.join(conversion, item.name, 'input.json');
  if (!fs.existsSync(input)) continue;
  const shader = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (!/^(FTSRDilateVelocityCS|FMotionBlurVelocityFlattenCS)$/.test(shader.shaderName)) continue;
  const globals = shader.metadata.spirvBindings.find(v => v.name === '$Globals');
  if (!globals?.members.some(v => v.name === 'VelocityScale')) continue;
  const view = shader.metadata.spirvBindings.find(v => v.name === 'View');
  const wgsl = path.join(conversion, item.name, 'output.wgsl');
  if (fs.existsSync(wgsl)) {
    for (const layout of uniformLayouts(fs.readFileSync(wgsl, 'utf8'))) {
      const reflected = shader.metadata.spirvBindings.find(v => v.group === layout.group && v.binding === layout.binding);
      for (const field of layout.fields.filter(v => /^(VelocityScale|VelocityMax|View_ClipToPrevClip)$/.test(v.name))) {
        const member = reflected.members.find(v => v.name === field.name);
        assert.equal(field.offset, member.offset, 'WGSL offset must match real SPIR-V reflection');
        assert.equal(field.size, member.size);
      }
    }
  }
  entries[shader.metadata.webEntry] = {
    name: shader.shaderName, input: audit(input),
    globals: {group: globals.group, binding: globals.binding,
      fields: globals.members.filter(v => /^(VelocityScale|VelocityMax|InputInfo_ViewportSize)$/.test(v.name))},
    view: view && {group: view.group, binding: view.binding,
      fields: view.members.filter(v => /View_(ClipToPrevClip|PreViewTranslationLow|PrevPreViewTranslationLow)$/.test(v.name))},
  };
}
assert(Object.keys(entries).length);
const output = path.join(__dirname, 'results', `motion-blur-inputs-${tag}.json`);
assert(!fs.existsSync(output), 'Preserve previous evidence; choose another tag');
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename),
  layoutReader: audit(path.join(__dirname, 'web-wgsl-uniform-layout.cjs')), entries, runs: [],
  boundary: 'Reads real queue-uploaded uniforms without GPU waits or rendering changes. Capturing CPU copies adds diagnostic overhead. Does not prove a subjective shake fix or validate velocity texture pixels.'};
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
let context;

function observe(entries, uniformLayouts, rafMaxFPS) {
  const state = globalThis.__motionInputs = {enabled: false, samples: [], shaderLayouts: {}, errors: [], losses: [], rafMaxFPS};
  if (rafMaxFPS) {
    const request = globalThis.requestAnimationFrame.bind(globalThis);
    const cancel = globalThis.cancelAnimationFrame.bind(globalThis);
    const pendingRAF = new Map();
    let sequence = 0, last = -Infinity;
    globalThis.requestAnimationFrame = callback => {
      const id = ++sequence, item = {};
      pendingRAF.set(id, item);
      const tick = time => {
        if (!pendingRAF.has(id)) return;
        if (time - last < 1000 / rafMaxFPS - 0.5) {item.native = request(tick); return;}
        last = time; pendingRAF.delete(id); callback(time);
      };
      item.native = request(tick);
      return id;
    };
    globalThis.cancelAnimationFrame = id => {
      const item = pendingRAF.get(id);
      if (item) {cancel(item.native); pendingRAF.delete(id);}
    };
  }
  const layouts = new WeakMap(), groups = new WeakMap(), pipelines = new WeakMap();
  const modules = new WeakMap();
  const createModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(desc) {
    const result = createModule.call(this, desc);
    if (/\bVelocityScale\s*:/.test(desc.code)) modules.set(result, desc.code);
    return result;
  };
  const passes = new WeakMap(), bytes = new WeakMap();
  let pending = [];
  const createLayout = GPUDevice.prototype.createBindGroupLayout;
  GPUDevice.prototype.createBindGroupLayout = function(desc) {
    const result = createLayout.call(this, desc);
    layouts.set(result, desc.entries.filter(v => v.buffer?.hasDynamicOffset).map(v => v.binding).sort((a, b) => a - b));
    return result;
  };
  const createGroup = GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup = function(desc) {
    const result = createGroup.call(this, desc);
    groups.set(result, {entries: desc.entries, dynamicBindings: layouts.get(desc.layout) || []});
    return result;
  };
  for (const method of ['createComputePipeline', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(desc) {
      const result = original.call(this, desc);
      let info = entries[desc.compute.entryPoint];
      const code = modules.get(desc.compute.module);
      if (!info && code) {
        const uniforms = uniformLayouts(code);
        const globals = uniforms.find(v => v.fields.some(f => f.name === 'VelocityScale'));
        const view = uniforms.find(v => v.fields.some(f => f.name === 'View_ClipToPrevClip'));
        const select = (layout, re) => layout && ({group: layout.group, binding: layout.binding,
          fields: layout.fields.filter(v => re.test(v.name))});
        if (globals) info = {
          name: /\bVelocityFlattenOutput\s*:/.test(code) ? 'FTSRDilateVelocityCS' : 'FMotionBlurVelocityFlattenCS',
          source: 'Actual running WGSL uniform layout',
          globals: select(globals, /^(VelocityScale|VelocityMax|InputInfo_ViewportSize|bCancelCameraMotion|bAddCustomCameraMotion)$/),
          view: select(view, /View_(ClipToPrevClip|PreViewTranslationLow|PrevPreViewTranslationLow)$/),
        };
      }
      if (info) {
        state.shaderLayouts[desc.compute.entryPoint] = info;
        const track = pipeline => pipelines.set(pipeline, {entry: desc.compute.entryPoint, ...info});
        if (method.endsWith('Async')) result.then(track, () => {});
        else track(result);
      }
      return result;
    };
  }
  const setPipeline = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {
    const pass = passes.get(this) || {groups: new Map()};
    pass.pipeline = pipelines.get(pipeline); passes.set(this, pass);
    return setPipeline.call(this, pipeline);
  };
  const setGroup = GPUComputePassEncoder.prototype.setBindGroup;
  GPUComputePassEncoder.prototype.setBindGroup = function(index, group, offsets, start, length) {
    const pass = passes.get(this) || {groups: new Map()};
    // Emscripten passes its entire wasm64 HEAPU32 with a small start/count window.
    const begin = start || 0, end = length === undefined ? undefined : begin + length;
    const dynamic = offsets ? Array.from(offsets.subarray ? offsets.subarray(begin, end) : offsets.slice(begin, end)) : [];
    pass.groups.set(index, {group: groups.get(group), dynamic}); passes.set(this, pass);
    return setGroup.apply(this, arguments);
  };
  const resolve = (pass, spec) => {
    const bound = pass.groups.get(spec.group);
    const resource = bound?.group?.entries.find(v => v.binding === spec.binding)?.resource;
    if (!resource?.buffer) throw new Error('Missing captured uniform binding');
    const dynamicIndex = bound.group.dynamicBindings.indexOf(spec.binding);
    const offset = (resource.offset || 0) + (dynamicIndex < 0 ? 0 : bound.dynamic[dynamicIndex] || 0);
    const size = resource.size ?? resource.buffer.size - offset;
    if (spec.fields.some(field => field.offset + field.size > size))
      throw new Error('Diagnostic field exceeds the actual uniform binding');
    return {buffer: resource.buffer, offset, size, fields: spec.fields};
  };
  for (const method of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
    const original = GPUComputePassEncoder.prototype[method];
    GPUComputePassEncoder.prototype[method] = function(...args) {
      const pass = passes.get(this), info = pass?.pipeline;
      if (state.enabled && info && state.samples.length + pending.length < 1000) {
        pending.push({frame: (globalThis.__webRHIFrames || 0) + 1, at: performance.now(),
          entry: info.entry, shader: info.name, globals: resolve(pass, info.globals),
          view: info.view && resolve(pass, info.view)});
      }
      return original.apply(this, args);
    };
  }
  const write = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function(buffer, offset, data, dataOffset = 0, size) {
    if (state.enabled && (buffer.usage & GPUBufferUsage.UNIFORM)) {
      let shadow = bytes.get(buffer);
      if (!shadow) {shadow = new Uint8Array(buffer.size); bytes.set(buffer, shadow);}
      const unit = ArrayBuffer.isView(data) ? (data.BYTES_PER_ELEMENT || 1) : 1;
      const begin = (data.byteOffset || 0) + dataOffset * unit;
      const count = size === undefined ? data.byteLength - dataOffset * unit : size * unit;
      shadow.set(new Uint8Array(data.buffer || data, begin, count), offset);
    }
    return write.apply(this, arguments);
  };
  const read = spec => {
    const shadow = bytes.get(spec.buffer);
    if (!shadow) return null;
    const values = {};
    for (const field of spec.fields) {
      const view = new DataView(shadow.buffer, spec.offset + field.offset, field.size);
      values[field.name] = Array.from({length: field.size / 4}, (_, i) =>
        /^b(CancelCameraMotion|AddCustomCameraMotion)$/.test(field.name) ?
          view.getUint32(i * 4, true) : view.getFloat32(i * 4, true));
    }
    return values;
  };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function(...args) {
    for (const sample of pending) state.samples.push({...sample, globals: read(sample.globals), view: sample.view && read(sample.view)});
    pending = [];
    return submit.apply(this, args);
  };
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await request.apply(this, args);
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => {if (info.reason !== 'destroyed') state.losses.push(info.message);});
    return device;
  };
}

(async () => {
  try {
    const cases = inputBridgeTag ?
      ['owner', 'direct'].map(mode => ({folder: `triplex-input-${mode}-${inputBridgeTag}`})) :
      pacedOnly ? [{folder: 'triplex-project-lumen-shadows-fixed-20261104', rafMaxFPS: 10}] :
      ['triplex-project-lumen-shadows-fixed-20261104', 'triplex-motion-no-lumen-10fps-20261104-v2'].map(folder => ({folder}));
    for (const {folder, rafMaxFPS} of cases) {
      const profile = path.join(__dirname, 'build/browser-profiles', `motion-inputs-${tag}-${report.runs.length}`);
      context = await chromium.launchPersistentContext(profile,
        {channel: 'msedge', headless: true, viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
      const affinity = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference='Stop'
        $taskBrowser=Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object {
          $_.CommandLine -and $_.CommandLine.Contains($env:UE_MOTION_INPUT_PROFILE) -and $_.CommandLine -notmatch '--type='
        } | Select-Object -First 1
        if(!$taskBrowser){throw 'Diagnostic browser missing'}
        for($taskAttempt=0;$taskAttempt -lt 12;$taskAttempt++){
          Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object {
            $_.ProcessId -eq $taskBrowser.ProcessId -or
            ($_.ParentProcessId -eq $taskBrowser.ProcessId -and $_.CommandLine -match '--type=gpu-process')
          } | ForEach-Object {
            $taskProcess=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if($taskProcess){$taskProcess.ProcessorAffinity=[IntPtr][long]4294901760}
          }
          Start-Sleep -Milliseconds 200
        }
        (Get-Process -Id $taskBrowser.ProcessId).ProcessorAffinity.ToInt64()
      `], {encoding: 'utf8', windowsHide: true, env: {...process.env, UE_MOTION_INPUT_PROFILE: profile}}).trim();
      assert.equal(affinity, '4294901760');
      await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: `(${observe.toString()})(${JSON.stringify(entries)}, ${uniformLayouts.toString()}, ${JSON.stringify(rafMaxFPS)});\n` + await response.text()});
      });
      const page = context.pages()[0], errors = [];
      page.on('console', message => {
        const text = message.text();
        if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|TypeError:/.test(text)) errors.push(text.slice(0, 2000));
      });
      page.on('pageerror', error => errors.push(error.message));
      page.on('crash', () => errors.push('Renderer crashed'));
      await (await context.newCDPSession(page)).send('Emulation.setFocusEmulationEnabled', {enabled: true});
      await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
      const advance = async count => {
        const before = await page.evaluate(() => globalThis.__webEngineFrames || 0);
        await page.waitForFunction(target => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= target,
          before + count, {timeout: 180000});
        const failure = await page.evaluate(() => globalThis.__webEngineFailure);
        assert(!failure, JSON.stringify({failure, errors}));
      };
      await advance(90);
      if (inputBridgeTag) {
        await page.waitForFunction(() => globalThis.__webInputBridge?.ready === true);
        await page.evaluate(() => {
          const state = globalThis.__webInputBridge;
          state.trace.length = 0; state.sent = 0; state.acknowledged = 0; state.maxQueue = 0;
        });
      }
      const owner = page.workers().find(w => w.url().includes('web-engine-worker.js'));
      assert(owner);
      await owner.evaluate(() => {__motionInputs.enabled = true;});
      await page.locator('canvas').focus();
      await page.mouse.move(650, 360);
      await page.mouse.down({button: 'right'});
      for (let i = 0; i < 80; i++) {
        await page.mouse.move(650 + i * 4, 360 + Math.sin(i / 15) * 12);
        await page.waitForTimeout(50);
      }
      await page.mouse.up({button: 'right'});
      await advance(30);
      if (inputBridgeTag) await page.waitForFunction(() => {
        const state = globalThis.__webInputBridge;
        return state.sent === state.acknowledged;
      });
      const state = await owner.evaluate(() => {
        __motionInputs.enabled = false;
        return {probe: __motionInputs, settings: globalThis.__webProjectSettings, camera: globalThis.__webDefaultCamera};
      });
      if (inputBridgeTag) {
        state.inputBridge = await page.evaluate(() => globalThis.__webInputBridge);
        assert(state.inputBridge.sent >= 10 && state.inputBridge.acknowledged >= 10);
        assert.equal(state.settings.gi, 1);
        assert.equal(state.settings.reflections, 1);
        assert.equal(state.settings.antiAliasing, 4);
        assert.equal(state.inputBridge.mode,
          folder.includes('-direct-') ? 'direct-game-thread' : 'owner-forwarded');
        const image = path.join(__dirname, 'results', `motion-blur-inputs-${tag}-${report.runs.length}.png`);
        await page.screenshot({path: image});
        state.screenshot = audit(image);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(state.probe.errors, []);
      assert.deepEqual(state.probe.losses, []);
      assert(state.probe.samples.length >= 30, 'Need real matched velocity-flatten shader dispatches');
      assert(state.probe.samples.every(s => s.globals?.VelocityScale?.every(Number.isFinite)));
      const scales = state.probe.samples.map(s => s.globals.VelocityScale[0]).sort((a, b) => a - b);
      const run = {folder, rafMaxFPS, affinity, ...state, errors,
        summary: {samples: scales.length, minScaleX: scales[0], medianScaleX: scales[Math.floor(scales.length / 2)],
          maxScaleX: scales.at(-1), maxToMin: scales.at(-1) / scales[0]}};
      report.runs.push(run); save();
      console.log(JSON.stringify({folder, ...run.summary}));
      await context.close(); context = null;
    }
    report.pass = true;
  } catch (error) {report.failure = error.stack; process.exitCode = 1;}
  finally {save(); await context?.close(); console.log(JSON.stringify({pass: report.pass, failure: report.failure, output}));}
})();
