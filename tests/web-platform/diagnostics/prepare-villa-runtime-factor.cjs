'use strict';
const {initializeProjectOutput, assertProjectOutputTree, assertProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {readPage, writePage} = require('../web-pipeline-prewarm-package.cjs');
const {audit} = require('../content-file-metadata.cjs');
const {writeVersions} = require('../asset-versions.cjs');
const base = path.resolve(__dirname, '..');
const old = path.join(base, 'build/villa-vsm-sampling-adaptive-20261112');
const factors = {
  pages: {source: 'villa-vsm-pages-final-20261112', folder: 'villa-runtime-factor-pages-20261113'},
  tsr: {source: 'villa-tsr-tiles-20261112', folder: 'villa-runtime-factor-20261113'},
};
const factor = process.argv[2] || 'pages';
assert(Object.hasOwn(factors, factor));
const runtime = path.join(base, 'build', factors[factor].source);
const directory = assertProjectOutputTree(path.join(base, 'build', factors[factor].folder));
assert(!fs.existsSync(directory), 'Preserve existing diagnostic packages');
const original = JSON.parse(fs.readFileSync(path.join(old, 'asset-versions.json')));
const replacement = JSON.parse(fs.readFileSync(path.join(runtime, 'asset-versions.json')));
for (const [name, record] of Object.entries(original))
  assert.equal(audit(path.join(old, name)).sha256, record.sha256);
for (const name of ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'])
  assert.equal(audit(path.join(runtime, name)).sha256, replacement[name].sha256);
const oldManifest = audit(path.join(old, 'asset-versions.json'));
const runtimeManifest = audit(path.join(runtime, 'asset-versions.json'));
fs.mkdirSync(directory);
const privateFiles = ['index.html', 'web-engine-worker.js', 'pipeline-prewarm.json', 'diagnostic-package.json'];
const runtimeFiles = ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'];
for (const name of Object.keys(original)) {
  if (privateFiles.includes(name) || name === 'asset-versions.json') continue;
  fs.linkSync(path.join(runtimeFiles.includes(name) ? runtime : old, name), path.join(directory, name));
}
const corpus = JSON.parse(fs.readFileSync(path.join(old, 'pipeline-prewarm.json')));
corpus.wasm = replacement['UEWebEngineThreads.wasm'].sha256;
fs.writeFileSync(path.join(directory, 'pipeline-prewarm.json'), JSON.stringify(corpus));
const overrides = {'r.WebGPU.IndirectDrawReuse': 0, 'r.WebGPU.VSMPageOptimization': 0};
if (factor === 'tsr') overrides['r.WebGPU.TSRLargeTiles'] = 0;
const marker = "        removeRunDependency('worker-content');";
let worker = fs.readFileSync(path.join(old, 'web-engine-worker.js'), 'utf8');
assert.equal(worker.split(marker).length, 2);
const ini = '\n[SystemSettings]\n' + Object.entries(overrides).map(([key, value]) => key + '=' + value).join('\n') + '\n';
worker = worker.replace(marker, `        const runtimeFactorIni = '/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(runtimeFactorIni, FS.readFile(runtimeFactorIni, {encoding:'utf8'}) + ${JSON.stringify(ini)});
${marker}`);
fs.writeFileSync(path.join(directory, 'web-engine-worker.js'), worker);
const page = readPage(old), replacementPage = readPage(runtime);
for (const name of runtimeFiles) page.assets.versions[name] = replacement[name].sha256;
page.assets.versions['web-engine-worker.js'] = audit(path.join(directory, 'web-engine-worker.js')).sha256;
page.assets.wasm = structuredClone(replacementPage.assets.wasm);
page.assets.pipelinePrewarm.sha256 = audit(path.join(directory, 'pipeline-prewarm.json')).sha256;
page.assets.runtimeFactor = true;
writePage(directory, page);
const diagnostic = {date: new Date().toISOString(), diagnosticOnly: true, releaseReady: false, factor,
  source: audit(__filename), old: oldManifest, runtime: runtimeManifest, overrides,
  diagnosticPrewarmIdentityOverride: true,
  boundary: 'Old Cook, config, host, adaptive shader replacement and startup arguments with the newer paired ' +
    'JS/WASM. Old pipeline descriptors replay with a diagnostic WASM identity override, not a release capture.'};
fs.writeFileSync(path.join(directory, 'diagnostic-package.json'), JSON.stringify(diagnostic, null, 2));
const products = Object.keys(original).map(name => ({
  file: path.join(directory, name),
  sha256: privateFiles.includes(name) ? audit(path.join(directory, name)).sha256 :
    (runtimeFiles.includes(name) ? replacement[name] : original[name]).sha256,
}));
const manifest = writeVersions(directory, products);
assert.equal(audit(oldManifest.file).sha256, oldManifest.sha256);
assert.equal(audit(runtimeManifest.file).sha256, runtimeManifest.sha256);
const output = assertProjectOutput(path.join(base, 'results', factors[factor].folder + '-package.json'));
fs.writeFileSync(output, JSON.stringify({...diagnostic, pass: true, directory, manifest}, null, 2));
console.log(JSON.stringify({pass: true, directory, manifest, output}));
