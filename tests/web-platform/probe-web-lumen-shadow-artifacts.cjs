'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder') || 'triplex-project-lumen-optimized-20261104';
const tag = option('tag');
assert(/^[a-z0-9-]+$/.test(folder) && /^[a-z0-9-]+$/.test(tag));
const camera = (option('camera') || '-775,-300,180,-30,270').split(',').map(Number);
assert(camera.length === 5 && camera.every(Number.isFinite));
const output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(output + '.json'), 'Use a new diagnostic tag');
const settings = JSON.parse(option('settings') || '{}');
assert(Object.entries(settings).every(([name, value]) => /^r\.[A-Za-z0-9.]+$/.test(name) && Number.isFinite(value)));
const browserArgs = JSON.parse(option('browser-args') || '[]');
assert(Array.isArray(browserArgs) && browserArgs.every(value => typeof value === 'string'));
const affinityMask = Number(option('affinity-mask') || 0);
assert(Number.isSafeInteger(affinityMask) && affinityMask >= 0);
const referenceFile = option('reference-report');
const maxError = Number(option('max-region-error') || 2);
assert(Number.isFinite(maxError) && maxError > 0 && maxError <= 5);
const regions = [
  {name: 'curtains', x: 530, y: 0, width: 310, height: 210},
  {name: 'floor', x: 280, y: 450, width: 500, height: 230},
];
const report = {date: new Date().toISOString(), pass: false, folder, camera, settings,
  browserArgs, affinityMask, cases: [], errors: [], source: audit(__filename),
  boundary: 'Controlled diagnostic sessions only. Disabling an effect isolates its contribution and is not a rendering fix or proof of desktop parity.'};
