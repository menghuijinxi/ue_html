const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {metadata, audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const projectId = process.argv.find(value => value.startsWith('--project='))?.slice(10);
if (projectId) assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId));
const defaultTemplate = process.argv.includes('--default-template');
const desktop = process.argv.includes('--desktop');
assert(!desktop || ((defaultTemplate || projectId) && !process.argv.includes('--es31')),
  '--desktop requires --default-template or --project and cannot be combined with --es31');
const es31 = !desktop && (!!projectId || defaultTemplate || process.argv.includes('--es31'));
const webgpu = desktop || es31 || process.argv.includes('--webgpu');
const prefix = projectId ? 'web-project-' + projectId + (desktop ? '-desktop' : '') : defaultTemplate ?
  (desktop ? 'web-engine-webgpu-sm5-default' : 'web-engine-webgpu-es31-default') :
  es31 ? 'web-engine-webgpu-es31' : webgpu ? 'web-engine-webgpu' : 'web-engine';
const format = es31 ? 'SF_WEBGPU_ES31' : 'SF_WEBGPU_SM5';
const platform = es31 ? 'SP_WEBGPU_ES31' : 'SP_WEBGPU_SM5';
const reportFile = path.join(__dirname, `results/${prefix}-stage-results.json`);
const report = {date: new Date().toISOString(), pass: false, architecture: 'wasm64',
  mode: es31 ? 'WebGPU-ES31' : webgpu ? 'WebGPU-SM5' : 'NullRHI-only', completeUEScene: false};
