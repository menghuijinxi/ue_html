'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit, metadata} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {validateCook} = require('./cached-cook-validation.cjs');
assert(process.argv[2], 'Pass the verified native uploader output directory');
const native = path.resolve(process.argv[2]);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const verify = i => assert.equal(audit(i.file).sha256, i.sha256, i.file);
const verified = read(path.join(native, 'verified.json'));
assert(verified.pass); verified.sources.forEach(verify);
assert(process.argv[3], 'Pass the verified multi-material native uploader directory');
const multiNativeFile=path.join(path.resolve(process.argv[3]),'verified.json'),multiNative=read(multiNativeFile);
assert(multiNative.pass);[...multiNative.sources,...multiNative.products].forEach(verify);
const multiAsset=path.dirname(multiNative.browserOracle.file),multiFixtureFile=path.join(multiAsset,'fixture.json'),multiFixture=read(multiFixtureFile);
assert(multiFixture.pass);[...multiFixture.sources,...multiFixture.products,multiFixture.binary].forEach(verify);
const multiMaterial={native:audit(multiNativeFile),fixture:audit(multiFixtureFile),browserOracle:multiNative.browserOracle,gpuPage:multiNative.products[0],
  cookedResource:audit(path.join(multiAsset,'resources.cooked.bin')),sourceTriangles:audit(path.join(multiAsset,'source-triangles.bin')),
  sourceMaterials:audit(path.join(multiAsset,'source-materials.bin'))};
verify(verified.runtimeShaderArchive);
const asset = path.dirname(verified.browserOracle.file);
// Inline platform predicates changed with the full target rebuild. Global and
// material shader maps must both come from a matching scene Cook.
const stageFile = path.join(__dirname, 'results/web-project-nanite-hzb-desktop-stage-results.json');
const stage = read(stageFile);
assert(stage.pass && stage.mode === 'WebGPU-SM5' && stage.useProjectSettings);
[...stage.sourceFiles, stage.cookReport, stage.pack, stage.manifest, stage.configBundle].forEach(verify);
const cook = read(stage.cookReport.file);
validateCook(cook, false, {});
assert(cook.exitCode === 0 && !cook.disabledSkyLight && cook.useProjectSettings);
assert.equal(cook.map, '/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla');
verify(cook.shaderInventory.artifact);
const inventory = read(cook.shaderInventory.artifact.file);
const naniteTypes = ['HZBBuildCS','OcclusionCS','HierarchyCull_CS','RasterVS','RasterPS','VisibleClustersCS','MaterialInputsCS',
  'ResolveCS','DepthVS','DepthPS','DepthSnapshotCS','GBufferVS','GBufferPS','GBufferSnapshotCS',
  'GBufferTilesCS','VisibilityClearCS','VisibilityResolveCS'].map(name => 'FWebNanite' + name);
assert(naniteTypes.every(name => inventory.types.some(type => type.name === name && type.permutations === 1)),
  'The scene Cook must include diagnostic and production Nanite shaders in complete sections');
assert(inventory.types.some(type=>type.name==='FWebNaniteScalarRasterPS'&&type.permutations===2), 'Both scalar visibility phases must be cooked');
assert.deepEqual(inventory.settings['r.VirtualTextures'], {host:'1',target:'1'});
const baseline = path.dirname(stage.manifest.file);
const pageTemplate = path.join(__dirname, 'build/villa-default-20261107/index.html');
const buildDir = path.join(__dirname, 'build/nanite-browser-runtime');
const build = read(path.join(buildDir, 'build.json'));
assert(build.pass); build.sources.forEach(verify); build.products.forEach(verify);
const output = path.join(__dirname, 'build/nanite-browser');
fs.mkdirSync(output, {recursive: true});
const manifest = read(path.join(baseline, 'content-files.json'));
assert.equal(manifest.shaderPlatform, 'SP_WEBGPU_SM5');
const baselinePack = path.join(baseline, manifest.pack.url);
assert.equal(audit(baselinePack).sha256, manifest.pack.sha256);
const global = manifest.files.find(f => f.path === '/Engine/GlobalShaderCache-SP_WEBGPU_SM5.bin');
assert(global);
const archiveFile = path.join(native, 'uploader-global-shaders.bin');
assert.equal(path.resolve(verified.runtimeShaderArchive.file), archiveFile);
const archive = fs.readFileSync(archiveFile);
assert.equal(archive.readInt32LE(), 1, 'Expected exactly the production transcode section');
const hierarchyFile = path.join(__dirname, 'results/nanite-hierarchy-shaders/verified.json');
const hierarchyShaders = read(hierarchyFile);
assert(hierarchyShaders.pass);
[...hierarchyShaders.sources, ...hierarchyShaders.shaderInputs, ...hierarchyShaders.compiler,
  hierarchyShaders.archive, hierarchyShaders.binary, ...hierarchyShaders.logs].forEach(verify);
