'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const {observeStoragePrecache} = require('./observe-storage-precache.cjs');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const output = path.join(__dirname, 'results/nanite-storage-precache-late');
fs.mkdirSync(output, {recursive:true});
const baselineFile = path.join(__dirname, 'results/nanite-browser/results.json'), baseline = read(baselineFile);
assert(baseline.pass);
const dynamicEntries = new Set(baseline.logs.flatMap(line => [...line.matchAll(/P3_WEB_STORAGE_PRECACHE_USED entry=(\S+)/g)].map(m=>m[1])));
const target = baseline.defaultDisabled.storagePrecache.pipelines.find(p => p.asynchronous && p.dispatches > 0 && dynamicEntries.has(p.entry));
assert(target, 'Need a proven dynamic-format variant used by the default scene');
function delayTarget(entry) {
  const create = GPUDevice.prototype.createComputePipelineAsync;
  globalThis.__storagePrecacheInjected = 0;
  GPUDevice.prototype.createComputePipelineAsync = function(descriptor) {
    if (descriptor.compute.entryPoint === entry && !globalThis.__storagePrecacheInjected) {
      ++globalThis.__storagePrecacheInjected;
      return new Promise((resolve,reject) => setTimeout(() => {
        create.call(this, descriptor).then(resolve,reject);
      }, 2000));
    }
    return create.call(this, descriptor);
  };
}
const report = {pass:false, target, baseline:audit(baselineFile), package:baseline.package,
  sources:[audit(__filename), audit(require.resolve('./observe-storage-precache.cjs'))], errors:[], logs:[]};
(async()=>{
  let context;
  try {
    // Reuse the completed full-scene probe's persistent content cache.
    context = await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),
      {channel:'msedge',headless:true,viewport:{width:960,height:640}});
    await context.route('**/web-engine-worker.js?*', async route=>{
      const response = await route.fetch();
      await route.fulfill({response,body:`(${delayTarget.toString()})(${JSON.stringify(target.entry)});\n(${observeStoragePrecache.toString()})();\n${await response.text()}`});
    });
    await context.route('**/build/nanite-browser/index.html',async route=>{
      const response=await route.fetch(), html=await response.text();
      assert(html.includes('"-WebNaniteResidentResources",'));
      await route.fulfill({response,body:html.replace('"-WebNaniteResidentResources",','')});
    });
    const page=await context.newPage();
    page.on('console',m=>{
      report.logs.push(m.text());
      if (/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(m.text())) report.errors.push(m.text());
    });
    page.on('pageerror',e=>report.errors.push(e.stack));
    await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
    await page.waitForFunction(()=>globalThis.__webEngineFailure || globalThis.__webEngineFrames>=60,null,{timeout:180000});
    assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure || null),null);
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
    const deadline=Date.now()+60000;
    do {
      report.observation=await owner.evaluate(()=>({...__storagePrecacheAudit,rhi:__webOptimizationRHI,injected:__storagePrecacheInjected}));
      if(report.observation.pipelines.some(p=>p.entry===target.entry&&p.asynchronous&&p.dispatches>0) &&
        report.observation.rhi.storageFormatPrecachedUsed > 0 && report.observation.rhi.storageFormatPrecachedBinds > 0) break;
      assert.equal(report.errors.length,0,report.errors.join('\n'));
      await page.waitForTimeout(100);
    } while(Date.now()<deadline);
    const state=report.observation;
    assert.equal(state.injected,1);assert.deepEqual(state.failures,[]);
    const same=p=>p.entry===target.entry&&JSON.stringify(p.formats)===JSON.stringify(target.formats);
    report.runtimeFirst=state.pipelines.filter(p=>same(p)&&!p.asynchronous&&p.dispatches>0);
    report.precachedAfter=state.pipelines.filter(p=>same(p)&&p.asynchronous&&p.dispatches>0);
    assert(report.runtimeFirst.length>0,'A runtime wrapper must execute while the same variant is pending');
    assert(report.precachedAfter.length>0,'That wrapper must adopt the completed asynchronous variant');
    assert(state.rhi.storageFormatPrecachedUsed>0&&state.rhi.storageFormatPrecachedBinds>0);
    assert.equal(state.rhi.asyncPrecacheFailed,0);
    assert.equal(report.errors.length,0,report.errors.join('\n'));
    report.frames=await page.evaluate(()=>__webEngineFrames);
    report.pass=true;
  } catch(error) {report.failure=error.stack;process.exitCode=1;console.error(error.stack);}
  finally {
    if(context)await context.close();
    fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({pass:report.pass,target:target.entry,output}));
  }
})();
