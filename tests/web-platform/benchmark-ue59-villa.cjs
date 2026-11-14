'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const sharp = require('sharp');

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag');
assert(tag && /^[a-z0-9-]+$/.test(tag), 'Provide a fresh --tag');
const url = new URL(option('url') || 'http://127.0.0.1:8900/index.html');
assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'This benchmark is for a local stage');
const tiers = (option('tiers') || 'forward,deferred,desktop').split(',');
assert(tiers.every(tier => ['forward', 'deferred', 'desktop'].includes(tier)));
const seconds = Number(option('seconds') || 30);
const warmup = Number(option('warmup') || 30);
const runs = Number(option('runs') || 2);
assert(seconds >= 10 && seconds <= 120 && warmup >= 10 && warmup <= 180);
assert(Number.isInteger(runs) && runs >= 1 && runs <= 4);
const browser = option('browser') || 'chrome';
assert(['chrome', 'edge'].includes(browser));
const interaction = process.argv.includes('--interaction');
const normalPage = process.argv.includes('--normal-page');
const captureTextures = process.argv.includes('--capture-textures');
const screenPercentage = option('screen-percentage') === undefined ? null : Number(option('screen-percentage'));
assert(screenPercentage === null || (screenPercentage >= 25 && screenPercentage <= 100));
const dpcvars = ['t.MaxFPS=0', 'r.VSync=0'];
if (screenPercentage !== null) dpcvars.push(`r.ScreenPercentage=${screenPercentage}`);
const executablePath = browser === 'edge'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const output = path.join(__dirname, 'results', 'ue59-official-villa', tag);
const profiles = path.join(__dirname, 'build', 'ue59-benchmark-profiles', tag);
assert(!fs.existsSync(output) && !fs.existsSync(profiles), 'Use a fresh tag');
fs.mkdirSync(output, { recursive: true });

function install({ captureTextures }) {
  const state = window.__ue59Benchmark = {
    active: false, times: [], submitted: 0, checkpoints: [], readyMs: null, firstCanvasMs: null,
    firstEngineTickMs: null,
    errors: [], dimensions: null, instrumentation: 'canvas-texture acquisition followed by queue.submit',
  };
  let pendingCanvas = false;
  if (captureTextures) {
    const textures = [];
    const createTexture = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (...args) {
      const texture = createTexture.apply(this, args);
      textures.push(texture);
      return texture;
    };
    state.textureSnapshot = () => [...new Set(textures.map(texture => JSON.stringify({
      label: texture.label, width: texture.width, height: texture.height,
      layers: texture.depthOrArrayLayers, format: texture.format,
    })))].map(text => JSON.parse(text));
  }
  window.addEventListener('ue-first-frame', () => { state.firstEngineTickMs ??= performance.now(); });
  const getTexture = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function (...args) {
    const texture = getTexture.apply(this, args);
    if (this.canvas === document.getElementById('canvas')) {
      pendingCanvas = true;
      state.dimensions = { width: texture.width, height: texture.height };
    }
    return texture;
  };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (...args) {
    const result = submit.apply(this, args);
    if (pendingCanvas) {
      pendingCanvas = false;
      const now = performance.now();
      state.submitted++;
      state.firstCanvasMs ??= now;
      if (state.active) state.times.push(now);
    }
    return result;
  };
  // The official present log precedes PresentOffscreen; interval deltas must still match exactly.
  const log = console.log;
  console.log = function (...args) {
    const text = typeof args[0] === 'string' ? args[0] : '';
    const present = /present frame (\d+) \((\d+)x(\d+)\)/.exec(text);
    if (present) state.checkpoints.push({ frame: Number(present[1]), submitted: state.submitted });
    if (text.includes('UE_RUN READY')) state.readyMs ??= performance.now();
    return log.apply(this, args);
  };
}

