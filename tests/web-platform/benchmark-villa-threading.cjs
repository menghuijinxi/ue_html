'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = n => process.argv.find(v => v.startsWith('--' + n + '='))?.slice(n.length + 3);
const folder = option('folder'), tag = option('tag');
assert([folder, tag].every(v => v && /^[a-z0-9-]+$/.test(v)));
const seconds = Number(option('seconds') || 20), warmup = Number(option('warmup') || 15);
const coreLimits = option('cores')?.split(',').map(Number);
assert(!coreLimits || (coreLimits.length && coreLimits.every(n => [4,6,8].includes(n)) && !option('modes')));
const modes = coreLimits ? coreLimits.map(() => 'full') :
  (option('modes') || 'full,render-serial,single,single,render-serial,full').split(',');
assert(modes.every(v => ['full', 'render-serial', 'single'].includes(v)) && seconds >= 5 && seconds <= 60);
assert(Number.isFinite(warmup) && warmup >= 0 && warmup <= 120);
const output = path.join(__dirname, 'results', tag), base = path.join(__dirname, 'build', folder);
const viewKey = view => ['width','height','outputWidth','outputHeight','antiAliasing','x','y','outputX','outputY'].map(k => view[k]);
assert(!fs.existsSync(output + '.json'), 'Use a fresh tag');
const report = {date: new Date().toISOString(), folder, seconds, warmup, runs: [], pass: false,
  coreLimits,
  source: audit(__filename), qualityOverrides: [], psoPrecache: false,
  packageFiles: ['index.html', 'UEWebEngineThreads.js', 'UEWebEngineThreads.wasm', 'config-files.json', 'content-files.json'].map(n => audit(path.join(base, n))),
  boundary: 'Same pthread WASM and Cook for every run; only startup threading/core-limit flags vary. Core tests retain full threading and map 4/6/8 reported cores to 3/5/7 UE task workers. Visible Edge, 2289x1287 CSS, DPR 1, fixed default spawn, normal browser cache. Timings use completed RHI viewport presents, no per-draw instrumentation or CPU sampling.'};
