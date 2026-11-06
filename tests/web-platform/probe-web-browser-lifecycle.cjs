const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder') || 'triplex-house-villa-df-distance-fields-threads';
const channel = process.argv.includes('--chrome') ? 'chrome' : 'msedge';
const runs = Number(option('runs') || 4);
const tag = option('tag') || 'baseline';
const extraArgs = option('browser-args') ? JSON.parse(option('browser-args')) : [];
const width = Number(option('width') || 1638), height = Number(option('height') || 810);
const dpr = Number(option('dpr') || 1.25);
const affinityMask = Number(option('affinity-mask') || 0);
assert(/^[a-z0-9-]+$/.test(folder) && /^[a-z0-9-]+$/.test(tag));
assert(Number.isInteger(runs) && runs > 0 && runs <= 20);
assert(Array.isArray(extraArgs) && extraArgs.every(value => typeof value === 'string'));
assert(width >= 640 && width <= 3840 && height >= 360 && height <= 2160 && dpr >= 1 && dpr <= 3);
assert(Number.isSafeInteger(affinityMask) && affinityMask >= 0);
assert(!affinityMask || process.platform === 'win32', 'CPU affinity diagnostics require Windows');
const results = path.join(__dirname, 'results');
const profile = path.join(__dirname, 'build/browser-profiles', `lifecycle-${channel}-${tag}`);
const report = {date: new Date().toISOString(), pass: false, folder, channel, runs, extraArgs,
  width, height, dpr, headful: process.argv.includes('--headful'), settingsOverrides: [],
  affinityMask, affinityChecks: [],
  hostCondition: affinityMask ? `diagnostic CPU affinity 0x${affinityMask.toString(16)}` :
    process.env.UE_WEB_TEST_HOST_CONDITION || 'default scheduling',
  source: audit(__filename), samples: [], crashes: [], errors: [], logs: [],
  boundary: 'Own browser profile; normal engine clock and unmodified shaders. Passing repeated starts is not proof that the reported intermittent crash is fixed.'};
let context, page;
function checkAffinity(apply) {
  if (!affinityMask) return;
  const script = `
    $ErrorActionPreference = 'Stop'
    $taskRoots = @(Get-CimInstance Win32_Process -Filter "name='$env:UE_LIFECYCLE_BROWSER'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:UE_LIFECYCLE_PROFILE) -and
        $_.CommandLine -notmatch '--type=' })
    if ($taskRoots.Count -ne 1) { throw 'Expected one isolated test browser' }
    $taskRoot = $taskRoots[0].ProcessId
    $taskMask = [long]$env:UE_LIFECYCLE_AFFINITY
    $taskAttempts = $(if ($env:UE_LIFECYCLE_APPLY -eq '1') { 12 } else { 1 })
    for ($taskAttempt = 0; $taskAttempt -lt $taskAttempts; $taskAttempt++) {
      $taskChecks = @(Get-CimInstance Win32_Process -Filter "name='$env:UE_LIFECYCLE_BROWSER'" |
        Where-Object { $_.ProcessId -eq $taskRoot -or $_.ParentProcessId -eq $taskRoot } |
        ForEach-Object {
          $taskProcess = Get-Process -Id $_.ProcessId -ErrorAction Stop
          if ($env:UE_LIFECYCLE_APPLY -eq '1') {
            $taskProcess.ProcessorAffinity = [IntPtr]$taskMask
          }
          [pscustomobject]@{ pid = $taskProcess.Id
            type = $(if ($_.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'browser' })
            mask = $taskProcess.ProcessorAffinity.ToInt64() }
        })
      if ($taskAttempt + 1 -lt $taskAttempts) { Start-Sleep -Milliseconds 200 }
    }
    if (!@($taskChecks | Where-Object type -eq 'gpu-process').Count) { throw 'No test GPU process found' }
    ConvertTo-Json -InputObject $taskChecks -Compress
  `;
  const processes = JSON.parse(require('node:child_process').execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', timeout: 20000,
      env: {...process.env, UE_LIFECYCLE_BROWSER: channel === 'msedge' ? 'msedge.exe' : 'chrome.exe',
        UE_LIFECYCLE_PROFILE: profile, UE_LIFECYCLE_AFFINITY: String(affinityMask),
        UE_LIFECYCLE_APPLY: apply ? '1' : '0'}}));
  report.affinityChecks.push({time: new Date().toISOString(), apply, processes});
  assert(processes.every(item => item.mask === affinityMask), 'Test browser CPU affinity changed');
}
const snapshot = () => page.evaluate(() => ({frames: globalThis.__webEngineFrames || 0,
  failure: globalThis.__webEngineFailure, ready: globalThis.__webEngineReady,
  surface: globalThis.__webEngineSurface, runtime: globalThis.__webEngineRuntime,
  memory: globalThis.__webTextureStreaming, io: globalThis.__webLocalContentStats,
  view: globalThis.__webRenderView, settings: globalThis.__webProjectSettings,
  threads: globalThis.__webEngineThreads}));
