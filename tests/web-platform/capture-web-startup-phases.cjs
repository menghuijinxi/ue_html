'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = n => process.argv.find(x => x.startsWith('--' + n + '='))?.slice(n.length + 3);
const folder = option('folder') || 'villa-pso-concurrency-v18-default', tag = option('tag');
const rounds = Number(option('rounds') || 3), startupTrace = process.argv.includes('--ue-trace'), browserTrace = process.argv.includes('--browser-trace');
const cpuProfile = process.argv.includes('--cpu-profile');
const manual = process.argv.includes('--manual');
const psoCorpus = process.argv.includes('--pso-corpus');
const profileName = option('profile') || 'stutters', settleCacheMs = Number(option('settle-cache-ms') || 0);
const gpuCacheKB = option('gpu-cache-kb') === undefined ? null : Number(option('gpu-cache-kb'));
assert(/^[a-z0-9-]+$/.test(profileName) && settleCacheMs >= 0 && settleCacheMs <= 30000);
assert(gpuCacheKB === null || (Number.isInteger(gpuCacheKB) && gpuCacheKB >= 1024));
const browserArgs = [...(gpuCacheKB === null ? [] : ['--gpu-disk-cache-size-kb=' + gpuCacheKB]),
  ...(process.argv.includes('--in-process-gpu') ? ['--in-process-gpu'] : [])];
