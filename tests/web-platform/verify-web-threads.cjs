const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {pass: false, date: new Date().toISOString(), browserRuns: [],
  fullEngineThreaded: false, renderingThreadSeparated: false};
const buildFile = path.join(__dirname, 'results/web-threads-build-results.json');
const url = 'http://127.0.0.1:8765/web-threads.html';

(async () => {
  let browser;
  try {
    const build = JSON.parse(fs.readFileSync(buildFile, 'utf8').replace(/^\uFEFF/, ''));
    assert(build.pass && build.threaded);
    assert(build.products.every(valid) && build.sourceFiles.every(valid) && valid(build.linkResponse));
    assert(build.objects.length >= 500 && build.objects.every(item =>
      valid(item.object) && valid(item.response) && valid(item.definitions) && valid(item.source)));
    assert(build.platformCopies.length > 20 && build.platformCopies.every(item =>
      valid(item.source) && valid(item.copied) && item.source.sha256 === item.copied.sha256));
    assert(build.dependencies.length === 2 && build.dependencies.every(valid));
    const staged = path.join(__dirname, 'build/web-threads');
    fs.mkdirSync(staged, {recursive: true});
    for (const item of build.products) fs.copyFileSync(item.file, path.join(staged, path.basename(item.file)));
    report.staged = build.products.map(item => audit(path.join(staged, path.basename(item.file))));
    const singleDirectory = path.resolve(__dirname, '../ue-web-smoke/Binaries/Web');
    const singleOutput = path.join(__dirname, 'build/web-threads-single');
    fs.mkdirSync(singleOutput, {recursive: true});
    report.singleThreadProducts = ['UEWebSmoke.js', 'UEWebSmoke.wasm'].map(name => {
      const file = path.join(singleDirectory, name), copied = path.join(singleOutput, name);
      fs.copyFileSync(file, copied);
      assert.equal(sha(file), sha(copied));
      return audit(copied);
    });
    const singleRun = cp.spawnSync(process.execPath, [path.join(singleDirectory, 'UEWebSmoke.js')],
      {encoding: 'utf8', timeout: 30000, windowsHide: true});
    assert.ifError(singleRun.error);
    assert.equal(singleRun.status, 0, singleRun.stdout + singleRun.stderr);
    const singlePrefix = 'P3_WEB_CORE_PROGRAM_RESULT ';
    const singleExpected = {pointerBytes: 8, arraySum: 25188352, groups: 6, pass: true};
    assert.deepEqual(JSON.parse(singleRun.stdout.split(/\r?\n/).find(line =>
      line.startsWith(singlePrefix)).slice(singlePrefix.length)), singleExpected);
    report.singleThreadNode = singleExpected;
    report.dependencies = [];
    for (const library of ['blake3', 'libpng']) {
      const file = path.join(__dirname, `results/web-${library}-thread-build-results.json`);
      const dependency = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      assert(dependency.pass && dependency.threaded && valid(dependency.library) &&
        dependency.objects.every(valid) && dependency.sourceFiles.every(valid) && dependency.products.every(valid));
      const program = dependency.products.find(item => item.file.endsWith('.js')).file;
      let input, expected;
      if (library === 'blake3') {
        const vectorsFile = path.resolve(__dirname,
          '../../reference-engine/Engine/Source/ThirdParty/BLAKE3/1.3.1/test_vectors/test_vectors.json');
        const vectors = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'));
        const cases = vectors.cases.flatMap(item => ['hash', 'keyed_hash', 'derive_key'].flatMap((mode, index) =>
          [0, 97].map(split => ({length: item.input_len, mode: index, split, expected: item[mode]}))));
        expected = cases.map(item => item.expected);
        input = `const m = require(${JSON.stringify(program)});
          m.onRuntimeInitialized = () => console.log('P3_BLAKE3_VECTORS ' +
            JSON.stringify(${JSON.stringify(cases)}.map(c =>
              m.UTF8ToString(Number(m._WebBlake3Digest(c.length, c.mode, c.split))))));`;
        report.vectors = audit(vectorsFile);
      }
      const run = cp.spawnSync(process.execPath, input ? ['-'] : [program],
        {input, encoding: 'utf8', timeout: 30000, windowsHide: true});
      assert.ifError(run.error);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const prefix = library === 'blake3' ? 'P3_BLAKE3_VECTORS ' : 'P3_LIBPNG_RESULT ';
      const output = run.stdout.split(/\r?\n/).find(line => line.startsWith(prefix));
      assert(output, run.stdout + run.stderr);
      const result = JSON.parse(output.slice(prefix.length));
      if (expected) assert.deepEqual(result, expected);
      else assert(result.pass && result.cases === 4 && result.checks === 8);
      report.dependencies.push({library, report: audit(file),
        result: expected ? {pass: true, checks: expected.length} : result});
    }

    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('**/web-core-program.html', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: (await response.text()).replace(
          'build/web-core-program/UEWebSmoke.js', 'build/web-threads-single/UEWebSmoke.js')});
      });
      await page.goto('http://127.0.0.1:8765/web-core-program.html');
      await page.waitForFunction(() => globalThis.__webCoreProgramReport, null, {timeout: 30000});
      assert.deepEqual(await page.evaluate(() => __webCoreProgramReport), singleExpected);
      assert.equal(await page.evaluate(() => HEAPU8.buffer instanceof SharedArrayBuffer), false);
      report.browserRuns.push({browser: name, singleThreadCore: singleExpected, sharedMemory: false, pass: true});
      let workers = [];
      page.on('worker', worker => workers.push(worker.url()));
      for (let iteration = 0; iteration < 3; ++iteration) {
        workers = [];
        if (iteration === 0) await page.goto(url);
        else await page.reload();
        await page.waitForFunction(() =>
          (globalThis.__webThreadsResult && globalThis.__webThreadsExitCode !== undefined) || globalThis.__webThreadsFailure,
          null, {timeout: 60000});
        const state = await page.evaluate(() => ({
          result: globalThis.__webThreadsResult,
          memory: globalThis.__webThreadsMemory,
          exitCode: globalThis.__webThreadsExitCode,
          failure: globalThis.__webThreadsFailure || null
        }));
        assert.equal(state.failure, null, state.failure);
        assert.equal(state.exitCode, 0);
        const result = state.result;
        assert(result.pass, JSON.stringify(result));
        assert.equal(result.pointerBytes, 8);
        assert.equal(result.browserMainThread, false);
        assert.equal(result.groups, 17);
        assert.equal(result.checks.length, 17);
        assert(result.checks.every(check => check.pass));
        assert(result.isolated && state.memory.shared);
        assert(result.cores >= 2 && result.cores <= 4);
        assert.equal(new Set(result.runnableIds).size, 2);
        assert.equal(new Set(result.taskIds).size, 2);
        assert(result.heapAfter > result.heapBefore && result.currentMemoryBytes >= result.heapAfter);
        assert.equal(result.currentHeapViewBytes, result.currentMemoryBytes, 'UI HEAP view must refresh after shared memory growth');
        assert(result.runtimeHeartbeats >= 15, 'UI timer must keep running during engine Worker waits');
        assert(result.maxRuntimeHeartbeatMs < 250, 'UI timer stalled during threaded UE checks');
        assert(workers.length >= 3);
        assert.deepEqual(errors, []);
        report.browserRuns.push({browser: name, version: browser.version(), iteration,
          ...state, workers, errors: [...errors], pass: true});
        console.log(`${name} run ${iteration + 1}: ${result.groups} checks passed, workers=${workers.length}, UI max=${result.maxRuntimeHeartbeatMs.toFixed(1)}ms`);
      }

      const workerStarted = page.waitForEvent('worker', {timeout: 30000});
      await page.reload();
      await workerStarted;
      await page.close();
      const recovered = await context.newPage();
      const recoveryErrors = [];
      recovered.on('pageerror', error => recoveryErrors.push(error.message));
      recovered.on('console', message => { if (message.type() === 'error') recoveryErrors.push(message.text()); });
      await recovered.goto(url);
      await recovered.waitForFunction(() => globalThis.__webThreadsExitCode !== undefined ||
        globalThis.__webThreadsFailure, null, {timeout: 60000});
      assert.deepEqual(await recovered.evaluate(() => ({
        pass: __webThreadsResult?.pass, exit: __webThreadsExitCode, failure: globalThis.__webThreadsFailure || null
      })), {pass: true, exit: 0, failure: null});
      assert.deepEqual(recoveryErrors, []);
      report.browserRuns.push({browser: name, interruptedPageClosedAndRestarted: true, pass: true});

      const isolatedFailure = await context.newPage();
      await isolatedFailure.route('**/web-threads.html', async route => {
        const response = await route.fetch();
        const headers = {...response.headers()};
        delete headers['cross-origin-embedder-policy'];
        delete headers['cross-origin-opener-policy'];
        await route.fulfill({response, headers});
      });
      await isolatedFailure.goto(url);
      const missingIsolation = await isolatedFailure.evaluate(() => ({
        isolated: crossOriginIsolated, failure: globalThis.__webThreadsFailure || null
      }));
      assert(!missingIsolation.isolated && missingIsolation.failure?.includes('SharedArrayBuffer'));
      report.browserRuns.push({browser: name, missingIsolationRejected: true, pass: true});
      await browser.close();
      browser = null;
    }
    Object.assign(report, {pass: true, build: audit(buildFile),
      sourceFiles: [__filename, path.join(__dirname, 'web-threads.html')].map(audit),
      boundary: 'Independent wasm64 pthread Core Program, all link object responses audited for -pthread and target isolation. Actual UE runnable, events, TLS, lock contention, cooperative stop/join, concurrent allocator/shared memory growth, UE Tasks parallel workers/dependencies/batches and TaskGraph restart/shutdown are exercised. UI heartbeats, reload, interrupted page recovery and isolation rejection are covered in Chrome and Edge. This does not migrate the scene Engine loop, DOM/input, IO ownership or GPU object ownership; no scene FPS improvement is claimed.'});
  } catch (error) {
    report.failure = error.stack;
    console.error(error.stack);
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-threads-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, browserRuns: report.browserRuns.length, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
