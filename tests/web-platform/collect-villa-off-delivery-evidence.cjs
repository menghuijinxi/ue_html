'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const {audit} = require('./content-file-metadata.cjs');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const verify = item => assert.equal(audit(item.file).sha256, item.sha256, item.file);
const name = 'villa-nanite-off-delivery-20261111', output = path.join(__dirname, 'evidence', name);
fs.mkdirSync(output, {recursive: true});
const artifacts = [], seen = new Set();
function archive(file) {
  file = path.resolve(file); if (seen.has(file)) return; seen.add(file);
  const data = fs.readFileSync(file), zipped = zlib.gzipSync(data, {level: 9});
  assert(zlib.gunzipSync(zipped).equals(data));
  const destination = path.join(output, `${artifacts.length}-${path.basename(file)}.gz`);
  fs.writeFileSync(destination, zipped);
  artifacts.push({original: audit(file), archive: audit(destination), encoding: 'gzip'});
}
const packageFile = path.join(__dirname, 'results/villa-nanite-off-20261111-package.json');
const pkg = read(packageFile); assert(pkg.pass); verify(pkg.source); verify(pkg.baseline); pkg.products.forEach(verify);
assert.deepEqual(pkg.settingsOverrides, {'r.Nanite': 0}); assert(pkg.additionalFileBytes < 1024 * 1024);
const original = read(pkg.baseline.file), oldDirectory = path.dirname(pkg.baseline.file);
const oldConfig = read(path.join(oldDirectory, 'config-files.json'));
const newConfig = read(path.join(pkg.output, 'config-files.json'));
assert.equal(oldConfig.length, newConfig.length);
for (let i = 0; i < oldConfig.length; ++i) {
  if (oldConfig[i].path === '/Engine/Platforms/Web/Config/WebEngine.ini') {
    assert.equal(Buffer.from(newConfig[i].data, 'base64').toString(),
      Buffer.from(oldConfig[i].data, 'base64').toString() + '\n[SystemSettings]\nr.Nanite=0\n');
  } else assert.deepEqual(newConfig[i], oldConfig[i]);
}
for (const item of pkg.shared) {
  assert.equal(original.products.find(p => path.basename(p.file) === item.name).sha256, item.sha256);
  const a = fs.statSync(path.join(oldDirectory, item.name)), b = fs.statSync(path.join(pkg.output, item.name));
  assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino); assert(b.nlink >= 2);
}
const probeFile = path.join(__dirname, 'results/villa-nanite-off-20261111/report.json');
const probe = read(probeFile); assert(probe.pass); verify(probe.source); verify(probe.package);
assert.equal(probe.package.sha256, audit(packageFile).sha256); assert.deepEqual(probe.errors, []);
assert.equal(probe.runs.length, 2);
for (const run of probe.runs) {
  assert.equal(run.nanite.enabled, false); assert.equal(run.nanite.registered, 0); assert.equal(run.nanite.entries, 0);
  assert(run.nanite.assets >= 2062 && run.movementCm > 5);
  verify(run.nanite.report); archive(run.nanite.report.file);
  archive(path.join(path.dirname(probeFile), `run-${run.run}.png`));
}
archive(path.join(path.dirname(probeFile), 'browser.log'));
const planFile = path.join(__dirname, 'cleanup-test-cache-20261111.json'), plan = read(planFile);
for (const item of plan.targets) {
  assert(fs.existsSync(item.path), 'Evidence collection must not delete cleanup targets'); assert.equal(item.links, 0);
  const parent = path.dirname(item.path);
  assert([path.join(plan.buildRoot, 'browser-profiles'), path.join(plan.buildRoot, 'browser-profile-archives')].includes(parent)
    || item.path === path.join(plan.buildRoot, 'nanite-release-20261111-launcher-failed'));
}
assert.equal(plan.targets.length, 191); assert.equal(plan.skipped.length, 4);
const previewFile = path.join(__dirname, 'results/cleanup-test-cache-20261111-preview.txt');
assert(fs.readFileSync(previewFile, 'utf8').includes('仅预览，未删除任何文件。'));
for (const file of [packageFile, pkg.source.file, pkg.baseline.file, probeFile, probe.source.file,
  path.join(pkg.output, 'index.html'), path.join(pkg.output, 'config-files.json'), path.join(pkg.output, 'asset-versions.json'),
  planFile, path.join(__dirname, 'create-test-cache-cleanup-plan.cjs'), path.join(__dirname, 'cleanup-test-cache-20261111.ps1'),
  path.join(__dirname, '清理旧测试缓存-20261111.bat'), path.join(__dirname, '清理旧测试缓存-20261111.txt'), previewFile, __filename]) archive(file);
const evidence = {pass: true, date: new Date().toISOString(), source: audit(__filename),
  url: pkg.url, package: audit(packageFile), verification: audit(probeFile), additionalFileBytes: pkg.additionalFileBytes,
  runs: probe.runs.map(r => ({run: r.run, fps: r.fps, nanite: r.nanite, movementCm: r.movementCm})),
  cleanup: {plan: audit(planFile), preview: audit(previewFile), deletionExecuted: false,
    directories: plan.targets.length, logicalGiB: plan.logicalBytes / 2 ** 30, skippedLinks: plan.skipped.length},
  artifacts,
  boundary: 'Requested current-version Nanite-off test package. Native Nanite is disabled from startup and remains disabled on reload. '
    + 'Startup, real input and resize pass; these checks do not close Nanite compatibility or performance work. '
    + 'Cleanup was previewed only. The user runs the fixed-list batch manually; logical size is not guaranteed physical recovery.'};
fs.writeFileSync(path.join(__dirname, 'evidence', name + '.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log({pass: true, url: pkg.url, archives: artifacts.length, additionalFileBytes: pkg.additionalFileBytes,
  cleanup: evidence.cleanup});
