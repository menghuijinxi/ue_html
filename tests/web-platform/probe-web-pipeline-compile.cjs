const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const directory = path.join(__dirname, 'results');
const snapshotFile = path.join(directory, 'web-default-pipeline-snapshot.json');
const suffix = option('report') || '';
assert(/^[a-z0-9-]*$/.test(suffix));
const mode = option('mode') || 'sync';
const dumpHlsl = process.argv.includes('--dump-hlsl');
assert(['sync', 'async-serial', 'async-parallel'].includes(mode));
const repetitions = Number(option('runs') || 1);
assert(Number.isInteger(repetitions) && repetitions > 0);
const executablePath = option('browser') === 'Edge' ?
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' :
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});

function recordPipelines() {
  const snapshot = {device: null, records: [], loss: null, errors: []};
  globalThis.__webPipelineSnapshot = snapshot;
  const objects = new WeakMap();
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor) {
    snapshot.device = JSON.parse(JSON.stringify(descriptor || {}));
    const device = await request.call(this, descriptor);
    device.lost.then(info => { snapshot.loss = {reason: info.reason, message: info.message}; });
    device.addEventListener('uncapturederror', event => snapshot.errors.push(event.error.message));
    return device;
  };
  const encode = value => {
    if (value && typeof value === 'object') {
      if (objects.has(value)) return {__gpuObject: objects.get(value)};
      if (Array.isArray(value)) return value.map(encode);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    }
    return value;
  };
  for (const method of ['createShaderModule', 'createBindGroupLayout', 'createPipelineLayout',
    'createRenderPipeline', 'createComputePipeline']) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(descriptor) {
      const id = snapshot.records.length;
      snapshot.records.push({id, method, descriptor: encode(descriptor)});
      const object = original.call(this, descriptor);
      objects.set(object, id);
      return object;
    };
  }
}

async function replayPipelines({snapshot, mode, only}) {
  const state = {completed: [], errors: [], loss: null, done: false};
  globalThis.__webPipelineReplay = state;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice(snapshot.device);
    device.lost.then(info => { state.loss = {reason: info.reason, message: info.message}; });
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    const objects = new Map();
    const decode = value => {
      if (value && typeof value === 'object') {
        if ('__gpuObject' in value) {
          if (!objects.has(value.__gpuObject)) throw new Error(`Missing GPU object ${value.__gpuObject}`);
          return objects.get(value.__gpuObject);
        }
        if (Array.isArray(value)) return value.map(decode);
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
      }
      return value;
    };
    const pending = [];
    for (const record of snapshot.records) {
      const isPipeline = /create(?:Render|Compute)Pipeline$/.test(record.method);
      if (isPipeline && only && !only.includes(record.id)) continue;
      const descriptor = decode(record.descriptor);
      if (isPipeline && mode !== 'sync') {
        const compile = device[`${record.method}Async`](descriptor).then(pipeline => {
          objects.set(record.id, pipeline);
          state.completed.push(record.id);
        });
        if (mode === 'async-serial') await compile;
        else pending.push(compile);
      } else {
        objects.set(record.id, device[record.method](descriptor));
        if (isPipeline) state.completed.push(record.id);
      }
    }
    await Promise.all(pending);
    await device.queue.onSubmittedWorkDone();
    // Drain validation callbacks before reporting a successful compile.
    await new Promise(resolve => setTimeout(resolve, 250));
    state.done = true;
  } catch (error) {
    state.failure = error.stack || String(error);
    state.done = true;
  }
}

(async () => {
  const report = {date: new Date().toISOString(), pass: false, mode, dumpHlsl,
    hostCondition: process.env.UE_WEB_TEST_HOST_CONDITION || 'default scheduling',
    runs: [], source: audit(__filename)};
  let browser;
  try {
    if (process.argv.includes('--capture')) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 1848, height: 1120}, deviceScaleFactor: 2});
      const errors = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      await page.addInitScript(recordPipelines);
      await page.goto('http://127.0.0.1:8765/build/ue-default-template/index.html', {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 120,
        null, {timeout: 90000});
      const snapshot = await page.evaluate(() => ({
        ...globalThis.__webPipelineSnapshot,
        frames: globalThis.__webEngineFrames || 0, failure: globalThis.__webEngineFailure || null
      }));
      snapshot.errors.push(...errors);
      snapshot.browser = browser.version();
      snapshot.package = audit(path.join(directory, 'web-default-template-package-results.json'));
      fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
      report.capture = {frames: snapshot.frames, failure: snapshot.failure, loss: snapshot.loss,
        records: snapshot.records.length, errors: snapshot.errors};
      await browser.close();
      browser = null;
      assert(snapshot.records.some(record => record.method === 'createRenderPipeline'));
    }
    assert(fs.existsSync(snapshotFile), 'Run with --capture first');
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    report.snapshot = audit(snapshotFile);
    const only = option('only')?.split(',').map(Number);
    assert(!only || only.every(Number.isInteger));
    report.only = only || null;
    report.pipelines = snapshot.records.filter(record => /create(?:Render|Compute)Pipeline$/.test(record.method) &&
      (!only || only.includes(record.id))).map(record => ({
        id: record.id, method: record.method,
        vertex: record.descriptor.vertex?.entryPoint,
        fragment: record.descriptor.fragment?.entryPoint,
        compute: record.descriptor.compute?.entryPoint
      }));
    assert(report.pipelines.length);
    for (let index = 0; index < repetitions; ++index) {
      browser = await chromium.launch({executablePath, headless: true,
        args: dumpHlsl ? ['--enable-dawn-features=dump_shaders'] : []});
      const page = await browser.newPage();
      await page.route('**/pipeline-replay.html', route => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Pipeline replay</title>'
      }));
      await page.goto('http://127.0.0.1:8765/pipeline-replay.html', {waitUntil: 'commit'});
      const errors = [];
      const dumps = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      if (dumpHlsl) page.on('console', message => {
        if (message.text().includes('/* Dumped generated HLSL */')) dumps.push(message.text());
      });
      await page.evaluate(({snapshot, mode, only, source}) => {
        (0, eval)(`(${source})`)({snapshot, mode, only});
      }, {snapshot, mode, only, source: replayPipelines.toString()});
      await page.waitForFunction(() => globalThis.__webPipelineReplay?.done ||
        globalThis.__webPipelineReplay?.loss, null, {timeout: 90000});
      const result = await page.evaluate(() => globalThis.__webPipelineReplay);
      result.errors.push(...errors);
      result.index = index;
      result.browser = browser.version();
      if (dumpHlsl) {
        const file = path.join(directory, `web-default-pipeline-hlsl${suffix ? '-' + suffix : ''}-${index}.log`);
        fs.writeFileSync(file, dumps.join('\n'));
        result.hlslDump = {...audit(file), shaders: dumps.length};
      }
      result.pass = result.done && !result.failure && !result.loss && result.errors.length === 0 &&
        result.completed.length === report.pipelines.length && (!dumpHlsl || dumps.length > 0);
      report.runs.push(result);
      console.log(JSON.stringify({index, mode, pass: result.pass, completed: result.completed.length,
        failure: result.failure, loss: result.loss, errors: result.errors.slice(0, 3)}));
      await browser.close();
      browser = null;
    }
    report.pass = report.runs.length === repetitions && report.runs.every(run => run.pass);
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, `web-default-pipeline-${mode}${suffix ? '-' + suffix : ''}-results.json`),
      JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, capture: report.capture, mode, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
