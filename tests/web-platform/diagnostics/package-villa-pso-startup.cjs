'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit, metadata} = require('../content-file-metadata.cjs');
const {readPage, writePage, replaceFile, runtimeFiles} = require('../web-pipeline-prewarm-package.cjs');
const {writeVersions} = require('../asset-versions.cjs');
const base = path.resolve(__dirname, '..');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag') || 'villa-pso-startup-20261113';
assert(/^[a-z0-9-]+$/.test(tag));
const concurrencyOption = option('concurrency') || 'auto';
const concurrency = concurrencyOption === 'auto' ? null : Number(concurrencyOption);
assert(concurrency === null || (Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 32));
const sourceName = option('source') || 'villa-tsr-tiles-20261112';
assert(/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(sourceName), 'Source must be a package inside build');
const source = path.join(base, 'build', sourceName);
const suite = assertProjectOutputTree(path.join(base, 'build', tag));
assert(!fs.existsSync(suite), 'Preserve existing diagnostic suites; choose a new tag');
const captureFree = process.argv.includes('--capture-free');
const releaseDefaults = process.argv.includes('--release-defaults');
assert(!releaseDefaults || captureFree, 'Release comparison requires the automatic baseline');
let variants = captureFree ? {
  overlap: {label: '记录预热参考', handoff: 'overlap'},
  legacy: {label: '旧自动收集 · 无记录', automatic: true, captureFree: true},
  automatic: {label: '新自动收集 · 无记录', automatic: true, captureFree: true, latestRuntime: true},
} : {
  recorded: {label: '记录预热 · 整包等待', handoff: 'complete'},
  overlap: {label: '记录预热 · 并行启动', handoff: 'overlap'},
  components: {label: '并行启动 + 自动组件', handoff: 'overlap', automatic: true, globalShaders: 0},
  automatic: {label: '并行启动 + 自动组件及全局', handoff: 'overlap', automatic: true},
};
let eagerCorpus = option('automatic-corpus');
assert(!releaseDefaults || !eagerCorpus && !option('baseline-suite'),
  'The release comparison must use the ordinary automatic catalog selection');