try {
  const cookFile = path.join(__dirname, `results/${prefix}-cook-results.json`);
  const cook = JSON.parse(fs.readFileSync(cookFile, 'utf8').replace(/^\uFEFF/, ''));
  assert(cook.pass && cook.exitCode === 0 && cook.mode === report.mode && cook.architecture === 'wasm64');
  assert.equal(cook.scene || 'Minimal', projectId ? 'Project' : defaultTemplate ? 'DefaultTemplate' : 'Minimal');
  const cookProject = projectId ? cook.projectName : 'UEShaderHost';
  assert(/^[a-zA-Z0-9_]+$/.test(cookProject));
  const runtimeRoot = 'Engine/Programs/UEWebEngine/Content/';
  report.scene = cook.scene || 'Minimal';
  report.map = cook.map || '/Game/WebMinimal';
  report.textureCompression = cook.textureCompression || 'Uncompressed';
  report.distanceFields = cook.distanceFields === true;
  assert(valid(cook.log) && cook.sourceFiles?.length && cook.sourceFiles.every(valid));
  assert(cook.hostProducts?.length >= (webgpu ? 4 : 3) && cook.hostProducts.every(valid));
  if (webgpu) {
    assert.deepEqual(cook.shaderFormats, [format]);
    assert(valid(cook.hostPreparationReport) && valid(cook.hostPreparationLog));
    const prepared = JSON.parse(fs.readFileSync(cook.hostPreparationReport.file, 'utf8'));
    assert(prepared.pass && prepared.sourceFiles.every(valid) && prepared.products.every(valid));
  }
  assert(cook.products?.length && cook.products.every(valid), 'Cooked files must match the Cook report');
  report.cookReport = audit(cookFile);
  report.sourceFiles = [audit(__filename), audit(path.join(__dirname, 'content-file-metadata.cjs'))];
  const staged = path.join(__dirname, `build/${prefix}`);
  fs.mkdirSync(staged, {recursive: true});
  const chunks = [];
  const entries = [];
  report.omittedMetadata = [];
  let offset = 0;
  for (const product of [...cook.products].sort((a, b) => a.file.localeCompare(b.file))) {
    let relative = path.relative(cook.output, product.file).replaceAll('\\', '/');
    assert(!relative.startsWith('../') && !path.isAbsolute(relative));
    if (webgpu) {
      if (relative.startsWith(cookProject + '/Metadata/ShaderLibrarySource/ShaderArchive-') &&
          relative.endsWith('.ushaderbytecode')) {
        const runtimeFile = path.join(cook.output, cookProject, 'Content', path.basename(product.file));
        assert.equal(sha(fs.readFileSync(runtimeFile)), product.sha256, 'Metadata archive must duplicate runtime bytes');
        report.omittedMetadata.push(product);
        continue;
      }
      // The browser Program's project directory differs from the native Cook project's directory.
      const projectPrefix = cookProject + '/Content/';
      relative = relative.replace(projectPrefix + 'ShaderArchive-' + cookProject + '-',
        projectPrefix + 'ShaderArchive-UEWebEngine-');
      if (relative.startsWith(projectPrefix)) relative = runtimeRoot + relative.slice(projectPrefix.length);
      assert(relative.startsWith('Engine/Content/') || relative.startsWith('Engine/Programs/UEWebEngine/Content/') ||
        relative === `Engine/GlobalShaderCache-${platform}.bin`, `Unexpected WebGPU Cook root: ${relative}`);
    } else {
      relative = relative.replace(/^UEShaderHost\/Content\//, 'Engine/Programs/UEWebEngine/Content/');
      assert(relative.startsWith('Engine/Content/') || relative.startsWith('Engine/Programs/UEWebEngine/Content/'),
        `Unexpected startup asset root: ${relative}`);
    }
    const data = fs.readFileSync(product.file);
    entries.push({path: '/' + relative, offset, size: data.length, sha256: product.sha256});
    chunks.push(data);
    offset += data.length;
  }
  const startupPath = projectId ? '/' + runtimeRoot + cook.map.slice(6) + '.umap' : defaultTemplate ?
    '/Engine/Content/Maps/Templates/Template_Default.umap' :
    '/Engine/Programs/UEWebEngine/Content/WebMinimal.umap';
  assert(entries.some(item => item.path === startupPath), 'The selected startup map must be cooked and staged');
  if (defaultTemplate)
    assert(entries.some(item =>
      item.path === '/Engine/Content/EngineMaterials/FastBlueNoise_scalar_128x128x8.uasset'),
    'SkyAtmosphere requires the mobile scalar blue-noise texture');
  if (desktop)
    for (const name of ['FastBlueNoise_scalar_128x128x64', 'FastBlueNoise_vec2_128x128x64'])
      assert(entries.some(item => item.path === `/Engine/Content/EngineMaterials/${name}.uasset`),
        `Desktop rendering requires ${name}`);
  for (const name of ['WorldGridMaterial', 'DefaultLightFunctionMaterial',
    'DefaultDeferredDecalMaterial', 'DefaultPostProcessMaterial']) {
    assert(entries.some(item => item.path === `/Engine/Content/EngineMaterials/${name}.uasset`),
      `Cook omitted required default material: ${name}`);
  }
  if (webgpu) {
    assert(entries.some(item => item.path === `/Engine/GlobalShaderCache-${platform}.bin`),
      'The real global shader map is required');
    assert(entries.some(item => item.path === `/Engine/Programs/UEWebEngine/Content/ShaderArchive-Global-${format}-${platform}.ushaderbytecode`),
      'The real shared Global shader archive is required');
    assert(entries.some(item => item.path === `/Engine/Programs/UEWebEngine/Content/ShaderArchive-UEWebEngine-${format}-${platform}.ushaderbytecode`),
      'The project material archive must use the browser Program name');
  }
  const packFile = path.join(staged, 'content.bin');
  const descriptor = fs.openSync(packFile, 'w');
  try {
    for (const chunk of chunks) {
      let written = 0;
      while (written < chunk.length) {
        const length = fs.writeSync(descriptor, chunk, written, Math.min(1024 * 1024, chunk.length - written));
        assert(length > 0, 'Content pack write must make progress');
        written += length;
      }
    }
  } finally { fs.closeSync(descriptor); }
  const manifestFile = path.join(staged, 'content-files.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    mode: report.mode, architecture: report.architecture, shaderFormat: webgpu ? format : null,
    shaderPlatform: webgpu ? platform : null,
    localIoVersion: 1, pack: metadata(packFile, 'content.bin'), files: entries
  }));
  report.pack = audit(packFile);
  report.manifest = audit(manifestFile);
  report.files = entries;
  report.totalBytes = offset;
  if (defaultTemplate || projectId) {
    const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'build/web-engine/config-files.json'), 'utf8'));
    const renderer = cook.minimalRendererConfig;
    assert(valid(renderer), 'The runtime configuration must match this Cook');
    const configPath = '/Engine/Platforms/Web/Config/WebEngine.ini';
    const ddpiPath = '/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini';
    const configs = base.filter(item => item.path !== configPath &&
      (!report.distanceFields || item.path !== ddpiPath));
    configs.push({path: configPath, sha256: renderer.sha256,
      data: fs.readFileSync(renderer.file).toString('base64')});
    if (report.distanceFields) {
      assert(desktop, 'Distance fields require the desktop renderer');
      const ddpi = cook.hostProducts.find(item => path.basename(item.file) === 'DataDrivenPlatformInfo.ini');
      assert(valid(ddpi), 'Distance-field runtime must use the Cook shader-platform capabilities');
      const data = fs.readFileSync(ddpi.file);
      const section = data.toString('utf8').split('[ShaderPlatform SP_WEBGPU_SM5]')[1]?.split('[')[0];
      assert(section?.includes('bSupportsDistanceFields=true'));
      assert(/(?:^|\n)r.GenerateMeshDistanceFields=1\r?(?:\n|$)/.test(fs.readFileSync(renderer.file, 'utf8')));
      configs.push({path: ddpiPath, sha256: ddpi.sha256, data: data.toString('base64')});
    }
    if (projectId) {
      const projectDirectory = path.dirname(cook.project);
      for (const name of ['DefaultEngine.ini', 'DefaultGame.ini', 'DefaultInput.ini', 'DefaultDeviceProfiles.ini']) {
        const file = path.join(projectDirectory, 'Config', name);
        if (!fs.existsSync(file)) continue;
        const data = fs.readFileSync(file);
        configs.push({path: '/Engine/Programs/UEWebEngine/Config/' + name,
          sha256: sha(data), data: data.toString('base64')});
      }
      report.projectId = projectId;
      report.projectName = cook.projectName;
    }
    const configFile = path.join(staged, 'config-files.json');
    fs.writeFileSync(configFile, JSON.stringify(configs));
    report.configBundle = audit(configFile);
  }
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, files: report.files?.length,
    bytes: report.totalBytes, failure: report.failure}, null, 2));
}
