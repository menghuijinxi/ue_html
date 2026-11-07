'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit, metadata} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
assert(process.argv[2], 'Pass the verified native uploader output directory');
const native = path.resolve(process.argv[2]);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const verify = i => assert.equal(audit(i.file).sha256, i.sha256, i.file);
const verified = read(path.join(native, 'verified.json'));
assert(verified.pass); verified.sources.forEach(verify);
verify(verified.runtimeShaderArchive);
const asset = path.dirname(verified.browserOracle.file);
// Match the current Renderer shader set; the historical default-template Cook
// predates required translucency shaders in the current threaded runtime.
const baseline = path.join(__dirname, 'build/villa-default-20261107');
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
const originalGlobal = Buffer.alloc(global.size), fd = fs.openSync(baselinePack, 'r');
try { assert.equal(fs.readSync(fd, originalGlobal, 0, global.size, global.offset), global.size); }
finally { fs.closeSync(fd); }
const merged = Buffer.concat([originalGlobal, archive.subarray(4)]);
merged.writeInt32LE(originalGlobal.readInt32LE() + 1);
fs.copyFileSync(baselinePack, path.join(output, 'content.bin'));
let offset = fs.statSync(baselinePack).size;
for (const [virtualPath, data] of [[global.path, merged],
  ['/Engine/Programs/UEWebEngine/Content/NaniteUploader/resources.cooked.bin', fs.readFileSync(path.join(asset, 'resources.cooked.bin'))]]) {
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
let html = fs.readFileSync(path.join(baseline, 'index.html'), 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/); assert(match);
const assets = {...JSON.parse(match[1]), versions, runtime:'UEWebEngineThreads.js',
  wasm:metadata(path.join(output, 'UEWebEngineThreads.wasm'), 'UEWebEngineThreads.wasm')};
assert(assets.threads && assets.renderer === 'desktop');
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
fs.writeFileSync(path.join(output, 'index.html'), html);
const products = ['index.html', 'content.bin', 'content-files.json', 'config-files.json', ...helpers, ...runtime].map(n => audit(path.join(output, n)));
products.push(writeVersions(output, products));
const report = {date:new Date().toISOString(), pass:true, output, build:audit(path.join(buildDir, 'build.json')),
  native:audit(path.join(native, 'verified.json')), browserOracle:verified.browserOracle, archive:audit(archiveFile),
  baseline:[baselinePack, ...['content-files.json', 'config-files.json', 'index.html'].map(n => path.join(baseline, n))].map(audit),
  sources:[__filename, ...helpers.map(n => path.join(__dirname, n))].map(audit),
  cookedResource:audit(path.join(asset, 'resources.cooked.bin')), products,
  boundary:'Existing matching Villa Cook payload plus a cooked transcode global-map section and serialized resident Nanite resource. Explicit diagnostic uses actual browser UE uploader; this is not full Nanite scene activation or a new full level Cook.'};
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass:true, output}));
