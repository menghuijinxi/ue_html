'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');

const name = 'nanite-release-20261111';
const root = path.join(__dirname, 'build', name);
const output = path.join(__dirname, 'evidence', name);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const verify = item => assert.equal(audit(item.file).sha256, item.sha256, item.file);
const report = {pass: false, date: new Date().toISOString(), source: audit(__filename),
  manifest: audit(path.join(root, 'manifest.json')), scenes: [], artifacts: [],
  boundary: 'Verifies every delivered file, the Windows PowerShell 5.1 launcher, local HTTP isolation/versioning, and normal rendering/input from both relocated scene URLs. No renderer, GPU, clock or project setting overrides.'};
const archived = new Set();
function archive(file) {
  file = path.resolve(file);
  if (archived.has(file)) return;
  archived.add(file);
  const bytes = fs.readFileSync(file);
  const compressed = zlib.gzipSync(bytes, {level: 9});
  assert(zlib.gunzipSync(compressed).equals(bytes));
  const target = path.join(output, `${report.artifacts.length}-${path.basename(file)}.gz`);
  fs.writeFileSync(target, compressed);
  report.artifacts.push({original: audit(file), archive: audit(target), encoding: 'gzip'});
}
let context;
(async () => {
  try {
    assert(!fs.existsSync(output), 'Do not overwrite an existing release verification');
    fs.mkdirSync(output, {recursive: true});
    const manifest = read(report.manifest.file);
    assert(manifest.pass);
    manifest.sources.forEach(verify);
    manifest.evidence.forEach(verify);
    for (const product of manifest.products) {
      const file = path.resolve(root, product.path);
      assert(file.startsWith(root + path.sep));
      assert.equal(fs.statSync(file).size, product.bytes);
      assert.equal(audit(file).sha256, product.sha256, file);
    }
    report.filesVerified = manifest.products.length;
    report.bytesVerified = manifest.products.reduce((sum, p) => sum + p.bytes, 0);
    for (const file of [__filename, report.manifest.file,
      path.join(__dirname, 'package-nanite-release.cjs'),
      path.join(__dirname, 'nanite-release-launcher.ps1'),
      path.join(root, 'start.ps1'), path.join(root, 'serve.cjs'),
      path.join(root, 'index.html'), path.join(root, '测试说明.md'),
      path.join(__dirname, 'results', name + '.json'),
      ...fs.readdirSync(path.join(root, 'validation')).map(f => path.join(root, 'validation', f))]) archive(file);
    // Keep the missing-installed-browser failure and the first Edge cold starts.
    const previous = path.join(__dirname, 'results/nanite-core/browser-before-executable');
    const originalProbe = audit(path.join(previous, 'probe-web-browser-lifecycle.cjs'));
    const missingBrowser = read(path.join(previous, 'web-browser-lifecycle-chrome-nanite-final-default-results.json'));
    assert.equal(missingBrowser.pass, false);
    assert.match(missingBrowser.failure, /distribution 'chrome' is not found/);
    assert.equal(missingBrowser.source.sha256, originalProbe.sha256);
    report.prerequisiteFailure = {reason: missingBrowser.failure, originalProbe};
    for (const file of fs.readdirSync(previous)) archive(path.join(previous, file));
    const browserTool = read(path.join(root, 'validation/chrome-testing.json'));
    verify(browserTool.executable); verify(browserTool.versions); archive(browserTool.versions.file);
    const launcherFailureFile = path.join(__dirname, 'evidence/nanite-release-launcher-failure-20261111.json');
    const launcherFailure = read(launcherFailureFile);
    assert.equal(launcherFailure.pass, false); assert.match(launcherFailure.failure, /Get-FileHash/);
    launcherFailure.artifacts.forEach(a => verify(a.archive));
    report.launcherFailureEvidence = audit(launcherFailureFile); archive(launcherFailureFile);
    archive(path.join(__dirname, 'results/nanite-core/release-first-failure.json'));
    for (const scene of ['default', 'villa']) {
      const result = {scene, errors: []};
      report.scenes.push(result);
      result.launcher = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'start.ps1'), '-Scene', scene,
        '-NoBrowser'], {encoding: 'utf8', timeout: 30000}).trim();
      const url = `http://127.0.0.1:8766/${scene}/index.html`;
      for (const product of manifest.products.filter(p => p.path.startsWith(scene + '/'))) {
        const response = await fetch(`http://127.0.0.1:8766/${product.path}?v=${product.sha256}`, {method: 'HEAD'});
        assert.equal(response.status, 200, product.path);
        assert.equal(response.headers.get('etag'), `"${product.sha256}"`);
        assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
        assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
        assert.equal(Number(response.headers.get('content-length')), product.bytes);
      }
      const profile = path.join(process.env.LOCALAPPDATA, 'UEHTML', `${name}-verification-${scene}`);
      assert(!fs.existsSync(profile), 'Require a fresh release test profile');
      context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
        viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
      const page = context.pages()[0];
      page.on('crash', () => result.errors.push('Page crashed'));
      page.on('pageerror', e => result.errors.push(e.message));
      page.on('console', m => {
        if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost/.test(m.text())) result.errors.push(m.text());
      });
      const snapshot = () => page.evaluate(() => ({frames: globalThis.__webEngineFrames,
        failure: globalThis.__webEngineFailure, ready: globalThis.__webEngineReady,
        isolated: crossOriginIsolated, camera: globalThis.__webDefaultCamera,
        settings: globalThis.__webProjectSettings, runtime: globalThis.__webEngineRuntime,
        psoExpected: globalThis.__webPSOPrecacheExpected, psoReady: globalThis.__webPSOPrecacheReady}));
      await page.goto(url, {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        (globalThis.__webEngineFrames >= 180 && (!globalThis.__webPSOPrecacheExpected || globalThis.__webPSOPrecacheReady)),
        undefined, {timeout: 180000});
      result.initial = await snapshot();
      assert(!result.initial.failure, result.initial.failure);
      assert(result.initial.isolated);
      assert.equal(result.initial.ready.shaderPlatform, 47);
      await page.locator('canvas').focus();
      await page.keyboard.down('w');
      await page.waitForFunction(f => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= f + 60,
        result.initial.frames, {timeout: 60000});
      await page.keyboard.up('w');
      result.moved = await snapshot();
      assert(!result.moved.failure, result.moved.failure);
      result.movement = Math.hypot(...['x', 'y', 'z'].map(axis =>
        result.moved.camera[axis] - result.initial.camera[axis]));
      assert(result.movement > 10, 'Player camera must move at least 10 cm through normal input');
      await page.setViewportSize({width: 1366, height: 768});
      await page.waitForFunction(f => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= f + 90,
        result.moved.frames, {timeout: 60000});
      result.resized = await snapshot();
      assert(!result.resized.failure, result.resized.failure);
      assert.deepEqual(result.errors, []);
      const screenshot = path.join(__dirname, 'results', `${name}-${scene}.png`);
      await page.screenshot({path: screenshot});
      archive(screenshot);
      await context.close(); context = null;
      console.log({scene, frames: result.resized.frames, errors: result.errors.length});
    }
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
  } finally {
    await context?.close();
    const file = path.join(__dirname, 'evidence', name + '.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log({pass: report.pass, file, failure: report.failure});
    process.exitCode = report.pass ? 0 : 1;
  }
})();
