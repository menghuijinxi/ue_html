'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const output = path.join(__dirname, 'results/nanite-browser');
fs.mkdirSync(output, {recursive:true});
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const packaged = read(path.join(__dirname, 'build/nanite-browser/package.json'));
assert(packaged.pass);
for (const input of [...packaged.sources, ...packaged.products, packaged.build, packaged.native,
  packaged.archive, packaged.browserOracle, packaged.cookedResource]) assert.equal(audit(input.file).sha256, input.sha256);
const oracle = read(packaged.browserOracle.file);
assert(oracle.pass && oracle.asset.webCookEnabled);
function observe() {
  const modules = new WeakSet(), pipelines = new WeakSet(), bound = new WeakMap();
  const state = globalThis.__naniteBrowserAudit = {dispatches:0, shaders:[], errors:[], adapter:null};
  const create = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(desc) {
    const result = create.call(this, desc);
    if (desc.code.includes('FPackedClusterInstallInfo') && desc.code.includes('SrcPageOffset')) {
      modules.add(result); state.shaders.push(desc.code);
    }
    return result;
  };
  const sync = GPUDevice.prototype.createComputePipeline;
  GPUDevice.prototype.createComputePipeline = function(desc) {
    const result = sync.call(this, desc); if (modules.has(desc.compute.module)) pipelines.add(result); return result;
  };
  const async = GPUDevice.prototype.createComputePipelineAsync;
  GPUDevice.prototype.createComputePipelineAsync = async function(desc) {
    const result = await async.call(this, desc); if (modules.has(desc.compute.module)) pipelines.add(result); return result;
  };
  const bind = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {bound.set(this, pipelines.has(pipeline)); return bind.call(this, pipeline);};
  const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups = function(...args) {if (bound.get(this)) ++state.dispatches; return dispatch.apply(this, args);};
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    state.adapter = {vendor:this.info.vendor, architecture:this.info.architecture,
      subgroupMinSize:this.info.subgroupMinSize, subgroupMaxSize:this.info.subgroupMaxSize, isFallbackAdapter:this.info.isFallbackAdapter};
    const device = await request.apply(this, args);
    device.addEventListener('uncapturederror', e => state.errors.push(e.error.message));
    return device;
  };
}
const report = {date:new Date().toISOString(), pass:false, cases:[], errors:[], logs:[],
  source:audit(__filename), package:audit(path.join(__dirname, 'build/nanite-browser/package.json')),
  boundary:'Browser UE FResources deserialization and actual Engine uploader through RDG/RHI. Resident root fixture with synthetic ordering edges; no full Nanite raster, hierarchy culling or streaming.'};
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
    const shaders = await owner.evaluate(() => __naniteBrowserAudit.shaders);
    assert.equal(shaders.length, 2);
    report.shaders = shaders.map((code,i) => {
      assert(/@workgroup_size\(32(?:u)?(?:,|\))/.test(code));
      const file = path.join(output, `transcode-${i}.wgsl`); fs.writeFileSync(file, code); return audit(file);
    });
    const frame = await page.evaluate(() => __webEngineFrames);
    await page.waitForFunction(f => __webEngineFrames >= f + 8, frame, {timeout:30000});
    report.framesAfter = await page.evaluate(() => __webEngineFrames);
    report.errors.push(...await owner.evaluate(() => __naniteBrowserAudit.errors));
    assert.equal(report.errors.length, 0);
    report.pass = true;
  } catch(error) {report.failure = error.stack; process.exitCode = 1; console.error(error.stack);}
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({pass:report.pass, cases:report.cases.length, output}));
  }
})();
