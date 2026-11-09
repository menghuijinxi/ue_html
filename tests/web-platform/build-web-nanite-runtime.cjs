'use strict';
// Link an isolated browser diagnostic, or import a verified complete UE target.
// Both modes preserve build provenance; neither claims a clean rebuild.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const unix = s => s.replaceAll('\\', '/');
const host = path.join(root, '.tools/ue58-web-build-host/Engine');
const intermediate = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngineThreads/Development');
const output = path.join(__dirname, 'build/nanite-browser-runtime');
fs.mkdirSync(output, {recursive: true});
// Public RHI inline changes require all dependent objects to be rebuilt by UBT.
// Import that verified target directly instead of mixing diagnostic replacements
// with objects compiled against a previous reference-count protocol.
if (process.argv.includes('--from-full-build')) {
  const fullFile=path.join(__dirname,'results/web-engine-full-thread-build-results.json');
  const full=JSON.parse(fs.readFileSync(fullFile,'utf8').replace(/^\uFEFF/,''));
  const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
  assert(full.pass&&full.buildSucceeded&&full.fullLinkVerified&&full.threads&&full.lowerMemory64);
  const inputs=[...full.sourceFiles,...full.products,full.linkResponse,full.log,
    ...full.objects.flatMap(o=>[o.object,o.response,o.definitions,o.source]),
    ...full.platformCopies.flatMap(c=>[c.source,c.copied])];
  inputs.forEach(verify);
  for(const file of ['Public/RHIResources.h','Private/RHIResources.cpp']) {
    for(const base of [path.join(root,'reference-engine/Engine'),host]) {
      const f=path.join(base,'Source/Runtime/RHI',file);
      assert(full.sourceFiles.some(i=>path.resolve(i.file)===f),'full build must audit '+f);
    }
  }
  const products=full.products.filter(p=>/UEWebEngineThreads\.(js|wasm)$/.test(p.file)).map(p=>{
    const dest=path.join(output,path.basename(p.file));fs.copyFileSync(p.file,dest);return audit(dest);
  });
  assert.equal(products.length,2);
  const report={date:new Date().toISOString(),pass:true,incrementalDiagnostic:false,fullTargetBuild:true,fullRebuild:false,
    fullEngineBuild:audit(fullFile),sources:[audit(__filename),audit(fullFile),...full.sourceFiles],
    linkInputs:[full.linkResponse,...full.objects.flatMap(o=>[o.object,o.response,o.definitions,o.source])],
    compiled:[],products,log:full.log};
  fs.writeFileSync(path.join(output,'build.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({pass:true,fullTargetBuild:true,output}));process.exit(0);
}
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
  'Private/Nanite/NaniteWebScene.cpp', 'Public/Rendering/NaniteWebScene.h',
  'Private/Nanite/NaniteWebRaster.cpp', 'Public/Rendering/NaniteWebRaster.h',
  'Private/Nanite/NaniteWebHZB.cpp', 'Public/Rendering/NaniteWebHZB.h',
  'Private/Nanite/NaniteWebDepth.cpp', 'Public/Rendering/NaniteWebDepth.h',
  'Private/Nanite/NaniteWebGBuffer.cpp', 'Public/Rendering/NaniteWebGBuffer.h'];
const engineDependencies = [];
const lifetimeDependencies=['Public/RHIResources.h','Private/RHIResources.cpp'].flatMap(file=>[
  path.join(root,'reference-engine/Engine/Source/Runtime/RHI',file),path.join(host,'Source/Runtime/RHI',file)]);
for(let i=0;i<lifetimeDependencies.length;i+=2)
  assert.equal(audit(lifetimeDependencies[i]).sha256,audit(lifetimeDependencies[i+1]).sha256,'prepare the RHI overlay and run a full target build');
const fullStamp=JSON.parse(fs.readFileSync(path.join(__dirname,'results/web-engine-full-thread-build-results.json'),'utf8').replace(/^\uFEFF/,''));
assert(fullStamp.pass&&fullStamp.fullLinkVerified,'a successful full UBT target build is required');
for(const file of lifetimeDependencies) {
  const built=fullStamp.sourceFiles.find(i=>path.resolve(i.file)===file);
  assert(built&&built.sha256===audit(file).sha256,'RHI inline changes require a full UBT target build before diagnostic relinking: '+file);
}
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
const tasks = engineFiles.filter(f => f.endsWith('.cpp') && !/NaniteWeb(Hierarchy|Scene|Raster|HZB|Depth|GBuffer)\.cpp$/.test(f)).map((file, i) => {
  const unity = fs.readdirSync(engine).filter(n => /^Module\.Engine\.\d+\.cpp$/.test(n))
    .filter(n => fs.readFileSync(path.join(engine, n), 'utf8').includes('Runtime/Engine/' + file));
  assert.equal(unity.length, 1);
  return [path.join(engine, unity[0] + '.o.rsp'), null, file.endsWith('StaticMeshSceneProxy.cpp') ? 'EngineNaniteProxy' : i ? 'EngineNaniteStreaming' : 'EngineNanite'];
});
for (let i = tasks.length - 1; i >= 0; --i) if (tasks.findIndex(t => t[0] === tasks[i][0]) !== i) tasks.splice(i, 1);
// A subsequent full UBT build can include the new source in an Engine unity.
// Compile that unity when present; avoid linking a second shader registration.
for (const kind of ['Hierarchy', 'Scene', 'Raster', 'HZB', 'Depth', 'GBuffer']) {
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
  ...['WebNaniteUploaderTest', 'WebNaniteResourcesTest', 'WebNaniteSceneTest', 'WebNaniteSceneCullTest', 'WebNaniteGBufferTest', 'WebNaniteHZBTest', 'WebNaniteInstancesTest', 'WebNaniteViewsTest'].map(name => {
    const ownResponse=path.join(intermediate,'UEWebEngine',name+'.cpp.o.rsp');
    return fs.existsSync(ownResponse)?[ownResponse,null,name]:[path.join(intermediate, 'UEWebEngine/UEWebEngine.cpp.o.rsp'),
      path.join(root, 'tests/ue-web-smoke/Source/UEWebEngine/Private', name + '.cpp'), name];
  }),
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
const sources = [__filename, ...engineDependencies, ...lifetimeDependencies,
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
    path.join(host, 'Source/Runtime/RenderCore/Public/WebShaderPlatform.h')] : !override&&!name.startsWith('WebNanite') ? [...rhiDependencies].sort() :
    [...engineDependencies, path.join(host, 'Source/Runtime/Engine/Private/Nanite/NaniteStreamingPageUploader.h'),
      path.join(root, 'tests/ue-web-smoke/Source/UEWebEngine/Private/WebNaniteHierarchyTest.h')];
  const inputs = [original, response, input, ...dependencies, ...lifetimeDependencies].map(audit);
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