const log = fs.createWriteStream(output + '.log');
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
let context, owner;
(async () => {
  try {
    const packageRoot = path.join(__dirname, 'build', folder);
    const versions = JSON.parse(fs.readFileSync(path.join(packageRoot, 'asset-versions.json'), 'utf8'));
    report.products = Object.entries(versions).map(([name, value]) => {
      assert.equal(path.basename(name), name);
      const item = audit(path.join(packageRoot, name));
      assert.equal(item.sha256, value.sha256, `Packaged asset changed: ${name}`);
      return item;
    });
    let reference, referencePng;
    if (referenceFile) {
      report.reference = audit(referenceFile);
      reference = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
      assert(reference.pass);
      assert.deepEqual(reference.camera, camera);
      assert.deepEqual(reference.settings, {'r.InstanceCulling.AllowBatchedBuildRenderingCommands': 0});
      const image = reference.cases.find(item => item.entry.name === 'baseline').image;
      assert.equal(audit(image.file).sha256, image.sha256);
      referencePng = PNG.sync.read(fs.readFileSync(image.file));
    }
    const profile = path.join(__dirname, 'build/browser-profiles', tag);
    context = await chromium.launchPersistentContext(profile,
      {channel: 'msedge', headless: true, viewport: {width: 1280, height: 720},
        args: browserArgs});
    if (affinityMask) {
      const script = `
        $ErrorActionPreference = 'Stop'
        $taskBrowser = Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:UE_SHADOW_TEST_PROFILE) -and
            $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
        if (!$taskBrowser) { throw 'Test browser process not found' }
        for ($taskAttempt = 0; $taskAttempt -lt 12; $taskAttempt++) {
          $taskProcesses = @(Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
            Where-Object { $_.ProcessId -eq $taskBrowser.ProcessId -or
              ($_.ParentProcessId -eq $taskBrowser.ProcessId -and $_.CommandLine -match '--type=gpu-process') })
          $taskChecks = @($taskProcesses | ForEach-Object {
            $taskProcess = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($taskProcess) {
              $taskProcess.ProcessorAffinity = [IntPtr][long]$env:UE_SHADOW_TEST_AFFINITY
              [pscustomobject]@{ pid = $taskProcess.Id
                type = $(if ($_.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'browser' })
                mask = $taskProcess.ProcessorAffinity.ToInt64() }
            }
          })
          Start-Sleep -Milliseconds 200
        }
        if (!@($taskChecks | Where-Object type -eq 'gpu-process').Count) { throw 'No test GPU process found' }
        if (@($taskChecks | Where-Object mask -ne ([long]$env:UE_SHADOW_TEST_AFFINITY)).Count) {
          throw 'Test browser affinity verification failed'
        }
        ConvertTo-Json -InputObject $taskChecks -Compress
      `;
      report.affinityChecks = JSON.parse(require('node:child_process').execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8',
          env: {...process.env, UE_SHADOW_TEST_PROFILE: profile, UE_SHADOW_TEST_AFFINITY: String(affinityMask)}}));
    }
    if (Object.keys(settings).length) await context.route('**/config-files.json', async route => {
      const response = await route.fetch(), configs = await response.json();
      const config = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
      assert(config);
      let text = Buffer.from(config.data, 'base64').toString('utf8');
      for (const name of Object.keys(settings))
        text = text.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*\\r?\\n?`, 'gm'), '');
      text += '\n[SystemSettings]\n' +
        Object.entries(settings).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
      config.data = Buffer.from(text).toString('base64');
      config.sha256 = require('node:crypto').createHash('sha256').update(text).digest('hex');
      report.runtimeConfig = config.sha256;
      await route.fulfill({response, body: JSON.stringify(configs)});
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `{
        const request = GPUAdapter.prototype.requestDevice;
        globalThis.__lumenShadowAudit = {errors: [], losses: [], shaders: {}, cubeCopies: {}};
        GPUAdapter.prototype.requestDevice = async function(...args) {
          const device = await request.apply(this, args);
          device.addEventListener('uncapturederror', e => __lumenShadowAudit.errors.push(e.error.message));
          device.lost.then(info => { if (info.reason !== 'destroyed') __lumenShadowAudit.losses.push(info.message); });
          return device;
        };
        const create = GPUDevice.prototype.createShaderModule;
        GPUDevice.prototype.createShaderModule = function(desc) {
          if (/ShadowDepthPass|PointLightDepthBias|ShadowDepthCube|ProjectionDepthBiasParameters/.test(desc.code)) {
            const entry = desc.code.match(/fn (main\\w*)\\(/)?.[1];
            if (entry) __lumenShadowAudit.shaders[entry] = desc.code;
          }
          return create.call(this, desc);
        };
        const copy = GPUCommandEncoder.prototype.copyTextureToTexture;
        GPUCommandEncoder.prototype.copyTextureToTexture = function(src, dst, size) {
          if (src.texture.label === 'WebCubeShadowFace' && dst.texture.label === 'CubeShadowDepthZ') {
            const face = Array.isArray(dst.origin) ? dst.origin[2] || 0 : dst.origin?.z || 0;
            __lumenShadowAudit.cubeCopies[face] = (__lumenShadowAudit.cubeCopies[face] || 0) + 1;
          }
          return copy.call(this, src, dst, size);
        };
      }\n` + await response.text()});
    });
    const page = context.pages()[0];
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    page.on('console', message => {
      const text = message.text();
      log.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(text)) report.errors.push(text);
      for (const [name, value] of Object.entries(settings))
        if (text.includes(`Set CVar [[${name}:${value}]]`)) (report.appliedSettings ||= {})[name] = value;
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    const advance = async count => {
      const frame = await page.evaluate(() => globalThis.__webEngineFrames || 0);
      await page.waitForFunction(target => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= target, frame + count, {timeout: 180000});
      const failure = await page.evaluate(() => globalThis.__webEngineFailure);
      assert(!failure, JSON.stringify(failure));
      assert.deepEqual(report.errors, []);
    };
    await advance(30);
    owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    assert(owner);
    assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), camera), 1);
    await advance(30);
    for (const entry of [
      {name: 'baseline', controls: []},
      ...(process.argv.includes('--cache-cycle') ? [
        {name: 'uncached', controls: [[10, 0]]},
        {name: 'recached', controls: [[10, 1]]},
      ] : process.argv.includes('--baseline-only') ? [] : [
        {name: 'no-reflections', controls: [[1, 0]]},
        {name: 'restored-reflections', controls: [[1, 1]]},
      ]),
    ]) {
      for (const control of entry.controls)
        assert.equal(await page.evaluate(values => __webEngineRPC('WebLightingQualityTest', ...values), control), 1);
      await advance(90);
      assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', -1, 0)), 1);
      await advance(2);
      const file = output + '-' + entry.name + '.png';
      await page.locator('canvas').screenshot({path: file, timeout: 60000});
      const png = PNG.sync.read(fs.readFileSync(file));
      let sum = 0, dark = 0;
      for (let y = 450; y < 690; ++y)
        for (let x = 280; x < 960; ++x) {
          const i = (y * png.width + x) * 4;
          const value = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
          sum += value;
          dark += value < 12 ? 1 : 0;
        }
      const state = await owner.evaluate(() => ({
        frames: globalThis.__webEngineFrames, camera: globalThis.__webDefaultCamera,
        lighting: globalThis.__webDistanceFieldsLighting, settings: globalThis.__webProjectSettings,
        errors: __lumenShadowAudit.errors, losses: __lumenShadowAudit.losses,
        cubeCopies: __lumenShadowAudit.cubeCopies,
      }));
      assert.deepEqual(state.errors, []);
      assert.deepEqual(state.losses, []);
      report.cases.push({entry, image: audit(file), state,
        floor: {mean: sum / (680 * 240), darkFraction: dark / (680 * 240)}});
      if (referencePng && ['baseline', 'recached'].includes(entry.name)) {
        assert.equal(png.width, referencePng.width);
        assert.equal(png.height, referencePng.height);
        const comparisons = regions.map(region => {
          let error = 0;
          for (let y = region.y; y < region.y + region.height; ++y)
            for (let x = region.x; x < region.x + region.width; ++x)
              for (let channel = 0; channel < 3; ++channel) {
                const offset = (y * png.width + x) * 4 + channel;
                error += Math.abs(png.data[offset] - referencePng.data[offset]);
              }
          return {...region, meanAbsoluteError: error / (region.width * region.height * 3), limit: maxError};
        });
        report.cases.at(-1).comparisons = comparisons;
        assert(state.lighting.shadowCacheEnabled);
        assert.equal(state.lighting.giMethod, 1);
        assert.equal(state.lighting.reflectionMethod, 1);
        assert.equal(state.lighting.antiAliasing, 4);
        assert(comparisons.every(item => item.meanAbsoluteError <= item.limit),
          `Batched shadow rendering differs from the synchronous reference: ${JSON.stringify(comparisons)}`);
      }
      save();
      console.log(JSON.stringify(report.cases.at(-1)));
    }
    if (Object.keys(settings).length) assert.deepEqual(report.appliedSettings, settings);
    report.pass = true;
  } catch (error) {report.failure = error.stack; process.exitCode = 1;}
  finally {
    try {
      owner ||= context?.pages()[0]?.workers().find(worker => worker.url().includes('web-engine-worker.js'));
      if (owner) {
        const shaders = await owner.evaluate(() => __lumenShadowAudit.shaders);
        for (const [entry, code] of Object.entries(shaders))
          fs.writeFileSync(output + '-' + entry + '.wgsl', code);
        report.capturedShaders = Object.keys(shaders);
      }
    } catch (error) {report.captureFailure = error.message;}
    save();
    await context?.close();
    log.end();
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, output}));
  }
})();
