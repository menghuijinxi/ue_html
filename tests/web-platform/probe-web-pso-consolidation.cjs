const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const audit = file => ({file, sha256: hash(fs.readFileSync(file))});
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const root = path.resolve(__dirname, '../..');
const report = {date: new Date().toISOString(), pass: false, runs: [],
  engineLoopBrowserTickVerified: false, completeUEScene: false};

(async () => {
  let browser;
  try {
    const buildFile = path.join(__dirname, 'results/web-engine-webgpu-link-results.json');
    const stageFile = path.join(__dirname, 'results/web-engine-webgpu-es31-stage-results.json');
    const build = read(buildFile);
    const stage = read(stageFile);
    assert(build.pass && stage.pass);
    for (const item of [...build.products, stage.pack, stage.manifest]) {
      assert.equal(hash(fs.readFileSync(item.file)), item.sha256);
    }
    report.buildReport = audit(buildFile);
    report.stageReport = audit(stageFile);
    report.sourceFiles = [__filename, path.join(__dirname, 'web-engine.html'),
      path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/RHI/Private/PipelineStateCache.cpp'),
      path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Core/Private/HAL/ThreadingBase.cpp'),
      path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Core/Private/Async/Fundamental/Scheduler.cpp')
    ].map(audit);
    const bundleFile = path.join(__dirname, 'build/web-engine/config-files.json');
    report.configBundle = audit(bundleFile);
    const bundle = read(bundleFile);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      for (const asyncConsolidation of [1, 0]) {
        browser = await chromium.launch({executablePath, headless: true});
        const page = await browser.newPage({viewport: {width: 1280, height: 800}});
        const run = {browser: name, version: browser.version(), asyncConsolidation,
          consoleLog: [], errors: [], consolidationGuardHit: false, gameEngineInitialized: false};
        const configs = structuredClone(bundle);
        const web = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
        assert(web, 'The real Web engine configuration must be present');
        let text = Buffer.from(web.data, 'base64').toString('utf8');
        text = text.replace(/^r\.pso\.EnableAsyncCacheConsolidation=.*(?:\r?\n|$)/gm, '');
        assert(text.startsWith('[SystemSettings]'));
        text = text.replace('[SystemSettings]', `[SystemSettings]\nr.pso.EnableAsyncCacheConsolidation=${asyncConsolidation}`);
        const bytes = Buffer.from(text);
        web.data = bytes.toString('base64');
        web.sha256 = hash(bytes);
        run.webConfig = {path: web.path, sha256: web.sha256, text};
        await page.route('**/build/web-engine/config-files.json', route => route.fulfill({
          status: 200, contentType: 'application/json', body: JSON.stringify(configs)
        }));
        await page.addInitScript(() => { Error.stackTraceLimit = 100; });
        page.on('console', message => {
          const text = message.text();
          run.consoleLog.push(text);
          if (text.includes('Consolidate was hit while Get/SetPSO was running'))
            run.consolidationGuardHit = true;
          if (text.includes('Game Engine Initialized.')) run.gameEngineInitialized = true;
        });
        page.on('pageerror', error => run.errors.push(error.stack || error.message));
        await page.goto('http://127.0.0.1:8765/web-engine.html?rhi=webgpu&incremental=1&cook=es31',
          {waitUntil: 'commit'});
        try {
          await page.waitForFunction(() => globalThis.__webEngineFailure ||
            (globalThis.__webEngineReady && globalThis.__webEngineFrames >= 9), null, {timeout: 45000});
        } catch (error) {
          run.waitFailure = error.message;
        }
        Object.assign(run, await page.evaluate(() => ({
          failure: globalThis.__webEngineFailure || null,
          frames: globalThis.__webEngineFrames || 0, ready: globalThis.__webEngineReady || null,
          configFiles: globalThis.__webEngineConfigFiles || []
        })));
        assert(run.configFiles.some(item => item.path === web.path && item.sha256 === web.sha256),
          'The engine must load the selected configuration bytes');
        assert(run.consoleLog.some(text => text.includes(
          `Set CVar [[r.pso.EnableAsyncCacheConsolidation:${asyncConsolidation}]]`)),
        'The engine must apply the selected CVar, not merely mount the INI');
        run.pass = asyncConsolidation === 1
          ? run.consolidationGuardHit && run.frames === 0 &&
            run.errors.some(text => text.includes('RHIAsyncCacheConsolidation'))
          : !run.consolidationGuardHit &&
            run.gameEngineInitialized && (run.frames >= 9 ||
              (run.failure && run.errors.length > 0 &&
                !run.errors.some(text => text.includes('RHIAsyncCacheConsolidation'))));
        report.runs.push(run);
        await browser.close();
        browser = null;
      }
    }
    report.asyncGuardReproduced = report.runs.filter(run => run.asyncConsolidation === 1)
      .every(run => run.pass);
    report.synchronousConsolidationPassedGuard = report.runs.filter(run => run.asyncConsolidation === 0)
      .every(run => run.pass);
    report.engineLoopBrowserTickVerified = report.runs.filter(run => run.asyncConsolidation === 0)
      .every(run => run.frames >= 9 && !run.failure);
    report.pass = report.runs.length === 4 && report.runs.every(run => run.pass);
    assert(report.pass, 'The same Engine must reproduce the async guard and pass it with synchronous consolidation');
  } catch (error) {
    report.error = error.stack || String(error);
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-pso-consolidation-probe-results.json'),
      JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, asyncGuardReproduced: report.asyncGuardReproduced,
      synchronousConsolidationPassedGuard: report.synchronousConsolidationPassedGuard,
      runs: report.runs.map(run => ({browser: run.browser, async: run.asyncConsolidation,
        frames: run.frames, failure: run.failure, guard: run.consolidationGuardHit}))}, null, 2));
    if (!report.pass) process.exitCode = 1;
  }
})();
