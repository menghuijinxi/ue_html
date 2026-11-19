'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {resolveWebRenderSize} = require('./web-engine-host.js');
const coreFiles = ['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'config-files.json', 'content.bin'];
const runtimeFiles = ['web-engine-host.js', 'web-engine-worker.js', 'web-content-worker.js', 'web-pipeline-prewarm.js'];

function readPage(folder) {
  const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
  const assetsMatch = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
  const argsMatch = html.match(/arguments: (\[[^\n]+\]),/);
  assert(assetsMatch && argsMatch, 'Missing runtime configuration');
  // The stock template uses single quotes; generated packages use JSON.
  assert(/^\[\s*(?:['"][a-zA-Z0-9_./=:-]+['"]\s*,?\s*)*\]$/.test(argsMatch[1]));
  const args = [...argsMatch[1].matchAll(/['"]([a-zA-Z0-9_./=:-]+)['"]/g)].map(match => match[1]);
  return {html, assetsMatch, argsMatch, assets: JSON.parse(assetsMatch[1]), args};
}

function replaceFile(file, bytes) {
  // Renaming a new file also detaches inherited hardlinks to archived packages.
  const temporary = file + '.' + require('node:crypto').randomUUID() + '.tmp';
  try {fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, file);}
  finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
}

function writePage(folder, page) {
  replaceFile(path.join(folder, 'index.html'), page.html
    .replace(page.assetsMatch[0], 'const localRuntimeAssets = ' + JSON.stringify(page.assets) + ';')
    .replace(page.argsMatch[0], 'arguments: ' + JSON.stringify(page.args) + ','));
}

function startupContext(folder) {
  const {assets, args} = readPage(folder);
  return {args: args.filter(arg => arg !== '-WebPSOPrecacheTest'),
    fixedRenderSize: resolveWebRenderSize(assets, args) || null,
    pipelineWarmup: assets.pipelineWarmup || null};
}

function prepareRecordedPrewarm(folder, input) {
  const corpus = JSON.parse(fs.readFileSync(input));
  assert.equal(corpus.version, 1);
  assert.equal(corpus.devices.length, 1);
  assert(corpus.descriptors.length && corpus.descriptors.every(item =>
    item.deviceId === corpus.devices[0].id && ['render', 'compute'].includes(item.kind)));
  const captureFile = path.join(path.dirname(path.resolve(input)), 'result.json');
  const capture = JSON.parse(fs.readFileSync(captureFile));
  assert(capture.pass && capture.capture, 'Require a successful capture');
  assert(!capture.withoutSubgroups, 'A masked-device capture is not a normal release capture');
  assert(!capture.cvars, 'Do not publish a capture made with configuration overrides');
  assert(capture.package && audit(capture.package.file).sha256 === capture.package.sha256,
    'Captured package has changed');
  const versions = JSON.parse(fs.readFileSync(capture.package.file));
  for (const name of coreFiles)
    assert.equal(audit(path.join(folder, name)).sha256, versions[name].sha256, 'Capture differs: ' + name);
  const capturedFolder = path.dirname(capture.package.file);
  assert.equal(audit(path.join(capturedFolder, 'index.html')).sha256, versions['index.html']?.sha256,
    'Captured entry page has changed');
  assert.deepEqual(startupContext(folder), startupContext(capturedFolder), 'Capture startup arguments or render size differ');
  const automatic = startupContext(capturedFolder).args.includes('-WebPSOPrecache');
  if (automatic) {
    assert(!capture.noPrecache && !capture.motionSeconds && !capture.scriptedMotionSeconds &&
      capture.runs?.length === 1, 'Automatic catalog must be collected before camera movement');
    const run = capture.runs[0], state = run.last?.worker;
    const pso = run.last?.nativePso ?? state?.pso;
    const rhi = run.last?.nativeRhi ?? state?.rhi;
    assert(run.pass && pso?.enabled && pso.active === 0 &&
      rhi?.asyncPrecacheRequested > 0 &&
      rhi.asyncPrecacheRequested === rhi.asyncPrecacheCompleted &&
      rhi.asyncPrecacheFailed === 0 && state?.pending === 0,
    'Automatic collectors and browser compiles must complete before exporting the catalog');
    assert(!(run.errors || []).length && !(state.errors || []).length &&
      Object.values(state.calls || {}).every(call => call.failed === 0) &&
      (run.precacheRejections || []).length <= (rhi.unsupportedPrecacheRequests || 0),
    'Automatic catalog contains native failures or unaccounted pipeline rejections');
    assert(corpus.requests?.length && corpus.requests.every(request => request.success),
      'Automatic catalog contains unfinished or failed pipeline requests');
  }
  const needed = new Set((corpus.requests || []).filter(request => !request.name.endsWith('Async'))
    .map(request => request.descriptorId));
  const contract = readPage(folder).assets.optimizationContract;
  if (contract) assert(capture.runs?.some(run => run.pass && run.engine === 'ours' &&
    run.optimizationAudit?.version === contract.version), 'Capture lacks native optimization verification');
  const warmup = readPage(folder).assets.pipelineWarmup;
  if (!automatic && warmup) {
    assert.deepEqual(capture.scriptedMotionModes, warmup.modes, 'Capture lacks required movement coverage');
    assert(capture.scriptedMotionSeconds >= warmup.seconds, 'Capture movement coverage is too short');
    const run = capture.runs?.find(run => run.engine === 'ours' && run.pass);
    assert(run?.scriptedMotion?.length === warmup.modes.length &&
      run.scriptedMotion.every((state, index) => state.motion.completed && state.motion.updates > 5 &&
        state.motion.mode === warmup.modes[index] && state.motion.elapsed >= warmup.seconds),
      'Required capture routes did not complete');
  }
  return {
    pack: {version: 1, wasm: versions[coreFiles[0]].sha256, content: versions['content.bin'].sha256,
      config: versions['config-files.json'].sha256, devices: corpus.devices,
      modules: corpus.modules, layouts: corpus.layouts,
      descriptors: automatic ? corpus.descriptors.slice().sort((a, b) =>
        Number(needed.has(b.id)) - Number(needed.has(a.id))) : corpus.descriptors},
    source: automatic ? 'automatic-collectors' : 'recorded',
    capture: audit(captureFile), corpus: audit(path.resolve(input)),
  };
}

function installRecordedPrewarm(folder, prepared) {
  const {pack, capture, corpus, source = 'recorded'} = prepared;
  const page = readPage(folder), assets = page.assets;
  assert(assets.threads && assets.renderer === 'desktop');
  assert.equal(assets.wasm.sha256, pack.wasm, 'HTML runtime does not match capture');
  const args = page.args = page.args.filter(arg => arg !== '-WebPSOPrecacheTest');
  const limits = args.filter(arg => arg.startsWith('-WebPSOPrecacheConcurrency='));
  const concurrency = limits.length ? Number(limits[0].split('=')[1]) : null;
  assert(limits.length <= 1 && (concurrency === null ||
    Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 32), 'Invalid precache concurrency');
  for (const name of runtimeFiles) {
    replaceFile(path.join(folder, name), fs.readFileSync(path.join(__dirname, name)));
    assets.versions[name] = audit(path.join(folder, name)).sha256;
  }
  const name = 'pipeline-prewarm.json', packFile = path.join(folder, name);
  replaceFile(packFile, JSON.stringify(pack));
  assets.pipelinePrewarm = {url: name, sha256: audit(packFile).sha256, content: pack.content,
    config: pack.config, handoff: 'overlap', source};
  if (concurrency !== null) assets.pipelinePrewarm.concurrency = concurrency;
  writePage(folder, page);
  return {mode: 'recorded', source, concurrency: concurrency ?? 'hardware-2-16', handoff: 'overlap',
    modules: pack.modules.length, pipelines: pack.descriptors.length,
    capture, corpus, pack: audit(packFile), engineArguments: args,
    files: [...runtimeFiles, name]};
}

module.exports = {prepareRecordedPrewarm, installRecordedPrewarm, readPage, writePage, replaceFile,
  startupContext, coreFiles, runtimeFiles};
