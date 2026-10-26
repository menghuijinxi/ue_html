const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const engine = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const baseline = path.join(root, '.tools/ue58-web-platform-host');
const es31 = process.argv.includes('--es31');
const host = path.join(root, es31 ? '.tools/ue58-web-es31-cook-host' : '.tools/ue58-web-cook-host');
const build = path.join(host, 'map-build');
const binaries = path.join(host, 'Engine/Binaries/Win64');
const oldBuild = path.join(baseline, 'map-build');
const compiler = 'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const unix = value => value.replaceAll('\\', '/');
const reportFile = path.join(__dirname, es31 ? 'results/web-es31-cook-host-results.json' : 'results/web-cook-host-results.json');
const report = {date: new Date().toISOString(), pass: false, host,
  profile: es31 ? 'WebGPU-ES31' : 'WebGPU-SM5', fullSourceEngineBuild: false};
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const previousCookFile = path.join(__dirname, es31 ?
  'results/web-engine-webgpu-es31-default-cook-results.json' : 'results/web-engine-webgpu-cook-results.json');
const previousCook = fs.existsSync(previousCookFile) ?
  JSON.parse(fs.readFileSync(previousCookFile, 'utf8').replace(/^\uFEFF/, '')) : null;
function recordedHostProduct(file) {
  if (previousCook?.hostProducts?.some(item =>
    path.resolve(item.file) === path.resolve(file) && valid(item))) return true;
  // A failed preparation can replace the latest report before all DLLs are copied.
  // Cook output directories retain the successful preparation snapshots.
  const outputs = path.join(__dirname, 'build');
  for (const group of fs.readdirSync(outputs, {withFileTypes: true})) {
    if (!group.isDirectory() || !/^web-engine-webgpu(?:-es31|-sm5)?(?:-default)?-cook$/.test(group.name)) continue;
    const directory = path.join(outputs, group.name);
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!entry.isDirectory() || !/^\d{8}-\d{6}$/.test(entry.name)) continue;
      const snapshot = path.join(directory, entry.name, 'host-preparation-report.json');
      if (!fs.existsSync(snapshot)) continue;
      const prepared = JSON.parse(fs.readFileSync(snapshot, 'utf8').replace(/^\uFEFF/, ''));
      if (!prepared.pass || path.resolve(prepared.host) !== host) continue;
      const product = prepared.products?.find(item =>
        path.resolve(item.file) === path.resolve(file) && valid(item));
      if (!product) continue;
      (report.reusedHostProducts ||= []).push({snapshot: audit(snapshot), product});
      return true;
    }
  }
  return false;
}

