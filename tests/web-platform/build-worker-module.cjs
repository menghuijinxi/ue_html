const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const engine = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const plugin = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader');
const generated = path.join(plugin, 'Intermediate/Build/Win64/x64/UnrealEditor/Development/WebGPUShaderFormat');
const output = path.join(root, '.tools/ue58-web-shader-worker');
const objects = path.join(output, 'module-build');
const binaries = path.join(output, 'Engine/Binaries/Win64');
const compiler = 'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64';
const unix = value => value.replaceAll('\\', '/');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(objects, {recursive: true});
fs.mkdirSync(binaries, {recursive: true});

// Reuse UBT's include paths and toolchain arguments; only the target flavor changes.
let definitions = fs.readFileSync(path.join(generated, 'Definitions.h'), 'utf8');
const flavor = {
  IS_PROGRAM: '1', UE_EDITOR: '0', WITH_ENGINE: '0', WITH_EDITOR: '0',
  WITH_UNREAL_DEVELOPER_TOOLS: '0', WITH_UNREAL_TARGET_DEVELOPER_TOOLS: '0',
  WITH_COREUOBJECT: '0', UE_ENABLE_ICU: '0', WITH_CEF3: '0', WITH_LIVE_CODING: '0',
  WITH_LOGGING_TO_MEMORY: '1', USE_LOGGING_IN_SHIPPING: '1',
  UBT_MODULE_MANIFEST: '"ShaderCompileWorker.modules"',
  UBT_MODULE_MANIFEST_DEBUGGAME: '"ShaderCompileWorker-Win64-DebugGame.modules"',
  UBT_COMPILED_TARGET: 'Program', UE_APP_NAME: '"ShaderCompileWorker"',
  UE_TARGET_NAME: 'ShaderCompileWorker',
};
for (const [name, value] of Object.entries(flavor)) {
  const pattern = new RegExp(`^#define ${name} .*$`, 'm');
  if (!pattern.test(definitions)) throw Error(`Missing generated definition: ${name}`);
  definitions = definitions.replace(pattern, `#define ${name} ${value}`);
}
definitions += '\n#define ALLOW_LOG_FILE 0\n#define ALLOW_WINDOWS_ERROR_REPORT_LIB 0\n' +
  '#define UE_EXTERNAL_PROFILING_ENABLED 0\n#define NOINITCRASHREPORTER 1\n#define UE_ENABLE_TRACKED_IO 0\n';
