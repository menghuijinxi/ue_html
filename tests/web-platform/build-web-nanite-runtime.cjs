'use strict';
// Link an isolated browser diagnostic from the existing threaded UE objects.
// This does not replace the ordinary executable or claim a clean full rebuild.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const unix = s => s.replaceAll('\\', '/');
const host = path.join(root, '.tools/ue58-web-build-host/Engine');
const intermediate = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngineThreads/Development');
const output = path.join(__dirname, 'build/nanite-browser-runtime');
fs.mkdirSync(output, {recursive: true});
const previous = fs.existsSync(path.join(output, 'build.json')) ? JSON.parse(fs.readFileSync(path.join(output, 'build.json'), 'utf8')) : null;
const sdk = unix(path.join(root, '.tools/emsdk'));
const execute = (response, log) => {
  const fd = fs.openSync(log, 'w');
  const result = cp.spawnSync(path.join(sdk, 'python/3.13.3_64bit/python.exe'),
    [path.join(sdk, 'upstream/emscripten/em++.py'), '@' + response], {
      cwd: path.join(host, 'Source'), windowsHide: true, stdio: ['ignore', fd, fd],
      env: {...process.env, WEB_EMSDK_ROOT: sdk, EM_CONFIG: sdk + '/.emscripten'},
    });
  fs.closeSync(fd);
  if (result.status !== 0) console.error(fs.readFileSync(log, 'utf8').slice(-9000));
  assert.equal(result.status, 0, result.error?.message || log);
};
const engineFiles = ['Private/Nanite/NaniteStreamingPageUploader.cpp',
  'Private/Rendering/NaniteStreamingManager.cpp', 'Public/Rendering/NaniteStreamingManager.h',
  'Private/Rendering/NaniteResources.cpp', 'Private/Nanite/NaniteWebHierarchy.cpp',
  'Public/Rendering/NaniteWebHierarchy.h', 'Private/StaticMeshSceneProxy.cpp',
  'Private/Nanite/NaniteWebScene.cpp', 'Public/Rendering/NaniteWebScene.h'];
const engineDependencies = [];
for (const file of engineFiles) {
  const source = path.join(root, 'reference-engine/Engine/Source/Runtime/Engine', file);
  const overlay = path.join(host, 'Source/Runtime/Engine', file);
  assert.equal(fs.realpathSync(path.dirname(overlay)).toLowerCase(), path.dirname(overlay).toLowerCase());
  if (fs.existsSync(overlay)) {
    assert.equal(fs.realpathSync(overlay).toLowerCase(), overlay.toLowerCase());
    assert.equal(fs.statSync(overlay).nlink, 1);
    fs.chmodSync(overlay, 0o666);
  }
  fs.copyFileSync(source, overlay);
  engineDependencies.push(source, overlay);
}
const engine = path.join(intermediate, 'Engine');
const tasks = engineFiles.filter(f => f.endsWith('.cpp') && !/NaniteWeb(Hierarchy|Scene)\.cpp$/.test(f)).map((file, i) => {
  const unity = fs.readdirSync(engine).filter(n => /^Module\.Engine\.\d+\.cpp$/.test(n))
    .filter(n => fs.readFileSync(path.join(engine, n), 'utf8').includes('Runtime/Engine/' + file));
  assert.equal(unity.length, 1);
  return [path.join(engine, unity[0] + '.o.rsp'), null, file.endsWith('StaticMeshSceneProxy.cpp') ? 'EngineNaniteProxy' : i ? 'EngineNaniteStreaming' : 'EngineNanite'];
});
for (let i = tasks.length - 1; i >= 0; --i) if (tasks.findIndex(t => t[0] === tasks[i][0]) !== i) tasks.splice(i, 1);
// A subsequent full UBT build can include the new source in an Engine unity.
// Compile that unity when present; avoid linking a second shader registration.
for (const kind of ['Hierarchy', 'Scene']) {
const hierarchyUnity = fs.readdirSync(engine).filter(n => /^Module\.Engine\.\d+\.cpp$/.test(n))
  .filter(n => fs.readFileSync(path.join(engine, n), 'utf8').includes(`Private/Nanite/NaniteWeb${kind}.cpp`));
assert(hierarchyUnity.length <= 1);
if (hierarchyUnity.length) {
  const response = path.join(engine, hierarchyUnity[0] + '.o.rsp');
  if (!tasks.some(t => t[0] === response)) tasks.push([response, null, 'EngineNanite' + kind]);
} else {
  tasks.push([tasks[0][0], path.join(host, `Source/Runtime/Engine/Private/Nanite/NaniteWeb${kind}.cpp`), 'EngineNanite' + kind]);
}
}
const rendererRelative = 'Source/Runtime/Renderer/Private/DeferredShadingRenderer.cpp';
const rendererSource = path.join(root, 'reference-engine/Engine', rendererRelative);
const rendererOverlay = path.join(host, rendererRelative);
assert.equal(fs.realpathSync(rendererOverlay).toLowerCase(), rendererOverlay.toLowerCase());
assert.equal(fs.statSync(rendererOverlay).nlink, 1);
fs.chmodSync(rendererOverlay, 0o666); fs.copyFileSync(rendererSource, rendererOverlay);
engineDependencies.push(rendererSource, rendererOverlay);
const renderer = path.join(intermediate, 'Renderer');
const rendererUnity = fs.readdirSync(renderer).filter(n => /^Module\.Renderer\.\d+\.cpp$/.test(n))
  .filter(n => fs.readFileSync(path.join(renderer, n), 'utf8').includes('Private/DeferredShadingRenderer.cpp'));