assert([folder, tag].every(x => x && /^[a-z0-9-]+$/.test(x)) && Number.isInteger(rounds) && rounds > 0 && rounds <= 5);
const output = path.join(__dirname, 'results', tag), recorder = fs.readFileSync(path.join(__dirname, 'web-startup-profile.js'), 'utf8');
assert(!fs.existsSync(output + '.json'), 'Preserve existing captures; use a new tag');
const report = {date: new Date().toISOString(), folder, startupTrace, browserTrace, cpuProfile, manual, psoCorpus, rounds, runs: [], errors: [], pass: false,
  profileName, settleCacheMs, browserArgs,
  qualityOverrides: [], boundary: 'Original package, retained browser/content caches. Opt-in API timing and marks. First canvas submit/completion and loading-hidden are different milestones.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
async function profileOwner(cdp, target) {
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  let sequence = 0;
  const pending = new Map();
  const listener = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message), task = pending.get(message.id);
    if (task) {pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(Error(JSON.stringify(message.error))) : task.resolve(message.result);}
  };
  cdp.on('Target.receivedMessageFromTarget', listener);
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => {pending.delete(id); reject(Error('CPU profiler timeout: ' + method));}, 30000);
    pending.set(id, {resolve, reject, timer});
    cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})}).catch(reject);
  });
  await command('Profiler.enable'); await command('Profiler.setSamplingInterval', {interval: 1000});
  await command('Profiler.start');
  return {stop: async () => {const result = await command('Profiler.stop');
    cdp.off('Target.receivedMessageFromTarget', listener);
    await cdp.send('Target.detachFromTarget', {sessionId}); return result.profile;}};
}
(async () => {
  const directory = path.join(__dirname, 'build', folder);
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const assets = JSON.parse(html.match(/const localRuntimeAssets = (\{[^\n]+\});/)[1]);
  report.package = ['index.html', 'content.bin', 'content-files.json', 'config-files.json', assets.runtime,
    assets.wasm.url, 'web-engine-worker.js', 'web-engine-host.js'].map(n => audit(path.join(directory, n)));
  report.sources = [__filename, path.join(__dirname, 'web-startup-profile.js')].map(audit);
  for (let index = 0; index < rounds; index++) {
    const context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', profileName), {
      channel: 'msedge', headless: false, viewport: {width: 1863, height: 1030}, deviceScaleFactor: 1.25, args: browserArgs});
    const run = {index, errors: [], samples: []}; report.runs.push(run); save();
    try {
      if (manual && psoCorpus) await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: 'globalThis.__webStartupPSOCorpus = true;\n' + await response.text()});
      });
      if (!manual) {
        await context.addInitScript({content: recorder});
        await context.route('**/index.html', async route => {
        const response = await route.fetch(); let html = await response.text();
        const stage = 'function startupStage(stage) {'; assert(html.includes(stage));
        html = html.replace(stage, stage + '\n globalThis.__webStartupProfile?.mark("page.stage." + stage);');
        if (startupTrace) {
          const args = html.match(/arguments: (\[[^\n]+\]),/); assert(args);
          const values = [...args[1].matchAll(/['"]([a-zA-Z0-9_./=:-]+)['"]/g)].map(x => x[1]);
          values.push('-WebStartupTrace'); html = html.replace(args[0], 'arguments: ' + JSON.stringify(values) + ',');
        }
        await route.fulfill({response, body: html});
      });
      await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: (psoCorpus ? 'globalThis.__webStartupPSOCorpus = true;\n' : '') + recorder + '\n' + await response.text()});
      });
      }
      const page = context.pages()[0], cdp = await context.newCDPSession(page);
      report.browser = await cdp.send('Browser.getVersion');
      await cdp.send('Performance.enable');
      let ownerProfiler, browserCDP;
      if (cpuProfile) {
        browserCDP = await context.browser().newBrowserCDPSession();
        const discoverOwner = ({targetInfo}) => {
          (run.targets ||= []).push(targetInfo);
          if (targetInfo.type === 'worker' && targetInfo.url.includes('web-engine-worker.js') && !ownerProfiler)
            ownerProfiler = profileOwner(browserCDP, targetInfo);
        };
        browserCDP.on('Target.targetCreated', discoverOwner);
        browserCDP.on('Target.targetInfoChanged', discoverOwner);
        await browserCDP.send('Target.setDiscoverTargets', {discover: true});
      }
      if (browserTrace) await cdp.send('Tracing.start', {categories: 'disabled-by-default-gpu.dawn,gpu,toplevel,devtools.timeline',
        options: 'record-until-full', transferMode: 'ReturnAsStream'});
      const log = fs.createWriteStream(output + `-${index}.log`);
      const logConsole = m => {const t = m.text(); log.write(t + '\n'); if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(t)) run.errors.push(t);};
      page.on('console', logConsole);
      page.on('pageerror', e => run.errors.push(e.message)); page.on('crash', () => run.errors.push('Renderer crashed'));
      try {
        const at = Date.now();
        await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'}); await page.bringToFront();
        await page.waitForFunction(() => globalThis.__webEngineFailure || (globalThis.__webEngineFrames >= 60 && document.getElementById('loading').hidden), null, {timeout: 240000});
        const failure = await page.evaluate(() => globalThis.__webEngineFailure);
        if (failure) {
          run.failure = failure;
          run.page = await page.evaluate(() => ({...__webStartupProfile, diagnostics: startupSnapshot()}));
        }
        assert(!failure, String(failure));
        const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
        await page.waitForTimeout(500);
        run.elapsedMs = Date.now() - at;
        run.state = await owner.evaluate(() => ({settings: __webProjectSettings, view: __webRenderView,
          rhi: __webOptimizationRHI, pso: __webPSOPrecache, io: __webContentIO.stats}));
        run.page = await page.evaluate(() => {__webStartupProfile.freeze(); return {...__webStartupProfile,
          navigation: performance.getEntriesByType('navigation').map(x => x.toJSON()), diagnostics: startupSnapshot()};});
        run.owner = await owner.evaluate(() => {__webStartupProfile.freeze(); return __webStartupProfile;});
        run.browserMetrics = (await cdp.send('Performance.getMetrics')).metrics;
        assert.deepEqual(run.owner.errors, []); assert.deepEqual(run.errors, []);
        assert.equal(run.owner.dropped + run.page.dropped, 0);
        if (manual) {
          const ready = page.waitForEvent('download');
          await page.locator('#web-startup-profile-export').click();
          run.manualExport = output + `-${index}-manual-export.json`;
          await (await ready).saveAs(run.manualExport);
          const exported = JSON.parse(fs.readFileSync(run.manualExport, 'utf8'));
          assert(exported.pass && exported.manual);
          assert(exported.runs[0].owner.marks.some(m => m.name === 'native.Init.end'));
          assert(exported.runs[0].owner.marks.some(m => m.name === 'gpu.firstGameFrameCompleted'));
          assert.deepEqual(exported.runs[0].state.settings, run.state.settings);
        }
        // Stop CPU sampling at the measured boundary, before trace export and PNG.
        if (cpuProfile) {
          assert(ownerProfiler, 'Owner Worker CPU profiler did not attach');
          run.cpuProfile = output + `-${index}-owner.cpuprofile`;
          fs.writeFileSync(run.cpuProfile, JSON.stringify(await (await ownerProfiler).stop()));
        }
        if (psoCorpus) {
          run.psoCorpus = output + `-${index}-pso-corpus.json`;
          fs.writeFileSync(run.psoCorpus, await owner.evaluate(() => JSON.stringify(__webStartupProfile.exportPSOCorpus())));
        }
        if (startupTrace) {
          assert.equal(await page.evaluate(() => __webEngineRPC('WebTraceStop')), 1);
          for (let attempt = 0; attempt < 100; attempt++) {
            const size = await page.evaluate(() => __webEngineRPC('WebTraceExport'));
            assert(size >= 0, 'Startup trace export failed: ' + size);
            if (size > 0) {run.traceBytes = size; break;}
            await page.waitForTimeout(100);
          }
          assert(run.traceBytes > 1024);
          const downloadReady = page.waitForEvent('download'); await page.evaluate(() => __webDownloadUETrace());
          run.ueTrace = output + `-${index}.utrace`; await (await downloadReady).saveAs(run.ueTrace);
        }
        if (browserTrace) {
          const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
          await cdp.send('Tracing.end'); const {stream} = await complete;
          run.browserTrace = output + `-${index}-browser-trace.json`;
          const fd = fs.openSync(run.browserTrace, 'w');
          try {for (;;) {const chunk = await cdp.send('IO.read', {handle: stream});
            fs.writeSync(fd, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
            if (chunk.eof) break;}}
          finally {fs.closeSync(fd); await cdp.send('IO.close', {handle: stream});}
        }
        await page.locator('canvas').screenshot({path: output + `-${index}-scene.png`, timeout: 60000});
        save(); console.log(JSON.stringify({index, elapsedMs: run.elapsedMs, pipelines: run.owner.pipelines.length, modules: run.owner.modules.length,
          marks: run.owner.marks.filter(m => m.name !== 'native.pso.complete'), nativePSOCompletions: run.owner.marks.filter(m => m.name === 'native.pso.complete').length, io: run.state.io}));
        if (settleCacheMs) await page.waitForTimeout(settleCacheMs);
      } finally {page.off('console', logConsole); log.end(); if (browserCDP) await browserCDP.detach();}
    } finally {save(); await context.close();}
  }
  report.pass = true;
})().catch(e => {report.errors.push(e.stack); console.error(e); process.exitCode = 1;}).finally(save);
