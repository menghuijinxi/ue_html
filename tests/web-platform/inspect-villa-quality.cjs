'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const observe = require('./web-gpu-memory-observer.cjs');
const option = n => process.argv.find(v => v.startsWith('--' + n + '='))?.slice(n.length + 3);
const tag = option('tag');
assert(tag && /^[a-z0-9-]+$/.test(tag));
const capture = process.argv.includes('--capture');
const selected = option('engine');
assert(!selected || ['ours', 'official'].includes(selected));
const affinity = Number(option('affinity') || 0);
assert(Number.isSafeInteger(affinity) && affinity >= 0);
const out = path.join(__dirname, 'results/villa-quality-' + tag);
assert(!fs.existsSync(out), 'Use a new tag to preserve evidence and avoid stale OPFS captures');
fs.mkdirSync(out, {recursive: true});
const profile = require('./villa-engine-comparison.json');
const report = {date: new Date().toISOString(), profile, capture, affinity, runs: [], pass: false};
let context;
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
(async () => {
  try {
    const browserProfile = path.join(__dirname, 'build/browser-profiles/quality-' + tag);
    context = await chromium.launchPersistentContext(browserProfile, {
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      headless: false, viewport: {width: 1920, height: 1125}, deviceScaleFactor: 1,
      args: ['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required']
    });
    if (affinity) report.affinityChecks = require('./comparison-browser-affinity.cjs')(browserProfile, affinity, true);
    await context.addInitScript(observe);
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: '(' + observe.toString() + ')();\n' + await response.text()});
    });
    if (capture) await context.route('**/villa-engine-comparison.html', async route => {
      const response = await route.fetch();
      let html = await response.text();
      html = html.replace("official.searchParams.set('prewarm', '1');", "")
        .replace("official.searchParams.set('harness', '1');",
        "official.searchParams.set('harness', '1'); official.searchParams.set('prewarm', 'capture'); official.searchParams.set('prewarm_capture_s', '60');");
      await route.fulfill({response, body: html});
    });
    const page = context.pages()[0];
    let run;
    page.on('console', m => {
      const text = m.text();
      if (run) fs.appendFileSync(path.join(out, run.engine + '-console.log'), text + '\n');
      if (/GPU validation:|GPUValidationError|WEBGPU (?:PIPELINE )?ERROR|Fatal error:|Assertion failed:|WebGPU device lost|HARNESS ABORT/.test(text))
        run?.errors.push(text);
    });
    page.on('pageerror', e => run?.errors.push(e.message));
    for (const engine of selected ? [selected] : ['ours', 'official']) {
      run = {engine, errors: [], snapshots: []}; report.runs.push(run);
      console.log('Starting ' + engine);
      await page.goto('http://127.0.0.1:8766/villa-engine-comparison.html#' + engine);
      await page.waitForSelector('iframe');
      const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
      await frame.waitForSelector('canvas', {state: 'attached', timeout: 30000});
      await frame.waitForFunction(engine => engine === 'ours' ?
        globalThis.__webEngineFailure || (globalThis.__webEngineFrames > 180 && globalThis.__webPSOPrecacheReady) :
        globalThis.__webGPUMemory?.submits > 600, engine, {timeout: 180000});
      run.failure = await frame.evaluate(() => globalThis.__webEngineFailure);
      assert(!run.failure, String(run.failure));
      const owner = () => page.workers().find(w => w.url().includes('web-engine-worker.js'));
      const snapshot = async name => {
        await page.waitForTimeout(8000);
        const realm = engine === 'ours' ? owner() : frame;
        const state = await realm.evaluate(() => ({
          gpu: globalThis.__webGPUMemorySnapshot?.(),
          view: globalThis.__webRenderView,
          streaming: globalThis.__webTextureStreaming,
          settings: globalThis.__webProjectSettings,
          pso: globalThis.__webPSOPrecache,
          optimization: globalThis.__webOptimizationRHI
        }));
        run.snapshots.push({name, ...state});
        await page.screenshot({path: path.join(out, engine + '-' + name + '.png')});
        save();
        console.log(JSON.stringify({engine, name, streaming: state.streaming, pso: state.pso,
          textures: state.gpu?.live.filter(v => v.kind === 'texture' && /Brick|Wall|Wood|Floor|SceneColor/i.test(v.label)).slice(0, 14)}));
      };
      await snapshot('baseline');
      if (engine === 'official') {
        const queries = ['r.PostProcessAAQuality', 'r.TemporalAA.Quality', 'r.TemporalAACurrentFrameWeight',
          'r.TemporalAASamples', 'r.TemporalAAFilterSize', 'r.Tonemapper.Sharpen',
          'r.Streaming.PoolSize', 'r.Streaming.MipBias', 'r.Streaming.UsePerTextureBias',
          'r.Streaming.LimitPoolSizeToVRAM', 'r.MaxAnisotropy', 'r.PSOPrecaching',
          'r.PSOPrecache.Components', 'r.PSOPrecache.Resources', 'Wasm.PipelinePrewarm',
          'Wasm.PipelinePrewarmPSOCache', 'ListTextures'];
        await frame.evaluate(queries => { for (const q of queries) window.ueExec(q); window.ueExec('FlushLog'); }, queries);
        await page.waitForTimeout(1500);
        const log = await frame.evaluate(async () => {
          const logs = await (await navigator.storage.getDirectory()).getDirectoryHandle('logs');
          return (await (await logs.getFileHandle((window.ueLogFile || 'triplexhousevilla.log').toLowerCase())).getFile()).text();
        });
        fs.writeFileSync(path.join(out, 'official-engine.log'), log);
        await frame.evaluate(() => window.ueExec('r.Streaming.PoolSize 2048'));
        await snapshot('pool2048');
        await frame.evaluate(() => window.ueExec('r.Tonemapper.Sharpen 1'));
        await snapshot('pool2048-sharpen1');
        if (capture) {
          await frame.evaluate(() => window.ueExec('r.Tonemapper.Sharpen 0'));
          await frame.locator('canvas').focus();
          for (const key of ['w', 'd', 's', 'a']) {
            await page.keyboard.down(key); await page.waitForTimeout(2000); await page.keyboard.up(key);
          }
          let text;
          const deadline = Date.now() + 150000;
          while (!text && Date.now() < deadline) {
            text = await frame.evaluate(async () => {
              try {
                const logs = await (await navigator.storage.getDirectory()).getDirectoryHandle('logs');
                const result = await (await (await logs.getFileHandle('webgpu-capture.json')).getFile()).text();
                return result.length > 1000 ? result : null;
              } catch { return null; }
            });
            if (!text) await page.waitForTimeout(2000);
          }
          assert(text, 'Official prewarm capture was not written');
          fs.writeFileSync(path.join(out, 'webgpu-capture.json'), text);
          run.captureCounts = JSON.parse(text).counts;
        }
      }
      assert.equal(run.errors.length, 0, run.errors.join('\n'));
      run.pass = true;
      await page.goto('about:blank');
    }
    report.pass = true;
  } catch (e) { report.error = e.stack; console.error(e); process.exitCode = 1; }
  finally { save(); await context?.close(); }
})();
