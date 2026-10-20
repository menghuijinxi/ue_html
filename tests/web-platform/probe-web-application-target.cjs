const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const host = path.join(root, '.tools/ue58-web-build-host/Engine');
const target = path.join(root, 'reference-engine/Engine');
const engine = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
function files(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(item =>
    item.isDirectory() ? files(path.join(dir, item.name)) : [path.join(dir, item.name)]);
}
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64',
  launchRuntimeVerified: false, completeBrowserUERuntime: false};
try {
  const ubt = path.join(host, 'Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll');
  const intermediate = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebApplication/Development');
  const args = [ubt, 'UEWebApplication', 'Web', 'Development',
    `-Project=${path.join(root, 'tests/ue-web-smoke/UEWebSmoke.uproject')}`,
    '-NoUBA', '-MaxParallelActions=2', '-NoUBTMakefiles'];
  const dotnet = path.join(engine, 'Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe');
  const entry = path.join(intermediate, 'UEWebApplication/UEWebApplication.cpp.o');
  fs.rmSync(entry, {force: true});
  const run = cp.spawnSync(dotnet, args,
    {encoding: 'utf8', timeout: 600000, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  const log = (run.stdout || '') + (run.stderr || '');
  const logFile = path.join(__dirname, 'results/web-application-build.log');
  fs.writeFileSync(logFile, log);
  assert.ifError(run.error);
  assert.equal(run.status, 0, log);
  assert(log.includes('Web Link UEWebApplication.js') && log.includes('Result: Succeeded'));
  const jsFile = path.join(root, 'tests/ue-web-smoke/Binaries/Web/UEWebApplication.js');
  const wasmFile = jsFile.replace(/\.js$/, '.wasm');
  assert(WebAssembly.validate(fs.readFileSync(wasmFile)));
  const module = 'Source/Runtime/ApplicationCore';
  const sourceAudit = files(path.join(target, module)).map(file => {
    const copied = path.join(host, path.relative(target, file));
    assert.equal(sha(copied), sha(file));
    return {...audit(file), copied, copiedSha256: sha(copied)};
  });
  const platformAudit = files(path.join(target, 'Platforms/Web/Source/Runtime/ApplicationCore')).map(file => {
    const copied = path.join(host, path.relative(target, file));
    assert.equal(sha(copied), sha(file));
    return {...audit(file), copied, copiedSha256: sha(copied)};
  });
  const objectAudit = files(path.join(intermediate, 'ApplicationCore')).filter(file => file.endsWith('.cpp.o')).map(file => {
    assert(fs.readFileSync(file).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
    const response = file + '.rsp';
    assert(fs.readFileSync(response, 'utf8').includes('-m64'));
    return {...audit(file), response, responseSha256: sha(response)};
  });
  for (const name of ['WebApplication.cpp.o', 'GenericApplication.cpp.o',
    'GenericWindow.cpp.o', 'GenericPlatformApplicationMisc.cpp.o'])
    assert(objectAudit.some(item => path.basename(item.file) === name));
  const linkResponse = path.join(intermediate, 'UEWebApplication.js.rsp');
  assert(fs.readFileSync(linkResponse, 'utf8').includes('-m64'));
  Object.assign(report, {pass: true, buildSucceeded: true, exitCode: run.status,
    ubt, ubtSha256: sha(ubt), logFile, logSha256: sha(logFile),
    jsFile, jsSha256: sha(jsFile), wasmFile, wasmSha256: sha(wasmFile),
    linkResponse, linkResponseSha256: sha(linkResponse), sourceAudit, platformAudit, objectAudit,
    sourceFiles: [
      path.join(root, 'tests/ue-web-smoke/Source/UEWebApplication.Target.cs'),
      path.join(root, 'tests/ue-web-smoke/Source/UEWebSmoke.Target.cs'),
      ...files(path.join(root, 'tests/ue-web-smoke/Source/UEWebApplication')),
      path.join(__dirname, 'prepare-web-core-host.ps1'),
      __filename
    ].map(audit),
    boundary: 'Normal UBT Program Target links target-branch 5.8.3 Core, TraceLog, ApplicationCore and AtomicQueue. UBT, other dependencies and build metadata still come from the installed 5.8.0 engine. This is not a Launch, FEngineLoop, Engine or Renderer build. Object counts are audit evidence, not a feature completion percentage.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(__dirname, 'results/web-application-target-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, buildSucceeded: report.buildSucceeded,
  objectCount: report.objectAudit?.length, failure: report.failure}, null, 2));
process.exitCode = report.pass ? 0 : 1;
