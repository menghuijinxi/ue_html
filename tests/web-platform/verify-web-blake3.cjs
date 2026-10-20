const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && item.sha256 === sha(item.file);
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64',
  completeBrowserUERuntime: false, browserRuns: []};

(async () => {
  let browser;
  try {
    const buildFile = path.join(__dirname, 'results/web-blake3-build-results.json');
    const build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
    assert(build.pass && build.portable && build.version === '1.3.1');
    assert(valid(build.library) && build.objects.length === 3 && build.objects.every(valid));
    assert(build.sourceFiles.every(valid) && build.products.every(valid));
    const vectorFile = path.resolve(__dirname,
      '../../reference-engine/Engine/Source/ThirdParty/BLAKE3/1.3.1/test_vectors/test_vectors.json');
    const vectors = JSON.parse(fs.readFileSync(vectorFile, 'utf8'));
    const cases = vectors.cases.flatMap(item => ['hash', 'keyed_hash', 'derive_key'].flatMap((mode, index) =>
      [0, 97].map(split => ({length: item.input_len, mode: index, split, expected: item[mode]}))));
    const jsFile = build.products.find(item => item.file.endsWith('.js')).file;
    const nodeScript = `
      const m = require(${JSON.stringify(jsFile)});
      m.onRuntimeInitialized = () => {
        const cases = ${JSON.stringify(cases)};
        const digests = cases.map(c => m.UTF8ToString(Number(m._WebBlake3Digest(c.length, c.mode, c.split))));
        console.log('P3_BLAKE3_VECTORS ' + JSON.stringify(digests));
      };`;
    const run = cp.spawnSync(process.execPath, ['-'],
      {input: nodeScript, encoding: 'utf8', timeout: 30000, windowsHide: true});
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stderr, '');
    const prefix = 'P3_BLAKE3_VECTORS ';
    const output = run.stdout.split(/\r?\n/).find(line => line.startsWith(prefix));
    assert(output);
    const expected = cases.map(item => item.expected);
    assert.deepEqual(JSON.parse(output.slice(prefix.length)), expected);
    report.node = {pass: true, checks: cases.length};
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto('http://127.0.0.1:8765/web-blake3.html');
      await page.waitForFunction(() => globalThis.__webBlake3Ready, null, {timeout: 30000});
      const digests = await page.evaluate(cases => cases.map(c =>
        Module.UTF8ToString(Number(Module._WebBlake3Digest(c.length, c.mode, c.split)))), cases);
      assert.deepEqual(digests, expected);
      assert.deepEqual(errors, []);
      report.browserRuns.push({browser: name, version: browser.version(), pass: true,
        checks: cases.length, errors});
      await browser.close();
      browser = null;
    }
    Object.assign(report, {pass: true, buildReport: audit(buildFile), library: build.library,
      sourceFiles: [__filename, vectorFile, path.join(__dirname, 'web-blake3.html')].map(audit),
      vectorCases: vectors.cases.length, modes: 3, partitions: [0, 97],
      outputBytes: 131, defaultOutputPrefixChecked: true,
      boundary: 'Portable BLAKE3 1.3.1 from the target engine source, built as a wasm64 static archive. Official bundled test vectors for hash, keyed hash and derive-key modes, with one-shot and 97-byte streaming input, match all 131 output bytes in Node, Chrome and Edge. The same archive is linked by the Engine target; this standalone check does not start Engine or verify the UE FBlake3 wrapper.'});
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-blake3-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, vectors: report.vectorCases, node: report.node,
      browsers: report.browserRuns, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
