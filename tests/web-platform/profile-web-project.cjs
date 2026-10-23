const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {chromium} = require('playwright');
const execute = promisify(execFile);
const directory = path.join(__dirname, 'results');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = option('project') || 'triplex-house-villa';
const suffix = option('report') || 'diagnosis';
assert(/^[a-z0-9-]+$/.test(id) && /^[a-z0-9-]+$/.test(suffix));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const report = {date: new Date().toISOString(), pass: false, project: id, phases: [],
  source: audit(__filename), boundary: 'Diagnostic measurements, not performance or visual acceptance. ' +
    'Queue completion latency is not GPU execution time. Descriptor allocation totals are not residency.'};
let browser;

function instrument() {
  const state = globalThis.__cost = {counts: {}, cpu: {}, raf: [], errors: [], deviceLosses: [],
    bufferBytes: 0, textureDescriptors: [], queueLatencies: [], measuring: false};
  const originalRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => originalRAF.call(globalThis, time => {
    const start = performance.now();
    callback(time);
    if (state.measuring) {
      state.raf.push({frame: globalThis.__webEngineFrames, time, cpu: performance.now() - start});
      if (state.device && !state.pendingQueue) {
        state.pendingQueue = true;
        const submitted = performance.now();
        state.device.queue.onSubmittedWorkDone().then(() => {
          state.queueLatencies.push(performance.now() - submitted);
          state.pendingQueue = false;
        });
      }
    }
  });
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await requestDevice.apply(this, args);
    state.adapter = {...this.info};
    state.device = device;
    globalThis.__costIdle = () => device.queue.onSubmittedWorkDone();
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => {
      if (info.reason !== 'destroyed') state.deviceLosses.push({reason: info.reason, message: info.message});
    });
    return device;
  };
  for (const [prototype, names] of [
    [GPUDevice.prototype, ['createBuffer', 'createTexture', 'createBindGroup', 'createRenderPipeline',
      'createBindGroupLayout', 'createCommandEncoder']],
    [GPUTexture.prototype, ['createView', 'destroy']],
    [GPUBuffer.prototype, ['destroy']],
    [GPUQueue.prototype, ['submit', 'writeBuffer', 'writeTexture']],
    [GPURenderPassEncoder.prototype, ['draw', 'drawIndexed', 'setBindGroup']],
    [GPUCommandEncoder.prototype, ['beginRenderPass', 'beginComputePass']]
  ]) for (const name of names) {
    const original = prototype[name];
    const key = `${prototype.constructor.name}.${name}`;
    prototype[name] = function(...args) {
      const start = performance.now();
      const result = original.apply(this, args);
      if (state.measuring) {
        state.counts[key] = (state.counts[key] || 0) + 1;
        state.cpu[key] = (state.cpu[key] || 0) + performance.now() - start;
      }
      if (key === 'GPUDevice.createBuffer') state.bufferBytes += args[0].size;
      if (key === 'GPUDevice.createTexture') {
        const descriptor = args[0];
        state.textureDescriptors.push({format: descriptor.format, size: descriptor.size,
          mips: descriptor.mipLevelCount || 1, usage: descriptor.usage});
      }
      return result;
    };
  }
}
async function memory() {
  const time = new Date().toISOString();
  const result = await execute('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory',
    '--format=csv,noheader,nounits'], {windowsHide: true});
  const wddmCommand = '$taskGpu=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "--type=gpu-process" }; ' +
    'Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | ForEach-Object { ' +
    '$taskMatch=[regex]::Match($_.Name,"^pid_(\\d+)_"); $taskId=[int]$taskMatch.Groups[1].Value; ' +
    'if($taskGpu.ProcessId -contains $taskId){[pscustomobject]@{pid=$taskId;name=$_.Name;' +
    'dedicated=$_.DedicatedUsage;shared=$_.SharedUsage;committed=$_.TotalCommitted}}} | ConvertTo-Json -Compress';
  const wddm = await execute('powershell.exe', ['-NoProfile', '-Command', wddmCommand],
    {windowsHide: true, maxBuffer: 1024 * 1024});
  return {time, nvidia: result.stdout.trim(), wddmGpuProcesses: wddm.stdout.trim() ? JSON.parse(wddm.stdout) : []};
}
function summarizeProfile(profile) {
  const weights = new Map();
  for (let index = 0; index < profile.samples.length; ++index) {
    const id = profile.samples[index];
    weights.set(id, (weights.get(id) || 0) + profile.timeDeltas[index]);
  }
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  return [...weights].map(([id, microseconds]) => ({...nodes.get(id).callFrame,
    selfMs: microseconds / 1000})).sort((a, b) => b.selfMs - a.selfMs).slice(0, 40);
}
(async () => {
  try {
    const packageFile = path.join(directory, `web-project-${id}-package-results.json`);
    const packaged = read(packageFile);
    assert(packaged.pass);
    for (const product of packaged.products) assert.equal(audit(product.file).sha256, product.sha256);
    report.package = audit(packageFile);
    report.before = await memory();
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const context = await browser.newContext({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.addInitScript(instrument);
    await page.goto(`http://127.0.0.1:8765/build/${id}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 20,
      null, {timeout: 240000});
    assert(await page.evaluate(() => !globalThis.__webEngineFailure && Module._WebProjectViewTest(-175, -80, 160, -5, 50)));
    const client = await context.newCDPSession(page);
    await client.send('Profiler.enable');
    await client.send('Profiler.setSamplingInterval', {interval: 1000});
    for (const [label, width, height, mode] of [
      ['baseline-720p', 1280, 720, 0], ['half-360p', 640, 360, 0],
      ['restored-720p', 1280, 720, 0], ['shadows-off', 1280, 720, 5],
      ['local-lights-off', 1280, 720, 2], ['sky-off', 1280, 720, 1],
      ['final-restored', 1280, 720, 0]
    ]) {
      await page.setViewportSize({width, height});
      assert(await page.evaluate(mode => Module._WebProjectLightingTestMode(mode), mode));
      await page.waitForFunction(frame => globalThis.__webEngineFrames >= frame + 8,
        await page.evaluate(() => globalThis.__webEngineFrames), {timeout: 60000});
      await page.evaluate(() => globalThis.__costIdle());
      const phase = {label, width, height, mode, before: await memory()};
      const profileCPU = label === 'baseline-720p';
      if (profileCPU) await client.send('Profiler.start');
      const sample = await page.evaluate(async () => {
        const state = globalThis.__cost;
        state.raf = []; state.counts = {}; state.cpu = {}; state.queueLatencies = [];
        const bufferBefore = state.bufferBytes;
        const texturesBefore = state.textureDescriptors.length;
        const frameBefore = globalThis.__webEngineFrames;
        state.measuring = true;
        const start = performance.now();
        await new Promise(resolve => setTimeout(resolve, 6000));
        state.measuring = false;
        const elapsedMs = performance.now() - start;
        await globalThis.__costIdle();
        const canvas = document.querySelector('canvas');
        return {elapsedMs, frames: globalThis.__webEngineFrames - frameBefore, raf: state.raf,
          counts: state.counts, cpu: state.cpu, queueLatencies: state.queueLatencies,
          bufferBytesCreated: state.bufferBytes - bufferBefore,
          texturesCreated: state.textureDescriptors.length - texturesBefore,
          totalBufferBytesCreated: state.bufferBytes, totalTexturesCreated: state.textureDescriptors.length,
          canvas: {width: canvas.width, height: canvas.height}, errors: state.errors,
          deviceLosses: state.deviceLosses, failure: globalThis.__webEngineFailure || null};
      });
      if (profileCPU) {
        const {profile} = await client.send('Profiler.stop');
        const file = path.join(directory, `${id}-${suffix}.cpuprofile`);
        fs.writeFileSync(file, JSON.stringify(profile));
        phase.cpuProfile = audit(file);
        phase.topSelfCPU = summarizeProfile(profile);
      }
      phase.sample = sample;
      phase.fps = sample.frames / sample.elapsedMs * 1000;
      phase.averageCallbackMs = sample.raf.reduce((sum, frame) => sum + frame.cpu, 0) / sample.raf.length;
      phase.callsPerFrame = Object.fromEntries(Object.entries(sample.counts).map(([key, count]) =>
        [key, count / sample.frames]));
      phase.after = await memory();
      const file = path.join(directory, `${id}-${suffix}-${label}.png`);
      await page.screenshot({path: file});
      phase.screenshot = audit(file);
      report.phases.push(phase);
      assert(sample.frames > 0 && !sample.failure && !sample.errors.length && !sample.deviceLosses.length);
      console.log(JSON.stringify({label, fps: phase.fps, callbackMs: phase.averageCallbackMs,
        buffersPerFrame: phase.callsPerFrame['GPUDevice.createBuffer'], nvidia: phase.after.nvidia}));
    }
    assert(!errors.length, errors.join('\n'));
    report.textureDescriptors = await page.evaluate(() => globalThis.__cost.textureDescriptors);
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    await browser?.close();
    report.after = await memory().catch(error => ({error: error.message}));
    const file = path.join(directory, `${id}-${suffix}-profile-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
  }
})();
