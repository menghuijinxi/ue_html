const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const engine = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const ubt = path.join(root, '.tools/ue58-web-build-host/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll');
const project = path.join(root, 'tests/ue-web-smoke/UEWebSmoke.uproject');
const hostCore = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Core');
const targetCore = path.join(root, 'reference-engine/Engine/Source/Runtime/Core');
const actionsFile = path.join(__dirname, 'build/web-core-target/actions.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {date: '2026-10-15', diagnosticVerified: false, buildSucceeded: false,
  normalTargetRulesReached: false, coreModuleWasmCompiled: false, completeBrowserUERuntime: false};
try {
  const args = [ubt, 'UEWebSmoke', 'Web', 'Development', `-Project=${project}`,
    '-NoUBA', '-MaxParallelActions=2', '-NoUBTMakefiles'];
  const dotnet = path.join(engine, 'Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe');
  const intermediate = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebSmoke/Development');
  const entryObject = path.join(intermediate, 'UEWebSmoke/UEWebSmoke.cpp.o');
  if (fs.existsSync(entryObject)) fs.unlinkSync(entryObject);
  fs.mkdirSync(path.dirname(actionsFile), {recursive: true});
  const graph = cp.spawnSync(dotnet, [...args, `-WriteOutdatedActions=${actionsFile}`],
    {encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  fs.writeFileSync(path.join(__dirname, 'results/web-core-target-actions.log'), (graph.stdout || '') + (graph.stderr || ''));
  assert.ifError(graph.error);
  assert.equal(graph.status, 0, graph.stdout + graph.stderr);
  const actions = JSON.parse(fs.readFileSync(actionsFile, 'utf8')).Actions;
  const compileActions = actions.filter(action => action.Type === 'Compile');
  const coreActions = compileActions.filter(action => action.ProducedItems.some(file => /[\\/]Development[\\/]Core[\\/]/.test(file)));
  for (const action of compileActions) {
    const response = action.CommandArguments.match(/@"([^"]+)"/)?.[1];
    assert(response, 'Compiler response path missing');
    assert(fs.readFileSync(response, 'utf8').includes('-m64'));
  }
  const link = actions.find(action => action.CommandDescription === 'Web Link');
  assert(link);
  const linkResponse = link.CommandArguments.match(/@"([^"]+)"/)[1];
  const linkText = fs.readFileSync(linkResponse, 'utf8');
  assert(!/oo2core|OodleDataCompression[\\/]Sdks/i.test(linkText));
  assert(linkText.includes('--use-port=zlib'));
  assert(linkText.includes('-m64') && linkText.includes('-Wl,--error-limit=0'));
  const coreSources = [
    'GenericPlatform/GenericPlatformStricmp.cpp',
    'Misc/Compression.cpp',
    'Compression/CompressedBuffer.cpp',
    'HAL/MallocAnsi.cpp',
    'HAL/MemoryBase.cpp',
    'HAL/UnrealMemory.cpp',
    'Containers/ContainerAllocationPolicies.cpp',
    'GenericPlatform/GenericPlatformMemory.cpp',
    'GenericPlatform/GenericPlatformTime.cpp',
    'GenericPlatform/GenericWidePlatformString.cpp',
    'Misc/AssertionMacros.cpp',
    'GenericPlatform/GenericPlatformProcess.cpp',
    'GenericPlatform/GenericPlatformMisc.cpp',
    'HAL/PlatformAffinity.cpp',
    'GenericPlatform/GenericPlatformAtomics.cpp',
    'GenericPlatform/GenericPlatformOutputDevices.cpp',
    'Misc/App.cpp',
    'Memory/LinearAllocator.cpp',
    'HAL/PlatformMemory.cpp',
    'Async/ParkingLot.cpp',
    'Async/WordMutex.cpp',
    'Tasks/TaskConcurrencyLimiter.cpp',
    'Async/TransactionallySafeMutexPool.cpp'
  ];
  const units = coreSources.map(relative => ({source: path.join(hostCore, 'Private', relative),
    targetSource: path.join(targetCore, 'Private', relative), module: 'Core'}));
  const platformCoreSources = ['WebPlatformFile.cpp', 'WebPlatformMemory.cpp', 'WebPlatformProcess.cpp'];
  for (const name of platformCoreSources) {
    const relative = `Engine/Platforms/Web/Source/Runtime/Core/Private/Web/${name}`;
    units.push({source: path.join(root, '.tools/ue58-web-build-host', relative),
      targetSource: path.join(root, 'reference-engine', relative), module: 'Core'});
  }
  units.push({source: path.join(root, 'tests/ue-web-smoke/Source/UEWebSmoke/Private/UEWebSmoke.cpp'), module: 'UEWebSmoke'});
  const positiveLogFile = path.join(__dirname, 'results/web-core-source-compile.log');
  const positiveLogs = [];
  for (const unit of units) {
    // SingleFile accepts one source and otherwise reuses an up-to-date object.
    const object = path.join(intermediate, unit.module, path.basename(unit.source) + '.o');
    if (fs.existsSync(object)) fs.unlinkSync(object);
    const positive = cp.spawnSync(dotnet, [...args, `-SingleFile=${unit.source}`],
      {encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
    const positiveLog = (positive.stdout || '') + (positive.stderr || '');
    positiveLogs.push(positiveLog);
    fs.writeFileSync(positiveLogFile, positiveLogs.join('\n'));
    assert.ifError(positive.error);
    assert.equal(positive.status, 0, positiveLog);
    assert(positiveLog.includes('Result: Succeeded') &&
      positiveLog.includes(`Web C++ ${path.basename(unit.source)}`), positiveLog);
  }
  const compiledUnits = units.map(unit => {
    const object = path.join(intermediate, unit.module, path.basename(unit.source) + '.o');
    const bytes = fs.readFileSync(object);
    assert(bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])), `${object}: not a WASM object`);
    const response = object + '.rsp';
    const responseText = fs.readFileSync(response, 'utf8');
    assert(responseText.includes('-m64'));
    const targetSource = unit.targetSource || unit.source;
    assert.equal(sha(unit.source), sha(targetSource), 'Compiled source differs from the target branch');
    return {...unit, sourceSha256: sha(unit.source), targetSource, targetSourceSha256: sha(targetSource),
      object, objectSha256: sha(object),
      response, responseSha256: sha(response), compiled: true};
  });
  for (const name of ['Compression.cpp', 'CompressedBuffer.cpp']) {
    const compressionObject = compiledUnits.find(unit => path.basename(unit.source) === name).object;
    const nm = cp.spawnSync(path.join(root, '.tools/emsdk/upstream/bin/llvm-nm.exe'),
      ['--undefined-only', '--demangle', compressionObject], {encoding: 'utf8', timeout: 30000, windowsHide: true});
    assert.ifError(nm.error);
    assert.equal(nm.status, 0, nm.stderr);
    assert(!/FOodleDataCompression::(?!ECompressor|ECompressionLevel)[A-Za-z_]+/.test(nm.stdout));
  }
  const run = cp.spawnSync(dotnet, args,
    {encoding: 'utf8', timeout: 900000, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  const log = (run.stdout || '') + (run.stderr || '');
  const logFile = path.join(__dirname, 'results/web-ubt-core-target.log');
  fs.writeFileSync(logFile, log);
  assert.ifError(run.error);
  assert.equal(run.status, 0, log);
  assert(log.includes('Web Link UEWebSmoke.js') && log.includes('Result: Succeeded'), log);
  const errors = log.split(/\r?\n/).filter(line => /(?:fatal )?error:/.test(line));
  assert.deepEqual(errors, []);
  const jsFile = link.ProducedItems.find(file => file.endsWith('.js'));
  const wasmFile = link.ProducedItems.find(file => file.endsWith('.wasm'));
  assert(jsFile && wasmFile && fs.existsSync(jsFile) && WebAssembly.validate(fs.readFileSync(wasmFile)));
  const linkObjects = [...linkText.matchAll(/^"([^"\r\n]+\.o)"\r?$/gm)].map(match => {
    const object = match[1];
    assert(object.includes('/Web/wasm64/'), `Non-wasm64 input: ${object}`);
    assert(fs.readFileSync(object).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
    const response = object + '.rsp';
    assert(fs.readFileSync(response, 'utf8').includes('-m64'));
    return {object, objectSha256: sha(object), response, responseSha256: sha(response)};
  });
  assert(linkObjects.length > compiledUnits.length);
  const platformRoot = path.join(root, 'reference-engine/Engine/Platforms/Web');
  const platformFiles = fs.readdirSync(platformRoot, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile()).map(entry => {
      const source = path.join(entry.parentPath, entry.name);
      const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Platforms/Web',
        path.relative(platformRoot, source));
      assert.equal(sha(source), sha(copied), 'Platform overlay is stale');
      return {file: source, sha256: sha(source), copied, copiedSha256: sha(copied)};
    });
  const changedSources = ['Core.Build.cs', 'Private/Misc/Compression.cpp',
    'Private/Compression/CompressedBuffer.cpp', 'Private/Compression/OodleDataCompression.cpp',
    'Private/Compression/OodleDataCompressionFormat.cpp', 'Private/Compression/OodleDataCompressionUtil.cpp',
    'Public/HAL/Platform.h', 'Public/CoreTypes.h', 'Public/Math/UnrealMathFPU.h', 'Public/GenericPlatform/GenericPlatformProcess.h',
    'Private/Async/ParkingLot.cpp', 'Public/Async/TransactionallySafeMutexPool.h',
    'Public/Memory/VirtualStackAllocator.h', 'Private/Memory/VirtualStackAllocator.cpp',
    'Private/GenericPlatform/GenericPlatformProcess.cpp', 'Private/Unix/UnixPlatformFile.cpp'];
  const overlayFiles = changedSources.map(relative => {
    const source = path.join(targetCore, relative), copied = path.join(hostCore, relative);
    assert.equal(sha(source), sha(copied), 'Source overlay is stale');
    return {file: source, sha256: sha(source), copied, copiedSha256: sha(copied)};
  });
  for (const relative of ['Runtime/TraceLog/Public/Trace/Detail/Channel.inl',
    'Runtime/TraceLog/Private/Trace/Channel.cpp', 'Runtime/TraceLog/Private/Trace/Trace.cpp',
    'Runtime/TraceLog/Private/Trace/Lock.h',
    'ThirdParty/AtomicQueue/AtomicQueue.h']) {
    const source = path.join(root, 'reference-engine/Engine/Source', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source', relative);
    assert.equal(sha(source), sha(copied), 'Source overlay is stale');
    overlayFiles.push({file: source, sha256: sha(source), copied, copiedSha256: sha(copied)});
  }
  Object.assign(report, {diagnosticVerified: true, normalTargetRulesReached: true,
    exitCode: run.status, blocker: null, buildSucceeded: true, coreModuleWasmCompiled: true,
    undefinedSymbols: [], normalTargetCppCompilationReachedLink: true,
    ordinaryProgramLinked: true, linkObjects, linkObjectCount: linkObjects.length,
    jsFile, jsSha256: sha(jsFile), wasmFile, wasmSha256: sha(wasmFile),
    linkResponse, linkResponseSha256: sha(linkResponse), platformFiles,
    architecture: 'wasm64', normalTargetActionGraphGenerated: true,
    coreCppCompilationAttempted: true, totalActions: actions.length,
    coreCompileActions: coreActions.length, oodleLibraryDependencyExcluded: true,
    zlibPortLinkOptionResolved: true,
    actionGraphContainsOutdatedActionsOnly: true, compiledUnits, positiveLogFile,
    selectedCoreSources: coreSources, selectedPlatformCoreSources: platformCoreSources,
    selectedCoreObjectsCompiled: coreSources.length + platformCoreSources.length,
    positiveLogSha256: sha(positiveLogFile), coreSourceObjectsWasmCompiled: true,
    compressionWasmObjectHasNoOodleCodecReferences: true, minimalProgramSourceWasmCompiled: true,
    actionsFile, actionsSha256: sha(actionsFile), overlayFiles,
    ubt, ubtSha256: sha(ubt), logFile, logSha256: sha(logFile),
    args,
    coreSourceEngineVersion: '5.8.3', dependencySourceEngineVersion: '5.8.0',
    sourceFiles: [
      project,
      path.join(root, 'tests/ue-web-smoke/Source/UEWebSmoke.Target.cs'),
      path.join(root, 'tests/ue-web-smoke/Source/UEWebSmoke/UEWebSmoke.Build.cs'),
      path.join(root, 'tests/ue-web-smoke/Source/UEWebSmoke/Private/UEWebSmoke.cpp'),
      path.join(targetCore, 'Core.Build.cs'),
      path.join(targetCore, 'Private/Misc/Compression.cpp'),
      path.join(engine, 'Source/Runtime/OodleDataCompression/OodleDataCompression.Build.cs')
    ].map(file => ({file, sha256: sha(file)})),
    boundary: 'Normal UBT Build mode freshly compiles 23 selected target-branch Core sources, three Web platform implementations and the Program entry to wasm64 objects, then successfully links the monolithic Core-only Program. Core module compilation is verified for this target configuration; no standalone Core archive or full Engine/Launch runtime is claimed. Both compression objects have no undefined Oodle codec references. All link object inputs and compiler responses are audited as wasm64 and hashed; cached and disabled objects are not counted as runtime feature tests. Core, TraceLog and AtomicQueue use target-branch 5.8.3 sources; UBT and other dependencies use installed 5.8.0. The exported graph contains outdated actions only. Execution of the ordinary Program is verified separately.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(__dirname, 'results/web-core-target-diagnostic.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.diagnosticVerified ? 0 : 1;