try {
  fs.mkdirSync(build, {recursive: true});
  fs.mkdirSync(binaries, {recursive: true});
  const shaderSources = require('./prepare-web-cook-shaders.cjs')();
  const shaders = path.join(host, 'Engine/Shaders');
  if (fs.existsSync(shaders) && fs.realpathSync(shaders) !== fs.realpathSync(shaderSources.directory)) {
    assert(fs.lstatSync(shaders).isSymbolicLink() &&
      fs.realpathSync(shaders) === fs.realpathSync(path.join(engine, 'Shaders')),
    'Only the known installed shader junction may be replaced');
    fs.unlinkSync(shaders);
  }
  if (!fs.existsSync(shaders)) fs.symlinkSync(shaderSources.directory, shaders, 'junction');
  report.shaderSources = shaderSources;
  const nativeReportFile = path.join(__dirname, 'results/native-rendercore-build-results.json');
  const native = JSON.parse(fs.readFileSync(nativeReportFile, 'utf8').replace(/^\uFEFF/, ''));
  assert(native.pass && native.installedInputsUnmodified && native.sourceFiles.every(valid) &&
    native.products.every(valid) && native.installedInputs.every(valid), 'Rebuild native RenderCore before Cook');
  const renderCore = native.products.find(item => path.basename(item.file) === 'UnrealEditor-RenderCore.dll');
  assert(renderCore);
  const destinationDLL = path.join(binaries, 'UnrealEditor-RenderCore.dll');
  if (fs.existsSync(destinationDLL) && sha(destinationDLL) !== renderCore.sha256) {
    const installedDLL = path.join(engine, 'Binaries/Win64/UnrealEditor-RenderCore.dll');
    const previous = fs.existsSync(reportFile) ?
      JSON.parse(fs.readFileSync(reportFile, 'utf8').replace(/^\uFEFF/, '')) : null;
    assert(sha(destinationDLL) === sha(installedDLL) ||
      sha(destinationDLL) === sha(path.join(baseline, 'Engine/Binaries/Win64/UnrealEditor-RenderCore.dll')) ||
      previous?.nativeRenderCore?.sha256 === sha(destinationDLL) ||
      recordedHostProduct(destinationDLL), 'Unexpected RenderCore DLL in Cook host');
    assert.equal(fs.realpathSync(binaries), path.resolve(binaries));
    // Unlink the dependency first; copying over its hardlink would overwrite the installed DLL.
    fs.unlinkSync(destinationDLL);
  }
  if (!fs.existsSync(destinationDLL)) fs.copyFileSync(renderCore.file, destinationDLL);
  assert.equal(fs.statSync(destinationDLL).nlink, 1);
  assert.equal(sha(destinationDLL), renderCore.sha256);
  assert(native.installedInputs.every(valid));
  report.nativeRenderCoreBuildReport = audit(nativeReportFile);
  report.nativeRenderCore = audit(destinationDLL);
  const rendererReportFile = path.join(__dirname, 'results/native-renderer-build-results.json');
  const renderer = JSON.parse(fs.readFileSync(rendererReportFile, 'utf8').replace(/^\uFEFF/, ''));
  assert(renderer.pass && renderer.installedInputsUnmodified && renderer.sourceFiles.every(valid) &&
    renderer.products.every(valid) && renderer.installedInputs.every(valid), 'Rebuild native Renderer before Cook');
  const rendererDLL = renderer.products.find(item => path.basename(item.file) === 'UnrealEditor-Renderer.dll');
  assert(rendererDLL);
  const rendererDestination = path.join(binaries, 'UnrealEditor-Renderer.dll');
  if (fs.existsSync(rendererDestination) && sha(rendererDestination) !== rendererDLL.sha256) {
    const previous = fs.existsSync(reportFile) ?
      JSON.parse(fs.readFileSync(reportFile, 'utf8').replace(/^\uFEFF/, '')) : null;
    assert(sha(rendererDestination) === sha(path.join(engine, 'Binaries/Win64/UnrealEditor-Renderer.dll')) ||
      sha(rendererDestination) === sha(path.join(baseline, 'Engine/Binaries/Win64/UnrealEditor-Renderer.dll')) ||
      previous?.nativeRenderer?.sha256 === sha(rendererDestination) ||
      recordedHostProduct(rendererDestination), 'Unexpected Renderer DLL in Cook host');
    assert.equal(fs.realpathSync(binaries), path.resolve(binaries));
    fs.unlinkSync(rendererDestination);
  }
  if (!fs.existsSync(rendererDestination)) fs.copyFileSync(rendererDLL.file, rendererDestination);
  assert.equal(fs.statSync(rendererDestination).nlink, 1);
  assert.equal(sha(rendererDestination), rendererDLL.sha256);
  assert(renderer.installedInputs.every(valid));
  report.nativeRendererBuildReport = audit(rendererReportFile);
  report.nativeRenderer = audit(rendererDestination);
  // Match the installed sources used by the rebuilt modules, including their dependent DLL exports.
  for (const entry of fs.readdirSync(path.join(engine, 'Binaries/Win64'), {withFileTypes: true})) {
    if (/^UnrealEditor-(?:BuildSettings(?:Stock)?|RenderCore|Renderer)\./.test(entry.name)) continue;
    const source = path.join(engine, 'Binaries/Win64', entry.name);
    const destination = path.join(binaries, entry.name);
    if (entry.isFile() && fs.existsSync(destination) && sha(destination) !== sha(source)) {
      const old = path.join(baseline, 'Engine/Binaries/Win64', entry.name);
      assert(fs.existsSync(old) && sha(destination) === sha(old), `Unexpected Cook dependency: ${destination}`);
      assert.equal(fs.realpathSync(binaries), path.resolve(binaries));
      fs.unlinkSync(destination);
    }
    if (fs.existsSync(destination)) continue;
    if (entry.isFile()) fs.linkSync(source, destination);
    else if (entry.isDirectory()) fs.symlinkSync(source, destination, 'junction');
  }
  for (const name of ['Config', 'Content', 'Source', 'Build', 'Plugins', 'Binaries/ThirdParty']) {
    const destination = path.join(host, 'Engine', name);
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.symlinkSync(path.join(engine, name), destination, 'junction');
    }
  }
  const platforms = path.join(host, 'Engine/Platforms');
  fs.mkdirSync(platforms, {recursive: true});
  assert(!fs.lstatSync(platforms).isSymbolicLink());
  for (const entry of fs.readdirSync(path.join(engine, 'Platforms'), {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === 'Web') continue;
    const destination = path.join(platforms, entry.name);
    if (!fs.existsSync(destination)) fs.symlinkSync(path.join(engine, 'Platforms', entry.name), destination, 'junction');
  }
  const config = path.join(platforms, 'Web/Config');
  fs.mkdirSync(config, {recursive: true});
  assert(!fs.lstatSync(path.dirname(config)).isSymbolicLink() && !fs.lstatSync(config).isSymbolicLink());
  const ddpi = es31 ? path.join(__dirname, 'cook-profiles/WebGPU-ES31.ini') :
    path.join(root, 'reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini');
  const hostDDPI = path.join(config, 'DataDrivenPlatformInfo.ini');
  fs.copyFileSync(ddpi, hostDDPI);

  const probe = path.join(oldBuild, 'map-probe.exe');
  const inspect = file => JSON.parse(cp.execFileSync(probe, [file], {encoding: 'utf8'}));
  const stockDLL = path.join(engine, 'Binaries/Win64/UnrealEditor-BuildSettings.dll');
  const original = inspect(stockDLL);
  assert(original.entries.every(entry => entry.index !== 46 && entry.index !== 47));
  const entries = [...original.entries,
    {name: es31 ? 'WEBGPU_ES31' : 'WEBGPU_SM5', platform: 'Web', index: es31 ? 46 : 47}];
  for (const entry of entries) {
    assert(/^\w+$/.test(entry.name) && /^\w+$/.test(entry.platform) && Number.isInteger(entry.index));
  }
  const generated = path.join(build, 'RHIStaticShaderPlatformNames.gen.cpp');
  fs.writeFileSync(generated, '#include "RHIStaticShaderPlatformNames.gen.h"\n' +
    'BUILDSETTINGS_API FStaticNameMapEntry GStaticShaderNames[] = {\n' +
    entries.map(entry => `    {TEXT("${entry.name}"), TEXT("${entry.platform}"), ${entry.index}},`).join('\n') +
    '\n    {nullptr, nullptr, 0},\n};\n');
  for (const name of ['RHIStaticShaderPlatformNames.gen.h', 'UnrealEditor-Definitions.h', 'UnrealEditor-Forward.def']) {
    fs.copyFileSync(path.join(oldBuild, name), path.join(build, name));
  }
  const response = fs.readFileSync(path.join(oldBuild, 'UnrealEditor-Compile.rsp'), 'utf8')
    .replaceAll(unix(oldBuild), unix(build));
  const compileResponse = path.join(build, 'UnrealEditor-Compile.rsp');
  fs.writeFileSync(compileResponse, response);
  const run = (name, args) => cp.execFileSync(path.join(compiler, name), args,
    {cwd: path.join(engine, 'Source'), stdio: 'inherit'});
  run('cl.exe', ['/Brepro', `@${compileResponse}`]);
  const preserved = path.join(binaries, 'UnrealEditor-BuildSettingsStock.dll');
  fs.copyFileSync(stockDLL, preserved);
  const replacement = path.join(binaries, 'UnrealEditor-BuildSettings.dll');
  const kit = 'C:/Program Files (x86)/Windows Kits/10';
  const msvc = path.resolve(compiler, '../../..');
  const linkArguments = ['/nologo', '/Brepro', '/DLL', `/OUT:${replacement}`,
    `/DEF:${path.join(build, 'UnrealEditor-Forward.def')}`,
    `/IMPLIB:${path.join(build, 'UnrealEditor-BuildSettings.lib')}`,
    path.join(build, 'UnrealEditor-Map.obj'),
    `/LIBPATH:${kit}/Lib/10.0.22621.0/um/x64`, `/LIBPATH:${kit}/Lib/10.0.22621.0/ucrt/x64`,
    `/LIBPATH:${msvc}/lib/x64`];
  run('link.exe', linkArguments);
  const rebuilt = inspect(replacement);
  assert.deepEqual(rebuilt, {...original, entries});
  assert.equal(sha(preserved), sha(stockDLL));
  assert.equal(sha(hostDDPI), sha(ddpi));
  report.platformMap = rebuilt;
  report.sourceFiles = [__filename, ddpi, generated, compileResponse,
    path.join(build, 'UnrealEditor-Definitions.h'), path.join(build, 'UnrealEditor-Forward.def')].map(audit);
  report.products = [replacement, preserved, hostDDPI, destinationDLL, rendererDestination, path.join(binaries, 'UnrealEditor-Cmd.exe')].map(audit);
  report.boundary = `Isolated installed 5.8.0 native Cook host with ${report.profile} assigned to Web. ` +
    (es31 ? 'ES3.1 Cook profile matching the Web browser feature level. ' :
      'Uses the target 5.8.3 Web DDPI. ') +
    'The platform-name map, RenderCore shared Web shader predicates and Renderer cloud shader gates are rebuilt; other BuildSettings exports forward to a separate stock DLL. Other native modules remain installed binaries. No Cook or shader success is implied.';
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, host, failure: report.failure}, null, 2));
}
