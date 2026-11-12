'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag'), rounds = Number(option('rounds') || 2);
const profileNameOverride = option('profile');
assert(!profileNameOverride || /^[a-z0-9-]+$/.test(profileNameOverride));
const affinity = Number(option('affinity') || 0);
const browser = option('browser') || 'chrome';
assert(['chrome', 'msedge'].includes(browser) && (!affinity || browser === 'chrome'));
const selected = option('engine');
const folder = option('folder');
const direct = process.argv.includes('--direct');
const serve = process.argv.includes('--serve');
const settleFrames = Number(option('settle-frames') || 0);
assert(Number.isInteger(settleFrames) && settleFrames >= 0 && settleFrames <= 600);
assert(!serve || direct);
const width = Number(option('width') || 1600), height = Number(option('height') || 1000);
const dpr = Number(option('dpr') || 1.5);
assert(!direct || (folder && selected === 'ours'));
assert(width >= 640 && width <= 3840 && height >= 360 && height <= 2160 && dpr >= 1 && dpr <= 3);
const cvars = option('cvars') || '';
assert(tag && /^[a-z0-9-]+$/.test(tag) && Number.isInteger(rounds) && rounds > 0);
assert(!selected || ['ours', 'official'].includes(selected));
const noLumen = option('lighting') === 'off';
const profileName = noLumen ? 'villa-engine-comparison-no-lumen.json' : 'villa-engine-comparison.json';
const profile = require('./' + profileName);
const temporary = path.join(__dirname, 'build/test-tmp');
fs.mkdirSync(temporary, {recursive: true}); process.env.TEMP = process.env.TMP = temporary;
const directory = path.join(__dirname, 'results', 'villa-startup-' + tag);
assert(!fs.existsSync(directory), 'Keep prior measurements; use a new tag');
fs.mkdirSync(directory);
const report = {date: new Date().toISOString(), profile: direct ? undefined : profile, affinity, rounds, cvars, folder, browser,
  browserProfile: profileNameOverride || 'startup-' + tag,
  direct, width, height, dpr, runs: []};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
const recorder = fs.readFileSync(path.join(__dirname, 'web-startup-probe.js'), 'utf8');
const candidate = option('worker');
const capture = process.argv.includes('--capture');
const plain = process.argv.includes('--plain');
const withoutSubgroups = process.argv.includes('--without-subgroups');
assert(!withoutSubgroups || capture && direct && selected === 'ours' && !plain && !cvars && !candidate,
  'Subgroup masking is only for an explicit fallback pipeline capture');
report.withoutSubgroups = withoutSubgroups;
function maskSubgroups() {
  const descriptor = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, 'features');
  Object.defineProperty(GPUAdapter.prototype, 'features', {...descriptor, get() {
    return new Set([...descriptor.get.call(this)].filter(feature => feature !== 'subgroups'));
  }});
}
const motionSeconds = Number(option('motion-seconds') || 0);
const scriptedMotionSeconds = Number(option('scripted-motion-seconds') || 0);
assert(!plain || (!capture && selected === 'ours' && !cvars && !candidate));
assert(Number.isFinite(motionSeconds) && motionSeconds >= 0 && motionSeconds <= 60);
assert(Number.isInteger(scriptedMotionSeconds) && scriptedMotionSeconds >= 0 && scriptedMotionSeconds <= 60);
assert(!scriptedMotionSeconds || capture && selected === 'ours' && !motionSeconds);
const noPrecache = process.argv.includes('--no-precache');
report.capture = capture;
report.noPrecache = noPrecache;
report.plain = plain;
report.motionSeconds = motionSeconds;
report.scriptedMotionSeconds = scriptedMotionSeconds;
report.package = require('./content-file-metadata.cjs').audit(
  path.join(__dirname, 'build', folder || profile.ours, 'asset-versions.json'));
const expectedPrewarm = require('./web-pipeline-prewarm-package.cjs')
  .readPage(path.dirname(report.package.file)).assets.pipelinePrewarm;
