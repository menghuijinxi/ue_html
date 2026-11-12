'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), sharp = require('sharp');
const {audit} = require('./content-file-metadata.cjs');
const {readPage} = require('./web-pipeline-prewarm-package.cjs');
const [folder, tag, probeFolder] = process.argv.slice(2);
assert(folder && tag && [folder, tag].every(value => /^[a-z0-9-]+$/.test(value)));
assert(probeFolder && fs.existsSync(probeFolder), 'Supply the successful all-permutation probe folder');
const packageRoot = path.join(__dirname, 'build', folder), directory = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const assets = readPage(packageRoot).assets;
assert.equal(assets.vsmAdaptiveSampling, 'cooked-with-fallback');
assert(assets.pipelinePrewarm);
const pack = JSON.parse(fs.readFileSync(path.join(packageRoot, 'pipeline-prewarm.json')));
assert(pack.devices[0].descriptor.requiredFeatures.includes('subgroups'));
const report = {date: new Date().toISOString(), pass: false,
  package: audit(path.join(packageRoot, 'asset-versions.json')), runs: [],
  sources: [__filename, 'web-pipeline-prewarm.js', 'web-engine-worker.js'].map(file => audit(path.resolve(__dirname, file))),
  boundary: 'Real adaptive cooked scene, prewarm adoption, player input, movement and physical sizing. Standalone VSM fallback module validation does not establish whole-scene compatibility without subgroups or a controlled performance result.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
const poseKeys = ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'controlPitch', 'controlYaw', 'controlRoll'];
process.env.TEMP = process.env.TMP = path.join(__dirname, 'build/test-tmp');
let context;
(async () => {
  try {
    for (const dpr of [1.5, 1]) {
      const adaptive = true, name = 'adaptive-dpr-' + String(dpr).replace('.', '-');
      const run = {name, dpr, errors: [], checks: [], states: []}; report.runs.push(run); save();
      context = await chromium.launchPersistentContext(
        path.join(__dirname, 'build/browser-profiles/vsm-adaptive-production-20261112'), {
          channel: 'msedge', headless: false, viewport: {width: 1600, height: 1000}, deviceScaleFactor: dpr,
          args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
        });
      const page = context.pages()[0] || await context.newPage();
      for (const previous of context.pages()) if (previous !== page) await previous.close();
      await page.goto('about:blank');
      const log = fs.createWriteStream(path.join(directory, name + '.log'));
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
          run.errors.push(text);
      });
      page.on('pageerror', error => run.errors.push(error.message));
      const snapshot = () => page.evaluate(() => ({
        frames: globalThis.__webEngineFrames, failure: globalThis.__webEngineFailure,
        sampling: globalThis.__webVSMAdaptiveSampling, prewarm: globalThis.__webPipelinePrewarm,
        settings: globalThis.__webProjectSettings, view: globalThis.__webRenderView,
        camera: globalThis.__webDefaultCamera, player: globalThis.__webPlayerView,
        metrics: globalThis.__webLivePerformance?.submitted,
        canvas: {width: document.getElementById('canvas')?.width, height: document.getElementById('canvas')?.height},
        diagnosticProbe: globalThis.__webVSMAdaptiveProbe
      }));
      function verify(state) {
        assert(!state.failure, state.failure);
        assert.deepEqual(run.errors, []);
        assert.equal(state.diagnosticProbe, undefined, 'A release must run its cooked shaders without diagnostic replacement');
        assert.equal(state.sampling.enabled, adaptive);
        assert.equal(state.sampling.supported, adaptive);
        assert(state.sampling[adaptive ? 'adaptiveModules' : 'fullSamplingModules'] > 0);
        assert.equal(state.sampling[adaptive ? 'fullSamplingModules' : 'adaptiveModules'], 0);
        for (const key of ['gi', 'reflections', 'virtualTextures', 'virtualShadows'])
          assert.equal(state.settings[key], 1);
        assert(state.settings.virtualTexturePathActive && state.settings.virtualShadowPathActive);
        assert(state.prewarm.ready && state.prewarm.adopted && state.prewarm.counts.hits > 0);
        assert.deepEqual([state.view.width, state.view.height, state.view.outputWidth, state.view.outputHeight,
          state.view.antiAliasing, state.canvas.width, state.canvas.height], [1400, 788, 1920, 1080, 4, 1920, 1080]);
      }
      await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        globalThis.__webVSMAdaptiveSampling && globalThis.__webEngineFrames >= 30 && document.getElementById('loading')?.hidden,
        null, {timeout: 240000});
      const initial = await snapshot(); verify(initial); run.states.push(initial); save();
      const restore = async player => {
        const serial = await page.evaluate(({keys, player}) =>
          __webEngineRPC('WebPlayerViewControl', player ? 1 : 0, ...keys.map(key => player ? player[key] : 0)),
          {keys: poseKeys, player});
        assert(serial > 0);
        await page.waitForFunction(serial => globalThis.__webPlayerView?.active && __webPlayerView.serial === serial,
          serial, {timeout: 10000});
        await page.waitForTimeout(400);
        return snapshot();
      };
      const native = await restore(null), offset = native.camera.z - native.player.z;
      const kitchen = {...native.player, x: -175, y: -80, z: 160 - offset, pitch: 0, yaw: 230,
        controlPitch: -5, controlYaw: 230};
      await restore(kitchen);
      await page.waitForTimeout(2500);
      const box = await page.locator('#canvas').boundingBox();
      await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
      const before = await snapshot(); verify(before);
      let moved, distance = 0;
      for (const key of ['w', 's', 'a', 'd']) {
        try {await page.keyboard.down(key); await page.waitForTimeout(900);}
        finally {await page.keyboard.up(key);}
        await page.waitForTimeout(300); moved = await snapshot();
        distance = Math.hypot(...['x', 'y', 'z'].map(axis => moved.camera[axis] - before.camera[axis]));
        if (distance > 10) break;
      }
      assert(distance > 10, 'Native player input must move the visible camera');
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
      try {
        await page.mouse.down({button: 'right'});
        for (let step = 1; step <= 20; ++step) {
          await page.mouse.move(box.x + box.width * (.5 + step * .007), box.y + box.height * .5);
          await page.waitForTimeout(30);
        }
      } finally {await page.mouse.up({button: 'right'});}
      await page.waitForTimeout(500);
      const turned = await snapshot(), yaw = Math.abs((turned.camera.yaw - moved.camera.yaw + 540) % 360 - 180);
      assert(yaw > 5, 'Native mouse input must rotate the visible camera');
      verify(turned); run.checks.push({name: 'native-player-input', distance, yaw}); save();
      for (const mode of [2, 1]) {
        await restore(kitchen);
        const serial = await page.evaluate(mode => __webEngineRPC('WebMotionBenchmarkControl', mode, 12), mode);
        await page.waitForFunction(serial => globalThis.__webEngineFailure ||
          globalThis.__webMotionBenchmark?.serial === serial && __webMotionBenchmark.completed, serial, {timeout: 30000});
        const after = await snapshot(); verify(after); run.states.push(after); save();
      }
      await restore(kitchen); await page.waitForTimeout(2000);
      await page.screenshot({path: path.join(directory, name + '.png')});
      const pixels = await page.screenshot({clip: {x: box.x + box.width * .3, y: box.y + box.height * .3,
        width: box.width * .4, height: box.height * .4}});
      const stats = (await sharp(pixels).stats()).channels.slice(0, 3);
      assert(stats.every(channel => channel.mean > 3 && channel.stdev > 5), 'Scene must be nonblank');
      run.checks.push({name: 'nonblank-scene', pixels: stats});
      const final = await snapshot(); verify(final);
      assert(final.prewarm.counts.hits > initial.prewarm.counts.hits);
      run.states.push(final); run.pass = true; save();
      console.log(JSON.stringify({name, pass: true, sampling: final.sampling, prewarm: final.prewarm.counts}));
      await page.goto('about:blank'); log.end();
      if (dpr === 1) {
        const probe = JSON.parse(fs.readFileSync(path.join(probeFolder, 'virtual-resource-shader-results.json'), 'utf8')
          .replace(/^\uFEFF/, ''));
        assert(probe.pass && probe.allPermutations);
        const modules = fs.readdirSync(path.join(probeFolder, 'ShaderConversion'), {withFileTypes: true})
          .filter(entry => entry.isDirectory()).flatMap(entry => {
            const file = path.join(probeFolder, 'ShaderConversion', entry.name, 'input.json');
            if (!fs.existsSync(file)) return [];
            const input = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
            const metadata = input.metadata;
            return metadata?.vsmFullSamplingMetadata ? [{name: input.shader,
              fallback: metadata.vsmFullSamplingWgsl,
              adaptive: fs.readFileSync(path.join(path.dirname(file), 'output.wgsl'), 'utf8')}] : [];
          });
        assert.equal(modules.length, probe.cases.length);
        await page.goto('http://127.0.0.1:8765');
        report.fallbackModules = await page.evaluate(async modules => {
          const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
          if (device.features.has('subgroups')) throw Error('Negative control requires a device without subgroups');
          const errors = [];
          device.addEventListener('uncapturederror', event => errors.push(event.error.message));
          let next = 0, checked = 0;
          await Promise.all(Array.from({length: 4}, async () => {
            while (next < modules.length) {
              const item = modules[next++], shader = device.createShaderModule({code: item.fallback});
              const messages = (await shader.getCompilationInfo()).messages.filter(message => message.type === 'error');
              if (messages.length) throw Error(item.name + ': ' + messages.map(message => message.message).join('\n'));
              checked++;
            }
          }));
          device.pushErrorScope('validation');
          const invalid = device.createShaderModule({code: modules[0].adaptive});
          const negative = (await invalid.getCompilationInfo()).messages.filter(message => message.type === 'error');
          const rejection = await device.popErrorScope();
          device.destroy();
          return {checked, errors, adaptiveRejected: negative.length > 0 && !!rejection};
        }, modules);
        assert.equal(report.fallbackModules.checked, probe.cases.length);
        assert.deepEqual(report.fallbackModules.errors, []);
        assert(report.fallbackModules.adaptiveRejected);
        save();
      }
      await context.close(); context = null;
    }
    report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); await context?.close();}
})();
