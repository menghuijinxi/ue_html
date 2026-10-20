const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');
const build = path.join(__dirname, 'build/web-core-types');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {pass: false, date: '2026-10-15', architecture: 'wasm64',
  targetCoreSourceVersion: '5.8.3', coreModuleWasmCompiled: false, completeBrowserUERuntime: false};
(async () => {
  let browser;
  try {
    const expected = {pointerBytes: 8, sizeTBytes: 8, tcharBytes: 2, layoutBytes: 32, pass: true};
    const js = path.join(build, 'web-ubt-smoke.js');
    const wasm = path.join(build, 'web-ubt-smoke.wasm');
    const run = cp.spawnSync(process.execPath, [js], {encoding: 'utf8', timeout: 30000});
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const nodeResult = JSON.parse(run.stdout.split(/\r?\n/).find(line =>
      line.startsWith('P3_WEB_CORE_TYPES_RESULT ')).substring('P3_WEB_CORE_TYPES_RESULT '.length));
    assert.deepEqual(nodeResult, expected);
    const dependencies = fs.readFileSync(path.join(build, 'web-core-types.cpp.o.d'), 'utf8');
    for (const header of ['CoreTypes.h', 'GenericPlatform.h', 'HAL/Platform.h', 'WebPlatform.h'])
      assert(dependencies.replaceAll('\\', '/').includes(header));
    report.browserRuns = [];
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto('http://127.0.0.1:8765/web-core-types.html');
      await page.waitForFunction(() => !!globalThis.__webCoreTypesReport, null, {timeout: 30000});
      const result = await page.evaluate(() => ({
        types: globalThis.__webCoreTypesReport,
        highPointerValue: Module._WebCorePointerRoundTrip(0x100000010n).toString(16)
      }));
      assert.deepEqual(result, {types: expected, highPointerValue: '100000021'});
      assert.deepEqual(errors, []);
      report.browserRuns.push({browser: name, version: browser.version(), ...result, errors, pass: true});
      await browser.close();
      browser = null;
    }
    const sourceFiles = [
      'tests/web-platform/web-core-types.cpp',
      'reference-engine/Engine/Source/Runtime/Core/Public/CoreTypes.h',
      'reference-engine/Engine/Source/Runtime/Core/Public/HAL/Platform.h',
      'reference-engine/Engine/Source/Runtime/Core/Public/GenericPlatform/GenericPlatform.h',
      'reference-engine/Engine/Platforms/Web/Source/Runtime/Core/Public/Web/WebPlatform.h',
      'reference-engine/Engine/Platforms/Web/Source/Runtime/Core/Public/Web/WebPlatformCompilerPreSetup.h',
      'reference-engine/Engine/Platforms/Web/Source/Runtime/Core/Public/Web/WebPlatformCompilerSetup.h'
    ].map(relative => { const file = path.join(root, relative); return {file, sha256: sha(file)}; });
    const ubt = path.join(root, '.tools/ue58-web-build-host/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll');
    Object.assign(report, {pass: true, realCoreTypeHeadersWasmVerified: true, nodeResult,
      highPointerRoundTripVerified: true, wasmFile: wasm, wasmSha256: sha(wasm),
      ubt, ubtSha256: sha(ubt), sourceFiles,
      boundary: 'A diagnostic UBT mode compiles and links a small executable against actual target-branch UE CoreTypes/HAL/GenericPlatform headers and the Web type headers. Node/Chrome/Edge verify pointer width, TCHAR width, C++ struct layout and a 64-bit integer round trip. No Core library translation units or platform services are linked; this is not a Core module or UE runtime startup.'});
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-core-types-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