let context, server;
(async () => {
  try {
    let origin = option('origin') || (direct ? 'http://127.0.0.1:8765' : 'http://127.0.0.1:8766');
    if (serve) {
      server = require('./serve.cjs');
      await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
      });
      origin = 'http://127.0.0.1:' + server.address().port;
    }
    const browserProfile = path.join(__dirname, 'build/browser-profiles', profileNameOverride || 'startup-' + tag);
    context = await chromium.launchPersistentContext(browserProfile, {
      channel: browser,
      headless: false, viewport: {width, height}, deviceScaleFactor: dpr,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
    if (affinity) report.affinityCheck = require('./comparison-browser-affinity.cjs')(browserProfile, affinity, true);
    if (!plain) await context.addInitScript({content: recorder});
    if (folder) await context.route('**/' + profileName, async route => {
      const response = await route.fetch();
      await route.fulfill({response, json: {...profile, ours: folder}});
    });
    if (noPrecache) await context.route('**/build/*/index.html', async route => {
      const response = await route.fetch(), html = await response.text();
      const match = html.match(/arguments: (\[[^\n]+\]),/);
      assert(match);
      const args = JSON.parse(match[1]).filter(arg => arg !== '-WebPSOPrecacheTest');
      await route.fulfill({response, body: html.replace(match[0], 'arguments: ' + JSON.stringify(args) + ',')});
    });
    if (cvars) await context.route('**/config-files.json', async route => {
      const response = await route.fetch(), configs = await response.json();
      const config = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
      assert(config);
      const text = Buffer.from(config.data, 'base64').toString() +
        '\n[SystemSettings]\n' + cvars.split(',').join('\n') + '\n';
      config.data = Buffer.from(text).toString('base64');
      config.sha256 = require('node:crypto').createHash('sha256').update(text).digest('hex');
      await route.fulfill({response, json: configs});
    });
    if (!plain) await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: (capture ?
        'globalThis.__webStartupPSOCorpus = true;\n' +
        fs.readFileSync(path.join(__dirname, 'web-startup-profile.js'), 'utf8') + '\n' : '') +
        (withoutSubgroups ? '(' + maskSubgroups.toString() + ')();\n' : '') + recorder + '\n' +
        (candidate ? fs.readFileSync(path.resolve(candidate), 'utf8') : await response.text())});
    });
    const page = context.pages()[0];
    let run;
    page.on('console', message => {
      if (!run) return;
      const text = message.text();
      fs.appendFileSync(path.join(directory, `${run.index}-${run.engine}.log`), text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|HARNESS ABORT|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text)) run.errors.push(text);
    });
    page.on('pageerror', error => run?.errors.push(error.message));
    for (let index = 0; index < rounds; ++index) {
      for (const engine of selected ? [selected] : ['ours', 'official']) {
        run = {index, engine, errors: [], samples: []}; report.runs.push(run);
        console.log(JSON.stringify({index, engine, stage: 'starting'}));
        const began = Date.now();
        await page.goto(direct ? `${origin}/build/${folder}/index.html` :
          origin + '/villa-engine-comparison.html' +
          (noLumen ? '?lighting=off' : '') + '#' + engine);
        if (!direct) await page.waitForSelector('iframe');
        const frame = direct ? page : await (await page.locator('iframe').elementHandle()).contentFrame();
        while (Date.now() - began < 120000) {
          const sample = await frame.evaluate(() => ({
            elapsed: performance.now(), frames: globalThis.__webEngineFrames,
            ready: globalThis.__webPSOPrecacheReady, shown: document.getElementById('loading')?.hidden,
            failure: globalThis.__webEngineFailure,
            stage: globalThis.__webStartupDiagnostics?.stage,
            prewarm: globalThis.__webPipelinePrewarm,
            page: globalThis.__villaStartupProbe, worker: globalThis.__villaStartupWorker,
            official: globalThis.__ue59Performance, harness: globalThis.__harness?.timings,
            view: globalThis.__webRenderView,
            canvas: document.getElementById('canvas') ? {
              width: document.getElementById('canvas').width, height: document.getElementById('canvas').height
            } : null
          }));
          run.last = sample;
          run.samples.push({ms: Date.now() - began, frames: sample.frames, stage: sample.stage,
            pso: sample.worker?.pso, shown: sample.shown, presents: sample.page?.presents});
          const ready = engine === 'ours' ? sample.shown && sample.frames >= 30 :
            sample.page?.marks.some(mark => mark.name === 'official.ready') && sample.page.presents >= 30;
          if (sample.failure || run.errors.length || ready) {
            run.elapsedMs = Date.now() - began; run.pass = !!ready && !sample.failure && !run.errors.length;
            break;
          }
          await page.waitForTimeout(100);
        }
        if (run.pass && engine === 'ours' && expectedPrewarm)
          assert(run.last.prewarm?.ready && run.last.prewarm.adopted && run.last.prewarm.counts.hits > 0,
            'Published pipeline prewarm must be adopted and used');
        if (run.pass && motionSeconds && engine === 'ours') {
          run.motion = [];
          const state = () => frame.evaluate(() => ({
              frames: __webEngineFrames, camera: __webDefaultCamera, view: __webRenderView,
              settings: __webProjectSettings, prewarm: globalThis.__webPipelinePrewarm,
              failure: globalThis.__webEngineFailure
          }));
          const before = await state();
          run.motion.push(before);
          await page.screenshot({path: path.join(directory, `${index}-spawn.png`)});
          await frame.locator('canvas').focus();
          const box = await frame.locator('canvas').boundingBox();
          let held;
          for (let step = 0; step < motionSeconds; ++step) {
            const key = ['w', 'd', 's', 'a'][Math.floor(step / 3) % 4];
            if (key !== held) {
              if (held) await page.keyboard.up(held);
              await page.keyboard.down(key); held = key;
            }
            if (step % 4 === 0) {
              await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
              await page.mouse.down({button: 'right'});
              await page.mouse.move(box.x + box.width * .65, box.y + box.height * .5, {steps: 6});
              await page.mouse.up({button: 'right'});
            }
            if (step % 7 === 0) {
              await page.keyboard.down('Space'); await page.waitForTimeout(100);
              await page.keyboard.up('Space');
            }
            await page.waitForTimeout(1000);
            const after = await state();
            run.motion.push(after);
            assert(!after.failure && !run.errors.length, after.failure || run.errors.join('\n'));
            assert(after.frames > run.motion.at(-2).frames);
            assert.deepEqual(before.settings, after.settings);
            for (const key of ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing'])
              assert.equal(before.view[key], after.view[key]);
            if (step % 10 === 9) console.log(JSON.stringify({index, seconds: step + 1,
              frames: after.frames, prewarm: after.prewarm}));
          }
          if (held) await page.keyboard.up(held);
          run.maxTravelCm = Math.max(...run.motion.map(sample => Math.hypot(
            sample.camera.x - before.camera.x, sample.camera.y - before.camera.y, sample.camera.z - before.camera.z)));
          run.maxTurnDegrees = Math.max(...run.motion.map(sample =>
            Math.abs(((sample.camera.yaw - before.camera.yaw + 540) % 360) - 180)));
          assert(run.maxTravelCm > 50 && run.maxTurnDegrees > 10, 'Real movement and turning required');
        }
        if (run.pass && scriptedMotionSeconds && engine === 'ours') {
          run.scriptedMotion = [];
          for (const mode of [2, 1]) {
            const serial = await frame.evaluate(({mode, seconds}) =>
              __webEngineRPC('WebMotionBenchmarkControl', mode, seconds), {mode, seconds: scriptedMotionSeconds});
            assert(serial > 0);
            await frame.waitForFunction(serial => globalThis.__webEngineFailure ||
              globalThis.__webMotionBenchmark?.serial === serial && __webMotionBenchmark.completed,
              serial, {timeout: (scriptedMotionSeconds + 15) * 1000});
            const state = await frame.evaluate(() => ({motion: __webMotionBenchmark,
              frames: __webEngineFrames, failure: globalThis.__webEngineFailure}));
            assert(!state.failure && !run.errors.length && state.motion.updates > 5);
            run.scriptedMotion.push(state);
          }
        }
        if (run.pass && settleFrames && engine === 'ours') {
          const before = await frame.evaluate(() => __webEngineFrames);
          await frame.waitForFunction(before => globalThis.__webEngineFailure || __webEngineFrames >= before,
            before + settleFrames, {timeout: 60000});
          assert(!await frame.evaluate(() => globalThis.__webEngineFailure) && !run.errors.length,
            'Pipeline capture failed during settling');
          run.settleFrames = settleFrames;
        }
        save();
        if (capture && run.pass && engine === 'ours') {
          const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
          assert(owner);
          const corpus = await owner.evaluate(() => __webStartupProfile.exportPSOCorpus(true));
          fs.writeFileSync(path.join(directory, `${index}-corpus.json`), JSON.stringify(corpus));
        }
        console.log(JSON.stringify({index, engine, pass: run.pass, elapsedMs: run.elapsedMs,
          failure: run.last?.failure, calls: run.last?.worker?.calls, pso: run.last?.worker?.pso}));
        if (run.pass) await page.screenshot({path: path.join(directory, `${index}-${engine}.png`)});
        await page.goto('about:blank');
        run = null;
        await page.waitForTimeout(1500);
      }
    }
    report.pass = report.runs.every(run => run.pass);
    if (!report.pass) process.exitCode = 1;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {
    save(); await context?.close();
    if (server) await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