function distribution(times, durationMs) {
  assert(times.length > 2, 'No usable canvas submissions');
  const intervals = times.slice(1).map((time, index) => time - times[index]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const slowest = sorted.slice(-Math.max(1, Math.ceil(sorted.length / 100)));
  const percentile = p => sorted[Math.floor((sorted.length - 1) * p)];
  return {
    frames: times.length, seconds: durationMs / 1000, fps: times.length * 1000 / durationMs,
    intervalFps: intervals.length * 1000 / (times.at(-1) - times[0]),
    low1Fps: 1000 / (slowest.reduce((sum, value) => sum + value, 0) / slowest.length),
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    maxMs: sorted.at(-1), intervalsOver33Ms: intervals.filter(value => value > 1000 / 30).length,
    intervalsOver100Ms: intervals.filter(value => value > 100).length,
  };
}

async function browserMemory(context) {
  const cdp = await context.browser().newBrowserCDPSession();
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map(process => Number(process.id)).filter(id => Number.isSafeInteger(id) && id > 0);
    assert(ids.length, 'No browser process IDs');
    const command = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ` +
      'Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress';
    const { stdout } = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000 });
    const rows = [].concat(JSON.parse(stdout));
    return {
      note: 'Working-set sums can count shared pages more than once; private bytes are committed private memory, not resident memory.',
      processes: rows.map(row => ({ pid: row.Id, type: processInfo.find(process => Number(process.id) === row.Id)?.type,
        workingSetBytes: row.WorkingSet64, privateBytes: row.PrivateMemorySize64 })),
      workingSetSumBytes: rows.reduce((sum, row) => sum + row.WorkingSet64, 0),
      privateBytesSum: rows.reduce((sum, row) => sum + row.PrivateMemorySize64, 0),
      allProcessesSampled: rows.length === ids.length,
    };
  } finally {
    await cdp.detach();
  }
}

async function cameraPosition(page) {
  const before = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getDirectoryHandle('logs')).getFileHandle(window.ueLogFile.toLowerCase());
    return ((await (await file.getFile()).text()).match(/LogCheatManager: BugItGo /g) || []).length;
  });
  await page.evaluate(() => { window.ueExec('LogLoc'); window.ueExec('FlushLog'); });
  for (let attempt = 0; attempt < 40; attempt++) {
    const position = await page.evaluate(async count => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getDirectoryHandle('logs')).getFileHandle(window.ueLogFile.toLowerCase());
      const text = await (await file.getFile()).text();
      const matches = [...text.matchAll(/LogCheatManager: BugItGo ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/g)];
      return matches.length > count ? matches.at(-1).slice(1).map(Number) : null;
    }, before);
    if (Array.isArray(position) && position.length === 6) {
      const [x, y, z, pitch, yaw, roll] = position;
      return { x, y, z, pitch, yaw, roll };
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Official LogLoc did not produce a fresh camera position');
}

const report = {
  date: new Date().toISOString(), url: url.href, browser, executablePath, viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1, seconds, warmup, runsPerTier: runs, interaction, normalPage, results: [], pass: false,
  captureTextures, performanceEligible: !captureTextures,
  metric: 'CPU submissions of the official final canvas copy, checked against RHI present counters. Not physical display FPS or GPU completion latency.',
  cache: 'Fresh browser profile per tier, reused for later runs. OS file and GPU driver caches are not cleared.',
  bootMode: normalPage ? 'Normal official page with GPU benchmark, automatic quality selection, and a start click.'
    : 'Official harness=1 skips the page GPU benchmark and automatic quality preset. Project and renderer defaults apply.',
  qualityOverrides: screenPercentage === null ? [] : [{ 'r.ScreenPercentage': screenPercentage }],
  timingOverrides: { 't.MaxFPS': 0, 'r.VSync': 0 },
};

async function main() {
  for (const tier of tiers) {
    for (let run = 0; run < runs; run++) {
      const prefix = `${tier}-${run + 1}`;
      const result = { tierAsked: tier, run: run + 1, cache: run ? 'warm-browser-profile' : 'cold-browser-profile', pass: false };
      report.results.push(result);
      const lines = [], errors = [];
      let context, page;
      let rejectBoot;
      const bootFailure = new Promise((resolve, reject) => { rejectBoot = reject; });
      bootFailure.catch(() => {});
      const recordError = message => {
        errors.push(message);
        rejectBoot(new Error(message));
      };
      try {
        context = await chromium.launchPersistentContext(path.join(profiles, tier), {
          executablePath, headless: false, viewport: report.viewport, deviceScaleFactor: 1,
          args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows', '--window-position=-32000,-32000',
            '--autoplay-policy=no-user-gesture-required'],
        });
        result.browserVersion = context.browser()?.version() || null;
        await context.addInitScript(install, { captureTextures });
        page = context.pages()[0] || await context.newPage();
        page.on('pageerror', error => recordError(error.message));
        page.on('crash', () => recordError('Browser page crashed'));
        page.on('console', message => {
          const text = message.text();
          lines.push({ at: Date.now(), type: message.type(), text });
          if (/WEBGPU (?:PIPELINE )?ERROR|GPUValidationError|UE_RUN ERROR|device (?:was )?lost|HARNESS ABORT/i.test(text)) recordError(text);
        });
        const target = new URL(url);
        target.searchParams.set('tier', tier);
        if (!normalPage) target.searchParams.set('harness', '1');
        target.searchParams.set('args', `-dpcvars=${dpcvars.join(',')}`);
        const navigationStart = Date.now();
        await Promise.race([page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 120000 }), bootFailure]);
        await Promise.race([page.waitForFunction(() => window.__ue59Benchmark?.readyMs !== null &&
          window.__ue59Benchmark?.submitted > 5, null, { timeout: 600000 }), bootFailure]);
        result.readyObservedSeconds = (Date.now() - navigationStart) / 1000;
        if (normalPage) {
          await Promise.race([page.locator('#cover.click').waitFor({ state: 'visible', timeout: 120000 }), bootFailure]);
          await page.locator('#cover.click').click({ position: { x: 960, y: 540 } });
          await page.locator('#cover').waitFor({ state: 'hidden', timeout: 30000 });
          result.normalPageClickPassed = true;
        }
        await page.waitForTimeout(warmup * 1000);
        await page.evaluate(() => {
          const state = window.__ue59Benchmark;
          state.times = [];
          state.measureStartMs = performance.now();
          state.active = true;
        });
        await page.waitForTimeout(seconds * 1000);
        const measured = await page.evaluate(() => {
          const state = window.__ue59Benchmark;
          state.active = false;
          state.measureEndMs = performance.now();
          return {
            ...state, visibility: document.visibilityState,
            textureSnapshot: undefined,
            textures: state.textureSnapshot?.() ?? null,
            pageTimeOrigin: performance.timeOrigin,
            officialBootTimings: window.__harness?.timings ?? null,
            engineArguments: window.Module?.arguments ?? null,
            memory: {
              wasmAllocatedBytes: window.__harness?.memory?.buffer?.byteLength ?? null,
              mainThreadJsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
            },
          };
        });
        Object.assign(result, {
          readySeconds: measured.readyMs / 1000,
          firstCanvasSeconds: measured.firstCanvasMs / 1000,
          firstEngineTickSeconds: measured.firstEngineTickMs / 1000,
          textureSizes: measured.textures?.filter(texture => /SceneColor|SceneDepth|GBuffer|TemporalAA|Tonemap/i.test(texture.label)) ?? null,
          dimensions: measured.dimensions, visibility: measured.visibility, memory: measured.memory,
          officialBootTimings: measured.officialBootTimings, engineArguments: measured.engineArguments,
          pageConfiguration: lines.filter(line => /^WEB_COMPAT |^UE_RUN CONFIG /.test(line.text)).map(line => line.text),
          readyEpochMs: measured.pageTimeOrigin + measured.readyMs,
          timing: distribution(measured.times, measured.measureEndMs - measured.measureStartMs),
        });
        try { result.browserMemory = await browserMemory(context); }
        catch (error) { result.browserMemory = { error: error.message }; }
        const tierLine = lines.map(line => line.text).find(text => text.includes('WebGPU tier:'));
        result.tierLine = tierLine || null;
        result.tierRan = /WebGPU tier:\s+(\w+)/.exec(tierLine || '')?.[1] || null;
        const checkpoints = measured.checkpoints.filter(point => point.frame >= 120);
        result.counterChecks = checkpoints.slice(1).map((point, index) => ({
          engine: point.frame - checkpoints[index].frame,
          measured: point.submitted - checkpoints[index].submitted,
        }));
        result.counterAgreement = result.counterChecks.length > 0 &&
          result.counterChecks.every(check => check.engine === check.measured);
        fs.writeFileSync(path.join(output, `${prefix}-samples.json`), JSON.stringify(measured, null, 2));
        const screenshot = path.join(output, `${prefix}.png`);
        await page.screenshot({ path: screenshot, timeout: 60000 });
        const imageStats = await sharp(screenshot).stats();
        result.image = {
          channelMeans: imageStats.channels.slice(0, 3).map(channel => channel.mean),
          channelStdevs: imageStats.channels.slice(0, 3).map(channel => channel.stdev),
          entropy: imageStats.entropy,
        };
        const diagnosticStart = lines.length;
        const queries = [
          't.MaxFPS', 'r.VSync', 'r.ScreenPercentage', 'sg.ResolutionQuality',
          'r.ScreenPercentage.Default', 'r.ScreenPercentage.Default.Desktop.Mode',
          'r.ScreenPercentage.Auto.PixelCountMultiplier', 'r.Mobile.AntiAliasing',
          'r.DynamicRes.OperationMode', 'r.AntiAliasingMethod',
          'r.DynamicGlobalIlluminationMethod', 'r.Lumen.DiffuseIndirect.Allow',
          'r.ReflectionMethod', 'r.Lumen.Reflections.Allow', 'r.Shadow.Virtual.Enable',
          'r.Streaming.PoolSize', 'r.Streaming.UseFixedPoolSize',
          'sg.GlobalIlluminationQuality', 'sg.ReflectionQuality', 'sg.ShadowQuality',
          'getall World URL', 'getall GameModeBase DefaultPawnClass', 'getall PlayerController Pawn',
        ];
        await page.evaluate(commands => {
          if (typeof window.ueExec !== 'function') throw new Error('Official console bridge is unavailable');
          for (const command of commands) window.ueExec(command);
        }, queries);
        await page.waitForTimeout(3000);
        result.diagnostics = lines.slice(diagnosticStart).map(line => line.text);
        if (interaction && run === runs - 1) {
          await page.locator('#canvas').click({ position: { x: 960, y: 540 } });
          const beforeMove = await cameraPosition(page);
          const beforeMoveImage = path.join(output, `${prefix}-before-move.png`);
          await page.screenshot({ path: beforeMoveImage, timeout: 60000 });
          await page.keyboard.down('s');
          await page.waitForTimeout(1000);
          const afterMove = await cameraPosition(page);
          await page.keyboard.up('s');
          await page.keyboard.down('d');
          await page.waitForTimeout(1000);
          await page.keyboard.up('d');
          await page.waitForTimeout(1000);
          const moved = path.join(output, `${prefix}-moved.png`);
          await page.screenshot({ path: moved, timeout: 60000 });
          const before = await sharp(beforeMoveImage).resize(160, 90).removeAlpha().raw().toBuffer();
          const after = await sharp(moved).resize(160, 90).removeAlpha().raw().toBuffer();
          const difference = before.reduce((sum, value, index) => sum + Math.abs(value - after[index]), 0) / before.length;
          await page.mouse.move(1060, 570, { steps: 10 });
          await page.waitForTimeout(1000);
          const afterTurn = await cameraPosition(page);
          const turned = path.join(output, `${prefix}-turned.png`);
          await page.screenshot({ path: turned, timeout: 60000 });
          const turnedPixels = await sharp(turned).resize(160, 90).removeAlpha().raw().toBuffer();
          const turnDifference = after.reduce((sum, value, index) => sum + Math.abs(value - turnedPixels[index]), 0) / after.length;
          result.interaction = {
            afterPerformanceMeasurement: true, keys: ['s:1000ms', 'd:1000ms'], mouseDelta: [100, 30],
            movementImageDifference: difference, turnImageDifference: turnDifference,
            pointerLock: await page.evaluate(() => document.pointerLockElement?.id ?? null),
            beforeMove, afterMove, afterTurn,
            distanceCm: Math.hypot(afterMove.x - beforeMove.x, afterMove.y - beforeMove.y, afterMove.z - beforeMove.z),
            turnDegrees: Math.abs(((afterTurn.yaw - afterMove.yaw + 540) % 360) - 180),
            note: 'Official LogLoc/FlushLog captures pawn position and view rotation outside the performance measurement.',
          };
          assert(difference > 2, 'Movement did not visibly change the scene');
          assert(turnDifference > 2, 'Mouse input did not visibly change the scene');
          assert(result.interaction.distanceCm > 5, 'The actual player pawn did not move');
          assert(result.interaction.turnDegrees > 1, 'The actual player view did not turn');
        }
        assert.equal(result.tierRan, tier, 'The requested renderer did not run');
        assert.deepEqual(result.dimensions, report.viewport, 'Unexpected canvas resolution');
        assert.equal(result.visibility, 'visible', 'Background page measurements are invalid');
        assert(result.counterAgreement, 'Canvas submissions do not match official present counters');
        assert(result.image.channelStdevs.some(value => value > 2), 'Blank screenshot');
        assert.equal(errors.length, 0, 'Browser or WebGPU errors');
        result.pass = true;
      } catch (error) {
        result.failure = error.stack || String(error);
        if (page && !page.isClosed()) {
          try {
            result.failureState = await page.evaluate(() => ({
              benchmark: window.__ue59Benchmark ?? null,
              title: document.title, visibility: document.visibilityState,
              text: document.body?.innerText?.slice(0, 4000),
            }));
            await page.screenshot({ path: path.join(output, `${prefix}-failure.png`), timeout: 15000 });
          } catch (captureError) {
            result.failureCaptureError = captureError.message;
          }
        }
      } finally {
        result.errors = errors;
        fs.writeFileSync(path.join(output, `${prefix}-console.json`), JSON.stringify(lines, null, 2));
        await context?.close();
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ tier, run: run + 1, pass: result.pass, readySeconds: result.readySeconds,
          timing: result.timing, failure: result.failure }));
      }
      if (!result.pass) break;
    }
  }
  report.pass = report.results.length === tiers.length * runs && report.results.every(result => result.pass);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
