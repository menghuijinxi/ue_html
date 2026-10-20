const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const host = path.join(root, '.tools/ue58-web-build-host/Engine');
const target = path.join(root, 'reference-engine/Engine');
const installed = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const intermediate = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngine/Development');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const files = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(item =>
  item.isDirectory() ? files(path.join(dir, item.name)) : [path.join(dir, item.name)]);
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64',
  fullLinkAttempted: false, engineTargetBuildSucceeded: false,
  launchRuntimeVerified: false, completeBrowserUERuntime: false};

try {
  fs.rmSync(path.join(intermediate, 'Makefile.bin'), {force: true});
  const ubt = path.join(host, 'Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll');
  const dotnet = path.join(installed, 'Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe');
  const args = [ubt, 'UEWebEngine', 'Web', 'Development',
    `-Project=${path.join(root, 'tests/ue-web-smoke/UEWebSmoke.uproject')}`,
    '-NoUBA', '-MaxParallelActions=2', '-NoUBTMakefiles', '-WebEngineCompileProbe'];
  function run(extra, name) {
    const result = cp.spawnSync(dotnet, [...args, ...extra], {
      encoding: 'utf8', timeout: 240000, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
    const log = (result.stdout || '') + (result.stderr || '');
    const logFile = path.join(__dirname, 'results', name);
    fs.writeFileSync(logFile, log);
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${logFile}\n${log.slice(-5000)}`);
    assert(log.includes('Result: Succeeded'));
    assert(!/(?:fatal )?error:|Error: Unable to parse/.test(log));
    return {...audit(logFile), exitCode: result.status};
  }
  const actionsFile = path.join(__dirname, 'build/web-engine-target/actions.json');
  fs.mkdirSync(path.dirname(actionsFile), {recursive: true});
  fs.rmSync(actionsFile, {force: true});
  fs.rmSync(path.join(intermediate, 'Launch/LaunchEngineLoop.cpp.o'), {force: true});
  report.graphLog = run([`-WriteOutdatedActions=${actionsFile}`], 'web-engine-graph.log');
  const actions = JSON.parse(fs.readFileSync(actionsFile, 'utf8')).Actions;
  const link = actions.find(action => action.Type === 'Link' && action.CommandDescription === 'Web Link');
  assert(link, 'Normal Engine link action must be present');
  const linkResponse = link.CommandArguments.match(/@"([^"]+)"/)?.[1];
  assert(linkResponse, 'Engine link response file must be present');
  const linkArguments = fs.readFileSync(linkResponse, 'utf8');
  for (const excluded of ['IoStoreOnDemand', 'IoStoreHttpClient']) {
    assert(!linkArguments.includes(`/Development/${excluded}/`), `${excluded} must be excluded on Web`);
  }
  assert(linkArguments.includes('/Development/IoStoreOnDemandCore/'),
    'Keep the shared IoStore interfaces required by asset management');
  report.ioStoreOnDemandNetworkExcluded = true;
  report.ioStoreOnDemandCoreRetained = true;
  for (const decoder of ['RadAudioDecoder', 'BinkAudioDecoder', 'VorbisAudioDecoder',
    'OpusAudioDecoder', 'AdpcmAudioDecoder'])
    assert(!linkArguments.includes(`/Development/${decoder}/`),
      `The current silent Web target must exclude ${decoder}`);
  report.audioDecodersExcluded = true;
  assert(linkArguments.includes('/BLAKE3/1.3.1/lib/wasm64/libBLAKE3.a'));
  assert(linkArguments.includes('/libPNG/libPNG-1.6.44/lib/wasm64/libpng.a'));
  report.portableBlake3AndPngLinked = true;
  const compile = actions.filter(action => action.Type === 'Compile');
  assert(compile.some(action => action.StatusDescription === 'LaunchEngineLoop.cpp'));
  assert(actions.some(action => action.Type === 'Link'));
  for (const action of compile) {
    assert.equal(action.CommandDescription, 'Web C++');
    const response = action.CommandArguments.match(/@"([^"]+)"/)?.[1];
    assert(response && fs.readFileSync(response, 'utf8').includes('-m64'));
  }
  const manifestFile = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/UEWebEngine/UEWebEngine.uhtmanifest');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const generatedAudit = [];
  for (const name of ['CoreUObject', 'Engine', 'UMG']) {
    const module = manifest.Modules.find(item => item.Name === name);
    assert(module, `${name} is still part of normal reflection generation`);
    const generated = files(module.OutputDirectory).filter(file => /\.generated\.h$|\.gen\.cpp$/.test(file));
    assert(generated.length > 0);
    generatedAudit.push(...generated.map(audit));
  }
  report.units = [];
  for (const [module, relative, targetBranch] of [
    ['Launch', 'Runtime/Launch/Private/LaunchEngineLoop.cpp', true],
    ['Launch', 'Runtime/Launch/Private/Launch.cpp', true],
    ['CoreUObject', 'Runtime/CoreUObject/Private/UObject/ScriptCore.cpp', true],
    ['CoreUObject', 'Runtime/CoreUObject/Private/UObject/UObjectBase.cpp', true],
    ['Engine', 'Runtime/Engine/Private/GameEngine.cpp', false],
    ['Engine', 'Runtime/Engine/Private/Shader/Preshader2.cpp', true],
    ['Engine', 'Runtime/Engine/Private/SkeletalRenderCPUSkin.cpp', false],
    ['InputCore', 'Runtime/InputCore/Private/InputCoreTypes.cpp', false],
    ['InputCore', '../Platforms/Web/Source/Runtime/InputCore/Private/Web/WebPlatformInput.cpp', true],
    ['UEWebEngine', null, true]
  ]) {
    const source = relative ? path.join(host, 'Source', relative) :
      path.join(root, 'tests/ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp');
    const original = relative ? path.join(targetBranch ? target : installed, 'Source', relative) : source;
    assert.equal(sha(source), sha(original));
    const object = path.join(intermediate, module, path.basename(source) + '.o');
    fs.rmSync(object, {force: true});
    const log = run([`-SingleFile=${source}`], `web-engine-${path.basename(source, '.cpp')}-compile.log`);
    assert(fs.readFileSync(log.file, 'utf8').includes(`Web C++ ${path.basename(source)}`));
    assert(fs.readFileSync(object).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
    const response = object + '.rsp';
    const text = fs.readFileSync(response, 'utf8');
    assert(text.includes('-m64'));
    const definitions = path.join(intermediate, module, 'Definitions.h');
    const defines = fs.readFileSync(definitions, 'utf8');
    for (const expected of ['#define WITH_ENGINE 1', '#define WITH_COREUOBJECT 1',
      '#define WITH_EDITORONLY_DATA 0', '#define UE_USE_VIRTUAL_STACK_ALLOCATOR_FOR_SCRIPT_VM 0'])
      assert(defines.includes(expected), `${module}: ${expected}`);
    if (['Launch', 'Engine', 'UEWebEngine'].includes(module)) {
      assert(defines.includes('#define ENABLE_RHI_VALIDATION 0'),
        `${module}: Web RHI validation must be consistently disabled`);
    }
    report.units.push({module, source: audit(source), original: audit(original),
      object: audit(object), response: audit(response), definitions: audit(definitions), log,
      origin: relative ? (targetBranch ? 'target-5.8.3' : 'installed-5.8.0') : 'test-program'});
    console.log(`P3_ENGINE_UNIT_OK ${module}/${path.basename(source)}`);
  }
  const launch = report.units.find(unit => unit.source.file.endsWith('LaunchEngineLoop.cpp'));
  const nm = path.join(process.env.WEB_EMSDK_ROOT || path.join(root, '.tools/emsdk'), 'upstream/bin/llvm-nm.exe');
  const entry = report.units.find(unit => unit.module === 'UEWebEngine');
  const entrySymbols = cp.spawnSync(nm, ['--defined-only', '-C', entry.object.file],
    {encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.ifError(entrySymbols.error);
  assert.equal(entrySymbols.status, 0, entrySymbols.stderr);
  for (const symbol of ['FMemory_Malloc(unsigned long, unsigned long)', 'FMemory_Free(void*)',
    'IMPLEMENT_MODULE_UEWebEngine'])
    assert(entrySymbols.stdout.includes(symbol), `Standard application entry defines ${symbol}`);
  const entrySymbolsFile = path.join(__dirname, 'results/web-engine-entry-symbols.log');
  fs.writeFileSync(entrySymbolsFile, entrySymbols.stdout);
  report.entryPointSymbols = audit(entrySymbolsFile);
  report.applicationModuleBoilerplateVerified = true;
  const symbols = cp.spawnSync(nm, ['--defined-only', '-C', launch.object.file],
    {encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.ifError(symbols.error);
  assert.equal(symbols.status, 0, symbols.stderr);
  for (const method of ['PreInit', 'Init', 'Tick', 'Exit'])
    assert(new RegExp(`\\bT FEngineLoop::${method}\\(`).test(symbols.stdout), `FEngineLoop::${method} definition`);
  const undefined = cp.spawnSync(nm, ['--undefined-only', '-C', launch.object.file],
    {encoding: 'utf8', timeout: 30000, windowsHide: true});
  assert.ifError(undefined.error);
  assert.equal(undefined.status, 0, undefined.stderr);
  assert(!/FOodleDataCompression::/.test(undefined.stdout));
  const symbolsFile = path.join(__dirname, 'results/web-engine-launch-symbols.log');
  fs.writeFileSync(symbolsFile, symbols.stdout + '\nUNDEFINED\n' + undefined.stdout);
  const tagTrace = path.join(host, 'Source/Runtime/Core/Private/ProfilingDebugging/TagTrace.cpp');
  const tagTraceObject = path.join(intermediate, 'Core/TagTrace.cpp.o');
  fs.rmSync(tagTraceObject, {force: true});
  const tagTraceLog = run([`-SingleFile=${tagTrace}`], 'web-engine-TagTrace-compile.log');
  assert(fs.readFileSync(tagTraceLog.file, 'utf8').includes('Web C++ TagTrace.cpp'));
  assert(fs.readFileSync(tagTraceObject).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
  assert(fs.readFileSync(tagTraceObject + '.rsp', 'utf8').includes('-m64'));
  report.lowLevelMemoryTrackerExcluded = fs.readFileSync(path.join(target,
    'Platforms/Web/Source/Runtime/Core/Public/Web/WebPlatform.h'), 'utf8').includes('#define PLATFORM_SUPPORTS_LLM 0');
  report.lowLevelMemoryTrackerCompileCheck = {source: audit(tagTrace),
    original: audit(path.join(target, 'Source/Runtime/Core/Private/ProfilingDebugging/TagTrace.cpp')),
    object: audit(tagTraceObject), response: audit(tagTraceObject + '.rsp'), log: tagTraceLog};
  assert.equal(report.lowLevelMemoryTrackerCompileCheck.source.sha256,
    report.lowLevelMemoryTrackerCompileCheck.original.sha256);
  assert(report.lowLevelMemoryTrackerExcluded);
  const validationSource = path.join(host, 'Source/Runtime/RHI/Private/RHIValidation.cpp');
  const validationObject = path.join(intermediate, 'RHI/RHIValidation.cpp.o');
  fs.rmSync(validationObject, {force: true});
  const validationLog = run([`-SingleFile=${validationSource}`], 'web-engine-RHIValidation-compile.log');
  assert(fs.readFileSync(validationLog.file, 'utf8').includes('Web C++ RHIValidation.cpp'));
  assert(fs.readFileSync(validationObject).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
  const validationDefinitions = path.join(intermediate, 'RHI/Definitions.h');
  assert(fs.readFileSync(validationDefinitions, 'utf8').includes('#define ENABLE_RHI_VALIDATION 0'));
  const validationSymbols = cp.spawnSync(nm, ['--defined-only', '-C', validationObject],
    {encoding: 'utf8', timeout: 30000, windowsHide: true});
  assert.ifError(validationSymbols.error);
  assert.equal(validationSymbols.status, 0, validationSymbols.stderr);
  assert(!/FRHIValidation::|FValidationRHI::|RHIValidation::/.test(validationSymbols.stdout));
  report.rhiValidationExcluded = true;
  report.rhiValidationCompileCheck = {source: audit(validationSource),
    original: audit(path.join(installed, 'Source/Runtime/RHI/Private/RHIValidation.cpp')),
    object: audit(validationObject), response: audit(validationObject + '.rsp'),
    definitions: audit(validationDefinitions), log: validationLog};
  assert.equal(report.rhiValidationCompileCheck.source.sha256,
    report.rhiValidationCompileCheck.original.sha256);
  const copiedAudit = ['Runtime/Launch', 'Runtime/CoreUObject', 'Runtime/Experimental/ChaosCore'].flatMap(module =>
    files(path.join(target, 'Source', module)).map(file => {
      const copied = path.join(host, path.relative(target, file));
      assert.equal(sha(file), sha(copied));
      return {...audit(file), copied, copiedSha256: sha(copied)};
    }));
  const sourceFiles = [__filename, path.join(__dirname, 'prepare-web-core-host.ps1'),
    path.join(target, 'Source/Runtime/Core/Public/Math/UnrealMathFPU.h'),
    path.join(host, 'Source/Runtime/Core/Public/Math/UnrealMathFPU.h'),
    path.join(target, 'Source/Runtime/Engine/Private/SparseVolumeTexture/SparseVolumeTextureData.cpp'),
    path.join(host, 'Source/Runtime/Engine/Private/SparseVolumeTexture/SparseVolumeTextureData.cpp'),
    path.join(target, 'Source/Runtime/MovieSceneTracks/Private/Sections/MovieSceneSkeletalAnimationSection.cpp'),
    path.join(host, 'Source/Runtime/MovieSceneTracks/Private/Sections/MovieSceneSkeletalAnimationSection.cpp'),
    path.join(target, 'Source/Runtime/RenderCore/Private/ShaderLibrary/ShaderCodeArchive.cpp'),
    path.join(host, 'Source/Runtime/RenderCore/Private/ShaderLibrary/ShaderCodeArchive.cpp'),
    path.join(target, 'Source/Runtime/Renderer/Private/SceneCulling/SceneCullingRenderer.cpp'),
    path.join(host, 'Source/Runtime/Renderer/Private/SceneCulling/SceneCullingRenderer.cpp'),
    path.join(target, 'Source/Runtime/SignalProcessing/Private/FloatArrayMath.cpp'),
    path.join(host, 'Source/Runtime/SignalProcessing/Private/FloatArrayMath.cpp'),
    ...['PreprocessedFontGeometry.cpp', 'SlateSdfGenerator.cpp', 'FontCache.cpp'].flatMap(name =>
      [target, host].map(engine => path.join(engine, 'Source/Runtime/SlateCore/Private/Fonts', name))),
    path.join(target, 'Source/Runtime/Slate/Private/Framework/Animation/AttributeInterpolator.cpp'),
    path.join(host, 'Source/Runtime/Slate/Private/Framework/Animation/AttributeInterpolator.cpp'),
    path.join(target, 'Source/Runtime/Slate/Public/Framework/Text/Web/WebPlatformTextField.h'),
    path.join(host, 'Source/Runtime/Slate/Public/Framework/Text/Web/WebPlatformTextField.h'),
    ...['SlateApplication.cpp', 'SlateUser.cpp'].flatMap(name =>
      [target, host].map(engine => path.join(engine, 'Source/Runtime/Slate/Private/Framework/Application', name))),
    ...['ICMP/Private/UDPPing.cpp', 'BuildPatchServices/Private/Installer/Verifier.cpp'].flatMap(name =>
      [target, host].map(engine => path.join(engine, 'Source/Runtime/Online', name))),
    ...['blake3.c', 'blake3_dispatch.c', 'blake3_portable.c', 'blake3.h', 'blake3_impl.h'].map(name =>
      path.join(target, 'Source/ThirdParty/BLAKE3/1.3.1/c', name)),
    ...fs.readdirSync(path.join(target, 'Source/ThirdParty/libPNG/libPNG-1.6.44'))
      .filter(name => /\.(?:c|h)$/.test(name) && !['example.c', 'pngtest.c'].includes(name))
      .map(name => path.join(target, 'Source/ThirdParty/libPNG/libPNG-1.6.44', name)),
    ...['UEWebEngine.Target.cs', 'UEWebApplication.Target.cs', 'UEWebSmoke.Target.cs',
      'UEWebEngine/UEWebEngine.Build.cs', 'UEWebEngine/Private/UEWebEngine.cpp'].map(file =>
      path.join(root, 'tests/ue-web-smoke/Source', file)),
    ...files(path.join(target, 'Platforms/Web')),
    path.join(host, 'Programs/UnrealHeaderTool/Config/DefaultEngine.ini')].map(audit);
  assert.equal(sha(path.join(installed, 'Programs/UnrealHeaderTool/Config/DefaultEngine.ini')),
    sourceFiles.at(-1).sha256);
  Object.assign(report, {pass: true, engineTargetActionGraphGenerated: true,
    uhtCodeGenerationVerified: true, launchEngineLoopWasmCompiled: true,
    scriptVMSourceWasmCompiled: true, gameEngineSourceWasmCompiled: true,
    preshader2SourceWasmCompiled: true,
    cpuSkinSourceWasmCompiled: true,
    inputCoreSourceWasmCompiled: true,
    inputCorePlatformSourceWasmCompiled: true,
    realEngineLoopMethodDefinitionsVerified: true, oodleStartupReferenceExcluded: true,
    ubt: audit(ubt), actions: audit(actionsFile), outdatedActionCount: actions.length,
    actionGraphContainsOutdatedActionsOnly: true, manifest: audit(manifestFile),
    generatedAudit, copiedAudit, sourceFiles, symbols: audit(symbolsFile),
    boundary: 'Normal UBT Engine-enabled Program Target generates reflection code and freshly compiles ten selected translation units, including real Launch/FEngineLoop, ScriptCore, UObjectBase, GameEngine, Preshader2, SkeletalRenderCPUSkin, InputCoreTypes, WebPlatformInput and the browser entry. Defined wasm64 symbols include FEngineLoop PreInit/Init/Tick/Exit. This is selected-object compilation, not a complete Engine build, a successful executable link, browser Engine initialization, ticking, rendering, Cook or scene execution. Core/TraceLog/ApplicationCore/CoreUObject/Launch/ChaosCore, Preshader2 and SparseVolumeTextureData use target 5.8.3 copies; WebPlatformInput is the new Web implementation. The remaining Engine sources are a local installed-5.8.0 copy. UBT, GameEngine, SkeletalRenderCPUSkin, original InputCore sources, most dependencies, shaders and UHT configuration still use installed 5.8.0. The exported graph contains outdated actions only; counts do not measure feature completion.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(__dirname, 'results/web-engine-target-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, compiledUnits: report.units?.length,
  engineTargetBuildSucceeded: false, launchRuntimeVerified: false, failure: report.failure}, null, 2));
process.exitCode = report.pass ? 0 : 1;
