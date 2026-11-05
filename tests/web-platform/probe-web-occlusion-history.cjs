'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const {execFileSync} = require('node:child_process');
const option = n => process.argv.find(v => v.startsWith('--' + n + '='))?.slice(n.length + 3);
const folder = option('folder'), tag = option('tag');
assert([folder, tag].every(v => v && /^[a-z0-9-]+$/.test(v)));
const modes = (option('modes') || 'control,history,hzb,instances,instances,hzb,history,control').split(',');
assert(modes.every(v => v==='default' || /^(control|history|hzb|instances|hzb-instances)(-local)?$/.test(v)));
const seconds = Number(option('seconds') || 20), warmup = Number(option('warmup') || 15);
assert(seconds >= 5 && seconds <= 60 && warmup >= 5 && warmup <= 120);
const tour = process.argv.includes('--tour');
const lifecycle = process.argv.includes('--lifecycle');
const initialHidden = process.argv.includes('--initial-hidden');
assert(!initialHidden || modes.every(mode=>mode==='default' || mode.endsWith('-local')));
const output = path.join(__dirname, 'results', tag), base = path.join(__dirname, 'build', folder);
assert(!fs.existsSync(output + '.json'), 'Use a fresh tag');
fs.copyFileSync(__filename, output + '-source.cjs');
const runtime = fs.readdirSync(base).find(v => /^UEWebEngineThreads\w*\.js$/.test(v)); assert(runtime);
const report = {date: new Date().toISOString(), folder, modes, seconds, warmup, tour, lifecycle, initialHidden, pass: false,
  source: audit(output + '-source.cjs'),
  packageFiles: ['index.html', runtime, runtime.replace(/\.js$/, '.wasm'), 'config-files.json', 'content-files.json',
    'web-engine-host.js', 'web-engine-worker.js'].map(f => audit(path.join(base, f))),
  qualityOverrides: [], runs: [], boundary: 'Fresh visible Edge session per run. Original Cook, lighting, resolution and two-frame legacy query history. Nonblocking candidates use matched primitive identities and bounded-age results. No CPU profiler, per-draw wrapper, extra GPU timestamp or extra GPU query. Built-in history counters remain enabled and their cost is included. FPS is RHI submission throughput, not physical display. Visual acceptance remains manual.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
function idleGpu() {
  try {
    const csv = execFileSync('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits'], {encoding:'utf8',windowsHide:true,timeout:10000}).trim();
    return {at:new Date().toISOString(), adapters:csv.split(/\r?\n/).map(line=>{
      const [name,utilization,memoryUsedMiB,memoryTotalMiB]=line.split(',').map(v=>v.trim());
      return {name,utilization:Number(utilization),memoryUsedMiB:Number(memoryUsedMiB),memoryTotalMiB:Number(memoryTotalMiB)};
    })};
  } catch { return {available:false}; }
}
const stableView = v => Object.fromEntries(Object.entries(v).filter(([k]) => !['frame', 'threadId'].includes(k)));
function distribution(values) {
  const sorted = [...values].sort((a,b) => a-b); assert(sorted.length);
  const tail = sorted.slice(-Math.ceil(sorted.length * .01));
  return {count: sorted.length, p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.floor(sorted.length*.95)],
    p99: sorted[Math.floor(sorted.length*.99)], maximum: sorted.at(-1),
    low1Fps: 1000 * tail.length / tail.reduce((s,v) => s+v,0)};
}
function presents() {
  let count = 0;
  const capture = globalThis.__occlusionCapture = {active: false, times: []};
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => count,
    set(value) {if(capture.active && value > count) capture.times.push(performance.now()); count=value;}});
}
let context, log;
(async()=>{try {
  report.idleGpu=idleGpu();save();
  assert(!report.idleGpu.adapters?.some(v=>v.utilization>50),'GPU already busy before the test browser starts; free it before benchmarking');
  for(const mode of modes) {
    const local = mode==='default' || mode.endsWith('-local');
    const occlusionMode = mode==='default' ? 'history' : local ? mode.slice(0,-6) : mode;
    const run = {index: report.runs.length+1, mode, local, errors: []}; report.runs.push(run); save();
    run.idleGpu=idleGpu();save();
    assert(!run.idleGpu.adapters?.some(v=>v.utilization>50),'GPU busy between runs; free it before benchmarking');
    context = await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/occlusion-history'),
      {channel:'msedge',headless:false,viewport:{width:2289,height:1287},deviceScaleFactor:1});
    await context.route('**/web-engine-worker.js?*',async route=>{
      const response=await route.fetch();
      await route.fulfill({response,body:'('+presents.toString()+')();\n'+await response.text()});
    });
    const page=context.pages()[0], cdp=await context.newCDPSession(page);
    if(initialHidden) await page.addInitScript(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));
    await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
    await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    log=fs.createWriteStream(output+'-'+run.index+'-'+mode+'.log');
    page.on('console',m=>{const t=m.text();log?.write(t+'\n');
      if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|Ensure condition failed|P3_ENGINE_.*FAILED/.test(t))run.errors.push(t);});
    page.on('pageerror',e=>run.errors.push(e.message));
    page.on('crash',()=>run.errors.push('Page crashed'));
    console.log('Occlusion start',run.index,mode);
    run.url='http://127.0.0.1:8765/build/'+folder+'/index.html'+
      (mode==='default'?'':'?occlusion='+occlusionMode+'&clock='+(local?'local':'owner'));
    await page.goto(run.url,{waitUntil:'commit'});
    await page.bringToFront();
    if(initialHidden) {
      await page.waitForFunction(()=>globalThis.__webGameFrameClock?.paused===true,null,{timeout:180000});
      const snapshot=()=>page.evaluate(()=>({clock:__webGameFrameClock,frame:globalThis.__webEngineFrames||0}));
      const hidden=await snapshot();await page.waitForTimeout(600);const hiddenAfter=await snapshot();
      assert(hiddenAfter.frame-hidden.frame<=3,'Initially hidden local clock kept ticking');
      await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
      run.initialVisibility={handlerSimulated:true,hidden,hiddenAfter};
    }
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=90,null,{timeout:180000});
    assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
    assert.equal(await page.evaluate(()=>__webEngineRPC('WebOptimizationTest',0)),1);
    const state=()=>owner.evaluate(()=>({frame:__webRHIFrames,game:__webEngineFrames,stages:__webThreadStages,
      threads:__webEngineThreads,view:__webRenderView,camera:__webDefaultCamera,settings:__webProjectSettings,
      occlusion:__webOcclusionRHI,history:globalThis.__webOcclusionHistory,queryWait:globalThis.__webOcclusionWait,
      optimization:globalThis.__webOptimizationRHI,culling:globalThis.__webOptimizationState,
      gameClock:globalThis.__webGameFrameClock,
      streaming:__webTextureStreaming,capacity:HEAPU8.buffer.byteLength,
      arguments:Module.arguments,failure:globalThis.__webEngineFailure}));
    // Startup texture uploads and browser pipeline creation must leave the window
    // before comparing steady throughput, including cold browser profiles.
    await page.waitForFunction(()=>globalThis.__webEngineFrames>=600 &&
      globalThis.__webTextureStreaming?.pending===0,null,{timeout:120000});
    await page.waitForTimeout(warmup*1000);run.before=await state();
    run.browser=await page.evaluate(()=>navigator.userAgent);
    assert(run.before.threads.renderThread && run.before.threads.rhiThread);
    assert.equal(run.before.queryWait.budgetMs,0);
    assert.equal(run.before.history.enabled,['history','hzb','hzb-instances'].includes(occlusionMode));
    assert(run.before.arguments.includes('-WebOcclusionMode='+occlusionMode));
    assert.equal(run.before.arguments.includes('-WebGameLocalClock'),local);
    // New runtimes report the clock actually activated in the Game Worker.
    if(run.before.gameClock) assert.deepEqual(run.before.gameClock,{mode:local?'local':'owner',paused:false});
    assert.equal(run.before.culling.hzbOcclusion,occlusionMode.startsWith('hzb')?2:0);
    assert.equal(run.before.culling.instanceOcclusion,['instances','hzb-instances'].includes(occlusionMode)?1:0);
    assert.equal(run.before.streaming.pending,0);
    await owner.evaluate(()=>{const c=__occlusionCapture;c.times=[];c.active=true;c.start=performance.now();c.first=__webRHIFrames;});
    await page.waitForTimeout(seconds*1000);
    run.measurement=await owner.evaluate(()=>{const c=__occlusionCapture;c.active=false;
      return {start:c.start,end:performance.now(),frames:__webRHIFrames-c.first,times:c.times};});
    run.after=await state();
    assert.equal(run.after.streaming.pending,0);
    assert.deepEqual(run.before.camera,run.after.camera);assert.deepEqual(run.before.settings,run.after.settings);
    assert.deepEqual(stableView(run.before.view),stableView(run.after.view));
    assert(!run.errors.length && !run.after.failure,run.errors.join('\n'));
    run.intervals=run.measurement.times.slice(1).map((t,i)=>t-run.measurement.times[i]);
    run.frameMs=distribution(run.intervals);run.fps=run.measurement.frames*1000/(run.measurement.end-run.measurement.start);
    run.rhiMs=(run.after.stages.rhiWorkMilliseconds-run.before.stages.rhiWorkMilliseconds)/run.measurement.frames;
    const frames=run.after.occlusion.sampleFrame-run.before.occlusion.sampleFrame;
    run.workload=Object.fromEntries(['draws','indirectDraws','dispatches','ready','pending','zero'].map(k=>[k,(run.after.occlusion[k]-run.before.occlusion[k])/frames]));
    run.history=Object.fromEntries(['polls','ready','hits','zero','fallback','expired','cameraRejected','boundsRejected','hzbSubmitted','hzbCompleted','hzbSkipped','queryCaptured','queryDropped'].map(k=>[k,(run.after.history[k]-run.before.history[k])/(run.after.history.frame-run.before.history.frame)]));
    if(run.before.history.enabled) assert(run.history.hits>0 && run.history.ready>0,'Candidate must consume real results');
    if(occlusionMode.startsWith('hzb')) assert(run.history.hzbCompleted>0,'HZB ring must complete and consume readbacks');
    await page.locator('canvas').screenshot({path:output+'-'+run.index+'-'+mode+'.png'});
    if(lifecycle && local) {
      await page.evaluate(()=>{
        Object.defineProperty(document,'hidden',{configurable:true,value:true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(500);const hidden=await state();
      await page.waitForTimeout(600);const hiddenAfter=await state();
      assert(hidden.gameClock.paused && hiddenAfter.gameClock.paused);
      assert(hiddenAfter.frame-hidden.frame<=3,'Hidden local clock kept submitting');
      await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
      await page.waitForTimeout(700);const resumed=await state();
      assert(!resumed.gameClock.paused && resumed.frame>hiddenAfter.frame+20);
      run.visibility={handlerSimulated:true,actualHiddenObserved:false,hidden,hiddenAfter,resumed};
    }
    if(tour) {
      run.tour=[];const camera=run.before.camera;
      for(const delta of [0,90,180,270,0]) {
        const view={...camera,yaw:camera.yaw+delta};
        assert.equal(await page.evaluate(v=>__webEngineRPC('WebProjectViewTest',v.x,v.y,v.z,v.pitch,v.yaw),view),1);
        await page.waitForTimeout(120);const early=await state();
        await page.waitForTimeout(1800);const settled=await state();
        const file=output+'-'+run.index+'-yaw'+delta+'-'+run.tour.length+'.png';
        await page.locator('canvas').screenshot({path:file});
        run.tour.push({view,early,settled,screenshot:audit(file)});
      }
      if(run.before.history.enabled) assert(run.tour.at(-1).settled.history.cameraRejected>run.after.history.cameraRejected,'Tour must exercise camera invalidation');
    }
    assert(!run.errors.length);run.pass=true;save();
    console.log(JSON.stringify({mode,fps:run.fps,low:run.frameMs.low1Fps,rhiMs:run.rhiMs,workload:run.workload,history:run.history}));
    await context.close();context=null;log.end();log=null;
  }
  for(const r of report.runs){assert.deepEqual(r.before.camera,report.runs[0].before.camera);assert.deepEqual(r.before.settings,report.runs[0].before.settings);assert.deepEqual(stableView(r.before.view),stableView(report.runs[0].before.view));}
  report.summary=Object.fromEntries([...new Set(modes)].map(mode=>{const runs=report.runs.filter(r=>r.mode===mode);
    return [mode,{fps:runs.reduce((s,r)=>s+r.measurement.frames,0)*1000/runs.reduce((s,r)=>s+r.measurement.end-r.measurement.start,0),
      frameMs:distribution(runs.flatMap(r=>r.intervals)),runs:runs.map(r=>r.fps)}];}));
  report.packageFiles.forEach(item=>assert.equal(audit(item.file).sha256,item.sha256));
  report.pass=true;console.log(JSON.stringify(report.summary));
}catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{await context?.close();log?.end();save();}})();
