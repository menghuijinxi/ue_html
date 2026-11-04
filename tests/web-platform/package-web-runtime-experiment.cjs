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
assert(evidenceFile, 'Require a verified package or ABBA report identifying the exact baseline');
const evidence = read(evidenceFile);
const proof = evidence.packages ? Object.values(evidence.packages).find(x => x.folder === baseline) :
  evidence.output && path.resolve(evidence.output) === base && (evidence.fullNormalUBTBuildVerified ||
    (valid(evidence.build) && evidence.baselineCookPayload?.every(valid))) &&
  evidence.products?.every(valid) ? {files: evidence.products} : null;
assert(evidence.pass && proof && Object.values(proof.files).every(valid));
const trace = process.argv.includes('--trace');
const simd = process.argv.includes('--simd');assert(!(simd&&trace));
const buildFile = option('build-report') ? path.resolve(option('build-report')) : path.join(results, `web-engine-full-thread${simd ? '-simd' : trace ? '-trace' : ''}-build-results.json`), build = read(buildFile);
assert(build.pass && build.threads && build.buildSucceeded && build.exitCode === 0 &&
  (build.fullLinkAttempted || build.fullLinkVerified) && build.sourceFiles.every(valid) && build.products.every(valid));
assert(Boolean(build.trace) === trace);
assert(Boolean(build.simd) === simd);
assert(build.objects.every(x => [x.object, x.response, x.definitions, x.source].every(valid)));
assert(!fs.existsSync(output), 'Use a fresh experiment folder to preserve prior evidence');
fs.mkdirSync(output, {recursive: true});
for (const f of fs.readdirSync(base)) if (fs.statSync(path.join(base, f)).isFile()) {
  if (/^UEWebEngine.*\.(wasm|js)$/.test(f)) continue;
  const source=path.join(base,f),destination=path.join(output,f);
  if(['content.bin','content-files.json','config-files.json'].includes(f)) {
    // Immutable Cook payloads are shared; never link the runtime/helpers we replace.
    try {fs.linkSync(source,destination);} catch {fs.copyFileSync(source,destination);}
  } else fs.copyFileSync(source,destination);
}
const runtime = simd ? 'UEWebEngineThreadsSIMD' : trace ? 'UEWebEngineThreadsTrace' : 'UEWebEngineThreads';
const runtimeNames = [runtime + '.js', runtime + '.wasm'];
for (const name of runtimeNames) fs.copyFileSync(build.products.find(x => path.basename(x.file) === name).file, path.join(output, name));
const helpers = ['web-engine-host.js', 'web-engine-worker.js', 'web-content-io.js', 'web-content-worker.js'];
for (const name of helpers) fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
const htmlFile = path.join(output, 'index.html');
let html = fs.readFileSync(htmlFile, 'utf8');
const startupProfile = process.argv.includes('--startup-profile');
const startupProfileSource = path.join(__dirname, 'web-startup-profile.js');
if (startupProfile) {
  const recorder = fs.readFileSync(startupProfileSource, 'utf8');
  assert(!recorder.includes('</script>'));
  const worker = path.join(output, 'web-engine-worker.js');
  fs.writeFileSync(worker, recorder + '\n' + fs.readFileSync(worker, 'utf8'));
  assert(html.includes('<meta charset="utf-8">') && html.includes('function startupStage(stage) {'));
  html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<script>globalThis.__webStartupProfileManual = true;\n' + recorder + '\n</script>');
  html = html.replace('function startupStage(stage) {', 'function startupStage(stage) {\n globalThis.__webStartupProfile?.mark("page.stage." + stage);');
}
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
assert(match);
const assets = JSON.parse(match[1]);
assert(assets.threads && assets.distanceFields && assets.renderer === 'desktop');
for (const name of Object.keys(assets.versions)) if (/^UEWebEngine.*\.(wasm|js)$/.test(name)) delete assets.versions[name];
assets.trace = trace;
assets.runtime = runtimeNames[0];
for (const name of [...runtimeNames, ...helpers]) assets.versions[name] = audit(path.join(output, name)).sha256;
assets.wasm = metadata(path.join(output, runtimeNames[1]), runtimeNames[1]);
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
const psoPrecache = process.argv.includes('--pso-precache');
const threadingTest = option('threading-test') || null;
assert(threadingTest === null || ['full', 'render-serial', 'single'].includes(threadingTest));
const precacheConcurrency = option('pso-concurrency') === undefined ? null : Number(option('pso-concurrency'));
assert(precacheConcurrency === null || (Number.isInteger(precacheConcurrency) && precacheConcurrency >= 1 && precacheConcurrency <= 8));
if (psoPrecache || precacheConcurrency !== null || threadingTest !== null) {
  const args = html.match(/arguments: (\[[^\n]+\]),/);
  assert(args);
  // Historical hand-authored pages use single-quoted argument literals.
  // Accept only plain argument strings; do not evaluate page source as code.
  assert(/^\[\s*(?:['"][a-zA-Z0-9_./=:-]+['"]\s*,?\s*)*\]$/.test(args[1]));
  const values = [...args[1].matchAll(/['"]([a-zA-Z0-9_./=:-]+)['"]/g)].map(match=>match[1]);
  if (threadingTest !== null) {
    assert(!values.some(value => value.startsWith('-WebThreadingTest=')));
    values.push('-WebThreadingTest=' + threadingTest);
  }
  if (psoPrecache && !values.includes('-WebPSOPrecacheTest')) values.push('-WebPSOPrecacheTest');
  if (precacheConcurrency !== null) {
    assert(values.includes('-WebPSOPrecacheTest'), 'Concurrency variant requires PSO precaching');
    assert(!values.some(value => value.startsWith('-WebPSOPrecacheConcurrency=')));
    values.push('-WebPSOPrecacheConcurrency=' + precacheConcurrency);
  }
  html = html.replace(args[0], 'arguments: ' + JSON.stringify(values) + ',');
}
fs.writeFileSync(htmlFile, html);
for (const name of ['content.bin', 'content-files.json', 'config-files.json'])
  assert.equal(audit(path.join(output, name)).sha256, audit(path.join(base, name)).sha256);
const products = fs.readdirSync(output).filter(f => f !== 'asset-versions.json').map(f => audit(path.join(output, f)));
products.push(writeVersions(output, products));
const buildSnapshot = path.join(results, outputFolder + '-build.json');
if (path.resolve(buildFile).toLowerCase() !== path.resolve(buildSnapshot).toLowerCase()) {
  fs.copyFileSync(buildFile, buildSnapshot);
}
const report = {date: new Date().toISOString(), pass: true, baseline, output, trace, psoPrecache, precacheConcurrency, startupProfile, threadingTest,
  sources: [__filename, ...helpers.map(f => path.join(__dirname, f)), ...(startupProfile ? [startupProfileSource] : [])].map(audit),
  build: audit(buildSnapshot), baselineEvidence: audit(evidenceFile), baselineCookPayload: proof.files,
  projectQualityOverrides: [], products,
  boundary: 'Runtime-only variant. Reuses the audited baseline Cook content/config byte for byte; the baseline reports retain Cook provenance. This variant does not rerun Cook.'};
fs.writeFileSync(path.join(results, outputFolder + '-package.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, files: products.length}));
