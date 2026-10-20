const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const engine = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const host = path.join(root, '.tools/ue58-web-platform-host');
const worker = path.join(root, '.tools/ue58-web-shader-worker');
const build = path.join(host, 'map-build');
const generated = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Intermediate/Build/Win64/x64/UnrealEditor/Development/WebGPUShaderFormat');
const compiler = 'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64';
const stock = path.join(engine, 'Binaries/Win64');
const unix = value => value.replaceAll('\\', '/');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (file, args, options = {}) => cp.execFileSync(file, args,
  {cwd: path.join(engine, 'Source'), encoding: 'utf8', ...options});
fs.mkdirSync(build, {recursive: true});

const kit = 'C:/Program Files (x86)/Windows Kits/10';
const msvc = path.resolve(compiler, '../../..');
run(path.join(compiler, 'cl.exe'), ['/nologo', '/EHsc', '/std:c++20',
  ...['um', 'shared', 'ucrt'].map(dir => `/I${kit}/Include/10.0.22621.0/${dir}`),
  `/I${msvc}/include`, `/Fo${path.join(build, 'map-probe.obj')}`, `/Fe${path.join(build, 'map-probe.exe')}`,
  path.join(__dirname, 'buildsettings-map-probe.cpp'), '/link',
  `/LIBPATH:${kit}/Lib/10.0.22621.0/um/x64`, `/LIBPATH:${kit}/Lib/10.0.22621.0/ucrt/x64`,
  `/LIBPATH:${msvc}/lib/x64`], {stdio: 'inherit'});
const inspect = file => JSON.parse(run(path.join(build, 'map-probe.exe'), [file]));
const original = inspect(path.join(stock, 'UnrealEditor-BuildSettings.dll'));
fs.writeFileSync(path.join(build, 'stock-entries.json'), JSON.stringify(original, null, 2));
run('pwsh.exe', ['-NoProfile', '-File', path.join(__dirname, 'generate-web-shader-map.ps1'),
  '-Engine', path.dirname(engine), '-Output', build, '-ExistingEntries', path.join(build, 'stock-entries.json')],
  {stdio: 'inherit'});
fs.copyFileSync(path.join(engine, 'Intermediate/Build/Win64/x64/UnrealEditor/Development/BuildSettings/Gen/RHIStaticShaderPlatformNames.gen.h'),
  path.join(build, 'RHIStaticShaderPlatformNames.gen.h'));

const binaries = path.join(host, 'Engine/Binaries/Win64');
fs.mkdirSync(binaries, {recursive: true});
for (const entry of fs.readdirSync(stock, {withFileTypes: true})) {
  if (entry.isFile() && /\.(dll|exe|modules|version|target)$/i.test(entry.name)) {
    fs.copyFileSync(path.join(stock, entry.name), path.join(binaries, entry.name));
  } else if (entry.isDirectory() && !fs.existsSync(path.join(binaries, entry.name))) {
    fs.symlinkSync(path.join(stock, entry.name), path.join(binaries, entry.name), 'junction');
  }
}
for (const dir of ['Config', 'Content', 'Shaders', 'Source', 'Build', 'Plugins', 'Binaries/ThirdParty']) {
  const dest = path.join(host, 'Engine', dir);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.symlinkSync(path.join(engine, dir), dest, 'junction');
  }
}
// Platforms is deliberately a real local directory: never write through an installed-engine junction.
for (const runtime of [host, worker]) {
  const platforms = path.join(runtime, 'Engine/Platforms');
  if (fs.existsSync(platforms)) assert(!fs.lstatSync(platforms).isSymbolicLink(), 'Platforms must be isolated');
  fs.mkdirSync(platforms, {recursive: true});
  const stockPlatforms = path.join(engine, 'Platforms');
  if (fs.existsSync(stockPlatforms)) for (const name of fs.readdirSync(stockPlatforms)) {
    if (name === 'WebGPU') throw Error('Stock engine already contains a WebGPU extension');
    const dest = path.join(platforms, name);
    if (!fs.existsSync(dest)) fs.symlinkSync(path.join(stockPlatforms, name), dest, 'junction');
  }
  const config = path.join(platforms, 'WebGPU/Config');
  fs.mkdirSync(config, {recursive: true});
  fs.copyFileSync(path.join(__dirname, 'platform-extension/Config/DataDrivenPlatformInfo.ini'),
    path.join(config, 'DataDrivenPlatformInfo.ini'));
  fs.copyFileSync(path.join(__dirname, 'platform-extension/Config/WebGPUEngine.ini'),
    path.join(config, 'WebGPUEngine.ini'));
}

