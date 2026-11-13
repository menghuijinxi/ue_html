'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {readPage, writePage} = require('./web-pipeline-prewarm-package.cjs');
const {finalizeDesktopRelease, verifyDesktopRelease} = require('./web-release-defaults.cjs');
const source = path.join(__dirname, 'build/villa-git-indirect-20261113');
const results = assertProjectOutputTree(path.join(__dirname, 'results/indirect-isolation-20261113'));
fs.mkdirSync(results, {recursive: true});
const parse = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const original = parse(path.join(source, 'asset-versions.json'));
const variants = {disabled: 0, templates: 1, bindings: 3};
function save(file, value) {
  fs.writeFileSync(assertProjectOutput(file), JSON.stringify(value, null, 2) + '\n');
}
function capture(folder) {
  const tag = 'indirect-isolation-' + path.basename(folder).replace('villa-indirect-', '') + '-' + Date.now();
  const snapshot = assertProjectOutputTree(path.join(__dirname, 'build', tag));
  fs.mkdirSync(snapshot);
  for (const name of fs.readdirSync(folder)) {
    if (['asset-versions.json', 'pipeline-prewarm.json'].includes(name)) continue;
    const from = path.join(folder, name), to = assertProjectOutput(path.join(snapshot, name));
    if (['content.bin', 'UEWebEngineThreads.wasm', 'UEWebEngineThreads.js'].includes(name)) fs.linkSync(from, to);
    else fs.copyFileSync(from, to);
  }
  writeVersions(snapshot, fs.readdirSync(snapshot).map(name => audit(path.join(snapshot, name))));
  const log = assertProjectOutput(path.join(results, tag + '.log'));
  const fd = fs.openSync(log, 'w');
  let child;
  console.log(JSON.stringify({stage: 'capture', tag, log}));
  try {
    child = cp.spawnSync(process.execPath, [path.join(__dirname, 'probe-villa-startup.cjs'),
      '--tag=' + tag, '--folder=' + tag, '--engine=ours', '--rounds=1', '--browser=msedge',
      '--profile=indirect-isolation-20261113', '--direct', '--origin=http://127.0.0.1:8765',
      '--capture', '--settle-frames=120', '--scripted-motion-seconds=12',
      '--width=1280', '--height=720', '--dpr=1'], {
      windowsHide: true, stdio: ['ignore', fd, fd], env: process.env});
  } finally {fs.closeSync(fd);}
  assert(!child.error && child.status === 0, 'Actual pipeline capture failed: ' + log);
  return path.join(__dirname, 'results/villa-startup-' + tag, '0-corpus.json');
}
async function main() {
  const response = await fetch('http://127.0.0.1:8765/villa-indirect-isolation-live.html');
  assert.equal(response.status, 200, 'Start the project preview service before capture');
  const sourceReport = parse(path.join(__dirname, 'results/git-history-20261113/indirect-package.json'));
  assert(sourceReport.pass && sourceReport.release.releaseReady);
  verifyDesktopRelease(source, sourceReport.release);
  for (const [name, item] of Object.entries(original))
    assert.equal(audit(path.join(source, name)).sha256, item.sha256, 'Historical source package changed: ' + name);
  const sourceManifest = audit(path.join(source, 'asset-versions.json'));
  for (const [id, mode] of Object.entries(variants)) {
    const folder = assertProjectOutputTree(path.join(__dirname, 'build/villa-indirect-' + id + '-20261113'));
    const reportFile = assertProjectOutput(path.join(results, id + '-package.json'));
    if (fs.existsSync(reportFile) && parse(reportFile).pass) {
      const saved = parse(reportFile);
      assert.equal(saved.sourcePackage.sha256, sourceManifest.sha256);
      for (const item of saved.products) assert.equal(audit(item.file).sha256, item.sha256);
      verifyDesktopRelease(folder, saved.release);
      continue;
    }
    assert(!fs.existsSync(folder), 'Preserve existing output; inspect a failed package before retrying');
    const space = fs.statfsSync(__dirname);
    assert(space.bavail * space.bsize > 1536 * 1024 * 1024, 'Insufficient project disk space');
    fs.mkdirSync(folder);
    const report = {date: new Date().toISOString(), pass: false, id, mode, folder,
      source: audit(__filename), sourcePackage: sourceManifest,
      rootCommit: sourceReport.rootCommit, engineCommit: sourceReport.engineCommit,
      boundary: 'Exact historical node 3 runtime/content. Only r.WebGPU.IndirectDrawReuse differs. ' +
        'Each configuration uses current unmodified release workers and its own matching actual pipeline capture. ' +
        'No page/TSR optimizations from later nodes and no performance conclusion.'};
    try {
      for (const name of Object.keys(original)) {
        if (['asset-versions.json', 'pipeline-prewarm.json'].includes(name)) continue;
        const target = assertProjectOutput(path.join(folder, name));
        if (['index.html', 'config-files.json'].includes(name)) fs.copyFileSync(path.join(source, name), target);
        else fs.linkSync(path.join(source, name), target);
      }
      const configFile = path.join(folder, 'config-files.json'), configs = parse(configFile);
      const web = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
      assert(web);
      const before = Buffer.from(web.data, 'base64').toString();
      const matches = before.match(/^r\.WebGPU\.IndirectDrawReuse=2\r?$/gm);
      assert.equal(matches?.length, 1, 'Exactly one historical reuse setting required');
      const after = before.replace(/^r\.WebGPU\.IndirectDrawReuse=2\r?$/m, 'r.WebGPU.IndirectDrawReuse=' + mode);
      web.data = Buffer.from(after).toString('base64');
      web.sha256 = crypto.createHash('sha256').update(after).digest('hex');
      save(configFile, configs);
      const page = readPage(folder);
      page.assets.versions['config-files.json'] = audit(configFile).sha256;
      delete page.assets.pipelinePrewarm;
      writePage(folder, page);
      report.release = finalizeDesktopRelease(folder, {capture});
      assert(report.release.releaseReady);
      for (const name of ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm', 'content.bin', 'content-files.json'])
        assert.equal(audit(path.join(folder, name)).sha256, original[name].sha256);
      assert.deepEqual(readPage(folder).args, readPage(source).args);
      report.products = Object.keys(original).filter(name => name !== 'asset-versions.json')
        .map(name => audit(path.join(folder, name)));
      report.products.push(writeVersions(folder, report.products));
      assert.equal(audit(sourceManifest.file).sha256, sourceManifest.sha256);
      report.pass = true;
      console.log(JSON.stringify({id, mode, releaseReady: true, modules: report.release.prewarm.modules,
        pipelines: report.release.prewarm.pipelines}));
    } catch (error) {report.error = error.stack; throw error;}
    finally {save(reportFile, report);}
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