assert.equal(fs.readFileSync(hierarchyShaders.archive.file).readInt32LE(), 8);
const originalGlobal = Buffer.alloc(global.size), fd = fs.openSync(baselinePack, 'r');
try { assert.equal(fs.readSync(fd, originalGlobal, 0, global.size, global.offset), global.size); }
finally { fs.closeSync(fd); }
// The full Cook registers the 13 hierarchy/raster/depth/GBuffer shader types.
// Preserve its complete sections, including production entries in shared files.
// Only the separately verified production transcode archive is appended.
const merged = Buffer.concat([originalGlobal, archive.subarray(4)]);
merged.writeInt32LE(originalGlobal.readInt32LE() + archive.readInt32LE());
fs.copyFileSync(baselinePack, path.join(output, 'content.bin'));
let offset = fs.statSync(baselinePack).size;
for (const [virtualPath, data] of [[global.path, merged],
  ['/Engine/Programs/UEWebEngine/Content/NaniteUploader/resources.cooked.bin', fs.readFileSync(path.join(asset, 'resources.cooked.bin'))],
  ['/Engine/Programs/UEWebEngine/Content/NaniteUploader/source-triangles.bin', fs.readFileSync(path.join(asset, 'source-triangles.bin'))],
  ['/Engine/Programs/UEWebEngine/Content/NaniteMultiMaterial/resources.cooked.bin',fs.readFileSync(multiMaterial.cookedResource.file)],
  ['/Engine/Programs/UEWebEngine/Content/NaniteMultiMaterial/source-triangles.bin',fs.readFileSync(multiMaterial.sourceTriangles.file)]]) {
  manifest.files = manifest.files.filter(f => f.path !== virtualPath);
  const sha256 = require('node:crypto').createHash('sha256').update(data).digest('hex');
  manifest.files.push({path: virtualPath, offset, size: data.length, sha256});
  fs.appendFileSync(path.join(output, 'content.bin'), data); offset += data.length;
}
manifest.pack = metadata(path.join(output, 'content.bin'), 'content.bin');
fs.writeFileSync(path.join(output, 'content-files.json'), JSON.stringify(manifest));
fs.copyFileSync(path.join(baseline, 'config-files.json'), path.join(output, 'config-files.json'));
const helpers = ['web-content-io.js', 'web-content-worker.js', 'web-engine-host.js', 'web-engine-worker.js'];
for (const name of helpers) fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
for (const file of build.products) fs.copyFileSync(file.file, path.join(output, path.basename(file.file)));
const runtime = build.products.map(i => path.basename(i.file));
const versions = Object.fromEntries([...runtime, ...helpers].map(n => [n, audit(path.join(output, n)).sha256]));
let html = fs.readFileSync(pageTemplate, 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/); assert(match);
const assets = {...JSON.parse(match[1]), versions, runtime:'UEWebEngineThreads.js',
  wasm:metadata(path.join(output, 'UEWebEngineThreads.wasm'), 'UEWebEngineThreads.wasm')};
assert(assets.threads && assets.renderer === 'desktop');
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
assert(html.includes('arguments: ['));
html = html.replace('arguments: [', 'arguments: ["-WebNaniteResidentResources","-WebNaniteRootPages=2",');
fs.writeFileSync(path.join(output, 'index.html'), html);
const products = ['index.html', 'content.bin', 'content-files.json', 'config-files.json', ...helpers, ...runtime].map(n => audit(path.join(output, n)));
products.push(writeVersions(output, products));
const report = {date:new Date().toISOString(), pass:true, output, build:audit(path.join(buildDir, 'build.json')),
  native:audit(path.join(native, 'verified.json')), browserOracle:verified.browserOracle, archive:audit(archiveFile),
  hierarchyShaders:audit(hierarchyFile),multiMaterial,
  sceneCook:{stage:audit(stageFile),cook:stage.cookReport,inventory:cook.shaderInventory.artifact,
    naniteTypes,supplementApplied:false,hierarchyArchiveApplied:false},
  baseline:[baselinePack, ...['content-files.json', 'config-files.json'].map(n => path.join(baseline, n)),pageTemplate].map(audit),
  sources:[__filename, path.join(__dirname,'cached-cook-validation.cjs'), ...helpers.map(n => path.join(__dirname, n))].map(audit),
  cookedResource:audit(path.join(asset, 'resources.cooked.bin')), sourceTriangles:audit(path.join(asset, 'source-triangles.bin')), products,
  boundary:'Fresh Villa scene Cook with resident Nanite depth, visible records and constant DefaultLit GBuffer export/snapshot shaders. Explicit component bindings and default-off toggles; no automatic whole-level Nanite conversion, arbitrary UMaterial graph, lightmaps, Substrate or complete scene acceptance.'};
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass:true, output}));
