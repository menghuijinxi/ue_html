const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag');
const folder = option('folder') || 'triplex-project-distance-fields-threads';
assert(/^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(folder));
const runs = Number(option('runs') || 3), seconds = Number(option('seconds') || 60);
assert(runs >= 1 && runs <= 10 && seconds >= 10 && seconds <= 600);
const width = Number(option('width') || 1533), height = Number(option('height') || 812);
const dpr = Number(option('dpr') || 1.21);
assert(width >= 640 && width <= 3840 && height >= 360 && height <= 2160 && dpr >= 1 && dpr <= 3);
const output = path.join(__dirname, 'results', `project-gameplay-${tag}`);
const report = {date: new Date().toISOString(), folder, width, height, dpr, requestedRuns: runs, seconds,
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  runs: [], settingsOverrides: [], pass: false};
const log = fs.createWriteStream(output + '.log');
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
let context;
(async () => {
  try {
    for (let run = 0; run < runs; ++run) {
      const result = {run, errors: [], samples: [], defaultPositionSRV: false, pass: false};
      report.runs.push(result);
      context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', `gameplay-${tag}-${run}`),
        {channel: 'msedge', headless: !process.argv.includes('--visible'), viewport: {width, height}, deviceScaleFactor: dpr});
      const page = context.pages()[0];
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('crash', () => result.errors.push('Renderer crashed'));
      page.on('console', message => {
        const text = message.text();
        log.write(`[${run}] ${text}\n`);
        if (text.includes('P3_DEFAULT_POSITION_SRV bytes=12 format=float32 zero=1')) result.defaultPositionSRV = true;
        if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) result.errors.push(text);
      });
      const start = Date.now();
      await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 2, null, {timeout: 900000});
      const snapshot = async label => {
        const state = await page.evaluate(() => ({frame: globalThis.__webEngineFrames,
          failure: globalThis.__webEngineFailure, camera: globalThis.__webDefaultCamera,
          view: globalThis.__webRenderView, settings: globalThis.__webProjectSettings,
          retirement: globalThis.__webGPUHandleDiagnostics,
          diagnostics: typeof startupSnapshot === 'function' ? startupSnapshot() : null}));
        if (state.diagnostics) {
          result.diagnostics = state.diagnostics;
          delete state.diagnostics;
        }
        result.samples.push({label, elapsedMilliseconds: Date.now() - start, ...state});
        save();
        assert(!state.failure, JSON.stringify(state.failure));
        assert(!result.errors.length, result.errors.join('\n'));
        return state;
      };
      await snapshot('spawn');
      await page.locator('canvas').focus();
      const keys = ['w', 'd', 's', 'a'];
      let held;
      for (let step = 0; step < seconds; ++step) {
        const key = keys[Math.floor(step / 3) % keys.length];
        if (held !== key) {
          if (held) await page.keyboard.up(held);
          await page.keyboard.down(key);
          held = key;
        }
        if (step % 7 === 0) {
          await page.keyboard.down('Space');
          const frame = await page.evaluate(() => globalThis.__webEngineFrames || 0);
          await page.waitForFunction(before => globalThis.__webEngineFailure || globalThis.__webEngineFrames > before + 1,
            frame, {timeout: 30000});
          await page.keyboard.up('Space');
        }
        if (step % 4 === 0) {
          await page.mouse.move(700, 400);
          await page.mouse.down({button: 'right'});
          await page.mouse.move(700 + (step % 8 ? -180 : 180), 410, {steps: 6});
          await page.mouse.up({button: 'right'});
        }
        if (step % 15 === 10) await page.setViewportSize({width: 1230, height: 694});
        if (step % 15 === 14) await page.setViewportSize({width, height});
        await page.waitForTimeout(1000);
        const state = await snapshot(`input-${step + 1}`);
        if (step > 4) assert(state.frame > result.samples.at(-3).frame, 'Engine frames stopped advancing');
        if (step % 10 === 9) console.log(JSON.stringify({run, step: step + 1, frame: state.frame, camera: state.camera}));
      }
      if (held) await page.keyboard.up(held);
      const cameras = result.samples.map(sample => sample.camera).filter(Boolean);
      const spawn = cameras[0];
      result.maxTravelCm = Math.max(...cameras.map(camera => Math.hypot(camera.x - spawn.x, camera.y - spawn.y, camera.z - spawn.z)));
      result.maxTurnDegrees = Math.max(...cameras.map(camera => Math.abs(((camera.yaw - spawn.yaw + 540) % 360) - 180)));
      assert(result.defaultPositionSRV, 'The repaired default position SRV must be created');
      assert(result.maxTravelCm > 50, 'Real player movement must be exercised');
      assert(result.maxTurnDegrees > 10, 'Real player rotation must be exercised');
      await page.locator('canvas').screenshot({path: output + `-${run}.png`, timeout: 60000});
      result.pass = true;
      console.log(JSON.stringify({run, pass: true, firstFrame: result.samples[0].frame,
        lastFrame: result.samples.at(-1).frame, seconds}));
      await context.close(); context = null;
      save();
    }
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally { save(); await context?.close(); log.end(); console.log(JSON.stringify({pass: report.pass, failure: report.failure, output})); }
})();
