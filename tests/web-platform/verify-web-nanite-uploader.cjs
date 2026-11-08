'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const verifyHierarchy = require('./verify-nanite-hierarchy-output.cjs');
const verifySceneCull = require('./verify-nanite-scene-cull-output.cjs');
const verifyRaster = require('./verify-nanite-raster-output.cjs');
const output = path.join(__dirname, 'results/nanite-browser');
fs.mkdirSync(output, {recursive:true});
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const packaged = read(path.join(__dirname, 'build/nanite-browser/package.json'));
assert(packaged.pass);
for (const input of [...packaged.sources, ...packaged.products, packaged.build, packaged.native,
  packaged.archive, packaged.hierarchyShaders, packaged.browserOracle, packaged.cookedResource, packaged.sourceTriangles]) assert.equal(audit(input.file).sha256, input.sha256);
const oracle = read(packaged.browserOracle.file);
assert(oracle.pass && oracle.asset.webCookEnabled);
function observe() {
  const modules = new WeakSet(), pipelines = new WeakSet(), bound = new WeakMap();
  const cullModules = new WeakSet(), cullPipelines = new WeakSet(), cullBound = new WeakMap();
  const rasterModules = new WeakSet(), rasterPipelines = new WeakSet(), rasterBound = new WeakMap();
  const state = globalThis.__naniteBrowserAudit = {dispatches:0, shaders:[], cullDispatches:0, cullShaders:[], rasterDraws:[], rasterShaders:[], errors:[], adapter:null};
  const create = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(desc) {
    const result = create.call(this, desc);
    if (desc.code.includes('FPackedClusterInstallInfo') && desc.code.includes('SrcPageOffset')) {
      modules.add(result); state.shaders.push(desc.code);
    }
    if (desc.code.includes('WebCullClusterKeys') && desc.code.includes('WebCullInputNodes')) {
      cullModules.add(result); state.cullShaders.push(desc.code);
    }
    if (desc.code.includes('WebRasterClusterKeys') || desc.code.includes('WebNaniteAtomicMax_Visibility')) {
      rasterModules.add(result); state.rasterShaders.push(desc.code);
    }
    return result;
  };
  const sync = GPUDevice.prototype.createComputePipeline;
  GPUDevice.prototype.createComputePipeline = function(desc) {
    const result = sync.call(this, desc); if (modules.has(desc.compute.module)) pipelines.add(result);
    if (cullModules.has(desc.compute.module)) cullPipelines.add(result); return result;
  };
  const async = GPUDevice.prototype.createComputePipelineAsync;
  GPUDevice.prototype.createComputePipelineAsync = async function(desc) {
    const result = await async.call(this, desc); if (modules.has(desc.compute.module)) pipelines.add(result);
    if (cullModules.has(desc.compute.module)) cullPipelines.add(result); return result;
  };
  const bind = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {bound.set(this, pipelines.has(pipeline)); cullBound.set(this, cullPipelines.has(pipeline)); return bind.call(this, pipeline);};
  const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups = function(...args) {if (bound.get(this)) ++state.dispatches; if(cullBound.get(this)) ++state.cullDispatches; return dispatch.apply(this, args);};
  const request = GPUAdapter.prototype.requestDevice;
  for (const name of ['createRenderPipeline','createRenderPipelineAsync']) {
    const create = GPUDevice.prototype[name];
    const record = (p,d) => {if(rasterModules.has(d.vertex.module)&&rasterModules.has(d.fragment?.module)) rasterPipelines.add(p); return p;};
    GPUDevice.prototype[name] = name.endsWith('Async') ? async function(d) {return record(await create.call(this,d),d);} : function(d) {return record(create.call(this,d),d);};
  }
  const rasterBind = GPURenderPassEncoder.prototype.setPipeline, draw = GPURenderPassEncoder.prototype.draw;
  GPURenderPassEncoder.prototype.setPipeline = function(p) {rasterBound.set(this,rasterPipelines.has(p));return rasterBind.call(this,p);};
  GPURenderPassEncoder.prototype.draw = function(...args) {if(rasterBound.get(this)) state.rasterDraws.push(args);return draw.apply(this,args);};
  GPUAdapter.prototype.requestDevice = async function(...args) {
    state.adapter = {vendor:this.info.vendor, architecture:this.info.architecture,
      subgroupMinSize:this.info.subgroupMinSize, subgroupMaxSize:this.info.subgroupMaxSize, isFallbackAdapter:this.info.isFallbackAdapter};
    const device = await request.apply(this, args);
    state.features = [...device.features];
    device.addEventListener('uncapturederror', e => state.errors.push(e.error.message));
    return device;
  };
}
const report = {date:new Date().toISOString(), pass:false, cases:[], residency:[], scene:[], sceneCulling:[], errors:[], logs:[],
  source:audit(__filename), package:audit(path.join(__dirname, 'build/nanite-browser/package.json')),
  cullOracle:audit(require.resolve('./verify-nanite-hierarchy-output.cjs')),
  sceneCullOracle:audit(require.resolve('./verify-nanite-scene-cull-output.cjs')),
  rasterOracle:audit(require.resolve('./verify-nanite-raster-output.cjs')),
  rasterReferencePolicy:{subpixelFractionalBits:8, depthTolerance:3e-5, edgeBandPixels:.02, minimumInteriorFraction:.25,
    reference:'https://learn.microsoft.com/en-us/windows/win32/direct3d12/constants'},
  boundary:'Actual browser UE scene culling feeds bounded opaque two-sided Nanite page-decoding VS/PS into an offscreen packed visibility buffer. Independent source-mesh coverage, reversed depth and instance checks. Main scene still uses fallback raster; no GBuffer/material, LOD, HZB or streaming acceptance.'};