const definitionFile = path.join(objects, 'Definitions.h');
fs.writeFileSync(definitionFile, definitions);
const objectFiles = [];
for (const source of ['WebGPUShaderFormat.cpp', 'PerModuleInline.gen.cpp']) {
  let response = fs.readFileSync(path.join(generated, `${source}.obj.rsp`), 'utf8');
  response = response.split(/\r?\n/).filter(line =>
    !line.startsWith('/experimental:log') && !line.startsWith('/sourceDependencies')).join('\n');
  response = response.replace(/\/FI"[^"]+"/, `/FI"${unix(definitionFile)}"`);
  const object = unix(path.join(objects, `${source}.obj`));
  response = response.replace(/\/Fo"[^"]+"/, `/Fo"${object}"`);
  const responseFile = path.join(objects, `${source}.rsp`);
  fs.writeFileSync(responseFile, response);
  cp.execFileSync(path.join(compiler, 'cl.exe'), [`@${responseFile}`],
    {cwd: path.join(engine, 'Source'), stdio: 'inherit'});
  objectFiles.push(object);
}
const dll = unix(path.join(binaries, 'ShaderCompileWorker-WebGPUShaderFormat.dll'));
let linkResponse = fs.readFileSync(path.join(generated, 'UnrealEditor-WebGPUShaderFormat.dll.rsp'), 'utf8');
let objectIndex = 0;
linkResponse = linkResponse.split(/\r?\n/).flatMap(line => {
  if (line.startsWith('/NATVIS:') || line.endsWith('.res"')) return [];
  if (line.endsWith('.obj"')) return [`"${objectFiles[objectIndex++]}"`];
  if (line.includes('/UnrealEditor/Development/') && line.endsWith('.lib"')) {
    const workerLibrary = line.replace('/UnrealEditor/Development/', '/ShaderCompileWorker/Development/')
      .replace('/UnrealEditor-', '/ShaderCompileWorker-');
    if (!fs.existsSync(path.resolve(engine, 'Source', workerLibrary.slice(1, -1)))) {
      throw Error(`Worker import library unavailable: ${workerLibrary}`);
    }
    return [workerLibrary];
  }
  if (line.startsWith('/OUT:')) return [`/OUT:"${dll}"`];
  if (line.startsWith('/PDB:')) return [`/PDB:"${unix(path.join(objects, 'WebGPUShaderFormat.pdb'))}"`];
  return [line];
}).join('\n');
if (objectIndex !== objectFiles.length || /UnrealEditor-[^"]+\.lib/.test(linkResponse)) {
  throw Error('Editor imports or unexpected objects in worker link');
}
const linkFile = path.join(objects, 'link.rsp');
fs.writeFileSync(linkFile, linkResponse);
cp.execFileSync(path.join(compiler, 'link.exe'), [`@${linkFile}`],
  {cwd: path.join(engine, 'Source'), stdio: 'inherit'});
const imports = cp.execFileSync(path.join(compiler, 'dumpbin.exe'), ['/DEPENDENTS', dll], {encoding: 'utf8'});
fs.writeFileSync(path.join(objects, 'imports.txt'), imports);
if (/UnrealEditor-/i.test(imports)) throw Error('Worker module imports Editor DLLs');

const stock = path.join(engine, 'Binaries/Win64');
const platformMapReport = path.join(__dirname, 'results/static-platform-host-build.json');
let preservedStaticPlatformMap = null;
if (fs.existsSync(platformMapReport)) {
  const platformMap = JSON.parse(fs.readFileSync(platformMapReport, 'utf8'));
  const workerMap = platformMap.flavors?.find(item => item.prefix === 'ShaderCompileWorker');
  const expected = path.join(binaries, 'ShaderCompileWorker-BuildSettings.dll');
  if (platformMap.pass && workerMap && path.resolve(workerMap.replacement) === path.resolve(expected) &&
      fs.existsSync(expected) && sha(expected) === workerMap.sha256) {
    preservedStaticPlatformMap = {file: expected, sha256: workerMap.sha256,
      report: {file: platformMapReport, sha256: sha(platformMapReport)}};
  }
}
for (const name of fs.readdirSync(stock).filter(name =>
  /^ShaderCompileWorker(?:\.exe|\.version|-[^/]+\.dll)$/i.test(name))) {
  if (preservedStaticPlatformMap && name === 'ShaderCompileWorker-BuildSettings.dll') continue;
  fs.copyFileSync(path.join(stock, name), path.join(binaries, name));
}
const examined = new Set();
const pending = fs.readdirSync(binaries).filter(name => /\.(dll|exe)$/i.test(name));
while (pending.length) {
  const name = pending.pop();
  if (examined.has(name.toLowerCase())) continue;
  examined.add(name.toLowerCase());
  const dump = cp.execFileSync(path.join(compiler, 'dumpbin.exe'),
    ['/DEPENDENTS', path.join(binaries, name)], {encoding: 'utf8'});
  for (const dependency of dump.split(/\r?\n/).map(line => line.trim())
    .filter(line => /^[\w.-]+\.dll$/i.test(line))) {
    if (fs.existsSync(path.join(stock, dependency))) {
      if (!fs.existsSync(path.join(binaries, dependency))) {
        fs.copyFileSync(path.join(stock, dependency), path.join(binaries, dependency));
      }
      pending.push(dependency);
    }
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(stock, 'ShaderCompileWorker.modules'), 'utf8'));
manifest.Modules.WebGPUShaderFormat = path.basename(dll);
fs.writeFileSync(path.join(binaries, 'ShaderCompileWorker.modules'), JSON.stringify(manifest, null, 2));
for (const directory of ['Config', 'Content', 'Shaders', 'Source', 'Build', 'Plugins', 'Binaries/ThirdParty']) {
  const destination = path.join(output, 'Engine', directory);
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.symlinkSync(path.join(engine, directory), destination, 'junction');
  }
}
const report = {
  kind: 'installed-engine-worker-module-build', buildId: manifest.BuildId,
  worker: path.join(binaries, 'ShaderCompileWorker.exe'),
  originalWorkerUnmodified: sha(path.join(stock, 'ShaderCompileWorker.exe')) ===
    sha(path.join(binaries, 'ShaderCompileWorker.exe')),
  dll, dllSha256: sha(dll), imports, flavor, preservedStaticPlatformMap,
  limitation: 'Manual Program-flavor DLL built using installed SCW import libraries and UBT-generated Editor include arguments.',
};
fs.writeFileSync(path.join(__dirname, 'results/worker-module-build.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({worker: report.worker, originalWorkerUnmodified: report.originalWorkerUnmodified, dll}, null, 2));
