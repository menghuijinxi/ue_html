'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process'), {chromium} = require('playwright');
const base = path.resolve(__dirname, '..'), tag = process.argv[2]; assert(/^[a-z0-9-]+$/.test(tag));
const directory = path.join(base, 'results', tag); assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const report = {date: new Date().toISOString(), pass: false, runs: [],
  boundary: 'Short startup diagnostic, not a motion/FPS benchmark. One original runtime and two startup overrides of the candidate.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
let context, run, log;
function adapterObserver() {
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function(...args) {
    globalThis.__pageProbeAdapter = {...this.info, vendor: this.info.vendor, architecture: this.info.architecture,
      description: this.info.description, device: this.info.device, fallback: this.isFallbackAdapter};
    return request.apply(this, args);
  };
}
(async () => {
  try {
    process.env.TEMP = process.env.TMP = path.join(base, 'build/test-tmp');
    context = await chromium.launchPersistentContext(path.join(base, 'build/browser-profiles/vsm-adaptive-production-20261112'),
      {channel: 'msedge', headless: false, viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
        args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
    const anchor = context.pages()[0] || await context.newPage(); await anchor.goto('about:blank');
    for (const page of context.pages()) if (page !== anchor) await page.close();
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch(), marker = "        removeRunDependency('worker-content');";
      let body = await response.text(); assert.equal(body.split(marker).length, 2);
      if (run.mode !== undefined) body = body.replace(marker, `
        const path='/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(path, FS.readFile(path, {encoding:'utf8'})+
          '\\n[SystemSettings]\\nr.WebGPU.VSMPageOptimization=${run.mode}\\n');
${marker}`);
      await route.fulfill({response, body: '(' + adapterObserver.toString() + ')();\n' + body});
    });
    for (const [folder, mode] of [['villa-vsm-indirect-20261112', undefined],
      ['villa-vsm-pages-20261112', 0], ['villa-vsm-pages-20261112', 3]]) {
      run = {folder, mode, errors: [], samples: []}; report.runs.push(run); save();
      const page = await context.newPage(); log = fs.createWriteStream(path.join(directory, 'run-' + report.runs.length + '.log'));
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost/.test(text))
          run.errors.push(text);
      });
      page.on('pageerror', error => run.errors.push(error.message));
      await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 60 &&
        document.getElementById('loading')?.hidden, null, {timeout: 180000});
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')); assert(owner);
      const state = () => owner.evaluate(() => ({time: performance.now(), frames: __webRHIFrames,
        stages: __webThreadStages, rhi: __webOcclusionRHI, adapter: __pageProbeAdapter,
        view: __webRenderView, settings: __webProjectSettings, failure: globalThis.__webEngineFailure}));
      run.before = await state(); assert(!run.before.failure, run.before.failure);
      for (let second = 0; second < 10; ++second) {
        await page.waitForTimeout(1000); run.samples.push(await state());
        if (second === 4) run.gpu = execFileSync('nvidia-smi',
          ['--query-gpu=pstate,utilization.gpu,memory.used,clocks.gr,clocks.mem', '--format=csv'], {encoding: 'utf8'});
      }
      run.after = await state();
      run.fps = (run.after.frames - run.before.frames) * 1000 / (run.after.time - run.before.time);
      assert.deepEqual(run.errors, []); assert(!run.after.failure, run.after.failure);
      console.log(JSON.stringify({folder, mode, fps: run.fps, adapter: run.after.adapter, gpu: run.gpu}));
      save(); await page.close(); log.end(); log = null;
    }
    report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
