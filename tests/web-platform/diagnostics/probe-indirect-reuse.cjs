'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('../content-file-metadata.cjs');
const [folder, tag] = process.argv.slice(2);
assert([folder, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const base = path.resolve(__dirname, '..'), directory = path.join(base, 'results', tag);
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename),
  package: audit(path.join(base, 'build', folder, 'asset-versions.json')), phases: [], errors: [],
  boundary: 'Short instrumented command identity sample, not performance timing.'};
function install() {
  const probe = globalThis.__indirectReuse = {active: false, frames: [], current: null};
  const ids = new WeakMap(), states = new WeakMap(); let sequence = 0, frame = 0;
  const id = value => {if (!value) return 0; if (!ids.has(value)) ids.set(value, ++sequence); return ids.get(value);};
  const begin = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function(desc) {
    const pass = begin.call(this, desc);
    states.set(pass, {label: desc.label, pipeline: 0, groups: [], vertex: [], index: []}); return pass;
  };
  for (const name of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'drawIndexedIndirect']) {
    const original = GPURenderPassEncoder.prototype[name];
    GPURenderPassEncoder.prototype[name] = function(...args) {
      if (probe.active && probe.current) {
        const state = states.get(this), current = probe.current;
        current.calls[name] = (current.calls[name] || 0) + 1;
        let previous, next;
        if (name === 'setPipeline') {previous = state.pipeline; next = id(args[0]); state.pipeline = next;}
        if (name === 'setBindGroup') {
          previous = state.groups[args[0]];
          const raw = args[2] || [], start = args[3] || 0;
          const end = args[4] === undefined ? raw.length : start + args[4];
          const offsets = Array.from(raw.subarray ? raw.subarray(start, end) : raw.slice(start, end));
          next = id(args[1]) + ':' + offsets.join(','); state.groups[args[0]] = next;
        }
        if (name === 'setVertexBuffer') {
          previous = state.vertex[args[0]]; next = [id(args[1]), args[2] || 0, args[3]].join(':');
          state.vertex[args[0]] = next;
        }
        if (name === 'setIndexBuffer') {
          previous = state.index; next = [id(args[0]), ...args.slice(1)].join(':'); state.index = next;
        }
        if (name !== 'drawIndexedIndirect' && previous === next)
          current.duplicates[name] = (current.duplicates[name] || 0) + 1;
        if (name === 'drawIndexedIndirect') {
          const parts = [state.label, state.pipeline, state.groups, state.vertex, state.index,
            id(args[0]), args[1]];
          const key = JSON.stringify(parts);
          current.keys.push(key);
          if (current.parts.length < 2) current.parts.push(parts);
        }
      }
      return original.apply(this, args);
    };
  }
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => frame, set(value) {
    if (probe.active && value > frame) {
      if (probe.current) probe.frames.push(probe.current);
      probe.current = {frame: value, calls: {}, duplicates: {}, keys: [], parts: []};
      if (probe.frames.length >= 24) probe.active = false;
    }
    frame = value;
  }});
}
let context, log;
(async () => {
  try {
    process.env.TEMP = process.env.TMP = path.join(base, 'build/test-tmp');
    context = await chromium.launchPersistentContext(path.join(base,
      'build/browser-profiles/vsm-adaptive-production-20261112'), {channel: 'msedge', headless: false,
      viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: '(' + install.toString() + ')();\n' + await response.text()});
    });
    const page = await context.newPage();
    for (const previous of context.pages()) if (previous !== page) await previous.close();
    log = fs.createWriteStream(path.join(directory, 'page.log'));
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      log.write(message.text() + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost/.test(message.text()))
        report.errors.push(message.text());
    });
    await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 60 && document.getElementById('loading')?.hidden,
      null, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    const motion = (seconds, mode) => page.evaluate(({seconds, mode}) =>
      __webEngineRPC('WebMotionBenchmarkControl', mode, seconds), {seconds, mode});
    for (const [name, mode] of [['standing', 0], ['turning', 2]]) {
      await motion(0, 2);
      if (mode) await motion(30, mode);
      await page.waitForTimeout(3000);
      await owner.evaluate(() => Object.assign(__indirectReuse, {active: true, frames: [], current: null}));
      await page.waitForTimeout(6000);
      const data = await owner.evaluate(() => __indirectReuse);
      assert(data.frames.length >= 6);
      const first = new Set(data.frames[1].keys);
      const prior = data.frames.map(frame => new Set(frame.keys));
      report.phases.push({name, frames: data.frames.map((frame, index) => ({
        frame: frame.frame, calls: frame.calls, duplicates: frame.duplicates,
        indirect: frame.keys.length, uniqueKeys: new Set(frame.keys).size,
        firstCommands: frame.parts,
        sameAsFirst: frame.keys.filter(key => first.has(key)).length,
        sameAsPrevious: index ? frame.keys.filter(key => prior[index - 1].has(key)).length : 0,
        bestEarlier: index ? Math.max(...prior.slice(0, index).map(set => frame.keys.filter(key => set.has(key)).length)) : 0
      }))});
      console.log(JSON.stringify(report.phases.at(-1)));
    }
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    await context?.close();
    log?.end();
  }
})();
