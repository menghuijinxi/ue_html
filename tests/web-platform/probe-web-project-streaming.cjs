const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {chromium} = require('playwright');
const execute = promisify(execFile);
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = option('project') || 'triplex-house-villa';
const name = option('browser') || 'Chrome';
const suffix = option('report') || 'streaming';
const measureMemory = process.argv.includes('--memory');
const cycles = Number(option('cycles') || 2);
assert(Number.isInteger(cycles) && cycles >= 2 && cycles <= 20);
assert(/^[a-z0-9-]+$/.test(id) && /^[a-z0-9-]+$/.test(suffix));
assert(['Chrome', 'Edge'].includes(name));
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, project: id, browser: name,
  cycles, phases: [], errors: [], engineErrors: [], source: audit(__filename),
  boundary: 'GPU mip residency streaming from the preloaded MEMFS content pack. ' +
    'RHI byte counts are format/block allocation estimates, not driver VRAM measurements. ' +
    'This does not implement HTTP range requests or bound CPU content-pack memory.'};
let browser, page;

async function memory() {
  const command = '$taskGpu=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "--type=gpu-process" }; ' +
    '$taskRows=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | ForEach-Object { ' +
    '$taskMatch=[regex]::Match($_.Name,"^pid_(\\d+)_"); $taskId=[int]$taskMatch.Groups[1].Value; ' +
    'if($taskGpu.ProcessId -contains $taskId){[pscustomobject]@{pid=$taskId;name=$_.Name;' +
    'dedicated=$_.DedicatedUsage;shared=$_.SharedUsage;committed=$_.TotalCommitted}}}); ' +
    'ConvertTo-Json -InputObject $taskRows -Compress';
  const result = await execute('powershell.exe', ['-NoProfile', '-Command', command],
    {windowsHide: true, maxBuffer: 1024 * 1024});
  return JSON.parse(result.stdout);
}

function instrument() {
  const state = globalThis.__streamProbe = {errors: [], deviceLosses: [], writes: 0, copies: 0,
    textures: {}, reallocations: 0};
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => {
      if (info.reason !== 'destroyed') state.deviceLosses.push({reason: info.reason, message: info.message});
    });
    globalThis.__streamIdle = () => device.queue.onSubmittedWorkDone();
    return device;
  };
  const create = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    const label = descriptor.label || '';
    const size = descriptor.size;
    const shape = `${size.width || size[0]}x${size.height || size[1]}:${descriptor.mipLevelCount || 1}`;
    if (label && !/Scene|Shadow|Volumetric|Bloom|Tonemap|Depth|SSAO|Screen|Velocity|BackBuffer|Slate/.test(label)) {
      const previous = state.textures[label] || [];
      if (previous.length && !previous.includes(shape)) ++state.reallocations;
      if (!previous.includes(shape)) previous.push(shape);
      state.textures[label] = previous;
    }
    return create.call(this, descriptor);
  };
  const write = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function(...args) {
    ++state.writes;
    return write.apply(this, args);
  };
  const copy = GPUCommandEncoder.prototype.copyTextureToTexture;
  GPUCommandEncoder.prototype.copyTextureToTexture = function(...args) {
    ++state.copies;
    return copy.apply(this, args);
  };
}

async function sample(label) {
  const value = await page.evaluate(() => ({
    frame: globalThis.__webEngineFrames || 0, failure: globalThis.__webEngineFailure,
    streaming: globalThis.__webTextureStreaming, gpu: globalThis.__streamProbe,
    runtime: globalThis.__webEngineRuntime
  }));
  assert(!value.failure && !value.gpu.errors.length && !value.gpu.deviceLosses.length &&
    !report.errors.length && !report.engineErrors.length,
  value.failure || value.gpu.errors[0] || report.errors[0] || report.engineErrors[0] || 'Device lost');
  return {label, ...value};
}