assert.equal(rendererUnity.length, 1);
tasks.push([path.join(renderer, rendererUnity[0] + '.o.rsp'), null, 'EngineNaniteRenderer']);
tasks.push(
  [path.join(intermediate, 'UEWebEngine/UEWebEngine.cpp.o.rsp'), null, 'EngineNaniteMain'],
  ...fs.readdirSync(path.join(intermediate, 'WebGPURHI')).filter(n => n.endsWith('.cpp.o.rsp'))
    .map(n => [path.join(intermediate, 'WebGPURHI', n), null, n.replace('.cpp.o.rsp', '')]),
  ...['WebNaniteUploaderTest', 'WebNaniteResourcesTest', 'WebNaniteSceneTest', 'WebNaniteSceneCullTest'].map(name => [path.join(intermediate, 'UEWebEngine/UEWebEngine.cpp.o.rsp'),
    path.join(root, 'tests/ue-web-smoke/Source/UEWebEngine/Private', name + '.cpp'), name]),
);
// RHI resource layouts are shared by all six translation units. Mixing an
// updated DynamicRHI with cached transitions/viewport code corrupts field reads.
const rhiRoots = [path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private'),
  ...['Private', 'Public'].map(p => path.join(host, 'Platforms/Web/Source/Runtime/WebGPURHI', p))];
