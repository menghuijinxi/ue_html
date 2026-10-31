const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const processMemory = require('./gpu-process-memory.cjs');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag'), folder = option('folder') || 'triplex-project-distance-fields-threads';
assert(/^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(folder));
const seconds = Number(option('seconds') || 15);
const output = path.join(__dirname, 'results', `cpu-${tag}`);
const report = {date: new Date().toISOString(), tag, folder, seconds, settingsOverrides: [], samples: [], errors: [], pass: false};
let context;
function countGPUCalls() {
  const counts = globalThis.__cpuGPUCalls = {};
  for (const [prototype, names] of [[GPUDevice.prototype, ['createBindGroup', 'createBuffer']],
    [GPUQueue.prototype, ['submit', 'writeBuffer']], [GPURenderPassEncoder.prototype, ['draw', 'drawIndexed']]]) {
    for (const name of names) {
      const original = prototype[name];
      prototype[name] = function(...args) { counts[name] = (counts[name] || 0) + 1; return original.apply(this, args); };
    }
  }
}
function summarize(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  const self = new Map(), total = new Map();
  for (let i = 0; i < profile.samples.length; ++i) {
    const id = profile.samples[i], delta = profile.timeDeltas[i];
    self.set(id, (self.get(id) || 0) + delta);
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) total.set(cursor, (total.get(cursor) || 0) + delta);
  }
  const rank = values => [...values].map(([id, us]) => ({name: nodes.get(id).callFrame.functionName,
    url: nodes.get(id).callFrame.url, milliseconds: us / 1000})).sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 50);
  return {durationMs: (profile.endTime - profile.startTime) / 1000, samples: profile.samples.length, self: rank(self), total: rank(total)};
}
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', 'cpu-villa'),
      {channel: 'msedge', headless: !process.argv.includes('--visible'), viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${countGPUCalls.toString()})();\n` + await response.text()});
    });
    const page = context.pages()[0];
    page.on('pageerror', error => report.errors.push(error.message));
    const logs = fs.createWriteStream(output + '.log');
    page.on('console', message => { const text = message.text(); logs.write(text + '\n');
      report.logCount = (report.logCount || 0) + 1;
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) report.errors.push(text);
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90, null, {timeout: 900000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    assert(owner);
    const cdp = await context.browser().newBrowserCDPSession();
    const {targetInfos} = await cdp.send('Target.getTargets');
    const target = targetInfos.find(target => target.type === 'worker' && target.url.includes('web-engine-worker.js'));
    assert(target);
    const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
    let id = 0;
    const pending = new Map();
    cdp.on('Target.receivedMessageFromTarget', event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message), task = pending.get(message.id);
      if (task) { pending.delete(message.id); message.error ? task.reject(Error(JSON.stringify(message.error))) : task.resolve(message.result); }
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id; pending.set(key, {resolve, reject});
      cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id: key, method, params})}).catch(reject);
    });
    await command('Profiler.enable');
    await command('Profiler.setSamplingInterval', {interval: 500});
    const state = () => owner.evaluate(() => ({frame: __webEngineFrames, times: globalThis.__webThreadFrameTimes,
      threads: globalThis.__webEngineThreads, pool: typeof PThread !== 'undefined' ? {active: Object.keys(PThread.pthreads).length,
        available: PThread.unusedWorkers.length} : null, camera: globalThis.__webDefaultCamera, view: globalThis.__webRenderView,
      settings: globalThis.__webProjectSettings, runtime: globalThis.__webEngineRuntime, calls: globalThis.__cpuGPUCalls,
      occlusion: globalThis.__webOcclusionRHI, retirement: globalThis.__webGPUHandleDiagnostics}));
    const views = process.argv.includes('--spawn') ? [null] : [[-175, -80, 160, -5, 50], [-175, -80, 160, -5, 230]];
    for (let index = 0; index < views.length; ++index) {
      if (views[index]) await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), views[index]);
      const first = (await state()).frame;
      await page.waitForFunction(frame => globalThis.__webEngineFailure || globalThis.__webEngineFrames > frame + 90, first, {timeout: 180000});
      const before = await state(), logCount = report.logCount, start = Date.now();
      await command('Profiler.start');
      await page.waitForTimeout(seconds * 1000);
      const {profile} = await command('Profiler.stop');
      const after = await state(), durationMs = Date.now() - start;
      fs.writeFileSync(output + `-${index}.cpuprofile`, JSON.stringify(profile));
      const sample = {before, after, durationMs, fps: (after.frame - before.frame) / durationMs * 1000,
        logs: report.logCount - logCount, profile: summarize(profile),
        callsPerFrame: Object.fromEntries(Object.entries(after.calls).map(([key, value]) =>
          [key, (value - (before.calls[key] || 0)) / (after.frame - before.frame)])),
        memory: processMemory({profile: path.join(__dirname, 'build/browser-profiles', 'cpu-villa')})};
      report.samples.push(sample);
      fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
      console.log(JSON.stringify({index, fps: sample.fps, logs: sample.logs, threads: after.threads, pool: after.pool,
        self: sample.profile.self.slice(0, 14), total: sample.profile.total.slice(0, 14)}));
    }
    report.pass = !report.errors.length;
    logs.end();
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally { fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2)); await context?.close();
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, output})); }
})();
