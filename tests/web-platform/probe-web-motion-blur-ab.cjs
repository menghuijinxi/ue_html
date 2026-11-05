'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');
const {performanceModes} = require('./web-performance-modes.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag') || '20261104';
const packageTag = option('package-tag') || tag;
assert(/^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(packageTag));
const packageFile = path.join(__dirname, 'results', `motion-blur-ab-${packageTag}-package.json`);
const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
assert(packaged.pass);
const renderMatrix = packaged.renderMatrix === true;
const optimizationsOff = process.argv.includes('--optimizations-off');
const {modes: launchModes, query} = performanceModes({optimizationsOff,
  occlusion: option('occlusion'), clock: option('clock'), rhiwake: option('rhiwake')});
assert(!query || renderMatrix, 'Performance switches require an explicit render configuration');
const selectedCase = option('case');
const cases = [...(renderMatrix ? [] : [{name: 'baseline', folder: packaged.baseline, settings: {}}]),
  ...packaged.cases].filter(entry => !selectedCase || entry.name === selectedCase);
assert(cases.length > 0 && (!selectedCase || cases.length === 1), 'Choose an existing case');
const profileRoot = path.resolve(option('profile-root') || path.join(__dirname, 'build/browser-profiles'));
const output = path.join(__dirname, 'results', `motion-blur-ab-${tag}-runtime`);
assert(!fs.existsSync(output + '.json'), 'Preserve previous measurements; use a new tag');
const report = {date: new Date().toISOString(), pass: false, package: audit(packageFile),
  profileRoot, packageTag, selectedCase, optimizationsOff, launchModes, query,
  modesSource: audit(path.join(__dirname, 'web-performance-modes.cjs')),
  source: audit(__filename), runs: [], boundary: 'Functional verification of the packaged configurations, not a subjective shaking or mouse-latency verdict. Diagnostic GPU wrappers add overhead. FPS measures RHI submission intervals, not physical presentation.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
let context;
function observe() {
  const state = globalThis.__motionAB = {presents: [], resources: {}, bindings: {}, errors: [], losses: []};
  let frame = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, enumerable: true,
    get: () => frame, set(next) {
      frame = next;
      state.presents.push({time: performance.now(), frame: next});
      if (state.presents.length > 4096) state.presents.shift();
    }});
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await request.apply(this, args);
    state.adapter = {...this.info};
    device.addEventListener('uncapturederror', e => state.errors.push(e.error.message));
    device.lost.then(info => {if (info.reason !== 'destroyed') state.losses.push(info.message);});
    return device;
  };
  const relevant = label => /^(TSR\.|MotionBlur\.|Lumen\.(ScreenProbeGather|Reflections))/.test(label || '');
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(desc) {
    if (relevant(desc.label)) state.resources[desc.label] = (state.resources[desc.label] || 0) + 1;
    return createTexture.call(this, desc);
  };
  const views = new WeakMap();
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(...args) {
    const result = createView.apply(this, args);
    if (relevant(this.label)) views.set(result, this.label);
    return result;
  };
  const groups = new WeakMap();
  const createGroup = GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup = function(desc) {
    const result = createGroup.call(this, desc);
    const outputs = desc.entries.map(entry => views.get(entry.resource)).filter(Boolean);
    if (outputs.length) groups.set(result, outputs);
    return result;
  };
  // Track use of pooled outputs as well as their initial allocation.
  const setGroup = GPUComputePassEncoder.prototype.setBindGroup;
  GPUComputePassEncoder.prototype.setBindGroup = function(index, group, ...args) {
    for (const label of groups.get(group) || []) state.bindings[label] = (state.bindings[label] || 0) + 1;
    return setGroup.call(this, index, group, ...args);
  };
}
function pinBrowser(profile) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $taskBrowser = Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:UE_MOTION_AB_PROFILE) -and
        $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
    if (!$taskBrowser) {throw 'Diagnostic browser missing'}
    for ($taskAttempt = 0; $taskAttempt -lt 12; $taskAttempt++) {
      $taskChecks = @(Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object {
        $_.ProcessId -eq $taskBrowser.ProcessId -or
        ($_.ParentProcessId -eq $taskBrowser.ProcessId -and $_.CommandLine -match '--type=gpu-process')
      } | ForEach-Object {
        $taskProcess = Get-Process -Id $_.ProcessId -ErrorAction Stop
        $taskProcess.ProcessorAffinity = [IntPtr][long]4294901760
        [pscustomobject]@{pid=$taskProcess.Id;gpu=$_.CommandLine -match '--type=gpu-process';mask=$taskProcess.ProcessorAffinity.ToInt64()}
      })
      Start-Sleep -Milliseconds 200
    }
    if (!@($taskChecks | Where-Object gpu).Count) {throw 'Diagnostic GPU process missing'}
    if (@($taskChecks | Where-Object mask -ne 4294901760).Count) {throw 'Diagnostic affinity mismatch'}
    ConvertTo-Json -InputObject $taskChecks -Compress
  `;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    {encoding: 'utf8', windowsHide: true, env: {...process.env, UE_MOTION_AB_PROFILE: profile}}));
}
function summarize(presents) {
  const intervals = presents.slice(1).map((value, index) => value.time - presents[index].time);
  const sorted = intervals.toSorted((a, b) => a - b);
  return {frames: presents.length, elapsedMs: presents.at(-1).time - presents[0].time,
    fps: (presents.length - 1) * 1000 / (presents.at(-1).time - presents[0].time),
    minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1], maxMs: sorted.at(-1)};
}
(async () => {
  try {
    for (const entry of cases) {
      const run = {name: entry.name, folder: entry.folder, settings: entry.settings,
        url: `http://127.0.0.1:8765/build/${entry.folder}/index.html${query}`, errors: [], applied: {}};
      report.runs.push(run); save();
      const profile = path.join(profileRoot, `motion-ab-${tag}-${entry.name}`);
      context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
        viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
      run.affinity = pinBrowser(profile);
      await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: `(${observe.toString()})();\n` + await response.text()});
      });
      const page = context.pages()[0];
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
      const log = fs.createWriteStream(output + '-' + entry.name + '.log');
      page.on('close', () => log.end());
      page.on('pageerror', error => run.errors.push(error.message));
      page.on('crash', () => run.errors.push('Renderer crashed'));
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(text)) run.errors.push(text);
        for (const [name, value] of Object.entries(entry.settings))
          if (text.includes(`Set CVar [[${name}:${value}]]`)) run.applied[name] = value;
      });
      await page.goto(run.url, {waitUntil: 'commit'});
      const advance = async count => {
        const frame = await page.evaluate(() => globalThis.__webEngineFrames || 0);
        await page.waitForFunction(target => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= target,
          frame + count, {timeout: 180000});
        const failure = await page.evaluate(() => globalThis.__webEngineFailure);
        assert(!failure, typeof failure === 'string' ? failure : JSON.stringify(failure));
        assert.deepEqual(run.errors, []);
      };
      await advance(60);
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
      assert(owner);
      const before = await owner.evaluate(() => __motionAB.presents.length);
      if (renderMatrix) run.cameraBeforeInput = await owner.evaluate(() => __webDefaultCamera);
      await page.locator('canvas').focus();
      await page.mouse.move(700, 400);
      await page.mouse.down({button: 'right'});
      await page.mouse.move(850, 420, {steps: 24});
      await page.mouse.up({button: 'right'});
      await advance(60);
      assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', -1, 0)), 1);
      await advance(2);
      run.state = await owner.evaluate(() => ({settings: globalThis.__webProjectSettings,
        lighting: globalThis.__webDistanceFieldsLighting, view: globalThis.__webRenderView,
        camera: globalThis.__webDefaultCamera, frameLimit: globalThis.__webMotionABFrameLimit,
        gameClock: globalThis.__webGameFrameClock, rhiWake: globalThis.__webRHIWakeScheduler,
        history: globalThis.__webOcclusionHistory, arguments: Module.arguments,
        occlusionRHI: globalThis.__webOcclusionRHI, uploadStaging: globalThis.__webUploadStaging,
        occlusionWait: globalThis.__webOcclusionWait,
        cpuTraceSamples: globalThis.__webMotionBlurCPU?.length || 0, probe: __motionAB}));
      run.timing = summarize(run.state.probe.presents.slice(before));
      run.hud = await page.evaluate(() => __webLivePerformance);
      assert.deepEqual(run.state.probe.errors, []);
      assert.deepEqual(run.state.probe.losses, []);
      assert.deepEqual(run.applied, entry.settings);
      assert.equal(run.state.view.antiAliasing, renderMatrix ? entry.settings['r.AntiAliasingMethod'] : 4);
      const resources = run.state.probe.resources;
      const motionBlur = resources['MotionBlur.SceneColor'] || 0;
      const lumen = resources['Lumen.ScreenProbeGather.ScreenProbeSceneDepth'] || 0;
      if (renderMatrix) {
        const gi = entry.settings['r.DynamicGlobalIlluminationMethod'], aa = entry.settings['r.AntiAliasingMethod'];
        assert.equal(run.state.settings.gi, gi);
        assert.equal(run.state.settings.reflections, gi);
        assert.equal(run.state.lighting.giMethod, gi, 'Final camera GI must match the package');
        assert.equal(run.state.lighting.reflectionMethod, gi);
        assert.equal(run.state.settings.antiAliasing, aa);
        assert.equal(run.state.lighting.antiAliasing, aa);
        assert.equal(run.state.frameLimit, undefined);
        assert.equal(run.state.cpuTraceSamples, 0, 'CPU diagnostic must remain disabled');
        assert.equal(run.state.gameClock.mode, launchModes.clock);
        if (launchModes.clock === 'local') assert.equal(run.state.gameClock.paused, false);
        assert.equal(run.state.rhiWake.requested, launchModes.rhiwake);
        assert.equal(run.state.rhiWake.active,
          launchModes.rhiwake === 'priority' && run.state.rhiWake.prioritySupported ? 'priority' : 'channel');
        assert.equal(run.state.history.enabled, launchModes.occlusion === 'history');
        assert(run.state.arguments.includes('-WebOcclusionMode=' + launchModes.occlusion));
        assert.equal(run.state.arguments.includes('-WebGameLocalClock'), launchModes.clock === 'local');
        assert(run.state.arguments.includes('-WebRHIWake=' + launchModes.rhiwake));
        if (query) {
          assert(!run.state.arguments.some(value => value.startsWith('-WebFrameScheduler=')));
          assert.equal(run.state.occlusionRHI.bindingPlanEnabled, false);
          assert.equal(run.state.uploadStaging.enabled, false);
          assert.equal(run.state.occlusionWait.budgetMs, 0);
        }
        const blurEnabled = entry.settings['r.MotionBlurQuality'] !== 0;
        assert.equal(motionBlur > 0, blurEnabled, 'Motion blur output must match the requested mode');
        assert.equal((run.state.probe.bindings['MotionBlur.SceneColor'] || 0) > 0, blurEnabled,
          'Actual motion blur use must match the requested mode');
        assert.equal(lumen > 0, gi === 1, 'Actual Lumen resources must match the requested mode');
        const tsr = Object.entries(resources).filter(([label]) => label.startsWith('TSR.'))
          .reduce((total, [, count]) => total + count, 0);
        assert.equal(tsr > 0, aa === 4, 'Actual TSR resources must match the requested AA mode');
        run.input = await page.evaluate(() => __webInputBridge);
        assert.equal(run.input.mode, 'owner-forwarded');
        assert(run.input.acknowledged > 0, 'Mouse input must reach the game thread');
        assert(Math.abs(run.state.camera.yaw - run.cameraBeforeInput.yaw) > 0.1 ||
          Math.abs(run.state.camera.pitch - run.cameraBeforeInput.pitch) > 0.1,
          'Mouse movement must actually rotate the camera');
      } else if (entry.name === 'no-lumen-10fps') {
        assert.equal(run.state.settings.gi, 0);
        assert.equal(run.state.settings.reflections, 0);
        assert.equal(run.state.frameLimit.fps, 10);
        assert.equal(lumen, 0, 'Lumen screen probes must not be created');
        assert(motionBlur > 0, 'A must retain the original motion blur');
        assert(run.timing.fps >= 9 && run.timing.fps <= 10.6, 'A must really run near 10 FPS');
        assert(run.timing.medianMs >= 90 && run.timing.medianMs <= 115);
      } else {
        assert.equal(run.state.frameLimit, undefined, 'B and baseline must retain the original frame scheduler');
        assert.equal(run.state.settings.gi, 1);
        assert.equal(run.state.settings.reflections, 1);
        assert(lumen > 0, 'Lumen must remain active');
        if (entry.name === 'no-motion-blur') {
          assert.equal(motionBlur, 0, 'B must not create the motion blur output');
          assert.equal(run.state.probe.bindings['MotionBlur.SceneColor'] || 0, 0);
        } else {
          assert(motionBlur > 0, 'Baseline must exercise the motion blur filter');
          assert((run.state.probe.bindings['MotionBlur.SceneColor'] || 0) > 0);
        }
      }
      const image = output + '-' + entry.name + '.png';
      await page.locator('canvas').screenshot({path: image, timeout: 60000});
      const png = PNG.sync.read(fs.readFileSync(image));
      let lit = 0;
      for (let offset = 0; offset < png.data.length; offset += 4)
        if (png.data[offset] + png.data[offset + 1] + png.data[offset + 2] > 24) lit++;
      assert(lit / (png.width * png.height) > 0.3, 'The actual villa must remain visible');
      run.image = audit(image);
      run.pass = true;
      save();
      console.log(JSON.stringify({name: entry.name, timing: run.timing, motionBlur, lumen, pass: run.pass}));
      await context.close(); context = null;
    }
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    if (context) {
      const page = context.pages()[0];
      report.startupFailure = await page?.evaluate(() => ({
        failure: globalThis.__webEngineFailure, diagnostics: globalThis.__webStartupDiagnostics,
      })).catch(() => null);
    }
    process.exitCode = 1;
  }
  finally {save(); await context?.close(); console.log(JSON.stringify({pass: report.pass, failure: report.failure, output}));}
})();
