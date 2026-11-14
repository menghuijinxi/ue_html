'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
const {audit, metadata} = require('./content-file-metadata.cjs');
const {readPage, writePage, replaceFile} = require('./web-pipeline-prewarm-package.cjs');
const {finalizeDesktopRelease} = require('./web-release-defaults.cjs');
const {writeVersions} = require('./asset-versions.cjs');
initializeProjectOutput();
const root = path.resolve(__dirname, '../..');
const work = assertProjectOutputTree(path.join(__dirname, 'build/git-history-20261113'));
const results = assertProjectOutputTree(path.join(__dirname, 'results/git-history-20261113'));
const source = path.join(__dirname, 'build/villa-vsm-sampling-adaptive-20261112');
const read = file => fs.readFileSync(file, 'utf8');
const parse = file => JSON.parse(read(file).replace(/^\uFEFF/, ''));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function write(file, data) {
  assertProjectOutput(file); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, data);
}
function deduplicate(cook) {
  const sourceReport = path.join(__dirname, 'results/web-project-triplex-virtual-desktop-cook-results.json');
  const baseline = parse(sourceReport);
  assert(baseline.pass);
  const byHash = new Map(baseline.products.map(item => [item.sha256, item]));
  const report = {source: audit(sourceReport), files: 0, sharedBytes: 0};
  for (const item of cook.products) {
    const original = byHash.get(item.sha256);
    if (!original || !fs.existsSync(original.file) || !fs.existsSync(item.file) ||
        path.resolve(original.file) === path.resolve(item.file)) continue;
    assertProjectOutput(item.file); assertProjectOutput(original.file);
    assert(path.resolve(item.file).startsWith(path.resolve(cook.output) + path.sep));
    if (fs.statSync(item.file).nlink > 1) continue;
    assert.equal(audit(original.file).sha256, item.sha256);
    assert.equal(audit(item.file).sha256, item.sha256);
    const temporary = assertProjectOutput(item.file + '.deduplicate');
    assert(!fs.existsSync(temporary));
    try {
      fs.linkSync(original.file, temporary);
      fs.renameSync(temporary, item.file);
    } finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
    report.files++; report.sharedBytes += fs.statSync(item.file).size;
  }
  write(path.join(results, 'cook-deduplicate.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({deduplicatedFiles: report.files, sharedBytes: report.sharedBytes}));
}
function stage() {
  const output = assertProjectOutputTree(path.join(work, 'staged'));
  const cook = parse(path.join(results, 'cook.json'));
  assert(cook.pass && cook.hostRestored, 'Historical Cook must succeed');
  const prepared = parse(path.join(__dirname, 'results/web-cook-host-results.json'));
  assert.equal(audit(prepared.nativeRenderer.file).sha256, prepared.nativeRenderer.sha256,
    'Restore the ordinary Cook renderer before packaging');
  assert.equal(audit(cook.reusedShaderCompiler.file).sha256, cook.reusedShaderCompiler.sha256);
  for (const file of ['Private/TemporalSuperResolution/TSRConvolutionNetworkPass.ush',
    'Private/VirtualShadowMaps/VirtualShadowMapProjection.usf',
    'Private/VirtualShadowMaps/VirtualShadowMapProjectionDirectional.ush',
    'Private/VirtualShadowMaps/VirtualShadowMapProjectionSpot.ush'])
    assert.equal(audit(path.join(root, '.tools/ue58-web-cook-shaders', file)).sha256,
      audit(path.join(root, 'reference-engine/Engine/Shaders', file)).sha256,
      'Restore the ordinary Cook shader: ' + file);
  fs.mkdirSync(output, {recursive: true});
  const manifestFile = path.join(output, 'content-files.json'), pack = path.join(output, 'content.bin');
  if (fs.existsSync(manifestFile)) {
    const saved = parse(manifestFile);
    assert.equal(audit(pack).sha256, saved.pack.sha256);
    return output;
  }
  deduplicate(cook);
  const files = [];
  const products = cook.products.filter(item => !item.file.replaceAll('\\', '/').includes('/Metadata/'));
  for (const product of products.sort((a, b) => a.file.localeCompare(b.file))) {
    assert.equal(audit(product.file).sha256, product.sha256, 'Cook product changed');
    let relative = path.relative(cook.output, product.file).replaceAll('\\', '/');
    relative = relative.replace('TriplexHouseVilla/Content/ShaderArchive-TriplexHouseVilla-',
      'TriplexHouseVilla/Content/ShaderArchive-UEWebEngine-')
      .replace(/^TriplexHouseVilla\/Content\//, 'Engine/Programs/UEWebEngine/Content/');
    assert(relative.startsWith('Engine/') && !relative.includes('../'), relative);
    files.push({path: '/' + relative, file: product.file, sha256: product.sha256,
      size: fs.statSync(product.file).size});
  }
  // Sky capture is immutable scene data, independent of the shader permutations being rebuilt.
  const original = parse(path.join(source, 'content-files.json'));
  const sky = original.files.find(item => item.path.endsWith('/WebSkyCaptures.bin'));
  assert(sky);
  const skyBytes = Buffer.alloc(sky.size), sourceFd = fs.openSync(path.join(source, 'content.bin'), 'r');
  try {assert.equal(fs.readSync(sourceFd, skyBytes, 0, skyBytes.length, sky.offset), skyBytes.length);}
  finally {fs.closeSync(sourceFd);}
  assert.equal(sha(skyBytes), sky.sha256);
  files.push({...sky, bytes: skyBytes});
  const space = fs.statfsSync(work), bytesRequired = files.reduce((sum, item) => sum + item.size, 0);
  assert(space.bavail * space.bsize > bytesRequired + 512 * 1024 * 1024,
    'Insufficient project disk space for the historical content pack');
  const entries = [], buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(assertProjectOutput(pack), 'w');
  let offset = 0;
  try {
    for (const item of files) {
      entries.push({path: item.path, offset, size: item.size, sha256: item.sha256});
      if (item.bytes) fs.writeSync(fd, item.bytes);
      else {
        const input = fs.openSync(item.file, 'r');
        try {
          let remaining = item.size;
          while (remaining) {
            const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, remaining), null);
            assert(count > 0);
            let written = 0;
            while (written < count) written += fs.writeSync(fd, buffer, written, count - written);
            remaining -= count;
          }
        } finally {fs.closeSync(input);}
      }
      offset += item.size;
    }
  } finally {fs.closeSync(fd);}
  assert(entries.some(item => item.path.endsWith('/BigTriplexHouseVilla.umap')));
  assert(entries.some(item => item.path === '/Engine/GlobalShaderCache-SP_WEBGPU_SM5.bin'));
  write(manifestFile, JSON.stringify({...original, pack: metadata(pack, 'content.bin'), files: entries}));
  return output;
}
function capture(folder) {
  const tag = 'git-history-' + path.basename(folder).replace('villa-git-', '') + '-' + Date.now();
  const snapshot = assertProjectOutputTree(path.join(__dirname, 'build', tag));
  fs.mkdirSync(snapshot);
  for (const name of fs.readdirSync(folder)) {
    if (['asset-versions.json', 'pipeline-prewarm.json'].includes(name)) continue;
    const from = path.join(folder, name), to = assertProjectOutput(path.join(snapshot, name));
    if (['content.bin', 'UEWebEngineThreads.wasm', 'UEWebEngineThreads.js'].includes(name)) fs.linkSync(from, to);
    else fs.copyFileSync(from, to);
  }
  writeVersions(snapshot, fs.readdirSync(snapshot).map(name => audit(path.join(snapshot, name))));
  const env = {...process.env};
  if (!env.NODE_PATH) env.NODE_PATH =
    'C:/Users/wap80/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
  const child = cp.spawnSync(process.execPath, [path.join(__dirname, 'probe-villa-startup.cjs'),
    '--tag=' + tag, '--folder=' + tag, '--engine=ours', '--rounds=1', '--browser=msedge',
    '--profile=git-history-prewarm', '--direct', '--origin=http://127.0.0.1:8765',
    '--capture', '--settle-frames=120', '--scripted-motion-seconds=12',
    '--width=1280', '--height=720', '--dpr=1'], {stdio: 'inherit', windowsHide: true, env});
  assert(!child.error && child.status === 0, 'Historical pipeline capture failed; package is not ready');
  return path.join(__dirname, 'results/villa-startup-' + tag, '0-corpus.json');
}
function packageNode(id, staged) {
  const output = assertProjectOutputTree(path.join(__dirname, 'build/villa-git-' + id + '-20261113'));
  const reportFile = assertProjectOutput(path.join(results, id + '-package.json'));
  if (fs.existsSync(reportFile) && parse(reportFile).pass) return;
  const runtime = parse(path.join(results, id + '-runtime.json'));
  assert(runtime.pass && runtime.products.every(item => audit(item.file).sha256 === item.sha256));
  const report = {date: new Date().toISOString(), pass: false, output,
    runtime: audit(path.join(results, id + '-runtime.json')), cook: audit(path.join(results, 'cook.json')),
    rootCommit: runtime.rootCommit, engineCommit: runtime.engineCommit,
    boundary: 'Historical renderer sources, command stream and accepted settings, with a matching pre-TSR Cook. Current shared startup host/worker are required by project release rules. Original diagnostic and TSR packages are preserved separately.'};
  try {
    fs.mkdirSync(output, {recursive: true});
    for (const name of fs.readdirSync(source)) {
      if (['asset-versions.json', 'pipeline-prewarm.json', 'content.bin', 'content-files.json',
        'UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'].includes(name)) continue;
      const input = path.join(source, name);
      if (fs.statSync(input).isFile()) fs.copyFileSync(input, assertProjectOutput(path.join(output, name)));
    }
    for (const name of ['content.bin', 'content-files.json']) {
      const target = assertProjectOutput(path.join(output, name));
      if (!fs.existsSync(target)) fs.linkSync(path.join(staged, name), target);
      assert.equal(audit(target).sha256, audit(path.join(staged, name)).sha256);
    }
    for (const product of runtime.products)
      replaceFile(path.join(output, path.basename(product.file)), fs.readFileSync(product.file));
    const configs = parse(path.join(output, 'config-files.json'));
    const web = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
    assert(web);
    const text = '; Project rendering settings are inherited without Web profile overrides.\n' +
      '\n[SystemSettings]\nr.Shadow.Virtual.Enable=1\n';
    web.data = Buffer.from(text).toString('base64'); web.sha256 = sha(Buffer.from(text));
    write(path.join(output, 'config-files.json'), JSON.stringify(configs));
    const page = readPage(output);
    page.assets.wasm = metadata(path.join(output, 'UEWebEngineThreads.wasm'), 'UEWebEngineThreads.wasm');
    delete page.assets.diagnosticOnly;
    delete page.assets.vsmAdaptiveProbe;
    for (const name of ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm', 'content.bin',
      'content-files.json', 'config-files.json']) page.assets.versions[name] = audit(path.join(output, name)).sha256;
    delete page.assets.pipelinePrewarm;
    writePage(output, page);
    const historicalDefaults = path.join(work, id, 'tests/web-platform/web-accepted-defaults.cjs');
    report.defaults = audit(historicalDefaults);
    report.profile = require(historicalDefaults).applyAcceptedDefaults(output);
    const configured = readPage(output);
    configured.assets.versions['config-files.json'] = audit(path.join(output, 'config-files.json')).sha256;
    writePage(output, configured);
    report.release = finalizeDesktopRelease(output, {capture});
    assert(report.release.releaseReady);
    report.products = fs.readdirSync(output).filter(name => name !== 'asset-versions.json')
      .map(name => audit(path.join(output, name)));
    report.products.push(writeVersions(output, report.products));
    report.pass = true;
  } catch (error) {report.error = error.stack; throw error;}
  finally {write(reportFile, JSON.stringify(report, null, 2));}
}
try {
  const staged = stage();
  for (const id of ['adaptive', 'indirect', 'pages']) {
    console.log('Packaging historical node: ' + id);
    packageNode(id, staged);
  }
} catch (error) {console.error(error); process.exitCode = 1;}
