'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const {readPage, writePage} = require('../web-pipeline-prewarm-package.cjs');
const base = path.resolve(__dirname, '..');
const source = path.join(base, 'build/villa-shadow-on-20261111-sparse');
const variantsFile = path.resolve(process.argv[2] || path.join(base, 'results/vsm-adaptive-variants-20261111-v2.json'));
const variants = JSON.parse(fs.readFileSync(variantsFile));
assert(variants.pass && variants.diagnosticOnly);
assert.deepEqual(variants.variants.map(v => v.permutation).sort(), [17, 18]);
const sourceVersions = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json')));
const corpus = JSON.parse(fs.readFileSync(path.join(source, 'pipeline-prewarm.json')));
for (const variant of variants.variants) {
  const modules = corpus.modules.filter(m => m.descriptor.code.includes('fn ' + variant.entry + '('));
  assert(modules.length);
  assert(modules.every(m => variant.replacements.some(r =>
    r.original === m.descriptor.code.replaceAll('\r\n', '\n').trim())), 'Unknown prewarm shader');
}
for (const name of ['web-engine-host.js', 'web-engine-worker.js', 'web-content-worker.js', 'web-pipeline-prewarm.js'])
  assert.equal(audit(path.join(source, name)).sha256, audit(path.join(base, name)).sha256,
    'Diagnostic base must use the current host and workers: ' + name);
for (const [name, record] of Object.entries(sourceVersions))
  assert.equal(audit(path.join(source, name)).sha256, record.sha256, 'Source changed: ' + name);

function install(variants, enabled) {
  const probe = globalThis.__webVSMAdaptiveProbe = {diagnosticOnly: true, enabled,
    entries: variants.map(v => v.entry), matched: {}, replaced: {}, errors: [], features: []};
  const error = message => {
    if (probe.errors.length < 30) probe.errors.push(String(message));
  };
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor) {
    const device = await request.call(this, descriptor);
    probe.features = [...device.features];
    if (enabled && !device.features.has('subgroups')) throw Error('自适应试验需要 subgroups 支持');
    device.addEventListener('uncapturederror', event => error(event.error.message));
    device.lost.then(info => {if (info.reason !== 'destroyed') error(info.message);});
    return device;
  };
  const create = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    const variant = variants.find(v => descriptor.code.includes('fn ' + v.entry + '('));
    if (variant) {
      const code = descriptor.code.replaceAll('\r\n', '\n').trim();
      const replacement = variant.replacements.find(r => r.original === code);
      if (!replacement) throw Error('Unrecognized VSM shader: ' + variant.entry);
      probe.matched[variant.entry] = (probe.matched[variant.entry] || 0) + 1;
      if (enabled) {
        descriptor = {...descriptor, code: replacement.adaptive};
        probe.replaced[variant.entry] = (probe.replaced[variant.entry] || 0) + 1;
      }
    }
    return create.call(this, descriptor);
  };
}

const report = {date: new Date().toISOString(), diagnosticOnly: true, releaseReady: false,
  base: audit(path.join(source, 'asset-versions.json')), variants: audit(variantsFile), packages: [],
  boundary: 'Explicit live diagnostic. Shader replacement applies before both prewarm and runtime creation. Original descriptor keys are retained for this experiment only; this is not a new Cook or a release corpus.'};
const workerSource = fs.readFileSync(path.join(source, 'web-engine-worker.js'), 'utf8');
const iniMarker = "        removeRunDependency('worker-content');";
const stateMarker = "  '__webEngineFrames', '__webEngineRuntime',";
assert.equal(workerSource.split(iniMarker).length, 2);
assert.equal(workerSource.split(stateMarker).length, 2);
for (const mode of ['baseline', 'adaptive']) {
  const directory = path.join(base, 'build/villa-vsm-sampling-' + mode + '-20261112');
  assert(!fs.existsSync(directory), 'Refuse to overwrite an existing diagnostic package: ' + directory);
}
for (const mode of ['baseline', 'adaptive']) {
  const directory = path.join(base, 'build/villa-vsm-sampling-' + mode + '-20261112');
  fs.mkdirSync(directory);
  for (const name of fs.readdirSync(source)) {
    if (['index.html', 'asset-versions.json', 'web-engine-worker.js'].includes(name)) continue;
    // Only immutable artifacts are linked. Modified files always get separate inodes.
    fs.linkSync(path.join(source, name), path.join(directory, name));
  }
  const settings = '\n[SystemSettings]\nr.Shadow.Virtual.SMRT.AdaptiveRayCount=1\n';
  const worker = '(' + install.toString() + ')(' + JSON.stringify(variants.variants) +
    ',' + (mode === 'adaptive') + ');\n' + workerSource
    .replace(stateMarker, "  '__webVSMAdaptiveProbe',\n" + stateMarker)
    .replace(iniMarker, `        const samplingIni = '/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(samplingIni, FS.readFile(samplingIni, {encoding:'utf8'}) + ${JSON.stringify(settings)});
${iniMarker}`);
  fs.writeFileSync(path.join(directory, 'web-engine-worker.js'), worker);
  const page = readPage(source);
  page.assets.versions['web-engine-worker.js'] = audit(path.join(directory, 'web-engine-worker.js')).sha256;
  page.assets.diagnosticOnly = true;
  page.assets.vsmAdaptiveProbe = mode;
  delete page.assets.releaseDefaults;
  assert(!page.args.includes('-WebPSOPrecacheTest'));
  writePage(directory, page);
  const descriptor = {diagnosticOnly: true, releaseReady: false, mode, base: report.base,
    variants: report.variants, boundary: report.boundary};
  fs.writeFileSync(path.join(directory, 'diagnostic-package.json'), JSON.stringify(descriptor, null, 2));
  const versions = {};
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name), stat = fs.statSync(file);
    versions[name] = {sha256: sourceVersions[name]?.sha256 || audit(file).sha256,
      size: stat.size, mtimeMs: stat.mtimeMs};
    if (['index.html', 'web-engine-worker.js'].includes(name)) versions[name].sha256 = audit(file).sha256;
  }
  fs.writeFileSync(path.join(directory, 'asset-versions.json'), JSON.stringify(versions, null, 2));
  report.packages.push({mode, manifest: audit(path.join(directory, 'asset-versions.json'))});
}
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json'))), sourceVersions);
const output = path.join(base, 'results/vsm-adaptive-live-packages-20261112.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, packages: report.packages}));
