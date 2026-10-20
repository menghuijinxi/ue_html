const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && item.sha256 === sha(item.file);
const files = directory => fs.readdirSync(directory, {withFileTypes: true}).flatMap(item =>
  item.isDirectory() ? files(path.join(directory, item.name)) : [path.join(directory, item.name)]);
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64',
  engineLoopBrowserTickVerified: false, completeBrowserUERuntime: false, completeUEScene: false,
  browserRuns: []};
report.contentNegativeChecks = [];

(async () => {
  let browser;
  let page;
  let consoleLog = [];
  let errors = [];
  try {
    const buildFile = path.join(__dirname, 'results/web-engine-full-build-results.json');
    const build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
    assert(build.pass && build.buildSucceeded && build.exitCode === 0 && build.fullLinkAttempted,
      'A successful complete Engine Target build is required before browser startup testing');
    assert.equal(build.architecture, 'wasm64');
    assert(valid(build.log) && valid(build.ubtLog) && valid(build.ubt) && valid(build.linkResponse));
    assert(build.sourceFiles?.length && build.sourceFiles.every(valid), 'Build source audits must match');
    const audited = new Set(build.sourceFiles.map(item => path.resolve(item.file).toLowerCase()));
    for (const directory of ['reference-engine/Engine/Platforms/Web', 'tests/ue-web-smoke/Source'])
      assert(files(path.join(root, directory)).every(file => audited.has(path.resolve(file).toLowerCase())),
        'New platform or target source files require a fresh full build');
    const expected = ['UEWebEngine.js', 'UEWebEngine.wasm', 'UEWebEngine.target'];
    assert.equal(build.products?.length, expected.length);
    const staged = path.join(__dirname, 'build/web-engine');
    fs.mkdirSync(staged, {recursive: true});
    report.stagedFiles = [];
    for (const name of expected) {
      const file = path.join(root, 'tests/ue-web-smoke/Binaries/Web', name);
      assert(build.products.some(item =>
        path.resolve(item.file).toLowerCase() === file.toLowerCase() && valid(item)), `Missing product: ${name}`);
      if (name.endsWith('.target')) continue;
      const copied = path.join(staged, name);
      fs.copyFileSync(file, copied);
      assert.equal(sha(copied), sha(file));
      report.stagedFiles.push(audit(copied));
    }
    report.buildReport = audit(buildFile);
    report.sourceFiles = ['web-engine.html', 'verify-web-engine.cjs'].map(name => audit(path.join(__dirname, name)));
    report.configFiles = [
      ['reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini',
        '/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini'],
      ['reference-engine/Engine/Platforms/Web/Config/WebEngine.ini',
        '/Engine/Platforms/Web/Config/WebEngine.ini'],
      ['.tools/ue58-web-build-host/Engine/Config/Windows/DataDrivenPlatformInfo.ini',
        '/Engine/Config/Windows/DataDrivenPlatformInfo.ini'],
      ['.tools/ue58-web-build-host/Engine/Config/Base.ini', '/Engine/Config/Base.ini'],
      ['.tools/ue58-web-build-host/Engine/Config/BaseEngine.ini', '/Engine/Config/BaseEngine.ini'],
      ...['BaseGame.ini', 'BaseInput.ini', 'BaseDeviceProfiles.ini', 'BaseScalability.ini',
        'BaseGameUserSettings.ini'].map(name =>
        [`.tools/ue58-web-build-host/Engine/Config/${name}`, `/Engine/Config/${name}`])
    ].map(([source, virtualPath]) => ({...audit(path.join(root, source)), virtualPath}));
    const bundleFile = path.join(staged, 'config-files.json');
    fs.writeFileSync(bundleFile, JSON.stringify(report.configFiles.map(item => ({
      path: item.virtualPath, sha256: item.sha256, data: fs.readFileSync(item.file).toString('base64')
    }))));
    report.configBundle = audit(bundleFile);
    const expectedConfigFiles = report.configFiles.map(item => ({path: item.virtualPath, sha256: item.sha256}));
    const stageFile = path.join(__dirname, 'results/web-engine-stage-results.json');
    const stage = JSON.parse(fs.readFileSync(stageFile, 'utf8'));
    assert(stage.pass && stage.mode === 'NullRHI-only' && stage.architecture === 'wasm64');
    assert(valid(stage.cookReport) && valid(stage.pack) && valid(stage.manifest) &&
      stage.sourceFiles?.length && stage.sourceFiles.every(valid), 'Cook/Stage evidence must match');
    const cook = JSON.parse(fs.readFileSync(stage.cookReport.file, 'utf8').replace(/^\uFEFF/, ''));
    assert(cook.pass && cook.exitCode === 0 && valid(cook.log) &&
      cook.products?.length && cook.products.every(valid) && cook.sourceFiles?.length && cook.sourceFiles.every(valid) &&
      cook.hostProducts?.length === 3 && cook.hostProducts.every(valid));
    const contentManifest = JSON.parse(fs.readFileSync(stage.manifest.file, 'utf8'));
    assert.deepEqual(contentManifest.files, stage.files);
    assert.equal(contentManifest.pack.sha256, stage.pack.sha256);
    report.stageReport = audit(stageFile);
    report.contentPack = stage.pack;
    report.contentManifest = stage.manifest;
    const expectedContentFiles = stage.files.map(({path, sha256, size}) => ({path, sha256, size}));
    report.contentFiles = expectedContentFiles;
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
      browser = await chromium.launch({executablePath, headless: true});
      page = await browser.newPage({viewport: {width: 1280, height: 800}});
      report.currentBrowser = name;
      errors = [];
      consoleLog = [];
      page.on('pageerror', error => errors.push(error.stack || error.message));
      page.on('console', message => {
        consoleLog.push(message.text());
        if (consoleLog.length > 200) consoleLog.shift();
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto('http://127.0.0.1:8765/web-engine.html', {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        (globalThis.__webEngineReady && globalThis.__webEngineFrames >= 3), null, {timeout: 120000});
      assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
      assert.deepEqual(await page.evaluate(() => globalThis.__webEngineReady), {nullRHI: true});
      const firstFrame = await page.evaluate(() => globalThis.__webEngineFrames);
      await page.waitForFunction(first => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= first + 6, firstFrame, {timeout: 30000});
      const state = await page.evaluate(() => ({
        ready: globalThis.__webEngineReady, frames: globalThis.__webEngineFrames,
        failure: globalThis.__webEngineFailure || null, log: globalThis.__webEngineLog,
        configFiles: globalThis.__webEngineConfigFiles,
        contentFiles: globalThis.__webEngineContentFiles
      }));
      assert.equal(state.failure, null);
      assert.deepEqual(state.configFiles, expectedConfigFiles);
      assert.deepEqual(state.contentFiles, expectedContentFiles);
      assert(state.frames >= firstFrame + 6);
      assert.deepEqual(errors, []);
      report.browserRuns.push({browser: name, version: browser.version(), firstFrame, ...state, errors, pass: true});
      if (name === 'Chrome') {
        await page.close();
        for (const kind of ['corrupt-pack', 'corrupt-file-hash']) {
          page = await browser.newPage();
          if (kind === 'corrupt-pack') {
            const bytes = Buffer.from(fs.readFileSync(stage.pack.file));
            bytes[0] ^= 1;
            await page.route('**/build/web-engine/content.bin', route =>
              route.fulfill({contentType: 'application/octet-stream', body: bytes}));
          } else {
            const manifest = structuredClone(contentManifest);
            manifest.files[0].sha256 = '0'.repeat(64);
            await page.route('**/build/web-engine/content-files.json', route =>
              route.fulfill({contentType: 'application/json', body: JSON.stringify(manifest)}));
          }
          await page.goto('http://127.0.0.1:8765/web-engine.html', {waitUntil: 'commit'});
          await page.waitForFunction(() => globalThis.__webEngineFailure, null, {timeout: 30000});
          const rejected = await page.evaluate(() => ({
            failure: globalThis.__webEngineFailure, ready: globalThis.__webEngineReady || null,
            frames: globalThis.__webEngineFrames || 0
          }));
          assert.match(rejected.failure, kind === 'corrupt-pack' ?
            /Engine content pack hash mismatch/ : /Engine content hash mismatch:/);
          assert.equal(rejected.ready, null);
          assert.equal(rejected.frames, 0);
          report.contentNegativeChecks.push({kind, ...rejected, pass: true});
          await page.close();
        }
      }
      await browser.close();
      browser = null;
      page = null;
    }
    report.pass = true;
    report.engineLoopBrowserTickVerified = true;
    delete report.currentBrowser;
    report.boundary = 'Complete normal wasm64 Engine Target, real FEngineLoop PreInit/Init and repeated Tick in Chrome and Edge with NullRHI -sm5 and a 4 MiB stack. The launcher mounts byte-verified configuration and shader-free Web Cook startup packages produced by an installed 5.8.0 native host for the mixed 5.8.3 source target. Cook/Stage is limited to NullRHI boot. No WebGPU shader packaging, rendered scene, project map, HTML UI bridge or mobile device is verified.';
  } catch (error) {
    report.failure = error.stack;
    report.consoleLog = consoleLog;
    report.errors = errors;
    if (page && !page.isClosed()) {
      let timer;
      try {
        report.failureState = await Promise.race([
          page.evaluate(() => ({
            ready: globalThis.__webEngineReady || null, frames: globalThis.__webEngineFrames || 0,
            failure: globalThis.__webEngineFailure || null, log: globalThis.__webEngineLog,
            configFiles: globalThis.__webEngineConfigFiles || null,
            contentFiles: globalThis.__webEngineContentFiles || null
          })).catch(() => null),
          new Promise(resolve => { timer = setTimeout(() => resolve({pageUnresponsive: true}), 5000); })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-engine-runtime-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, browserRuns: report.browserRuns.map(run =>
      ({browser: run.browser, frames: run.frames, pass: run.pass})), failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