(async () => {
  try {
    const packageFile = option('package-report') ? path.resolve(option('package-report')) :
      path.join(results, folder.startsWith('ue-default-template') ?
      `web-default-template${folder.slice('ue-default-template'.length)}-package-results.json` :
      `web-project-${folder}-package-results.json`);
    const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''));
    assert(packaged.pass);
    assert.equal(path.resolve(packaged.output), path.join(__dirname, 'build', folder));
    for (const item of packaged.products) assert.equal(audit(item.file).sha256, item.sha256);
    report.package = audit(packageFile);
    context = await chromium.launchPersistentContext(profile,
      {channel, headless: !report.headful, viewport: {width, height},
        deviceScaleFactor: dpr, args: extraArgs});
    // GPU sandbox startup can reset inherited affinity; apply it before opening the scene.
    checkAffinity(true);
    page = context.pages()[0] || await context.newPage();
    const session = await context.newCDPSession(page);
    report.browser = await session.send('Browser.getVersion');
    await session.detach();
    page.on('crash', () => report.crashes.push({run: report.operation, time: new Date().toISOString()}));
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text();
      if (report.logs.length >= 160) report.logs.shift();
      report.logs.push(text);
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost/.test(text))
        report.errors.push(text);
    });
    for (let run = 0; run < runs; ++run) {
      report.operation = {run, phase: 'navigate'};
      const url = `http://127.0.0.1:8765/build/${folder}/index.html`;
      if (run) await page.reload({waitUntil: 'commit'});
      else await page.goto(url, {waitUntil: 'commit'});
      report.operation.phase = 'startup';
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 180,
        undefined, {timeout: 180000});
      const value = await snapshot();
      report.samples.push({run, ...value});
      assert(!value.failure, value.failure);
      assert.equal(value.ready?.shaderPlatform, 47);
      assert.deepEqual(report.crashes, []);
      assert.deepEqual(report.errors, []);
      checkAffinity(false);
      console.log(JSON.stringify({run, frames: value.frames, surface: value.surface}));
      report.operation.phase = 'resize';
      await page.setViewportSize(run % 2 ? {width, height} : {width: 1280, height: 720});
      await page.waitForFunction(target => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= target,
        value.frames + 90, {timeout: 90000});
      const resized = await snapshot();
      report.samples.push({run, phase: 'resized', ...resized});
      assert(!resized.failure, resized.failure);
      assert.deepEqual(report.crashes, []);
      assert.deepEqual(report.errors, []);
      checkAffinity(false);
    }
    report.screenshot = path.join(results, `web-browser-lifecycle-${channel}-${tag}.png`);
    await page.screenshot({path: report.screenshot});
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    if (page) report.final = await snapshot().catch(() => null);
  } finally {
    await context?.close();
    const file = path.join(results, `web-browser-lifecycle-${channel}-${tag}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