if (releaseDefaults) {
  variants = {
    automatic: {label: '自动收集 · 引擎内预热', automatic: true, captureFree: true, latestRuntime: true},
    release: {label: '默认发布 · 提前并行缓存', automatic: true, latestRuntime: true, release: true},
  };
}
let collected;
if (eagerCorpus === 'auto') {
  assert(captureFree, 'Automatic catalog preparation requires automatic collectors');
  const {spawnSync} = require('node:child_process'), collectTag = tag + '-collect';
  const env = {...process.env};
  if (!env.NODE_PATH) env.NODE_PATH = path.join(require('node:os').homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
  const run = args => {
    const child = spawnSync(process.execPath, args, {stdio: 'inherit', windowsHide: true, env});
    assert(!child.error && child.status === 0, 'Automatic catalog preparation failed; preserve the failed results');
  };
  run([__filename, '--tag=' + collectTag, '--capture-free', '--only=automatic',
    '--concurrency=' + concurrencyOption, '--source=' + sourceName]);
  run([path.join(__dirname, 'probe-villa-pso-startup.cjs'), '--suite=' + collectTag,
    '--tag=' + collectTag, '--profile=automatic-pso-catalog', '--modes=automatic',
    '--capture-corpus', '--expect-zero']);
  eagerCorpus = path.join(base, 'results', collectTag + '.json');
}
if (eagerCorpus) {
  assert(captureFree, 'An automatic catalog requires the automatic collector comparison');
  collected = JSON.parse(fs.readFileSync(path.resolve(eagerCorpus)));
  assert(collected.pass && collected.captureCorpus && collected.runs.length === 1);
  const run = collected.runs[0];
  assert(run.pass && run.startup.pso.enabled && run.startup.pso.active === 0 &&
    run.startup.rhi.asyncPrecacheRequested === run.startup.rhi.asyncPrecacheCompleted &&
    run.startup.rhi.asyncPrecacheFailed === 0 && !run.startup.prewarm?.adopted);
  assert.equal(audit(run.corpus.file).sha256, run.corpus.sha256, 'Automatic catalog changed');
  variants.eager = {label: '自动收集 · 提前并行缓存', automatic: true, latestRuntime: true,
    handoff: 'overlap', eager: true};
  variants.automatic.label = '自动收集 · 引擎内预热';
}
const baselineSuite = option('baseline-suite');
if (baselineSuite) {
  assert(captureFree && /^[a-z0-9-]+$/.test(baselineSuite),
    'An automatic baseline requires capture-free mode and a valid suite tag');
  const previousSuite = JSON.parse(fs.readFileSync(path.join(base, 'build', baselineSuite, 'suite.json')));
  const previous = previousSuite.variants?.automatic;
  assert(previousSuite.pass && previous?.captureFree && previous.automatic,
    'The baseline must be a packaged automatic mode without a pipeline corpus');
  const previousFolder = assertProjectOutputTree(path.join(base, 'build', previous.folder));
  for (const name of ['content.bin', 'config-files.json'])
    assert.equal(audit(path.join(previousFolder, name)).sha256, audit(path.join(source, name)).sha256,
      'The automatic baseline must use the same cooked scene and configuration');
  const comparableArgs = folder => readPage(folder).args.filter(arg =>
    arg !== '-WebPSOPrecacheTest' && !arg.startsWith('-WebPSOPrecacheConcurrency='));
  assert.deepEqual(comparableArgs(previousFolder), comparableArgs(source),
    'The automatic baseline must use matching rendering arguments');
  for (const [name, file] of Object.entries(previous.files))
    assert.equal(audit(path.join(previousFolder, name)).sha256, file.sha256, 'The baseline package changed');
  variants = {previous: {label: '上版自动收集 · 无记录', automatic: true, captureFree: true,
    source: previousFolder, baselineSuite}, ...variants};
}
const only = option('only');
if (only) {
  const selected = only.split(',');
  assert(selected.length && selected.every(mode => Object.hasOwn(variants, mode)), 'Unknown PSO mode');
  for (const mode of Object.keys(variants)) if (!selected.includes(mode)) delete variants[mode];
}
fs.mkdirSync(suite);
for (const [mode, variant] of Object.entries(variants)) {
  const variantSource = variant.source || source;
  const folder = assertProjectOutputTree(path.join(suite, mode));
  fs.mkdirSync(folder);
  const mutable = new Set(['index.html', 'asset-versions.json', 'pipeline-prewarm.json', 'config-files.json', ...runtimeFiles]);
  for (const entry of fs.readdirSync(variantSource, {withFileTypes: true})) {
    if (!entry.isFile()) continue;
    if (variant.captureFree && entry.name === 'pipeline-prewarm.json') continue;
    const target = assertProjectOutput(path.join(folder, entry.name));
    if (mutable.has(entry.name)) fs.copyFileSync(path.join(variantSource, entry.name), target);
    else fs.linkSync(path.join(variantSource, entry.name), target);
  }
  const page = readPage(folder);
  let pack;
  if (!variant.captureFree && !variant.eager && !variant.release) {
    pack = JSON.parse(fs.readFileSync(path.join(source, 'pipeline-prewarm.json')));
    if (sourceName === 'villa-tsr-tiles-20261112')
      assert.equal(pack.descriptors.length, 311, 'Use the original capture, without manual supplements');
  }
  page.args = page.args.filter(arg => !['-WebPSOPrecache', '-WebPSOPrecacheTest'].includes(arg) &&
    !arg.startsWith('-WebPSOPrecacheConcurrency='));
  if (variant.automatic) {
    page.args.push(variant.release ? '-WebPSOPrecache' : '-WebPSOPrecacheTest');
    if (concurrency !== null) page.args.push('-WebPSOPrecacheConcurrency=' + concurrency);
  }
  if (variant.globalShaders === 0) {
    const file = path.join(folder, 'config-files.json'), configs = JSON.parse(fs.readFileSync(file));
    const config = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
    assert(config);
    const bytes = Buffer.from(Buffer.from(config.data, 'base64').toString() +
      '\n[SystemSettings]\nr.PSOPrecache.GlobalShaders=0\n');
    config.data = bytes.toString('base64');
    config.sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    replaceFile(file, JSON.stringify(configs));
    pack.config = audit(file).sha256;
    page.assets.pipelinePrewarm.config = pack.config;
  }
  for (const name of runtimeFiles) {
    replaceFile(path.join(folder, name), fs.readFileSync(path.join(base, name)));
    page.assets.versions[name] = audit(path.join(folder, name)).sha256;
  }
  if (variant.latestRuntime) {
    for (const name of ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm']) {
      replaceFile(path.join(folder, name), fs.readFileSync(path.resolve(base, '../ue-web-smoke/Binaries/Web', name)));
      page.assets.versions[name] = audit(path.join(folder, name)).sha256;
    }
    page.assets.wasm = metadata(path.join(folder, 'UEWebEngineThreads.wasm'), 'UEWebEngineThreads.wasm');
  }
  if (variant.eager) {
    const run = collected.runs[0], corpus = JSON.parse(fs.readFileSync(run.corpus.file));
    for (const name of ['UEWebEngineThreads.wasm', 'content.bin', 'config-files.json'])
      assert.equal(audit(path.join(folder, name)).sha256, run.package[name].sha256,
        'Automatic catalog input differs: ' + name);
    const {startupContext} = require('../web-pipeline-prewarm-package.cjs');
    assert.deepEqual(startupContext(folder), startupContext(path.dirname(run.package['index.html'].file)),
      'Automatic catalog arguments or resolution differ');
    assert.equal(audit(run.package['index.html'].file).sha256, run.package['index.html'].sha256);
    assert.equal(corpus.devices.length, 1);
    assert(corpus.requests.length && corpus.requests.every(request => request.success));
    assert(corpus.descriptors.every(record => record.deviceId === corpus.devices[0].id));
    // First-frame synchronous requests take precedence; retain every collected PSO.
    const needed = new Set(corpus.requests.filter(request => !request.name.endsWith('Async'))
      .map(request => request.descriptorId));
    pack = {version: 1, wasm: page.assets.wasm.sha256, content: audit(path.join(folder, 'content.bin')).sha256,
      config: audit(path.join(folder, 'config-files.json')).sha256, devices: corpus.devices,
      modules: corpus.modules, layouts: corpus.layouts,
      descriptors: corpus.descriptors.slice().sort((a, b) => Number(needed.has(b.id)) - Number(needed.has(a.id)))};
    page.assets.pipelinePrewarm = {url: 'pipeline-prewarm.json', content: pack.content, config: pack.config,
      source: 'automatic-collectors'};
    variant.pipelines = pack.descriptors.length;
    variant.catalog = {report: audit(path.resolve(eagerCorpus)), corpus: run.corpus};
  }
  if (variant.captureFree) {
    delete page.assets.pipelinePrewarm;
    delete page.assets.releaseDefaults;
    assert(!fs.existsSync(path.join(folder, 'pipeline-prewarm.json')));
  } else if (!variant.release) {
    replaceFile(path.join(folder, 'pipeline-prewarm.json'), JSON.stringify(pack));
    page.assets.pipelinePrewarm.sha256 = audit(path.join(folder, 'pipeline-prewarm.json')).sha256;
    page.assets.pipelinePrewarm.handoff = variant.handoff;
    if (concurrency !== null) page.assets.pipelinePrewarm.concurrency = concurrency;
  }
  if (!variant.release) page.assets.diagnosticOnly = true;
  else delete page.assets.diagnosticOnly;
  page.assets.psoStartupExperiment = {mode, automatic: !!variant.automatic,
    globalShaders: variant.globalShaders ?? 1, concurrency, captureFree: !!variant.captureFree,
    boundary: variant.release ? 'Normal release defaults: full automatic collector catalog, immediate bounded parallel replay and runtime automatic collection. Both completion gates are required.' :
      variant.eager ? 'Complete automatic-collector catalog starts before WASM, with UE automatic collection still enabled and both completion gates required. No camera capture.' :
      variant.captureFree ? 'Diagnostic automatic UE collectors only. No pipeline corpus, replay or camera warmup.' :
      'Diagnostic only. Component mode leaves global pipelines to the recorded startup corpus and runtime misses; it does not provide capture-free global coverage.'};
  writePage(folder, page);
  if (variant.release) {
    const release = require('../web-release-defaults.cjs').finalizeDesktopRelease(folder);
    assert(release.releaseReady && release.prewarm.source === 'automatic-collectors');
    variant.pipelines = release.prewarm.pipelines;
    variant.catalog = {report: release.prewarm.capture, corpus: release.prewarm.corpus};
    replaceFile(path.join(folder, 'release-report.json'), JSON.stringify(release, null, 2));
  }
  writeVersions(folder, fs.readdirSync(folder).map(name => audit(path.join(folder, name))));
  variant.folder = tag + '/' + mode;
  variant.expected = {indirectDrawReuse: 2, vsmPageOptimization: 3};
  variant.files = Object.fromEntries(['UEWebEngineThreads.wasm', 'content.bin', 'config-files.json', 'index.html']
    .map(name => [name, audit(path.join(folder, name))]));
}
let html = fs.readFileSync(path.join(base, 'villa-git-history-live.html'), 'utf8')
  .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="/">')
  .replaceAll('Triplex Villa · Git 版本对照', 'Triplex Villa · PSO 启动对照')
  .replace(/<div class="modes"[\s\S]*?<\/div>/, '<div class="modes" role="radiogroup" aria-label="PSO 模式">' +
    Object.entries(variants).map(([mode, variant], index) => '<label><input type="radio" name="mode" value="' +
      mode + '"' + (index === 0 ? ' checked' : '') + '><span>' + variant.label + '</span></label>').join('') + '</div>')
  .replace('<script src="villa-git-history-live.js"></script>',
    '<script>globalThis.__villaHistoryVariants=' + JSON.stringify(variants) + ';</script>')
  .replace('<span id="quality">', '<span>加载 <b id="startup-ms">待确认</b></span>' +
    '<span>自动 PSO <b id="automatic-pso">关闭</b></span><span id="quality">')
  .replace('</html>', '<script src="diagnostics/villa-pso-startup-live.js"></script></html>');
replaceFile(path.join(suite, 'comparison.html'), html);
const report = {date: new Date().toISOString(), pass: true, diagnosticOnly: true, source, variants,
  page: path.join(suite, 'comparison.html'), originalRecordedPipelines: 311,
  boundary: releaseDefaults ? 'Release variant uses the normal finalizeDesktopRelease automatic catalog preparation and runtime gates. The baseline uses the same current WASM/Cook/settings without a catalog. No manual camera capture supplies the release catalog.' :
    eagerCorpus ? 'Same current WASM, Cook, TSR and render settings. Both modes retain automatic UE collectors. Eager mode additionally replays their complete startup output, bound to the exact build and arguments, before WASM startup; no manual camera route contributes to the catalog. Diagnostic comparison, not a coverage guarantee for every future scene or configuration.' :
    captureFree ? 'Legacy and new automatic modes contain no pipeline corpus. New runtime changes PSO collection, exact native raster-state reuse, unused placeholder modules and depth-atlas sampling compatibility. Same Cook, TSR and render settings. Diagnostic only; release defaults unchanged.' :
    'Same original WASM/Cook/TSR settings. No hand-selected pipeline supplements. Automatic component/global collection is an explicit diagnostic; ordinary release defaults are unchanged.'};
replaceFile(path.join(suite, 'suite.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, suite, page: report.page, modes: Object.keys(variants)}));
