const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {metadata, audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {validateCook} = require('./cached-cook-validation.cjs');
const {applyAcceptedDefaults} = require('./web-accepted-defaults.cjs');
const {prepareRecordedPrewarm, installRecordedPrewarm} = require('./web-pipeline-prewarm-package.cjs');
const id = process.argv.find(value => value.startsWith('--project='))?.slice(10);
assert(id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
const desktop = process.argv.includes('--desktop');
const threads = process.argv.includes('--threads');
const parallelRecording = process.argv.includes('--parallel-recording');
assert(!parallelRecording || threads, 'Parallel command recording requires the threaded runtime');
const trace = process.argv.includes('--trace');
assert(!trace || threads, '--trace requires --threads');
const distanceFields = process.argv.includes('--distance-fields');
assert(!distanceFields || desktop, 'Distance fields require the desktop renderer');
assert(!threads || desktop, 'Threaded engine requires the desktop renderer');
const runtime = trace ? 'UEWebEngineThreadsTrace' : threads ? 'UEWebEngineThreads' : 'UEWebEngine';
const suffix = (distanceFields ? '-distance-fields' : '') + (threads ? '-threads' : desktop ? '-desktop' : '') +
  (trace ? '-trace' : '');
const prefix = `web-project-${id}${suffix}${parallelRecording ? '-parallel-recording' : ''}`;
const stagePrefix = `web-project-${id}${desktop ? '-desktop' : ''}`;
const directory = path.join(__dirname, 'results');
const outputFolder = process.argv.find(value => value.startsWith('--output-folder='))?.slice(16) ||
  id + suffix + (parallelRecording ? '-parallel-recording' : '');
assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(outputFolder));
const output = path.join(__dirname, 'build', outputFolder);
const pipelineCorpus = process.argv.find(value => value.startsWith('--pipeline-corpus='))?.slice(18);
const capturePrewarm = process.argv.includes('--capture-prewarm');
const legacyPrecache = process.argv.includes('--legacy-precache');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const template = path.join(__dirname, 'web-default-template.html');
const report = {date: new Date().toISOString(), pass: false, id, output, architecture: 'wasm64',
  renderer: desktop ? 'desktop-deferred' : 'mobile-forward', threads, trace, distanceFields, parallelRecording,
  sourceFiles: [__filename, template, path.join(__dirname, 'content-file-metadata.cjs'),
    ...['asset-versions.cjs', 'cached-cook-validation.cjs', 'web-content-io.js', 'web-content-worker.js',
      ...(threads ? ['web-engine-host.js', 'web-engine-worker.js'] : [])].map(name =>
      path.join(__dirname, name))].map(audit), fullNormalUBTBuildVerified: false,
  completeUEScene: false};
try {
  const acceptedDefaults = threads && !trace && !process.argv.includes('--legacy-defaults');
  assert([!!pipelineCorpus, capturePrewarm, legacyPrecache].filter(Boolean).length <= 1,
    'Select one startup mode');
  assert(!acceptedDefaults || pipelineCorpus || capturePrewarm || legacyPrecache,
    'Desktop releases require --pipeline-corpus=<capture>; use --capture-prewarm for a capture base or --legacy-precache for diagnostics');
  assert(!pipelineCorpus || acceptedDefaults, 'Recorded prewarm requires an ordinary desktop threaded package');
  const buildOption = process.argv.find(value => value.startsWith('--build-report='))?.slice(15);
  const buildFile = buildOption ? path.resolve(buildOption) : path.join(directory, `web-engine-full${trace ? '-thread-trace' : threads ? '-thread' : ''}-build-results.json`);
  const stageFile = path.join(directory, `${stagePrefix}-stage-results.json`);
  const prepareFile = path.join(directory, `web-project-${id}-prepare-results.json`);
  const build = read(buildFile), stage = read(stageFile), prepared = read(prepareFile);
  if (acceptedDefaults) assert(build.lowerMemory64, 'Default desktop runtime requires lowered memory64; rebuild or select --legacy-defaults');
  assert.equal(build.trace === true, trace, 'Trace package must use the matching diagnostic runtime');
  assert(build.pass && build.buildSucceeded && build.exitCode === 0 &&
    (build.fullLinkAttempted || threads && build.fullLinkVerified) &&
    build.sourceFiles.every(valid) && build.products.every(valid) && valid(build.log));
  if (threads) {
    assert(build.threads && build.objects.length > 300 && valid(build.linkResponse));
    assert(build.objects.every(item => [item.object, item.response, item.definitions, item.source].every(valid)));
    assert(build.platformCopies.every(item => valid(item.source) && valid(item.copied) &&
      item.source.sha256 === item.copied.sha256));
  }
  assert(stage.pass && stage.scene === 'Project' && stage.projectId === id &&
    stage.sourceFiles.every(valid) && [stage.cookReport, stage.pack, stage.manifest, stage.configBundle].every(valid));
  const cook = read(stage.cookReport.file);
  assert.equal(cook.mode, desktop ? 'WebGPU-SM5' : 'WebGPU-ES31');
  assert.equal(cook.distanceFields === true, distanceFields);
  assert.equal(stage.distanceFields === true, distanceFields);
  assert.equal(stage.mode, cook.mode);
  validateCook(cook, process.argv.includes('--reuse-cook'), report);
  assert(prepared.pass && prepared.originalProjectUnmodified && prepared.sourceFiles.every(valid));
  report.buildReport = audit(buildFile);
  report.stageReport = audit(stageFile);
  report.preparationReport = audit(prepareFile);
  report.map = stage.map;
  report.project = stage.projectName;
  report.textureCompression = cook.textureCompression || 'Uncompressed';
  report.useProjectSettings = cook.useProjectSettings === true;
  assert.equal(stage.textureCompression, report.textureCompression);
  fs.mkdirSync(output, {recursive: true});
  let html = fs.readFileSync(template, 'utf8');
  const wasm = build.products.find(item => path.basename(item.file) === runtime + '.wasm');
  const versions = Object.fromEntries([runtime + '.js', runtime + '.wasm', 'web-content-io.js', 'web-content-worker.js',
    ...(threads ? ['web-engine-host.js', 'web-engine-worker.js'] : [])].map(name => {
    const file = name.startsWith(runtime + '.') ? build.products.find(item => path.basename(item.file) === name).file :
      path.join(__dirname, name);
    return [name, audit(file).sha256];
  }));
  html = html.replace('const localRuntimeAssets = {};', 'const localRuntimeAssets = ' +
    JSON.stringify({versions, renderer: desktop ? 'desktop' : 'mobile', threads, trace, distanceFields, runtime: runtime + '.js',
      wasm: metadata(wasm.file, runtime + '.wasm')}) + ';');
  const original = "arguments: ['-webgpu', '-WebDefaultTemplate'],";
  assert(html.includes(original) && /^\/Game\/[a-zA-Z0-9_/]+$/.test(stage.map));
  report.engineArguments = ['-webgpu', '-WebProjectMap=' + stage.map,
    ...(parallelRecording ? ['-WebParallelDrawRecording'] : [])];
  html = html.replace(original, `arguments: ${JSON.stringify(report.engineArguments)},`)
    .replaceAll('UE 默认关卡', stage.projectName);
  if (report.textureCompression === 'BC' || report.textureCompression === 'Project') {
    const marker = 'const requiredTextureFeatures = desktopRenderer ?';
    assert(html.includes(marker));
    const end = "['texture-formats-tier1', 'texture-formats-tier2', 'rg11b10ufloat-renderable', 'float32-filterable'] : [];";
    assert(html.includes(end));
    html = html.replace(end,
      "['texture-compression-bc', 'texture-formats-tier1', 'texture-formats-tier2', 'rg11b10ufloat-renderable', 'float32-filterable'] : ['texture-compression-bc'];");
  }
  fs.writeFileSync(path.join(output, 'index.html'), html);
  const copies = [[stage.pack.file, 'content.bin'], [stage.manifest.file, 'content-files.json'],
    [stage.configBundle.file, 'config-files.json'],
    ...['web-content-io.js', 'web-content-worker.js',
      ...(threads ? ['web-engine-host.js', 'web-engine-worker.js'] : [])].map(name =>
      [path.join(__dirname, name), name])];
  for (const name of [runtime + '.js', runtime + '.wasm']) {
    const product = build.products.find(item => path.basename(item.file) === name);
    assert(product && valid(product));
    copies.push([product.file, name]);
  }
  for (const [source, name] of copies) {
    const destination = path.join(output, name);
    fs.copyFileSync(source, destination);
    assert.equal(audit(source).sha256, audit(destination).sha256);
  }
  if (acceptedDefaults) {
    report.performanceProfile = applyAcceptedDefaults(output);
    report.sourceFiles.push(audit(require.resolve('./web-accepted-defaults.cjs')));
    report.engineArguments.push('-WebPSOPrecacheTest');
  }
  const extraFiles = [];
  if (pipelineCorpus) {
    report.startupPrewarm = installRecordedPrewarm(output, prepareRecordedPrewarm(output, pipelineCorpus));
    report.engineArguments = report.startupPrewarm.engineArguments;
    extraFiles.push(...report.startupPrewarm.files);
    report.sourceFiles.push(...['web-pipeline-prewarm-package.cjs', 'web-pipeline-prewarm.js'].map(name =>
      audit(path.join(__dirname, name))));
  } else if (capturePrewarm) {
    const file = path.join(output, 'index.html');
    const content = fs.readFileSync(file, 'utf8'), args = content.match(/arguments: (\[[^\n]+\]),/);
    assert(args);
    report.engineArguments = JSON.parse(args[1]).filter(arg => arg !== '-WebPSOPrecacheTest');
    fs.writeFileSync(file, content.replace(args[0], 'arguments: ' + JSON.stringify(report.engineArguments) + ','));
    report.startupPrewarm = {mode: 'capture-only', releaseReady: false};
  } else if (legacyPrecache) {
    report.startupPrewarm = {mode: 'legacy-speculative-diagnostic', releaseReady: false};
  }
  report.products = [...new Set(['index.html', ...copies.map(([, name]) => name), ...extraFiles])]
    .map(name => audit(path.join(output, name)));
  report.products.push(writeVersions(output, report.products));
  report.totalBytes = report.products.reduce((total, item) => total + fs.statSync(item.file).size, 0);
  report.fullNormalUBTBuildVerified = true;
  report.disabledSkyLight = cook.disabledSkyLight;
  report.compressHDRCubemaps = cook.compressHDRCubemaps || false;
  report.boundary = (report.useProjectSettings ? 'Project map and gameplay with the original project rendering settings. ' :
    'Project map and gameplay with the explicitly recorded Web renderer profile. ') +
    'Packaging success does not prove browser compatibility, visual parity, performance or phone support.';
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(directory, `${prefix}-package-results.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, output, files: report.products?.length,
    bytes: report.totalBytes, failure: report.failure}, null, 2));
}