function install() {
  const state = globalThis.__threadingCapture = {active: false, times: []};
  let count = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true,
    get: () => count,
    set(value) {if (value > count && state.active) state.times.push(performance.now()); count = value;}
  });
}
function distribution(values) {
  assert(values.length);
  const sorted = [...values].sort((a,b) => a-b), mean = values.reduce((a,b) => a+b,0)/values.length;
  const slow = sorted.slice(-Math.max(1, Math.ceil(values.length*.01)));
  return {count: values.length, mean, p50: sorted[Math.floor(sorted.length*.5)],
    p95: sorted[Math.floor((sorted.length-1)*.95)], p99: sorted[Math.floor((sorted.length-1)*.99)],
    low1Fps: 1000/(slow.reduce((a,b)=>a+b,0)/slow.length), over33ms: values.filter(v=>v>1000/30).length};
}
let context;
async function profileBlockedWorker(file, all = false) {
  const cdp = await context.browser().newBrowserCDPSession();
  const {targetInfos} = await cdp.send('Target.getTargets');
  const targets = targetInfos.filter(t => t.type === 'worker' &&
    (all || t.url.includes('web-engine-worker.js')));
  assert(targets.length);
  let id=0; const pending=new Map(), sessions=[];
  cdp.on('Target.receivedMessageFromTarget', e => {
    const m=JSON.parse(e.message), p=pending.get(m.id);
    if(p){pending.delete(m.id); m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
  });
  const command=(sessionId,method,params={})=>new Promise((resolve,reject)=>{
    const key=++id;pending.set(key,{resolve,reject});
    cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:key,method,params})}).catch(reject);
  });
  for(const target of targets){
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
    await command(sessionId,'Profiler.enable'); await command(sessionId,'Profiler.start'); sessions.push({target,sessionId});
  }
  await new Promise(resolve=>setTimeout(resolve,all?5000:1500));
  for(let i=0;i<sessions.length;i++){
    const {target,sessionId}=sessions[i],{profile}=await command(sessionId,'Profiler.stop');
    fs.writeFileSync(all?file.replace('.cpuprofile','-'+i+'.cpuprofile'):file,JSON.stringify(profile));
  }
  if(all)fs.writeFileSync(file.replace('.cpuprofile','-targets.json'),JSON.stringify(sessions,null,2));
  await cdp.detach();
}
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/threading-ab'),
      {channel: 'msedge', headless: false, viewport: {width: 2289, height: 1287}, deviceScaleFactor: 1});
    const page = context.pages()[0], input = await context.newCDPSession(page);
    await input.send('Input.setIgnoreInputEvents', {ignore: true});
    await input.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    let mode, run, log;
    await context.route('**/index.html', async route => {
      const response = await route.fetch(); let html = await response.text();
      const match = html.match(/arguments: (\[[^\n]+\]),/); assert(match);
      const args = JSON.parse(match[1]); assert(!args.some(v => /PSOPrecache|VisualTestClock/.test(v)));
      assert(!args.some(v => /^-(corelimit|WebThreadingTest)=/.test(v)), 'Use a package without baked-in threading overrides');
      args.push('-WebThreadingTest=' + mode);
      if (run.coreLimit) args.push('-corelimit=' + run.coreLimit);
      html = html.replace(match[0], 'arguments: ' + JSON.stringify(args) + ',');
      await route.fulfill({response, body: html});
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: '(' + install.toString() + ')();\n' + await response.text()});
    });
    page.on('console', m => {const text = m.text(); log?.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|P3_ENGINE_PREINIT_FAILED|P3_ENGINE_INIT_FAILED|thread pool is exhausted|Failed to create thread|pthread_create.*failed/i.test(text)) run?.errors.push(text);});
    page.on('pageerror', e => run?.errors.push(e.message));
    for (let index = 0; index < modes.length; ++index) {
      mode = modes[index]; run = {mode, coreLimit:coreLimits?.[index] || null, index: index+1, started:new Date().toISOString(), errors: []}; report.runs.push(run);
      log = fs.createWriteStream(output + '-' + run.index + '-' + mode + '.log');
      console.log('Web start', run.index, mode, run.coreLimit || 'default cores');
      await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
      try {
        await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90, null,
          {timeout:Number(option('startup-timeout') || 120000)});
      } catch(error) {
        if(process.argv.includes('--diagnose-blocked')) await profileBlockedWorker(output+'-blocked.cpuprofile');
        throw error;
      }
      const failure = await page.evaluate(() => globalThis.__webEngineFailure);
      assert(!failure, JSON.stringify(failure));
      report.browser = {version:context.browser().version(), ...await page.evaluate(() =>
        ({userAgent:navigator.userAgent, hardwareConcurrency:navigator.hardwareConcurrency}))};
      const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
      const state = () => owner.evaluate(() => ({frames: globalThis.__webRHIFrames, gameFrames: globalThis.__webEngineFrames,
        threads: globalThis.__webEngineThreads, stages: globalThis.__webThreadStages,
        view: globalThis.__webRenderView, settings: globalThis.__webProjectSettings, camera: globalThis.__webDefaultCamera,
        occlusion: globalThis.__webOcclusionRHI, memory: globalThis.__webTextureStreaming, io: globalThis.__webContentIO?.stats}));
      await page.waitForTimeout(warmup*1000);
      run.before = await state();
      const threads = run.before.threads; assert(threads);
      assert.equal(threads.renderThread, mode === 'full'); assert.equal(threads.rhiThread, mode === 'full');
      assert.equal(threads.threadingTest, mode === 'full' ? 0 : mode === 'render-serial' ? 1 : 2);
      if (mode === 'single') assert.equal(threads.taskWorkers, 0);
      else assert(threads.taskWorkers > 0);
      const ids = [threads.gameThread, threads.renderThreadId, threads.rhiThreadId];
      assert.equal(new Set(ids).size, mode === 'full' ? 3 : 1);
      if (run.coreLimit) {
        assert.equal(threads.cores, run.coreLimit, 'Requested core limit did not take effect');
        assert.equal(threads.taskWorkers, run.coreLimit - 1, 'Unexpected UE task worker count');
      }
      await owner.evaluate(() => {const s = __threadingCapture; s.times = []; s.start = performance.now(); s.startFrame = __webRHIFrames; s.active = true;});
      await page.waitForTimeout(seconds*1000);
      run.measurement = await owner.evaluate(() => {const s = __threadingCapture; s.active = false;
        return {timeOrigin:performance.timeOrigin, start:s.start, end:performance.now(), frames:__webRHIFrames-s.startFrame, times:s.times};});
      run.after = await state();
      assert.deepEqual(run.after.camera, run.before.camera, 'Camera moved');
      assert.deepEqual(viewKey(run.after.view), viewKey(run.before.view), 'Resolution or AA changed');
      assert.deepEqual(run.after.settings, run.before.settings, 'Renderer settings changed');
      assert.equal(run.errors.length, 0, run.errors.join('\n'));
      run.fps = run.measurement.frames/(run.measurement.end-run.measurement.start)*1000;
      run.intervals = run.measurement.times.slice(1).map((t,i)=>t-run.measurement.times[i]);
      run.frameMs = distribution(run.intervals);
      run.resourceProxyCallsPerFrame = (run.after.stages.resourceProxyCalls-run.before.stages.resourceProxyCalls)/run.measurement.frames;
      if (mode === 'full') run.rhiWorkMs = (run.after.stages.rhiWorkMilliseconds-run.before.stages.rhiWorkMilliseconds)/run.measurement.frames;
      const oldCounters=run.before.occlusion, newCounters=run.after.occlusion;
      const sampleFrames=newCounters.sampleFrame-oldCounters.sampleFrame;
      assert(sampleFrames>0);
      run.workload={sampleFrames, ...Object.fromEntries(['draws','indirectDraws','dispatches'].map(k=>
        [k+'PerFrame',(newCounters[k]-oldCounters[k])/sampleFrames]))};
      await page.locator('canvas').screenshot({path: output + '-' + run.index + '-' + mode + '.png'});
      if(process.argv.includes('--profile-workers')) await profileBlockedWorker(output+'-'+run.index+'-workers.cpuprofile',true);
      log.end(); log = null;
      fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
      console.log(JSON.stringify({mode, coreLimit:run.coreLimit, fps:run.fps, low1:run.frameMs.low1Fps, threads, workload:run.workload, view:run.before.view}));
      // Stop the old engine before the next mode; no two test engines coexist.
      await page.goto('about:blank');
      await page.waitForTimeout(1500);
    }
    report.summary = {};
    const group = r => coreLimits ? String(r.coreLimit) : r.mode;
    for (const key of new Set(report.runs.map(group))) {
      const runs = report.runs.filter(r=>group(r)===key), frames = runs.reduce((s,r)=>s+r.measurement.frames,0);
      const ms = runs.reduce((s,r)=>s+r.measurement.end-r.measurement.start,0);
      report.summary[key] = {fps:frames/ms*1000, frameMs:distribution(runs.flatMap(r=>r.intervals))};
      for (const r of runs) {
        assert.deepEqual(viewKey(r.before.view), viewKey(report.runs[0].before.view));
        assert.deepEqual(r.before.camera, report.runs[0].before.camera);
        assert.deepEqual(r.before.settings, report.runs[0].before.settings);
      }
    }
    report.pass = true; console.log(JSON.stringify(report.summary, null, 2));
  } catch (error) {report.error = error.stack; process.exitCode = 1; console.error(error.stack);}
  finally {await context?.close(); fs.writeFileSync(output+'.json', JSON.stringify(report,null,2));}
})();
