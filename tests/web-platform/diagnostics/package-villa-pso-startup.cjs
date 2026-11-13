'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const {readPage, writePage, replaceFile, runtimeFiles} = require('../web-pipeline-prewarm-package.cjs');
const {writeVersions} = require('../asset-versions.cjs');
const base = path.resolve(__dirname, '..');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag') || 'villa-pso-startup-20261113';
assert(/^[a-z0-9-]+$/.test(tag));
const source = path.join(base, 'build/villa-tsr-tiles-20261112');
const suite = assertProjectOutputTree(path.join(base, 'build', tag));
assert(!fs.existsSync(suite), 'Preserve existing diagnostic suites; choose a new tag');
const variants = {
  recorded: {label: '记录预热 · 整包等待', handoff: 'complete'},
  overlap: {label: '记录预热 · 并行启动', handoff: 'overlap'},
  components: {label: '并行启动 + 自动组件', handoff: 'overlap', automatic: true, globalShaders: 0},
  automatic: {label: '并行启动 + 自动组件及全局', handoff: 'overlap', automatic: true},
};
fs.mkdirSync(suite);
for (const [mode, variant] of Object.entries(variants)) {
  const folder = assertProjectOutputTree(path.join(suite, mode));
  fs.mkdirSync(folder);
  const mutable = new Set(['index.html', 'asset-versions.json', 'pipeline-prewarm.json', 'config-files.json', ...runtimeFiles]);
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    if (!entry.isFile()) continue;
    const target = assertProjectOutput(path.join(folder, entry.name));
    if (mutable.has(entry.name)) fs.copyFileSync(path.join(source, entry.name), target);
    else fs.linkSync(path.join(source, entry.name), target);
  }
  const page = readPage(folder), pack = JSON.parse(fs.readFileSync(path.join(folder, 'pipeline-prewarm.json')));
  assert.equal(pack.descriptors.length, 311, 'Use the original capture, without manual supplements');
  page.args = page.args.filter(arg => arg !== '-WebPSOPrecacheTest' && !arg.startsWith('-WebPSOPrecacheConcurrency='));
  if (variant.automatic) page.args.push('-WebPSOPrecacheTest', '-WebPSOPrecacheConcurrency=2');
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
  replaceFile(path.join(folder, 'pipeline-prewarm.json'), JSON.stringify(pack));
  page.assets.pipelinePrewarm.sha256 = audit(path.join(folder, 'pipeline-prewarm.json')).sha256;
  page.assets.pipelinePrewarm.handoff = variant.handoff;
  page.assets.diagnosticOnly = true;
  page.assets.psoStartupExperiment = {mode, automatic: !!variant.automatic,
    globalShaders: variant.globalShaders ?? 1, concurrency: 2,
    boundary: 'Diagnostic only. Component mode leaves global pipelines to the recorded startup corpus and runtime misses; it does not provide capture-free global coverage.'};
  writePage(folder, page);
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
  boundary: 'Same original WASM/Cook/TSR settings. No hand-selected pipeline supplements. Automatic component/global collection is an explicit diagnostic; ordinary release defaults are unchanged.'};
replaceFile(path.join(suite, 'suite.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, suite, page: report.page, modes: Object.keys(variants)}));
