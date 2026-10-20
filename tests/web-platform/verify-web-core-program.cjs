const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64',
  completeBrowserUERuntime: false, launchRuntimeVerified: false};
(async () => {
  let browser;
  try {
    const target = JSON.parse(fs.readFileSync(path.join(__dirname, 'results/web-core-target-diagnostic.json'), 'utf8'));
    assert(target.diagnosticVerified && target.buildSucceeded && target.ordinaryProgramLinked);
    assert.equal(target.jsSha256, sha(target.jsFile));
    assert.equal(target.wasmSha256, sha(target.wasmFile));
    const staged = path.join(__dirname, 'build/web-core-program');
    fs.mkdirSync(staged, {recursive: true});
    for (const file of [target.jsFile, target.wasmFile])
      fs.copyFileSync(file, path.join(staged, path.basename(file)));
    const run = cp.spawnSync(process.execPath, [target.jsFile], {encoding: 'utf8', timeout: 30000});
    fs.writeFileSync(path.join(__dirname, 'results/web-core-program-node.log'), (run.stdout || '') + (run.stderr || ''));
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stderr, '');
    const prefix = 'P3_WEB_CORE_PROGRAM_RESULT ';
    const lines = run.stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
    assert.equal(lines.length, 1);
    const nodeResult = JSON.parse(lines[0].slice(prefix.length));
    const expected = {pointerBytes: 8, arraySum: 25188352, groups: 6, pass: true};
    assert.deepEqual(nodeResult, expected);
    report.browserRuns = [];
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto('http://127.0.0.1:8765/web-core-program.html');
      await page.waitForFunction(() => globalThis.__webCoreProgramReport || globalThis.__webCoreProgramFailure,
        null, {timeout: 30000});
      const result = await page.evaluate(() => ({
        program: globalThis.__webCoreProgramReport,
        failure: globalThis.__webCoreProgramFailure || null
      }));
      assert.deepEqual(result, {program: expected, failure: null});
      assert.deepEqual(errors, []);
      report.browserRuns.push({browser: name, version: browser.version(), ...result, errors, pass: true});
      await browser.close();
      browser = null;
    }
    Object.assign(report, {pass: true, nodeResult, ordinaryProgramLinkedAndExecuted: true,
      realUEArrayAllocationAndReleaseVerified: true, jsFile: target.jsFile, jsSha256: sha(target.jsFile),
      realUEFileIOVerified: true, alignedReallocationVerified: true,
      registerTransformFPUVerified: true,
      arithmeticShiftFPUVerified: true,
      wasmFile: target.wasmFile, wasmSha256: sha(target.wasmFile),
      stagedFiles: [target.jsFile, target.wasmFile].map(file => {
        const copied = path.join(staged, path.basename(file));
        assert.equal(sha(file), sha(copied));
        return {file: copied, sha256: sha(copied)};
      }),
      sourceFiles: ['web-core-program.html', 'verify-web-core-program.cjs'].map(name => {
        const file = path.join(__dirname, name);
        return {file, sha256: sha(file)};
      }),
      boundary: 'The ordinary Core-only UE Program is built by normal UBT Target mode, then runs in Node, Chrome and Edge. It grows a real TArray to 4096 elements, reserves/removes/shrinks/frees storage, verifies 64-byte-aligned reallocation with preserved contents, allocates/frees 64KiB-aligned pages through libc, and uses UE Unix file IO over Emscripten MEMFS for a Unicode filename, binary write/flush/read/rename/delete. Register-based FPU transforms cover float/double rotation, scale, inverse and composition; arithmetic shifts cover signed lanes at 0/1/31/32/255 bits. This does not start ApplicationCore, Launch, Engine, Renderer, Cook or a scene. Persistent storage, asynchronous mounting, mapped files, competing file access, UE worker threads and allocator failure paths require separate verification.'});
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-core-program-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
