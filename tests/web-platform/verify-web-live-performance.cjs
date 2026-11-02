'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {WebFrameSamples} = require('./web-engine-host.js');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder') || 'villa-live-fps-v3';
const tag = option('tag') || 'live-fps';
assert(/^[a-z0-9-]+$/.test(folder) && /^[a-z0-9-]+$/.test(tag));
const output = path.join(__dirname, 'results', tag);
fs.mkdirSync(path.dirname(output),{recursive:true});
const report = {pass:false, headed:true, folder, errors:[], phases:[],
  boundary:'Owner frame submission intervals, separate page observations. Physical presentation timestamps are unavailable.'};
const close = (a,b) => assert(Math.abs(a-b) < .001, `${a} != ${b}`);
// A stall must affect the tail average rather than disappear into mean FPS.
const synthetic = new WebFrameSamples();
let now = 0; synthetic.add(now);
for (let i = 0; i < 1000; ++i) { now += i < 990 ? 1000/60 : 100; synthetic.add(now); }
close(synthetic.read(now).low, 10);
assert.equal(synthetic.read(now + 2000).fps, 0);
assert(synthetic.read(now + 2000).frameMs >= 2000);
for (let i = 0; i < 2400; ++i) { now += 1000/60; synthetic.add(now); }
close(synthetic.read(now).low, 60); // Old stutters expire from the rolling window.
synthetic.reset(); assert.equal(synthetic.read(now).low, null);
now=0; synthetic.add(now);
for(let i=0;i<198;++i){now+=1000/60;synthetic.add(now);}
now+=100;synthetic.add(now);now+=200;synthetic.add(now);
close(synthetic.read(now).low,1000/150);
close(synthetic.read(now).p99Ms,1000/60); // Percentile and slowest-1% mean differ.
for(let i=0;i<330;++i){now+=1000/60;synthetic.add(now);}
close(synthetic.read(now).low,60); // Recovery takes five seconds, not thirty.
report.syntheticIntervals = true;
let context;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/live-fps'),
      {channel:'msedge', headless:false, viewport:{width:1863,height:1030}, deviceScaleFactor:1.25});
    const page = context.pages()[0];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
    await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    // Verify coexistence with the accessor used by existing profiling tools.
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response,body:`let probeFrames=0; globalThis.__hudObserverCalls=0;
Object.defineProperty(globalThis,'__webRHIFrames',{configurable:true,enumerable:true,
 get:()=>probeFrames,set(value){probeFrames=value;++globalThis.__hudObserverCalls;}});\n` + await response.text()});
    });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('crash', () => report.errors.push('Page crashed'));
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
    await page.bringToFront();
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webLivePerformance?.visual?.samples >= 100,
      null,{timeout:900000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js'));
    assert(owner);
    await page.waitForTimeout(20000);
    await page.evaluate(() => document.querySelector('#web-performance-hud button').click());
    const sample = async () => page.evaluate(() => ({...__webLivePerformance,
      camera:__webDefaultCamera,view:__webRenderView,hidden:document.hidden}));
    const begin = await owner.evaluate(() => ({count:__webRHIFrames,time:performance.now(),observerCalls:__hudObserverCalls}));
    const standing = {name:'standing',samples:[]};
    for (let i=0; i<20; ++i) { await page.waitForTimeout(1000); standing.samples.push(await sample()); }
    const end = await owner.evaluate(() => ({count:__webRHIFrames,time:performance.now(),observerCalls:__hudObserverCalls}));
    standing.ownerSubmittedFps=(end.count-begin.count)*1000/(end.time-begin.time);
    standing.ownerCounters={begin,end};
    report.phases.push(standing);
    console.log(JSON.stringify({phase:'standing',ownerSubmittedFps:standing.ownerSubmittedFps,last:standing.samples.at(-1),counters:standing.ownerCounters}));
    assert(end.observerCalls > begin.observerCalls && end.count > begin.count);
    report.accessorChaining = true;
    await page.screenshot({path:output+'-standing.png'});
    const moving={name:'moving',samples:[]};
    await page.evaluate(() => {
      document.querySelector('#web-performance-hud button').click();
      const canvas=document.querySelector('#canvas'); canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'w',code:'KeyW',keyCode:87,which:87,bubbles:true}));
    });
    try {
      for(let i=0;i<8;++i){await page.waitForTimeout(1000);moving.samples.push(await sample());}
    } finally {
      await page.evaluate(() => document.querySelector('#canvas').dispatchEvent(new KeyboardEvent('keyup',
        {key:'w',code:'KeyW',keyCode:87,which:87,bubbles:true})));
    }
    report.phases.push(moving);
    assert.notDeepEqual(moving.samples.at(-1).camera,standing.samples.at(-1).camera,'Movement did not reach gameplay');
    await page.screenshot({path:output+'-moving.png'});
    const downloadEvent=page.waitForEvent('download');
    await page.evaluate(()=>document.querySelector('#web-performance-hud [data-action="export"]').click());
    const download=await downloadEvent;
    await download.saveAs(output+'-export.json');
    const exported=JSON.parse(fs.readFileSync(output+'-export.json','utf8'));
    assert.equal(exported.source,'rhi-owner-submission-intervals');
    assert(exported.frames.length>=100 && exported.contexts.length>0);
    assert(exported.frames.every(f=>f.ms>0 && Number.isFinite(f.ms)));
    assert.equal(exported.lowWindowMs,5000);
    report.export={frames:exported.frames.length,contexts:exported.contexts.length,pipelineEvents:exported.pipelineEvents.length};
    const other=await context.newPage(); await other.goto('about:blank'); await other.bringToFront();
    await page.waitForTimeout(1500);
    report.hidden=await page.evaluate(() => ({hidden:document.hidden,stats:__webLivePerformance}));
    if(report.hidden.hidden)assert.equal(report.hidden.stats.visible,false);
    // Some automation hosts keep all tabs visible; retain the observed result
    // and exercise the visibility event handler explicitly in that case.
    report.visibilityHandler=await page.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
      const paused={...__webLivePerformance};
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      return {paused,restoredHidden:document.hidden};
    });
    assert.equal(report.visibilityHandler.paused.visible,false);
    await other.close();await page.bringToFront();
    await page.evaluate(()=>document.querySelector('#web-performance-hud button').click());
    await page.waitForTimeout(500);
    report.resumed=await sample();
    assert(report.resumed.visible && report.resumed.visual.low===null && report.resumed.visual.samples<100);
    assert.equal(report.errors.length,0,report.errors.join('\n'));
    for(const phase of report.phases) {
      const samples=phase.samples.filter(s=>s.visual?.fps!==null);
      phase.meanVisualFps=samples.reduce((sum,s)=>sum+s.visual.fps,0)/samples.length;
      phase.meanSubmittedFps=samples.reduce((sum,s)=>sum+s.submitted.fps,0)/samples.length;
      phase.meanPageRefreshHz=samples.reduce((sum,s)=>sum+s.refresh.fps,0)/samples.length;
      phase.last1PercentLow=samples.at(-1).submitted.low;
      assert(samples.every(s=>!s.hidden && s.visual.fps>0 && s.visual.fps<=s.refresh.fps+2));
    }
    report.pass=true;
  } finally {
    fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));
    await context?.close();
  }
  console.log(JSON.stringify({pass:report.pass,phases:report.phases.map(({samples,...rest})=>rest)}));
})().catch(e=>{console.error(e);process.exitCode=1;});
