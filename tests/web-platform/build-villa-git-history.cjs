'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
const {audit} = require('./content-file-metadata.cjs');
initializeProjectOutput();
const root = path.resolve(__dirname, '../..'), unix = p => p.replaceAll('\\', '/');
const work = assertProjectOutputTree(path.join(__dirname, 'build/git-history-20261113'));
const results = assertProjectOutput(path.join(__dirname, 'results/git-history-20261113'));
fs.mkdirSync(work, {recursive: true}); fs.mkdirSync(results, {recursive: true});
const nodes = [
  {id: 'adaptive', revision: '2abb246', engine: '0239f495b4'},
  {id: 'indirect', revision: '410778f', engine: '231b20bb08'},
  {id: 'pages', revision: '23d4f43', engine: '231b20bb08'},
];
const plugin = 'tests/ue-shader-host/Plugins/WebGPUShader';
const engineBuild = 'Engine/Platforms/Web/Build';
const tsr = 'Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp';
const base = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngineThreads/Development');
const nativeBase = path.join(root, '.tools/ue58-web-native-build-host/Engine');
const nativeIntermediate = path.join(nativeBase, 'Intermediate/Build/Win64/x64/UnrealEditor/Development/Renderer');
const tools = 'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.50.35717/bin/Hostx64/x64';
const git = (repo, ...args) => cp.execFileSync('git', ['-C', repo, ...args], {maxBuffer: 64 * 1024 * 1024, windowsHide: true});
function write(file, value) {
  assertProjectOutput(file); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value);
  return file;
}
const json = (file, value) => write(file, JSON.stringify(value, null, 2));
const read = file => fs.readFileSync(file, 'utf8');
function auditBase() {
  const file = path.join(__dirname, 'results/web-engine-full-thread-build-results.json');
  const build = JSON.parse(read(file).replace(/^\uFEFF/, ''));
  assert(build.pass && build.fullLinkVerified && build.threads && build.lowerMemory64);
  const objects = build.objects.map(item => item.object);
  const sourceFiles = build.sourceFiles.filter(item => /\.(cpp|h|inl|ush|usf)$/.test(item.file));
  for (const item of [...objects, ...sourceFiles, build.linkResponse])
    assert.equal(audit(item.file).sha256, item.sha256, 'Base build has changed: ' + item.file);
  const reportFile = path.join(results, 'base-audit.json');
  if (!fs.existsSync(reportFile)) json(reportFile,
    {date: new Date().toISOString(), pass: true, baseBuild: audit(file), objects, sourceFiles});
  return audit(reportFile);
}
async function auditRuntimes() {
  const baseAudit = auditBase();
  for (const node of nodes) {
    const directory = path.join(work, node.id), reportFile = path.join(results, node.id + '-runtime.json');
    const report = JSON.parse(read(reportFile));
    assert(report.pass);
    for (const item of [...report.products, ...report.recompiledObjects])
      assert.equal(audit(item.file).sha256, item.sha256);
    await WebAssembly.compile(fs.readFileSync(path.join(directory, 'runtime/UEWebEngineThreads.wasm')));
    const sourceFiles = [];
    for (const [repo, revision, prefix] of [[root, node.revision, plugin + '/Source'],
      [path.join(root, 'reference-engine'), node.engine, engineBuild],
      [path.join(root, 'reference-engine'), node.engine, tsr]]) {
      for (const name of git(repo, 'ls-tree', '-r', '--name-only', revision, '--', prefix).toString().trim().split('\n').filter(Boolean)) {
        const file = path.join(directory, name), bytes = fs.readFileSync(file);
        assert(bytes.equals(git(repo, 'show', revision + ':' + name)), 'Historical source changed: ' + file);
        sourceFiles.push(audit(file));
      }
    }
    Object.assign(report, {baseAudit, sourceFiles, wasmValidated: true});
    json(reportFile, report);
    console.log(JSON.stringify({id: node.id, historicalSourcesVerified: sourceFiles.length, wasmValidated: true}));
  }
}
function snapshot(repo, revision, prefix, destination) {
  for (const name of git(repo, 'ls-tree', '-r', '--name-only', revision, '--', prefix).toString().trim().split('\n').filter(Boolean))
    write(path.join(destination, name), git(repo, 'show', `${revision}:${name}`));
}
async function run(tag, executable, args, cwd) {
  const log = assertProjectOutput(path.join(results, tag + '.log'));
  console.log(JSON.stringify({stage: tag, log}));
  const fd = fs.openSync(log, 'w');
  try {
    await new Promise((resolve, reject) => {
      const child = cp.spawn(executable, args, {cwd, windowsHide: true, stdio: ['ignore', fd, fd],
        env: {...process.env, EM_CONFIG: unix(path.join(root, '.tools/emsdk/.emscripten'))}});
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(Error(`${tag} failed (${code}): ${log}`)));
    });
  } finally {fs.closeSync(fd);}
  return audit(log);
}
function replace(text, from, to) {return text.replaceAll(unix(from), unix(to)).replaceAll(from, to);}
function nativeResponse(text, oldCwd, output) {
  // Resolve relative response paths before moving the response to its private build directory.
  return text.replace(/"([^"\r\n]+)"/g, (whole, value) => {
    if (!value.startsWith('../')) return whole;
    return '"' + unix(path.resolve(oldCwd, value)) + '"';
  }).replace(/\/(?:OUT:|PDB:|Fo|experimental:log |sourceDependencies )"([^"]+)"/gi,
    (whole, file) => whole.replace(file, unix(path.join(output, path.basename(file)))));
}
function prepare(node) {
  const directory = assertProjectOutputTree(path.join(work, node.id));
  fs.mkdirSync(directory, {recursive: true});
  snapshot(root, node.revision, plugin + '/Source', directory);
  snapshot(root, node.revision, 'tests/web-platform/web-accepted-defaults.cjs', directory);
  snapshot(path.join(root, 'reference-engine'), node.engine, engineBuild, directory);
  write(path.join(directory, tsr), git(path.join(root, 'reference-engine'), 'show', `${node.engine}:${tsr}`));
  // Keep the original port script unchanged, with its workspace-relative dependency available.
  const portTools = path.join(work, '.tools');
  fs.mkdirSync(portTools, {recursive: true});
  const dawn = 'emdawnwebgpu-v20261009.190412';
  if (!fs.existsSync(path.join(portTools, dawn)))
    fs.symlinkSync(path.join(root, '.tools', dawn), assertProjectOutput(path.join(portTools, dawn)), 'junction');
  return directory;
}
async function runtime(node) {
  const reportFile = path.join(results, node.id + '-runtime.json');
  if (fs.existsSync(reportFile)) {
    const saved = JSON.parse(read(reportFile));
    if (saved.pass && saved.products.every(item => audit(item.file).sha256 === item.sha256)) return saved;
  }
  const directory = prepare(node), output = path.join(directory, 'runtime');
  fs.mkdirSync(output, {recursive: true});
  const report = {date: new Date().toISOString(), pass: false, ...node,
    rootCommit: git(root, 'rev-parse', node.revision).toString().trim(),
    engineCommit: git(path.join(root, 'reference-engine'), 'rev-parse', node.engine).toString().trim(),
    boundary: 'Incremental historical Git build. Recompile all six WebGPURHI translation units and the Renderer unity containing TSR; relink the complete runtime using unchanged objects from the audited small-TSR build. Original optimization, allocator and thread flags are preserved.',
    actions: [], sourceFiles: []};
  const replacements = new Map();
  try {
    report.baseAudit = auditBase();
    const historicalChanges = git(path.join(root, 'reference-engine'), 'diff', '--name-only', node.engine, '2ac751c827').toString().trim().split('\n');
    assert(historicalChanges.every(name => name.startsWith('Engine/Shaders/') ||
      name === tsr || name === engineBuild + '/WebGPUCommandStream.js'), 'Unexpected engine ABI change');
    const compiler = path.join(root, '.tools/emsdk/python/3.13.3_64bit/python.exe');
    const emcc = path.join(root, '.tools/emsdk/upstream/emscripten/em++.py');
    const cwd = path.join(root, '.tools/ue58-web-build-host/Engine/Source');
    for (const name of ['BrowserBreadcrumbs.cpp', 'BrowserBufferLock.cpp', 'BrowserDynamicRHI.cpp',
      'BrowserTransitions.cpp', 'BrowserViewport.cpp', 'WebGPUBrowserModule.cpp']) {
      const object = path.join(base, 'WebGPURHI', name + '.o'), target = path.join(output, name + '.o');
      let response = replace(read(object + '.rsp'), path.join(root, plugin + '/Source'), path.join(directory, plugin + '/Source'));
      response = replace(response, object, target);
      const file = write(target + '.rsp', response);
      if (!process.argv.includes('--link-only'))
        report.actions.push(await run(node.id + '-' + name, compiler, [emcc, '@' + file], cwd));
      replacements.set(unix(object), unix(target));
    }
    const object = path.join(base, 'Renderer/Module.Renderer.23.cpp.o');
    const originalUnity = path.join(base, 'Renderer/Module.Renderer.23.cpp');
    const unity = write(path.join(output, 'Module.Renderer.23.cpp'),
      read(originalUnity).replace('Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp', unix(path.join(directory, tsr))));
    let response = replace(read(object + '.rsp'), originalUnity, unity);
    const target = path.join(output, 'Module.Renderer.23.cpp.o');
    response = replace(response, object, target);
    const file = write(target + '.rsp', response);
    if (!process.argv.includes('--link-only'))
      report.actions.push(await run(node.id + '-Renderer', compiler, [emcc, '@' + file], cwd));
    const commonRenderer = path.join(work, 'adaptive/runtime/Module.Renderer.23.cpp.o');
    if (node.id !== 'adaptive' && fs.existsSync(commonRenderer)) {
      assert.equal(audit(path.join(directory, tsr)).sha256, audit(path.join(work, 'adaptive', tsr)).sha256);
      replacements.set(unix(object), unix(commonRenderer));
    } else replacements.set(unix(object), unix(target));
    let link = read(path.join(base, 'UEWebEngineThreads.js.rsp'));
    for (const [from, to] of replacements) link = link.replaceAll(from, to);
    link = replace(link, path.join(root, 'reference-engine', engineBuild), path.join(directory, engineBuild));
    link = replace(link, path.join(root, 'tests/ue-web-smoke/Binaries/Web/UEWebEngineThreads.js'),
      path.join(output, 'UEWebEngineThreads.js'));
    const linkResponse = write(path.join(output, 'UEWebEngineThreads.js.rsp'), link);
    report.actions.push(await run(node.id + '-link', compiler,
      [emcc, '@' + linkResponse], cwd));
    report.products = ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'].map(name => audit(path.join(output, name)));
    await WebAssembly.compile(fs.readFileSync(path.join(output, 'UEWebEngineThreads.wasm')));
    report.wasmValidated = true;
    report.recompiledObjects = [...replacements.values()].map(audit);
    report.linkResponse = audit(linkResponse);
    const historicalPlugin = path.join(directory, plugin, 'Source');
    report.sourceFiles = [path.join(directory, tsr), ...fs.readdirSync(historicalPlugin, {recursive: true})
      .filter(name => fs.statSync(path.join(historicalPlugin, name)).isFile())
      .map(name => path.join(historicalPlugin, name)), ...fs.readdirSync(path.join(directory, engineBuild))
      .filter(name => name.endsWith('.js')).map(name => path.join(directory, engineBuild, name))].map(audit);
    report.pass = true;
    return report;
  } catch (error) {report.error = error.stack; throw error;}
  finally {json(reportFile, report);}
}
async function native() {
  const node = nodes[0], directory = prepare(node), output = path.join(directory, 'native');
  fs.mkdirSync(output, {recursive: true});
  const reportFile = path.join(results, 'native.json');
  if (fs.existsSync(reportFile)) {
    const saved = JSON.parse(read(reportFile));
    if (saved.pass && saved.products.every(item => audit(item.file).sha256 === item.sha256)) return saved;
  }
  const report = {pass: false, date: new Date().toISOString(), actions: []};
  try {
    const unityName = 'Module.Renderer.23.cpp';
    const unity = write(path.join(output, unityName), read(path.join(nativeIntermediate, unityName))
      .replace('Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp', unix(path.join(directory, tsr))));
    let response = nativeResponse(read(path.join(nativeIntermediate, unityName + '.obj.rsp')), path.join(nativeBase, 'Source'), output);
    response = replace(response, path.join(nativeIntermediate, unityName), unity);
    const file = write(path.join(output, unityName + '.obj.rsp'), response);
    report.actions.push(await run('native-Renderer-compile', path.join(tools, 'cl.exe'), ['@' + file], path.join(nativeBase, 'Source')));
    let link = nativeResponse(read(path.join(nativeIntermediate, 'UnrealEditor-Renderer.dll.rsp')), path.join(nativeBase, 'Source'), output);
    link = replace(link, path.join(nativeIntermediate, unityName + '.obj'), path.join(output, unityName + '.obj'));
    const linker = write(path.join(output, 'Renderer.dll.rsp'), link);
    report.actions.push(await run('native-Renderer-link', path.join(tools, 'link.exe'), ['@' + linker], path.join(nativeBase, 'Source')));
    report.products = [audit(path.join(output, 'UnrealEditor-Renderer.dll'))];
    report.pass = true; return report;
  } catch (error) {report.error = error.stack; throw error;}
  finally {json(reportFile, report);}
}
async function cook() {
  const build = await native(), directory = path.join(work, 'adaptive');
  const output = assertProjectOutputTree(path.join(work, 'cook'));
  const reportFile = path.join(results, 'cook.json');
  if (fs.existsSync(reportFile) && JSON.parse(read(reportFile)).pass) return;
  fs.mkdirSync(output, {recursive: true});
  const swaps = [], report = {date: new Date().toISOString(), pass: false, output,
    rootRevision: nodes[0].revision, engineRevision: nodes[0].engine,
    native: audit(path.join(results, 'native.json')), actions: []};
  function swap(target, source) {
    assertProjectOutput(target);
    assert.equal(fs.statSync(target).nlink, 1, 'Do not overwrite a shared dependency');
    const original = fs.readFileSync(target), originalHash = audit(target).sha256;
    const replacement = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
    swaps.push({target, original, originalHash});
    write(target, replacement);
  }
  try {
    const binaries = path.join(root, '.tools/ue58-web-cook-host/Engine/Binaries/Win64');
    assert.equal(git(root, 'diff', nodes[0].revision, 'HEAD', '--',
      plugin + '/Source/WebGPUShaderFormat').toString().trim(), '',
    'Reusing the native shader compiler requires unchanged sources');
    report.reusedShaderCompiler = audit(path.join(root, plugin, 'Binaries/Win64/UnrealEditor-WebGPUShaderFormat.dll'));
    for (const product of build.products.filter(item => path.basename(item.file) === 'UnrealEditor-Renderer.dll')) {
      swap(path.join(binaries, 'UnrealEditor-Renderer.dll'), product.file);
    }
    const shaders = ['Private/TemporalSuperResolution/TSRConvolutionNetworkPass.ush',
      'Private/VirtualShadowMaps/VirtualShadowMapProjection.usf',
      'Private/VirtualShadowMaps/VirtualShadowMapProjectionDirectional.ush',
      'Private/VirtualShadowMaps/VirtualShadowMapProjectionSpot.ush'];
    for (const file of shaders)
      swap(path.join(root, '.tools/ue58-web-cook-shaders', file),
        git(path.join(root, 'reference-engine'), 'show', nodes[0].engine + ':Engine/Shaders/' + file));
    const project = path.join(root, 'tests/web-platform/build/projects/triplex-virtual/TriplexHouseVilla.uproject');
    const packages = ['WorldGridMaterial', 'DefaultLightFunctionMaterial', 'DefaultDeferredDecalMaterial',
      'DefaultPostProcessMaterial', 'FastBlueNoise_scalar_128x128x8',
      'FastBlueNoise_scalar_128x128x64', 'FastBlueNoise_vec2_128x128x64']
      .map(name => '/Engine/EngineMaterials/' + name);
    packages.push('/Engine/EngineResources/DefaultTexture', '/Engine/EngineResources/WhiteSquareTexture',
      '/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla');
    const args = [project, '-run=Cook', '-TargetPlatform=Web', '-ddpi:Web:bIsEnabled=false',
      '-OutputDir=' + output, '-PACKAGE=' + packages.join('+'), '-SkipZenStore', '-NoDefaultMaps',
      '-NoGameAlwaysCook', '-CookProcessCount=1', '-unattended', '-nop4', '-nosplash', '-nosound',
      '-nullrhi', '-sm5', '-UTF8Output', '-processaffinity=2', '-abslog=' + path.join(results, 'cook-ue.log'),
      '-WebGPUCook', '-noshaderworker', '-WebProjectSettingsCook', '-WebGPUStopOnShaderError',
      '-ini:Game:[/Script/UnrealEd.ProjectPackagingSettings]:bShareMaterialShaderCode=True',
      '-ini:Game:[/Script/UnrealEd.ProjectPackagingSettings]:bSharedMaterialNativeLibraries=False',
      '-ini:Engine:[SystemSettings]:r.ShaderDevelopmentMode=0'];
    process.env.WEBGPU_TINT_DIR = path.join(root, '.tools/dawn-v20261009.190412/bin');
    process.env.WEBGPU_INTERMEDIATE_DIR = assertProjectOutput(path.join(output, 'ShaderConversion'));
    report.arguments = args;
    report.hostProducts = swaps.map(item => audit(item.target));
    report.actions.push(await run('cook-console', path.join(binaries, 'UnrealEditor-Cmd.exe'), args, root));
    report.products = fs.readdirSync(output, {recursive: true})
      .filter(name => /\.(uasset|umap|uexp|ubulk|ushaderbytecode)$/.test(name) ||
        path.basename(name) === 'GlobalShaderCache-SP_WEBGPU_SM5.bin')
      .filter(name => !name.startsWith('ShaderConversion'))
      .map(name => audit(path.join(output, name)));
    assert(report.products.length > 4000, 'Missing cooked villa assets');
    report.pass = true;
  } catch (error) {report.error = error.stack; throw error;}
  finally {
    for (const item of swaps.reverse()) {
      write(item.target, item.original);
      assert.equal(audit(item.target).sha256, item.originalHash);
    }
    report.hostRestored = true;
    json(reportFile, report);
  }
}
(async () => {
  if (process.argv.includes('--audit-only')) await auditRuntimes();
  else if (process.argv.includes('--cook')) await cook();
  else if (process.argv.includes('--native')) await native();
  else for (const node of nodes.filter(node => !process.argv.some(arg => arg.startsWith('--node=')) ||
    process.argv.includes('--node=' + node.id))) await runtime(node);
})().catch(error => {console.error(error); process.exitCode = 1;});
