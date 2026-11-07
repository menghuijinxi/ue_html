'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const base = path.join(root, '.tools/ue58-web-cook-host');
const host = path.join(root, '.tools/ue58-nanite-cook-host');
const build = path.join(host, 'map-build');
const binaries = path.join(host, 'Engine/Binaries/Win64');
const native = JSON.parse(fs.readFileSync(path.join(__dirname, 'results/native-rendercore-build-results.json'), 'utf8').replace(/^\uFEFF/, ''));
assert(native.pass);
for (const input of [...native.sourceFiles, ...native.products, ...native.installedInputs])
  assert.equal(audit(input.file).sha256, input.sha256, `Stale native build: ${input.file}`);
function local(dir) {
  fs.mkdirSync(dir, {recursive: true});
  assert.equal(fs.realpathSync(dir).toLowerCase(), path.resolve(dir).toLowerCase());
}
function copy(source, destination) {
  if (fs.existsSync(destination)) {
    assert.equal(fs.realpathSync(destination).toLowerCase(), path.resolve(destination).toLowerCase());
    assert.equal(fs.statSync(destination).nlink, 1);
    if (audit(source).sha256 === audit(destination).sha256) return;
  }
  fs.copyFileSync(source, destination);
}
function linkDir(source, destination) {
  if (!fs.existsSync(destination)) fs.symlinkSync(source, destination, 'junction');
  assert.equal(fs.realpathSync(source).toLowerCase(), fs.realpathSync(destination).toLowerCase());
}
local(build); local(binaries);
for (const name of ['Config', 'Content', 'Source', 'Build', 'Plugins', 'Platforms', 'Shaders', 'Binaries/ThirdParty'])
  linkDir(path.join(base, 'Engine', name), path.join(host, 'Engine', name));
for (const entry of fs.readdirSync(path.join(base, 'Engine/Binaries/Win64'), {withFileTypes: true})) {
  if (/^UnrealEditor-(?:RenderCore|BuildSettings)\./.test(entry.name)) continue;
  const source = path.join(base, 'Engine/Binaries/Win64', entry.name), destination = path.join(binaries, entry.name);
  if (fs.statSync(source).isDirectory()) linkDir(source, destination);
  else {
    if (!fs.existsSync(destination)) fs.linkSync(source, destination);
    assert.equal(audit(destination).sha256, audit(source).sha256, `Stale host dependency: ${entry.name}`);
  }
}
copy(native.products.find(p => p.file.endsWith('UnrealEditor-RenderCore.dll')).file,
  path.join(binaries, 'UnrealEditor-RenderCore.dll'));
const baseBuild = path.join(base, 'map-build');
for (const name of ['RHIStaticShaderPlatformNames.gen.h', 'UnrealEditor-Definitions.h', 'UnrealEditor-Forward.def'])
  copy(path.join(baseBuild, name), path.join(build, name));
const unix = p => p.replaceAll('\\', '/');
const source = fs.readFileSync(path.join(baseBuild, 'RHIStaticShaderPlatformNames.gen.cpp'), 'utf8');
assert(source.includes('{TEXT("WEBGPU_SM5"), TEXT("Web"), 47}'));
assert(!source.includes('WEBGPU_ES31'));
fs.writeFileSync(path.join(build, 'RHIStaticShaderPlatformNames.gen.cpp'),
  source.replace('    {nullptr, nullptr, 0}', '    {TEXT("WEBGPU_ES31"), TEXT("Web"), 46},\n    {nullptr, nullptr, 0}'));
const response = path.join(build, 'UnrealEditor-Compile.rsp');
fs.writeFileSync(response, fs.readFileSync(path.join(baseBuild, 'UnrealEditor-Compile.rsp'), 'utf8')
  .replaceAll(unix(baseBuild), unix(build)));
const shared = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Intermediate/Build/Win64/x64/UnrealEditor/Development/WebGPUShaderFormat/WebGPUShaderFormat.Shared.rsp');
const toolchain = fs.readFileSync(shared, 'utf8').match(/\/(?:external:)?I\s*"([^"\r\n]+\/VC\/Tools\/MSVC\/\d+\.\d+\.\d+)\/include"/i);
assert(toolchain);
const compiler = path.join(toolchain[1], 'bin/Hostx64/x64');
const run = (name, args) => cp.execFileSync(path.join(compiler, name), args, {
  cwd: path.join(process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine', 'Source'), stdio: 'inherit', windowsHide: true});
run('cl.exe', ['/Brepro', '@' + response]);
const dll = path.join(binaries, 'UnrealEditor-BuildSettings.dll');
if (fs.existsSync(dll)) assert.equal(fs.statSync(dll).nlink, 1);
const kit = 'C:/Program Files (x86)/Windows Kits/10';
run('link.exe', ['/nologo', '/Brepro', '/DLL', `/OUT:${dll}`,
  `/DEF:${path.join(build, 'UnrealEditor-Forward.def')}`, `/IMPLIB:${path.join(build, 'UnrealEditor-BuildSettings.lib')}`,
  path.join(build, 'UnrealEditor-Map.obj'), `/LIBPATH:${kit}/Lib/10.0.22621.0/um/x64`,
  `/LIBPATH:${kit}/Lib/10.0.22621.0/ucrt/x64`, `/LIBPATH:${toolchain[1]}/lib/x64`]);
const probe = path.join(root, '.tools/ue58-web-platform-host/map-build/map-probe.exe');
const inspect = file => JSON.parse(cp.execFileSync(probe, [file], {encoding: 'utf8', windowsHide: true}));
const original = inspect(path.join(base, 'Engine/Binaries/Win64/UnrealEditor-BuildSettings.dll'));
assert.deepEqual(inspect(dll), {...original, entries: [...original.entries, {name: 'WEBGPU_ES31', platform: 'Web', index: 46}]});
console.log(JSON.stringify({host, platformMap: inspect(dll), renderCore: audit(path.join(binaries, 'UnrealEditor-RenderCore.dll'))}));