const flavors = [];
for (const [prefix, runtime] of [['UnrealEditor', host], ['ShaderCompileWorker', worker]]) {
  const directory = path.join(runtime, 'Engine/Binaries/Win64');
  const name = `${prefix}-BuildSettings.dll`;
  const old = path.join(stock, name), replacement = path.join(directory, name);
  const preservedName = `${prefix}-BuildSettingsStock.dll`;
  fs.copyFileSync(old, path.join(directory, preservedName));
  assert.equal(sha(path.join(directory, preservedName)), sha(old), 'Preserved BuildSettings DLL changed');
  const originalFlavor = inspect(old);
  assert.deepEqual(originalFlavor.entries, original.entries, 'Editor/Worker stock platform maps differ');
  const exports = run(path.join(compiler, 'dumpbin.exe'), ['/EXPORTS', old]).split(/\r?\n/)
    .flatMap(line => line.match(/^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\?\S+)/i)?.[1] || []);
  assert(exports.includes('?GStaticShaderNames@@3PAUFStaticNameMapEntry@@A'));
  const functions = exports.filter(name => !name.startsWith('?GStaticShaderNames'));
  const definitions = fs.readFileSync(path.join(generated, 'Definitions.h'), 'utf8') +
    '\n#define BUILDSETTINGS_API DLLEXPORT\n';
  const defs = path.join(build, `${prefix}-Definitions.h`);
  fs.writeFileSync(defs, definitions);
  let response = fs.readFileSync(path.join(generated, 'PerModuleInline.gen.cpp.obj.rsp'), 'utf8');
  response = response.replace(/^"[^"]+"$/m, `"${unix(path.join(build, 'RHIStaticShaderPlatformNames.gen.cpp'))}"`)
    .replace(/\/FI"[^"]+"/, `/FI"${unix(defs)}"`)
    .replace(/\/Fo"[^"]+"/, `/Fo"${unix(path.join(build, `${prefix}-Map.obj`))}"`)
    .split(/\r?\n/).filter(line => !/^\/(experimental:log|sourceDependencies)/.test(line)).join('\n');
  const compileRsp = path.join(build, `${prefix}-Compile.rsp`);
  fs.writeFileSync(compileRsp, response);
  run(path.join(compiler, 'cl.exe'), [`@${compileRsp}`], {stdio: 'inherit'});
  const def = path.join(build, `${prefix}-Forward.def`);
  fs.writeFileSync(def, 'EXPORTS\n' + functions.map(symbol =>
    `${symbol}=${preservedName.slice(0, -4)}.${symbol}`).join('\n') + '\n');
  run(path.join(compiler, 'link.exe'), ['/nologo', '/DLL', `/OUT:${replacement}`, `/DEF:${def}`,
    `/IMPLIB:${path.join(build, `${prefix}-BuildSettings.lib`)}`,
    path.join(build, `${prefix}-Map.obj`),
    `/LIBPATH:${kit}/Lib/10.0.22621.0/um/x64`, `/LIBPATH:${kit}/Lib/10.0.22621.0/ucrt/x64`,
    `/LIBPATH:${msvc}/lib/x64`], {stdio: 'inherit'});
  const rebuilt = inspect(replacement);
  assert.deepEqual(rebuilt, {...originalFlavor, entries: [...original.entries,
    {name: 'WEBGPU_ES31', platform: 'WebGPU', index: 46},
    {name: 'WEBGPU_SM5', platform: 'WebGPU', index: 47}]});
  flavors.push({prefix, replacement, sha256: sha(replacement), map: rebuilt,
    forwardedFunctions: functions.length, preservedBuildSettingsSha256: sha(path.join(directory, preservedName))});
}
const report = {pass: true, kind: 'isolated-static-shader-platform-map',
  generator: JSON.parse(fs.readFileSync(path.join(build, 'generator.json'), 'utf8')),
  ddpiSha256: sha(path.join(__dirname, 'platform-extension/Config/DataDrivenPlatformInfo.ini')),
  editor: path.join(binaries, 'UnrealEditor-Cmd.exe'), worker: path.join(worker, 'Engine/Binaries/Win64/ShaderCompileWorker.exe'),
  originalEditorUnmodified: sha(path.join(binaries, 'UnrealEditor-Cmd.exe')) === sha(path.join(stock, 'UnrealEditor-Cmd.exe')),
  flavors, fullSourceEngineBuild: false,
  limitation: 'Only the generated static-name table is rebuilt. BuildSettings functions forward to preserved stock DLLs. Other host modules remain installed 5.8.0.'};
fs.writeFileSync(path.join(__dirname, 'results/static-platform-host-build.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, editor: report.editor, flavors: flavors.map(item => item.prefix)}, null, 2));