const rhiDependencies = new Set();
function visitRHI(file) {
  file = path.resolve(file);
  if (rhiDependencies.has(file)) return;
  rhiDependencies.add(file);
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/^#include "([^"]+)"/gm)) {
    const found = [path.dirname(file), ...rhiRoots].map(p => path.resolve(p, match[1])).find(p => fs.existsSync(p));
    if (found) visitRHI(found);
  }
}
for (const [response, override] of tasks) if (!override && response.includes('WebGPURHI')) {
  const lines = fs.readFileSync(response, 'utf8').split(/\r?\n/);
  visitRHI(lines[lines.indexOf('-c') + 1].replaceAll('"', ''));
}
const sources = [__filename, ...engineDependencies,
  path.join(root, 'tests/ue-web-smoke/Source/UEWebEngine/UEWebEngine.Build.cs'),
  ...['WebGPUDynamicRHI.cpp', 'WebGPUDynamicRHI.h'].map(n => path.join(root,
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private', n))].map(audit);
const compiled = [];
for (const [original, override, name] of tasks) {
  const lines = fs.readFileSync(original, 'utf8').split(/\r?\n/);
  const previousObject = lines[lines.indexOf('-o') + 1];
  const input = override || lines[lines.indexOf('-c') + 1].replaceAll('"', '');
  for (const [flag, file] of [['-c', input], ['-o', path.join(output, name + '.o')], ['-MF', path.join(output, name + '.d')]]) {
    assert.equal(lines.filter(l => l === flag).length, 1);
    lines[lines.indexOf(flag) + 1] = '"' + unix(file) + '"';
  }
  if (override) for (const part of ['Engine/Private', 'Engine/Internal', 'Json/Public'])
    lines.push('-I"' + unix(path.join(host, 'Source/Runtime', part)) + '"');
  const response = path.join(output, name + '.rsp'), log = path.join(output, name + '.log');
  fs.writeFileSync(response, lines.join('\n'));
  const dependencies = name.startsWith('EngineNanite') ? [...engineDependencies,
    path.join(host, 'Source/Runtime/Engine/Private/Nanite/NaniteStreamingPageUploader.h'),
    path.join(host, 'Source/Runtime/RenderCore/Public/WebShaderPlatform.h')] : !override ? [...rhiDependencies].sort() :
    [...engineDependencies, path.join(host, 'Source/Runtime/Engine/Private/Nanite/NaniteStreamingPageUploader.h'),
      path.join(root, 'tests/ue-web-smoke/Source/UEWebEngine/Private/WebNaniteHierarchyTest.h')];
  const inputs = [original, response, input, ...dependencies].map(audit);
  const checkpoint = path.join(output, name + '.verified.json');
  const cached = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) :
    previous?.compiled.find(c => c.object.file === path.join(output, name + '.o'));
  const unchanged = cached && JSON.stringify(cached.inputs) === JSON.stringify(inputs) &&
    [cached.object, cached.log].every(i => fs.existsSync(i.file) && audit(i.file).sha256 === i.sha256);
  console.log((unchanged ? 'Reusing verified object ' : 'Compiling ') + name);
  if (!unchanged) execute(response, log);
  for (const input of inputs) assert.equal(audit(input.file).sha256, input.sha256, `Input changed during compile: ${input.file}`);
  const compiledItem = {inputs, previousObject: override ? null : previousObject, object: audit(path.join(output, name + '.o')), log: audit(log)};
  fs.writeFileSync(checkpoint, JSON.stringify(compiledItem));
  compiled.push(compiledItem);
}
const originalLink = path.join(intermediate, 'UEWebEngineThreads.js.rsp');
const lines = fs.readFileSync(originalLink, 'utf8').split(/\r?\n/);
const originalObjects = lines.filter(l => /^".*\.(o|a)"$/.test(l)).map(l => audit(l.slice(1, -1)));
assert(originalObjects.length > 300);
for (const item of compiled) {
  const replacement = '"' + unix(item.object.file) + '"';
  if (item.previousObject) {
    assert.equal(lines.filter(l => l === item.previousObject).length, 1);
    lines[lines.indexOf(item.previousObject)] = replacement;
  } else lines.push(replacement);
}
assert.equal(lines[0], '-o');
lines[1] = '"' + unix(path.join(output, 'UEWebEngineThreads.js')) + '"';
const link = path.join(output, 'link.rsp'), log = path.join(output, 'link.log');
fs.writeFileSync(link, lines.join('\n'));
const linkInputs = [originalLink, link, ...originalObjects.map(s => s.file)].map(audit);
const linkReused = previous && JSON.stringify(previous.linkInputs) === JSON.stringify(linkInputs) &&
  JSON.stringify(previous.compiled.map(c => c.object)) === JSON.stringify(compiled.map(c => c.object)) &&
  [...previous.products, previous.log].every(i => fs.existsSync(i.file) && audit(i.file).sha256 === i.sha256);
console.log(linkReused ? 'Reusing verified browser UE link' : 'Linking isolated browser UE runtime');
if (!linkReused) execute(link, log);
for (const input of [...sources, ...linkInputs, ...compiled.flatMap(c => c.inputs)])
  assert.equal(audit(input.file).sha256, input.sha256, `Input changed: ${input.file}`);
const report = {date: new Date().toISOString(), pass: true, incrementalDiagnostic: true, fullRebuild: false, linkReused:!!linkReused,
  sources, compiled, linkInputs, log: audit(log),
  products: ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'].map(n => audit(path.join(output, n)))};
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output}));