(async () => {
  let browser;
  try {
    // The existing scene pack exceeds the ephemeral context's storage quota.
    // Use a dedicated workspace profile, as the other full-scene probes do.
    browser = await chromium.launchPersistentContext(path.join(output, 'profile'),
      {channel:'msedge', headless:true, viewport:{width:960,height:640}});
    report.browser = browser.browser().version();
    const context = browser;
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body:'(' + observe.toString() + ')();\n' + await response.text()});
    });
    const page = await context.newPage();
    page.on('console', m => {
      report.logs.push(m.text());
      if (/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(m.text())) {
        report.errors.push(m.text());
        page.evaluate(() => {globalThis.__naniteVerificationError = true;}).catch(() => {});
      }
    });
    page.on('pageerror', e => report.errors.push(e.stack));
    page.on('crash', () => report.errors.push('Page crashed'));
    await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
    await page.waitForFunction(() => globalThis.__naniteVerificationError || globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 10, null, {timeout:180000});
    assert.equal(report.errors.length, 0, report.errors.join('\n'));
    assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    report.adapter = await owner.evaluate(() => __naniteBrowserAudit.adapter);
    report.features = await owner.evaluate(() => __naniteBrowserAudit.features);
    assert(report.features.some(f=>f.includes('atomic-vec2u')));
    assert(!report.adapter.isFallbackAdapter && report.adapter.subgroupMinSize >= 32);
    for (let index = 0; index < 4; ++index) {
      const before = await owner.evaluate(() => __naniteBrowserAudit.dispatches);
      assert.equal(await page.evaluate(step => __webEngineRPC('WebNaniteUploaderTest', step), index + 1), 1);
      let result;
      const start = Date.now();
      do {
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
        assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteUploaderTest', 0)), 1);
        result = await owner.evaluate(() => globalThis.__webNaniteUploaderTest || null);
      } while ((!result || result.pending || result.index !== index) && Date.now() - start < 30000);
      assert(result && !result.pending && result.index === index && !result.error && result.guards, JSON.stringify({...result, bytes:undefined}));
      const dispatches = await owner.evaluate(() => __naniteBrowserAudit.dispatches) - before;
      assert.equal(dispatches, [2,2,3,4][index]);
      assert.equal(result.size, oracle.asset.gpuPageBytes);
      assert.equal(result.count, index >= 2 ? 2 : 1);
      const bytes = Buffer.from(result.bytes), pages = [];
      for (let i = 0; i < result.count; ++i) {
        const file = path.join(output, `page-${index}-${i}.bin`);
        fs.writeFileSync(file, bytes.subarray(i * result.size, (i + 1) * result.size));
        const product = audit(file);
        for (const b of oracle.browsers) assert.equal(product.sha256, b.gpuPageSha256);
        pages.push(product);
      }
      report.cases.push({index, pass:true, guards:true, dispatches, pages});
      console.log('Browser UE uploader case ' + index + ' passed');
    }
    let originalHierarchy, fixups, previousActive;
    for (let step = 1; step <= 4; ++step) {
      const before = await owner.evaluate(() => __naniteBrowserAudit.dispatches);
      assert.equal(await page.evaluate(s => __webEngineRPC('WebNaniteResourcesTest', s), step), 1);
      let result;
      const start = Date.now();
      do {
        await page.waitForTimeout(100);
        assert.equal(report.errors.length, 0, report.errors.join('\n'));
        assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
        assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteResourcesTest', 0)), 1);
        result = await owner.evaluate(() => globalThis.__webNaniteResourcesTest || null);
      } while ((!result || result.pending || result.step !== step) && Date.now() - start < 30000);
      assert(result && !result.pending && result.step === step, JSON.stringify({...result, pages:undefined, hierarchy:undefined}));
      const dispatches = await owner.evaluate(() => __naniteBrowserAudit.dispatches) - before;
      assert.equal(dispatches, step === 4 ? 0 : 2);
      assert.equal(result.active.length, [1,2,2,0][step - 1]);
      assert.equal(result.hasResources, step !== 4);
      assert.equal(result.modifiedCount, step === 4 ? 0 : 1);
      assert.equal(result.levels, step === 4 ? 0 : result.expectedLevels);
      if (step === 1) {
        assert(result.rejectedStreaming);
        assert(result.fixups.length > 0);
        originalHierarchy = Buffer.from(result.originalHierarchy); fixups = result.fixups;
        assert.equal(result.active[0].page, 0);
      } else if (step !== 4) {
        assert.deepEqual(Buffer.from(result.originalHierarchy), originalHierarchy);
        assert.deepEqual(result.fixups, fixups);
      }
      if (step === 2) {
        assert.deepEqual(result.active[0], previousActive[0]);
        assert.equal(result.active[1].page, 1);
        assert(result.active[1].hierarchyOffset >= result.active[0].hierarchyBytes);
      }
      if (step === 3) {
        assert(result.rejectedBudget);
        assert.deepEqual(result.active[1], previousActive[1]);
        assert.equal(result.removedId, previousActive[0].id);
        assert.notEqual(result.active[0].id, result.removedId);
        assert.equal(result.active[0].page, previousActive[0].page);
        assert.equal(result.active[0].hierarchyOffset, previousActive[0].hierarchyOffset);
      }
      if (step === 4) assert(result.cancelledPending);
      const info = r => ({page:r.page, id:r.id, clusters:r.clusters});
      assert.deepEqual(result.installed, step === 4 ? [] : [info(result.active[step === 2 ? 1 : 0])]);
      const removed = step === 3 ? [previousActive[0]] : step === 4 ? previousActive : [];
      assert.deepEqual(result.uninstalled.sort((a,b) => a.page-b.page), removed.map(info).sort((a,b) => a.page-b.page));
      const pages = Buffer.from(result.pages), hierarchy = Buffer.from(result.hierarchy);
      verifyHierarchy(result, pages, result.active);
      assert.equal(pages.length, oracle.asset.gpuPageBytes * (step === 1 ? 1 : 2));
      const products = [];
      for (const resource of result.active) {
        assert.equal(resource.clusters, oracle.asset.numClusters);
        const file = path.join(output, `resident-${step}-${resource.page}.bin`);
        fs.writeFileSync(file, pages.subarray(resource.page * oracle.asset.gpuPageBytes, (resource.page + 1) * oracle.asset.gpuPageBytes));
        const product = audit(file);
        for (const b of oracle.browsers) assert.equal(product.sha256, b.gpuPageSha256);
        products.push(product);
        const expected = Buffer.from(originalHierarchy);
        for (const fixup of fixups) expected.writeUInt32LE(((resource.page + fixup.page) << result.clusterBits) | fixup.cluster, fixup.offset);
        assert.equal(resource.hierarchyBytes, expected.length);
        assert.deepEqual(hierarchy.subarray(resource.hierarchyOffset, resource.hierarchyOffset + expected.length), expected);
      }
      const hierarchyFile = path.join(output, `hierarchy-${step}.bin`);
      fs.writeFileSync(hierarchyFile, hierarchy); products.push(audit(hierarchyFile));
      const {pages:ignoredPages, hierarchy:ignoredHierarchy, ...metadata} = result;
      report.residency.push({...metadata, pass:true, dispatches, poolBytes:pages.length, hierarchyPoolBytes:hierarchy.length, products});
      previousActive = result.active;
      console.log('Browser UE resident manager step ' + step + ' passed');
    }
    assert(report.logs.some(line => line.includes('LogInit: Command Line:') &&
      line.includes('-WebNaniteResidentResources -WebNaniteRootPages=2')));
    for (let step = 1; step <= 5; ++step) {
      const before = await owner.evaluate(() => __naniteBrowserAudit.dispatches);
      assert.equal(await page.evaluate(s => __webEngineRPC('WebNaniteSceneTest', s), step), 1);
      let result;
      const start = Date.now();
      do {
        await page.waitForTimeout(100);
        assert.equal(report.errors.length, 0, report.errors.join('\n'));
        assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
        assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteSceneTest', 0)), 1);
        result = await owner.evaluate(() => globalThis.__webNaniteSceneTest || null);
      } while ((!result || result.pending || result.step !== step) && Date.now() - start < 30000);
      assert(result && !result.pending && result.step === step, JSON.stringify({...result, pages:undefined, hierarchy:undefined}));
      const dispatches = await owner.evaluate(() => __naniteBrowserAudit.dispatches) - before;
      assert.equal(dispatches, [2,0,0,2,0][step - 1]);
      assert.equal(result.registered, [2,1,0,2,0][step - 1]);
      assert.equal(result.proxies, result.registered);
      assert.equal(result.active, ![3,5].includes(step));
      assert.equal(result.levels, result.active ? 1 : 0);
      const products = [];
      if (result.active) {
        assert.equal(result.clusters, oracle.asset.numClusters);
        if (step === 2) assert.equal(result.id, report.scene[0].id);
        if (step === 4) assert.notEqual(result.id, report.scene[0].id);
        const pageBytes = Buffer.from(result.pages).subarray(result.page * oracle.asset.gpuPageBytes, (result.page + 1) * oracle.asset.gpuPageBytes);
        verifyHierarchy(result, Buffer.from(result.pages), [result]);
        const pageFile = path.join(output, `scene-page-${step}.bin`); fs.writeFileSync(pageFile, pageBytes);
        const pageAudit = audit(pageFile); products.push(pageAudit);
        for (const browser of oracle.browsers) assert.equal(pageAudit.sha256, browser.gpuPageSha256);
        const expected = Buffer.from(originalHierarchy);
        for (const fixup of fixups) expected.writeUInt32LE(((result.page + fixup.page) << oracle.asset.clusterIndexBits) | fixup.cluster, fixup.offset);
        const hierarchy = Buffer.from(result.hierarchy).subarray(result.offset, result.offset + expected.length);
        assert.deepEqual(hierarchy, expected);
        const hierarchyFile = path.join(output, `scene-hierarchy-${step}.bin`); fs.writeFileSync(hierarchyFile, hierarchy);
        products.push(audit(hierarchyFile));
      }
      const {pages, hierarchy, ...metadata} = result;
      report.scene.push({...metadata, pass:true, dispatches, products});
      console.log('Browser UE static mesh scene step ' + step + ' passed');
    }
    assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteSceneTest', 6)), 1);
    assert.equal(await owner.evaluate(() => __naniteBrowserAudit.cullDispatches), 67, 'Unused scene outputs must be culled by RDG');
    const fixturePage = fs.readFileSync(report.scene[0].products[0].file);
    const sourceTriangles = fs.readFileSync(packaged.sourceTriangles.file);
    for (let step = 1; step <= 19; ++step) {
      const before = await owner.evaluate(() => __naniteBrowserAudit.cullDispatches);
      const drawsBefore = await owner.evaluate(() => __naniteBrowserAudit.rasterDraws.length);
      assert.equal(await page.evaluate(s => __webEngineRPC('WebNaniteSceneCullTest', s), step), 1);
      let result;
      const start = Date.now();
      do {
        await page.waitForTimeout(100);
        assert.equal(report.errors.length, 0, report.errors.join('\n'));
        assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteSceneCullTest', 0)), 1);
        result = await owner.evaluate(() => globalThis.__webNaniteSceneCullTest || null);
      } while ((!result || result.pending || result.step !== step) && Date.now()-start < 30000);
      assert(result && !result.pending && result.step === step, JSON.stringify(result));
      try {
        verifySceneCull(result, fixturePage, report.sceneCulling);
        result.raster = verifyRaster(result, sourceTriangles, fixturePage, oracle.asset.positionPrecision);
      }
      catch (error) { result.validationFailure = error.stack; }
      const bytes = Buffer.alloc(result.visibility.length*4);
      result.visibility.forEach((v,i)=>bytes.writeUInt32LE(v,i*4));
      const file = path.join(output, `visibility-${step}.bin`); fs.writeFileSync(file,bytes);
      result.visibilityProduct = audit(file); delete result.visibility;
      result.rasterDraws = await owner.evaluate(() => __naniteBrowserAudit.rasterDraws.length) - drawsBefore;
      assert.equal(result.rasterDraws,result.entries.length);
      const dispatches = await owner.evaluate(() => __naniteBrowserAudit.cullDispatches) - before;
      assert.equal(dispatches, result.entries.reduce((sum,e) => sum + e.levels, 0));
      report.sceneCulling.push({...result, dispatches, pass:!result.validationFailure});
      console.log('Browser renderer scene cull/raster step ' + step + (result.validationFailure ? ' failed validation' : ' passed'));
    }
    assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteSceneCullTest', 20)), 1);
    assert(report.sceneCulling.every(c => c.pass), report.sceneCulling.filter(c => !c.pass).map(c => `Step ${c.step}: ${c.validationFailure}`).join('\n'));
    const shaders = await owner.evaluate(() => __naniteBrowserAudit.shaders);
    const cullShaders = await owner.evaluate(() => __naniteBrowserAudit.cullShaders);
    assert.equal(cullShaders.length, 1);
    report.cullShaders = cullShaders.map(code => {
      assert(/@workgroup_size\(64(?:u)?(?:,|\))/.test(code));
      const file = path.join(output, 'hierarchy.wgsl'); fs.writeFileSync(file, code); return audit(file);
    });
    report.cullDispatches = await owner.evaluate(() => __naniteBrowserAudit.cullDispatches);
    assert.equal(report.cullDispatches, 100);
    const rasterShaders = await owner.evaluate(() => __naniteBrowserAudit.rasterShaders);
    assert.equal(rasterShaders.length,2);
    assert(rasterShaders.some(code=>code.includes('atomicStoreMax')&&code.includes('atomic<vec2<u32>>')));
    report.rasterShaders = rasterShaders.map((code,i)=>{
      const file=path.join(output,`raster-${i}.wgsl`);fs.writeFileSync(file,code);return audit(file);
    });
    report.rasterDraws = await owner.evaluate(() => __naniteBrowserAudit.rasterDraws);
    assert.equal(report.rasterDraws.length,33);
    assert(report.rasterDraws.every(d=>d[0]===384&&d[1]>0));
    assert.equal(shaders.length, 2);
    report.shaders = shaders.map((code,i) => {
      assert(/@workgroup_size\(32(?:u)?(?:,|\))/.test(code));
      const file = path.join(output, `transcode-${i}.wgsl`); fs.writeFileSync(file, code); return audit(file);
    });
    const frame = await page.evaluate(() => __webEngineFrames);
    await page.waitForFunction(f => __webEngineFrames >= f + 8, frame, {timeout:30000});
    report.framesAfter = await page.evaluate(() => __webEngineFrames);
    report.startupPipelineFailures = report.logs.filter(line => /LogRHI: Error: Failed to create .*pipeline/.test(line));
    report.errors.push(...await owner.evaluate(() => __naniteBrowserAudit.errors));
    assert.equal(report.errors.length, 0);
    await page.close();
    // Boot the same runtime without the explicit residency flag to check that
    // ordinary Web rendering still runs with Nanite resource activation off.
    await context.route('**/build/nanite-browser/index.html', async route => {
      const response = await route.fetch();
      const html = await response.text();
      assert(html.includes('"-WebNaniteResidentResources",'));
      await route.fulfill({response, body:html.replace('"-WebNaniteResidentResources",', '')});
    });
    const normal = await context.newPage();
    const normalPipelineFailures = [];
    normal.on('pageerror', error => report.errors.push(error.stack));
    normal.on('console', message => {
      if (/LogRHI: Error: Failed to create .*pipeline/.test(message.text())) normalPipelineFailures.push(message.text());
      if (/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(message.text())) report.errors.push(message.text());
    });
    await normal.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
    await normal.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 10, null, {timeout:180000});
    assert.equal(await normal.evaluate(() => globalThis.__webEngineFailure || null), null);
    assert.equal(await normal.evaluate(() => __webEngineRPC('WebNaniteSceneTest', 1)), 0);
    assert.equal(await normal.evaluate(() => __webEngineRPC('WebNaniteSceneCullTest', 1)), 0);
    const normalOwner = normal.workers().find(w => w.url().includes('web-engine-worker.js')); assert(normalOwner);
    const normalAudit = await normalOwner.evaluate(() => __naniteBrowserAudit);
    assert.equal(normalAudit.dispatches, 0);
    assert.equal(normalAudit.cullDispatches, 0);
    assert.equal(normalAudit.rasterDraws.length, 0);
    report.errors.push(...normalAudit.errors); assert.equal(report.errors.length, 0);
    report.defaultDisabled = {pass:true, frames:await normal.evaluate(() => __webEngineFrames), transcodeDispatches:0, cullDispatches:0, rasterDraws:0,
      startupPipelineFailures:normalPipelineFailures};
    await normal.close();
    const preview = await context.newPage();
    await preview.setViewportSize({width:824,height:700});
    await preview.setContent('<style>body{margin:20px;background:#eef2f6;color:#203040;font:14px sans-serif}main{display:grid;grid-template-columns:repeat(2,384px);gap:16px}canvas{display:block;width:384px;height:256px;image-rendering:pixelated}p{margin:8px 0}</style><h2>Nanite offscreen GPU visibility readback</h2><p>Teal / orange: instance; brightness: reversed depth. Main scene shading is not shown.</p><main></main>');
    const labels = {1:'Perspective: two instances',3:'Mirrored scale and frustum clipping',5:'Orthographic view',11:'Near instance occludes far instance',12:'Equal-depth packed ID tie',13:'Eye / near-plane clipping',14:'Cull error rejects geometry',19:'Overflow count rejects geometry'};
    for (const [step,label] of Object.entries(labels)) {
      const test=report.sceneCulling[Number(step)-1], bytes=fs.readFileSync(test.visibilityProduct.file);
      const words=Array.from({length:bytes.length/4},(_,i)=>bytes.readUInt32LE(i*4));
      await preview.evaluate(({test,words,label})=>{
        const div=document.createElement('div'), title=document.createElement('p'), canvas=document.createElement('canvas');
        title.textContent=label; canvas.width=test.rasterWidth;canvas.height=test.rasterHeight;
        const ctx=canvas.getContext('2d'), image=ctx.createImageData(canvas.width,canvas.height);
        const floats=new Float32Array(1), bits=new Uint32Array(floats.buffer);
        let min=1,max=0;for(let i=0;i<words.length;i+=2) if(words[i]) {bits[0]=words[i+1];min=Math.min(min,floats[0]);max=Math.max(max,floats[0]);}
        for(let i=0;i<words.length/2;++i){
          let rgb=[15,23,35];
          if(words[i*2]) {
            const slot=(words[i*2]>>>7)-1, entry=test.entries.find(e=>slot>=e.clusterBase&&slot<e.clusterBase+e.keys.length);
            bits[0]=words[i*2+1];const light=.3+.7*(floats[0]-min)/Math.max(max-min,1e-9);
            rgb=(entry.component?[255,166,65]:[65,219,192]).map(v=>Math.round(v*light));
          }
          image.data.set([...rgb,255],i*4);
        }
        ctx.putImageData(image,0,0);div.append(title,canvas);document.querySelector('main').append(div);
      },{test,words,label});
    }
    const previewFile=path.join(output,'opaque-raster-visibility.png');
    await preview.screenshot({path:previewFile,fullPage:true});await preview.close();
    report.visibilityPreview=audit(previewFile);
    report.pass = true;
  } catch(error) {report.failure = error.stack; process.exitCode = 1; console.error(error.stack);}
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({pass:report.pass, cases:report.cases.length, output}));
  }
})();
