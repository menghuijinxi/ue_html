'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const verifyDepth = require('./verify-nanite-depth-output.cjs');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const verify = i => assert.equal(audit(i.file).sha256, i.sha256, `Stale file: ${i.file}`);
const browserFile = path.join(__dirname, 'results/nanite-browser/results.json');
const browser = read(browserFile);
assert(browser.pass && browser.errors.length === 0);
assert.deepEqual(browser.cases.map(c => c.dispatches), [2,2,3,4]);
for (const test of browser.cases) {assert(test.pass && test.guards); test.pages.forEach(verify);}
assert.deepEqual(browser.residency.map(c => c.dispatches), [2,2,2,0]);
assert.deepEqual(browser.residency.map(c => c.active.length), [1,2,2,0]);
assert(browser.residency[0].rejectedStreaming && browser.residency[2].rejectedBudget && browser.residency[3].cancelledPending);
for (const test of browser.residency) {assert(test.pass); test.products.forEach(verify);}
assert.deepEqual(browser.scene.map(c => c.dispatches), [2,0,0,2,0]);
assert.deepEqual(browser.scene.map(c => c.proxies), [2,1,0,2,0]);
assert(browser.defaultDisabled.pass && browser.defaultDisabled.transcodeDispatches === 0);
for (const test of browser.scene) {assert(test.pass); test.products.forEach(verify);}
assert.equal(browser.cullDispatches, 100);
assert.equal(browser.sceneCulling.length, 19);
assert.deepEqual(browser.sceneCulling.map(c => c.entries.length), [2,2,2,2,2,1,0,2,0,2,...Array(9).fill(2)]);
assert(browser.sceneCulling.every(c => c.pass && c.rejected === 0 && c.dispatches === c.entries.length));
assert(browser.sceneCulling.every(c => c.raster.pass && c.rasterDraws === c.entries.length));
assert.equal(browser.sceneCulling[0].rasterInputRejections, 6);
browser.sceneCulling.forEach(c=>verify(c.visibilityProduct));
assert.equal(browser.rasterDraws.length, 33);
assert.equal(browser.defaultDisabled.rasterDraws, 0);
assert.equal(browser.defaultDisabled.cullDispatches, 0);
assert.equal(browser.defaultDisabled.depthDraws,0);
assert.equal(browser.sceneDepth.length,5);
assert.deepEqual(browser.sceneDepth.map(c=>c.step),[20,21,22,23,24]);
for(const test of browser.sceneDepth) {
  assert(test.pass&&test.validation.pass&&test.depthDraws>=4);
  const raw={...test};
  test.products.forEach((p,i)=>{verify(p);const b=fs.readFileSync(p.file);raw[i?'after':'before']=Array.from({length:b.length/4},(_,j)=>b.readUInt32LE(j*4));});
  assert.deepEqual(verifyDepth(raw),test.validation);
}
assert(browser.depthDraws>=20&&browser.totalCullDispatches>100&&browser.totalRasterDraws>33);
assert(browser.sceneDepthCleanup.pass&&browser.sceneDepthCleanup.framesObserved>=4);
assert.equal([...browser.residency, ...browser.scene].flatMap(c => c.culling || []).length, 62);
assert.equal([...browser.residency, ...browser.scene].reduce((n, c) => n + (c.cullInputRejections || 0), 0), 88);
[browser.source, browser.cullOracle, browser.sceneCullOracle, browser.rasterOracle, browser.depthOracle, browser.package,
  ...browser.shaders, ...browser.cullShaders, ...browser.rasterShaders, ...browser.depthShaders,
  browser.visibilityPreview, browser.depthPreview].forEach(verify);
const packaged = read(browser.package.file);
assert(packaged.pass);
const packageInputs = [...packaged.sources, ...packaged.products, ...packaged.baseline,
  packaged.build, packaged.native, packaged.archive, packaged.hierarchyShaders, packaged.browserOracle, packaged.cookedResource, packaged.sourceTriangles];
packageInputs.forEach(verify);
const hierarchyShaders = read(packaged.hierarchyShaders.file);
assert(hierarchyShaders.pass);
[...hierarchyShaders.sources, ...hierarchyShaders.shaderInputs, ...hierarchyShaders.compiler,
  hierarchyShaders.archive, hierarchyShaders.binary, ...hierarchyShaders.logs].forEach(verify);
const build = read(packaged.build.file);
assert(build.pass && build.incrementalDiagnostic && !build.fullRebuild);
[...build.sources, ...build.linkInputs, ...build.products, build.log,
  ...build.compiled.flatMap(c => [...c.inputs, c.object, c.log])].forEach(verify);
const native = read(packaged.native.file);
assert(native.pass && native.policyChecks === 21 && native.products.length === 12);
[...native.sources, ...native.products, ...native.build.inputs, native.build.binary,
  native.build.log, native.runtimeShaderArchive, native.browserOracle,
  ...native.generated.sources, ...native.generated.generated].forEach(verify);
assert.equal(native.runtimeShaderArchive.sha256, packaged.archive.sha256);
const oracle = read(packaged.browserOracle.file);
assert(oracle.pass && oracle.asset.webCookEnabled); oracle.sources.forEach(verify);
for (const b of oracle.browsers) for (const test of browser.cases)
  for (const page of test.pages) assert.equal(page.sha256, b.gpuPageSha256);
const {logs, ...browserSummary} = browser;
const report = {date:new Date().toISOString(), pass:true,
  referenceCommit:cp.execFileSync('git', ['-C', path.join(__dirname, '../../reference-engine'), 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  browser:{...browserSummary, logReport:audit(browserFile)},
  package:packaged, build:{report:packaged.build, incrementalDiagnostic:true, fullRebuild:false,
    compiled:build.compiled, sources:build.sources, products:build.products, log:build.log,
    preservedLinkInputs:build.linkInputs.length},
  native:{report:packaged.native, policyChecks:native.policyChecks, modes:native.modes,
    products:native.products, runtimeShaderArchive:native.runtimeShaderArchive},
  hierarchyShaders:{report:packaged.hierarchyShaders, ...hierarchyShaders},
  sources:[__filename, path.join(__dirname, 'build-web-engine.ps1'),
    path.join(__dirname, '../../UE58_WEBGPU_NANITE_IMPLEMENTATION.md')].map(audit),
  boundary:browser.boundary};
const destination = path.join(__dirname, 'evidence/nanite-browser-scene-depth-20261108.json');
const previewDestination = destination.replace(/\.json$/, '.png');
fs.copyFileSync(browser.depthPreview.file, previewDestination);
report.visibilityPreview = audit(previewDestination);
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass:true, destination}));
