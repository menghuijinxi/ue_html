const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');
const build = path.join(__dirname, 'build/web-ubt-smoke');
const reportFile = path.join(__dirname, 'results/web-ubt-results.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ubt = path.join(root, '.tools/ue58-web-build-host/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll');
const dotnet = path.join(process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine',
  'Binaries/ThirdParty/DotNet/10.0/win-x64/dotnet.exe');
const report = {pass: false, date: '2026-10-15', targetEngineVersion: '5.8.3',
  ubtSourceEngineVersion: '5.8.0', completeUEBuildTargetTested: false,
  coreModuleWasmCompiled: false, completeBrowserUERuntime: false};

(async () => {
  let browser;
  try {
    const actionsFile = path.join(build, 'actions.json');
    const actions = JSON.parse(fs.readFileSync(actionsFile, 'utf8')).Actions;
    assert.equal(actions.length, 3);
    assert.deepEqual(actions.map(action => action.CommandDescription), ['Web C++', 'Web Archive', 'Web Link']);
    assert(actions.every(action => action.CommandVersion === '6.0.9' &&
      action.bCanExecuteRemotely === false && action.bCanExecuteInUBA === false));
    assert(actions[1].PrerequisiteActions.includes(actions[0].Id) &&
      actions[2].PrerequisiteActions.includes(actions[1].Id));
    const compileResponse = fs.readFileSync(path.join(build, 'web-ubt-smoke.cpp.o.rsp'), 'utf8');
    assert(compileResponse.includes('-D"PLATFORM_WEB=1"') && compileResponse.includes('-std=c++20') &&
      compileResponse.includes('-m64') && !compileResponse.includes('PLATFORM_64BITS='));
    const dependencies = fs.readFileSync(actions[0].DependencyListFile, 'utf8').replace(/\\\r?\n/g, '');
    assert(actions[0].ProducedItems.includes(actions[0].DependencyListFile) &&
      dependencies.includes('web-ubt-smoke.cpp') && /[\\/]c\+\+[\\/]v1[\\/]vector/.test(dependencies));
    const wasmFile = path.join(build, 'web-ubt-smoke.wasm');
    const bytes = fs.readFileSync(wasmFile);
    assert(WebAssembly.validate(bytes) && bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
    const run = cp.spawnSync(process.execPath, [path.join(build, 'web-ubt-smoke.js')],
      {encoding: 'utf8', timeout: 30000});
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const nodeResult = JSON.parse(run.stdout.split(/\r?\n/).find(line =>
      line.startsWith('P3_WEB_UBT_RESULT ')).substring('P3_WEB_UBT_RESULT '.length));
    assert.deepEqual(nodeResult, {pointerBytes: 8, checksum: 15550, pass: true});
    const missingSDK = cp.spawnSync(dotnet, [ubt, '-Mode=WebToolchainSmoke',
      `-Source=${path.join(__dirname, 'web-ubt-smoke.cpp')}`, `-Output=${path.join(build, 'missing-sdk')}`],
      {encoding: 'utf8', timeout: 30000, env: {...process.env, WEB_EMSDK_ROOT: path.join(build, 'absent-sdk')}});
    assert.ifError(missingSDK.error);
    assert.notEqual(missingSDK.status, 0);
    assert((missingSDK.stdout + missingSDK.stderr).includes('Web SDK validation failed.'));
    fs.writeFileSync(path.join(__dirname, 'results/web-ubt-missing-sdk.log'),
      missingSDK.stdout + missingSDK.stderr);
    report.browserRuns = [];
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto('http://127.0.0.1:8765/web-ubt-smoke.html');
      await page.waitForFunction(() => !!globalThis.__webUbtReport, null, {timeout: 30000});
      const result = await page.evaluate(() => ({
        report: globalThis.__webUbtReport, exportedChecksum: Module._WebToolchainChecksum(7)
      }));
      assert.deepEqual(result, {report: nodeResult, exportedChecksum: 112});
      assert.deepEqual(errors, []);
      report.browserRuns.push({browser: name, version: browser.version(), ...result, errors, pass: true});
      await browser.close();
      browser = null;
    }
    const sourceRoot = path.join(root, 'reference-engine/Engine/Platforms/Web');
    const sourceFiles = fs.readdirSync(sourceRoot, {recursive: true, withFileTypes: true})
      .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
    Object.assign(report, {pass: true, webPlatformRegistered: true,
      sdkVersion: '6.0.9', architecture: 'wasm64', missingSdkRejected: true, compileArchiveLinkActionsVerified: true,
      compilerHeaderDependenciesRecorded: true,
      wasmExecutableVerified: true, nodeResult, actionsFile, actionsSha256: sha(actionsFile),
      ubt, ubtSha256: sha(ubt), wasmFile, wasmSha256: sha(wasmFile),
      sourceFiles: sourceFiles.map(file => ({file, sha256: sha(file)})),
      boundary: 'An isolated build of the installed UE 5.8.0 UBT sources includes the target branch Web platform extension. A diagnostic UBT mode registers Web/wasm64 and executes real UEToolChain compile/archive/link actions through the normal action executor. The standard C++/libc++ WASM runs in Node, Chrome and Edge. This test does not build a normal Target module graph or UE Runtime. Initial Core platform type headers are tested separately; Core services, ApplicationCore, Launch, RHI, Cook and a UE scene remain incomplete.'});
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