async function settle(label, poolMiB, view) {
  if (poolMiB) assert(await page.evaluate(value => Module._WebTextureStreamingTestBudget(value), poolMiB));
  if (view) assert(await page.evaluate(value => Module._WebProjectViewTest(...value), view));
  let previous, stable = 0;
  for (let index = 0; index < 36; ++index) {
    const start = await page.evaluate(() => globalThis.__webEngineFrames || 0);
    await page.waitForFunction(frame => globalThis.__webEngineFailure ||
      globalThis.__streamProbe.errors.length || globalThis.__webEngineFrames >= frame,
    start + 30, {timeout: 90000});
    const value = await sample(label);
    assert(value.streaming?.supported && value.streaming.streamable > 100, 'Streamable cooked textures missing');
    const state = value.streaming;
    if ((!poolMiB || state.poolBytes === poolMiB * 1024 * 1024) && !state.pending &&
        state.residentBytes === previous?.streaming.residentBytes &&
        state.requestedMips === state.residentMips) ++stable;
    else stable = 0;
    previous = value;
    if (index % 10 === 0) console.log(JSON.stringify({label, ...state}));
    if (stable >= 3) break;
  }
  assert(stable >= 3, `Streaming did not settle in ${label}: ${JSON.stringify(previous.streaming)}`);
  await page.evaluate(() => globalThis.__streamIdle());
  if (measureMemory) {
    const existing = new Set(report.beforeGpuProcesses.map(row => row.pid));
    previous.gpuProcesses = (await memory()).filter(row => !existing.has(row.pid));
  }
  report.phases.push(previous);
  console.log(JSON.stringify({browser: name, ...previous.streaming, label}));
  return previous;
}

(async () => {
  try {
    const file = path.join(directory, `web-project-${id}-package-results.json`);
    const packaged = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    assert(packaged.pass && packaged.products.every(item => audit(item.file).sha256 === item.sha256));
    report.packageReport = audit(file);
    if (measureMemory) report.beforeGpuProcesses = await memory();
    browser = await chromium.launch({headless: true, executablePath: name === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    report.version = browser.version();
    page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    const log = report.log = [];
    page.on('console', message => {
      const text = message.text();
      if (log.length >= 80) log.shift();
      log.push(text);
      if (/GPU validation:|Ensure condition failed|Assertion failed|Fatal error:|Texture stream in request failed/.test(text))
        report.engineErrors.push(text);
    });
    await page.addInitScript(instrument);
    await page.goto(`http://127.0.0.1:8765/build/${id}/index.html`, {waitUntil: 'commit'});
    const view = [-175, -80, 160, -5, 50];
    const initial = await settle('initial-256', null, null);
    const high = await settle('room-256', 256, view);
    const low = await settle('room-64', 64);
    assert(low.streaming.residentBytes < high.streaming.residentBytes * 0.8, 'Budget reduction did not evict mips');
    assert(low.streaming.poolAllocatedBytes < high.streaming.poolAllocatedBytes, 'Evicted textures remain allocated');
    const restored = await settle('restored-256', 256);
    assert(restored.streaming.residentBytes > low.streaming.residentBytes * 1.25, 'Missing mip IO after budget recovery');
    assert(restored.gpu.writes > low.gpu.writes && restored.gpu.copies > low.gpu.copies,
      'Recovery must copy shared mips and upload streamed bulk data');
    const secondLow = await settle('second-64', 64);
    assert(secondLow.streaming.residentBytes <= low.streaming.residentBytes * 1.1, 'Repeated eviction grows residency');
    const final = await settle('second-restored-256', 256);
    assert(final.streaming.poolAllocatedBytes <= restored.streaming.poolAllocatedBytes * 1.1,
      'Reallocation cycles leak texture memory');
    assert(final.gpu.reallocations > initial.gpu.reallocations);
    for (let cycle = 3; cycle <= cycles; ++cycle) {
      const evicted = await settle(`cycle-${cycle}-64`, 64);
      assert(evicted.streaming.residentBytes <= low.streaming.residentBytes * 1.1);
      const reloaded = await settle(`cycle-${cycle}-256`, 256);
      assert(reloaded.streaming.residentBytes > evicted.streaming.residentBytes * 1.25);
      assert(reloaded.streaming.poolAllocatedBytes <= restored.streaming.poolAllocatedBytes * 1.1,
        `Cycle ${cycle} grows allocated texture memory`);
    }
    for (const view of [[410, -200, 450, -15, 180], [-175, -80, 160, -5, 230], [-175, -80, 160, -5, 50]])
      await settle('tour', null, view);
    const screenshot = path.join(directory, `web-project-${id}-${suffix}-${name.toLowerCase()}.png`);
    await page.locator('canvas').screenshot({path: screenshot});
    report.screenshot = audit(screenshot);
    report.pass = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) {
      report.diagnostics = await page.evaluate(() => ({
        streaming: globalThis.__webTextureStreaming, frames: globalThis.__webEngineFrames,
        gpu: globalThis.__streamProbe,
        startup: typeof startupSnapshot === 'function' ? startupSnapshot() : null
      })).catch(() => null);
    }
  } finally {
    if (browser) await browser.close();
    const file = path.join(directory, `web-project-${id}-${suffix}-${name.toLowerCase()}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    if (!report.pass) process.exitCode = 1;
  }
})();
