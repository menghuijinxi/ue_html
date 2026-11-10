'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {resolveWebRenderSize} = require('./web-engine-host.js');
const {prepareRecordedPrewarm, installRecordedPrewarm, readPage, writePage, replaceFile,
  startupContext, coreFiles, runtimeFiles} = require('./web-pipeline-prewarm-package.cjs');

function releaseOptions(argv = process.argv) {
  const option = name => argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
  const result = {corpus: option('pipeline-corpus'), captureOnly: argv.includes('--capture-prewarm'),
    legacyPrecache: argv.includes('--legacy-precache'), refresh: argv.includes('--refresh-prewarm')};
  assert([!!result.corpus, result.captureOnly, result.legacyPrecache, result.refresh].filter(Boolean).length <= 1,
    'Select one startup mode');
  return result;
}

function capturePipelines(folder) {
  const tag = 'auto-prewarm-' + require('node:crypto').randomUUID();
  const snapshot = path.join(__dirname, 'build', tag);
  fs.mkdirSync(snapshot);
  for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
    if (!entry.isFile() || ['asset-versions.json', 'pipeline-prewarm.json'].includes(entry.name)) continue;
    const source = path.join(folder, entry.name), target = path.join(snapshot, entry.name);
    // The capture must remain auditable when the ordinary output is rebuilt.
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  }
  writeVersions(snapshot, fs.readdirSync(snapshot).map(name => audit(path.join(snapshot, name))));
  console.log('No matching pipeline capture; recording actual startup pipelines in ' + tag);
  const env = {...process.env};
  try {require.resolve('playwright');}
  catch {
    const bundled = path.join(require('node:os').homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
    assert(fs.existsSync(path.join(bundled, 'playwright')),
      'Automatic capture requires Playwright (install locally or configure NODE_PATH)');
    env.NODE_PATH = [bundled, env.NODE_PATH].filter(Boolean).join(path.delimiter);
  }
  const child = spawnSync(process.execPath, [path.join(__dirname, 'probe-villa-startup.cjs'),
    '--tag=' + tag, '--folder=' + tag, '--engine=ours', '--rounds=1', '--browser=msedge',
    '--direct', '--serve', '--capture', '--settle-frames=120', '--width=1280', '--height=720', '--dpr=1'],
  {stdio: 'inherit', windowsHide: true, env});
  assert(!child.error && child.status === 0,
    'Automatic pipeline capture failed; no release was approved. ' + (child.error?.message || 'See capture diagnostics.'));
  return path.join(__dirname, 'results', 'villa-startup-' + tag, '0-corpus.json');
}

function matchingCapture(folder, resultsDirectory) {
  const hashes = Object.fromEntries(coreFiles.map(name => [name, audit(path.join(folder, name)).sha256]));
  const context = startupContext(folder);
  const candidates = fs.readdirSync(resultsDirectory, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && entry.name.startsWith('villa-startup-'))
    .map(entry => path.join(resultsDirectory, entry.name));
  for (const directory of candidates.reverse()) {
    try {
      const capture = JSON.parse(fs.readFileSync(path.join(directory, 'result.json')));
      if (!capture.pass || !capture.capture || capture.cvars || !capture.package) continue;
      const versions = JSON.parse(fs.readFileSync(capture.package.file));
      if (!coreFiles.every(name => versions[name]?.sha256 === hashes[name])) continue;
      assert.deepEqual(startupContext(path.dirname(capture.package.file)), context);
      const corpus = path.join(directory, '0-corpus.json');
      return {prepared: prepareRecordedPrewarm(folder, corpus), corpus};
    } catch {
      // Stale/failed captures are never a fallback for another binary or config.
    }
  }
  return null;
}

function finalizeDesktopRelease(folder, options = {}) {
  const page = readPage(folder);
  assert(page.assets.threads && page.assets.renderer === 'desktop', 'Desktop threaded release required');
  assert([!!options.corpus, options.captureOnly, options.legacyPrecache, options.refresh].filter(Boolean).length <= 1);
  const size = resolveWebRenderSize(page.assets, page.args);
  if (size) page.assets.fixedRenderSize = size;
  page.assets.renderSizing = size ? 'fixed-physical-pixels' : 'css-dpr-once';
  page.assets.releaseDefaults = 'desktop-startup-20261110';
  delete page.assets.pipelinePrewarm;
  page.args = page.args.filter(arg => arg !== '-WebPSOPrecacheTest');
  if (options.legacyPrecache) page.args.push('-WebPSOPrecacheTest');
  for (const name of runtimeFiles) {
    replaceFile(path.join(folder, name), fs.readFileSync(path.join(__dirname, name)));
    page.assets.versions[name] = audit(path.join(folder, name)).sha256;
  }
  writePage(folder, page);
  const report = {version: page.assets.releaseDefaults, releaseReady: false,
    renderSizing: page.assets.renderSizing, fixedRenderSize: size || null,
    cacheLock: 'shared-read-short-prepare', files: [...runtimeFiles]};
  if (options.captureOnly || options.legacyPrecache) {
    report.prewarm = {mode: options.captureOnly ? 'capture-only' : 'legacy-speculative-diagnostic', releaseReady: false};
  } else {
    const cached = !options.corpus && !options.refresh &&
      matchingCapture(folder, options.resultsDirectory || path.join(__dirname, 'results'));
    const corpus = options.corpus || cached?.corpus || (options.capture || capturePipelines)(folder);
    report.prewarm = installRecordedPrewarm(folder, cached?.prepared || prepareRecordedPrewarm(folder, corpus));
    report.prewarm.selection = options.corpus ? 'explicit' : cached ? 'automatic-reuse' : 'automatic-capture';
    report.files = report.prewarm.files;
    report.releaseReady = true;
  }
  report.engineArguments = readPage(folder).args;
  report.runtime = runtimeFiles.map(name => audit(path.join(folder, name)));
  verifyDesktopRelease(folder, report);
  return report;
}

function verifyDesktopRelease(folder, report) {
  const {assets, args} = readPage(folder);
  for (const name of runtimeFiles) {
    const hash = audit(path.join(folder, name)).sha256;
    assert.equal(hash, audit(path.join(__dirname, name)).sha256, 'Stale release runtime: ' + name);
    assert.equal(assets.versions[name], hash, 'Stale runtime URL: ' + name);
  }
  const size = resolveWebRenderSize(assets, args);
  assert.equal(assets.renderSizing, size ? 'fixed-physical-pixels' : 'css-dpr-once');
  if (!report.releaseReady) return;
  assert(!args.includes('-WebPSOPrecacheTest'), 'Speculative precache is diagnostic only');
  assert.equal(report.prewarm.mode, 'recorded');
  assert.equal(assets.pipelinePrewarm?.url, 'pipeline-prewarm.json');
  const packFile = path.join(folder, assets.pipelinePrewarm.url);
  assert.equal(audit(packFile).sha256, assets.pipelinePrewarm.sha256);
  const pack = JSON.parse(fs.readFileSync(packFile));
  for (const [key, file] of [['wasm', coreFiles[0]], ['content', 'content.bin'], ['config', 'config-files.json']])
    assert.equal(pack[key], audit(path.join(folder, file)).sha256, 'Prewarm differs: ' + key);
}

module.exports = {releaseOptions, finalizeDesktopRelease, verifyDesktopRelease};
