const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');
const build = path.join(__dirname, 'build/web-core-services');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64', singleThreaded: true,
  coreModuleWasmCompiled: false, ordinaryProgramLinked: false, completeBrowserUERuntime: false};
(async () => {
  let browser;
  try {
    const core = JSON.parse(fs.readFileSync(path.join(__dirname, 'results/web-core-target-diagnostic.json'), 'utf8'));
    assert.equal(core.diagnosticVerified, true);
    const compiledCoreObject = core.compiledUnits.find(unit => unit.source.endsWith('GenericPlatformStricmp.cpp'));
    assert(compiledCoreObject?.compiled && compiledCoreObject.objectSha256 === sha(compiledCoreObject.object));
    const archiveResponse = path.join(build, 'web-ubt-smoke.a.rsp');
    assert(fs.readFileSync(archiveResponse, 'utf8').includes(compiledCoreObject.object.replaceAll('\\', '/')));
    const linkResponse = path.join(build, 'web-ubt-smoke.js.rsp');
    assert(fs.readFileSync(linkResponse, 'utf8').includes('--use-port=zlib'));
    const expected = {pointerBytes: 8, int128Alignment: 16, groups: 7, pass: true, zlibVersion: '1.3.2'};
    const js = path.join(build, 'web-ubt-smoke.js');
    const wasmFile = path.join(build, 'web-ubt-smoke.wasm');
    const run = cp.spawnSync(process.execPath, [js], {encoding: 'utf8', timeout: 30000});
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const prefix = 'P3_WEB_CORE_SERVICES_RESULT ';
    const nodeResult = JSON.parse(run.stdout.split(/\r?\n/).find(line => line.startsWith(prefix)).slice(prefix.length));
    assert.deepEqual(nodeResult, expected);
    const dependencies = fs.readFileSync(path.join(build, 'web-core-services.cpp.o.d'), 'utf8').replaceAll('\\', '/');
    for (const header of ['WebPlatformString.h', 'WebPlatformAtomics.h', 'WebPlatformMemory.h',
      'WebPlatformMath.h', 'WebPlatformTLS.h', 'WebPlatformMutex.h'])
      assert(dependencies.includes(header), `Missing dependency: ${header}`);
    report.browserRuns = [];
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto('http://127.0.0.1:8765/web-core-services.html');
      await page.waitForFunction(() => !!globalThis.__webCoreServicesReport, null, {timeout: 30000});
      const result = await page.evaluate(() => ({
        services: globalThis.__webCoreServicesReport,
        highAtomicValue: Module._WebCoreAtomicRoundTrip(0x100000010n).toString(16)
      }));
      assert.deepEqual(result, {services: expected, highAtomicValue: '100000021'});
      assert.deepEqual(errors, []);
      report.browserRuns.push({browser: name, version: browser.version(), ...result, errors, pass: true});
      await browser.close();
      browser = null;
    }
    const platformRoot = path.join(root, 'reference-engine/Engine/Platforms/Web');
    const files = fs.readdirSync(platformRoot, {recursive: true, withFileTypes: true})
      .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
    files.push(path.join(__dirname, 'web-core-services.cpp'),
      path.join(__dirname, 'web-core-services.html'),
      path.join(root, 'reference-engine/Engine/Source/Runtime/Core/Private/GenericPlatform/GenericPlatformStricmp.cpp'),
      path.join(root, 'reference-engine/Engine/Source/Runtime/Core/Public/GenericPlatform/GenericPlatformProcess.h'),
      path.join(root, 'reference-engine/Engine/Source/Runtime/TraceLog/Public/Trace/Detail/Channel.inl'),
      path.join(root, '.tools/emsdk/upstream/emscripten/tools/ports/zlib.py'));
    Object.assign(report, {pass: true, realCoreStringObjectLinkedAndExecuted: true, nodeResult,
      compiledCoreObject, ubt: core.ubt, ubtSha256: sha(core.ubt), wasmFile, wasmSha256: sha(wasmFile),
      archiveResponse, archiveResponseSha256: sha(archiveResponse), linkResponse, linkResponseSha256: sha(linkResponse),
      sourceFiles: files.map(file => ({file, sha256: sha(file)})),
      groups: ['strings', 'atomics', 'memory', 'math', 'tls', 'recursive-mutex', 'zlib'],
      boundary: 'The sample links the actual target-branch GenericPlatformStricmp object produced by normal UBT Target compilation, plus a diagnostic entry. Its Core-module and ordinary-Program fields describe this diagnostic sample only. Node/Chrome/Edge execute UE string comparisons, UTF-16 lengths, format macros, 32/64-bit atomic operations, 16-byte FInt128 alignment, overlapping memory moves, math, TLS slots and a recursive pthread mutex. FInt128 alignment does not enable 128-bit atomics. OS virtual-memory blocks remain disabled; a sampled linear-memory pointer leaves the high marker bit clear. zlib 1.3 headers from the installed engine link against the Emscripten 6.0.9 zlib 1.3.2 port; round trip and corrupt-data rejection pass. This diagnostic is single-threaded and does not itself exercise UE allocation or the ordinary Program; those are verified separately in web-core-program-results.json. Complete string conversion/formatting, shared mutex contention, blocking events, working UE threads, full compression runtime and complete Core startup remain unverified.'});
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-core-services-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
