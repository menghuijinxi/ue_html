'use strict';
// Preserve a measured Cook payload exactly while testing runtime-only changes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit, metadata} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const baseline = option('baseline'), outputFolder = option('output');
assert([baseline, outputFolder].every(x => x && /^[a-z0-9-]+$/.test(x)) && baseline !== outputFolder);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const results = path.join(__dirname, 'results'), base = path.join(__dirname, 'build', baseline);
const output = path.join(__dirname, 'build', outputFolder);
const evidenceFile = option('evidence');
assert(evidenceFile, 'Require a historical ABBA report identifying the exact baseline package');
const evidence = read(evidenceFile), proof = Object.values(evidence.packages).find(x => x.folder === baseline);
assert(evidence.pass && proof && Object.values(proof.files).every(valid));
const buildFile = path.join(results, 'web-engine-full-thread-build-results.json'), build = read(buildFile);
assert(build.pass && build.threads && build.buildSucceeded && build.exitCode === 0 &&
  (build.fullLinkAttempted || build.fullLinkVerified) && build.sourceFiles.every(valid) && build.products.every(valid));
assert(build.objects.every(x => [x.object, x.response, x.definitions, x.source].every(valid)));
assert(!fs.existsSync(output), 'Use a fresh experiment folder to preserve prior evidence');
fs.mkdirSync(output, {recursive: true});
for (const f of fs.readdirSync(base)) if (fs.statSync(path.join(base, f)).isFile()) {
  const source=path.join(base,f),destination=path.join(output,f);
  if(['content.bin','content-files.json','config-files.json'].includes(f)) {
    // Immutable Cook payloads are shared; never link the runtime/helpers we replace.
    try {fs.linkSync(source,destination);} catch {fs.copyFileSync(source,destination);}
  } else fs.copyFileSync(source,destination);
}
const runtimeNames = ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'];
for (const name of runtimeNames) fs.copyFileSync(build.products.find(x => path.basename(x.file) === name).file, path.join(output, name));
const helpers = ['web-engine-host.js', 'web-engine-worker.js', 'web-content-io.js', 'web-content-worker.js'];
for (const name of helpers) fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
const htmlFile = path.join(output, 'index.html');
let html = fs.readFileSync(htmlFile, 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
assert(match);
const assets = JSON.parse(match[1]);
assert(assets.threads && assets.distanceFields && assets.renderer === 'desktop');
for (const name of [...runtimeNames, ...helpers]) assets.versions[name] = audit(path.join(output, name)).sha256;
assets.wasm = metadata(path.join(output, 'UEWebEngineThreads.wasm'), 'UEWebEngineThreads.wasm');
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
const psoPrecache = process.argv.includes('--pso-precache');
if (psoPrecache) {
  const args = html.match(/arguments: (\[[^\n]+\]),/);
  assert(args);
  // Historical hand-authored pages use single-quoted argument literals.
  // Accept only plain argument strings; do not evaluate page source as code.
  assert(/^\[\s*(?:['"][a-zA-Z0-9_./=:-]+['"]\s*,?\s*)*\]$/.test(args[1]));
  const values = [...args[1].matchAll(/['"]([a-zA-Z0-9_./=:-]+)['"]/g)].map(match=>match[1]);
  values.push('-WebPSOPrecacheTest');
  html = html.replace(args[0], 'arguments: ' + JSON.stringify(values) + ',');
}
fs.writeFileSync(htmlFile, html);
for (const name of ['content.bin', 'content-files.json', 'config-files.json'])
  assert.equal(audit(path.join(output, name)).sha256, audit(path.join(base, name)).sha256);
const products = fs.readdirSync(output).filter(f => f !== 'asset-versions.json').map(f => audit(path.join(output, f)));
products.push(writeVersions(output, products));
const buildSnapshot = path.join(results, outputFolder + '-build.json');
fs.copyFileSync(buildFile, buildSnapshot);
const report = {date: new Date().toISOString(), pass: true, baseline, output, psoPrecache,
  sources: [__filename, ...helpers.map(f => path.join(__dirname, f))].map(audit),
  build: audit(buildSnapshot), historicalEvidence: audit(evidenceFile), historicalCookPayload: proof.files,
  projectQualityOverrides: [], products,
  boundary: 'Runtime-only experiment. Reuses historical measured Cook content/config byte for byte; does not claim a fresh Cook or current shader compiler audit.'};
fs.writeFileSync(path.join(results, outputFolder + '-package.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, files: products.length}));
