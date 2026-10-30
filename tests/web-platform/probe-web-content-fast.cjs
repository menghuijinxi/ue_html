const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.alloc(32 * 1024 * 1024 + 37);
for (let index = 0; index < bytes.length; ++index) bytes[index] = (index * 17 + (index >>> 9)) & 255;
const blockSize = 256 * 1024, blocks = [];
for (let index = 0; index < bytes.length; index += blockSize)
  blocks.push(hash(bytes.subarray(index, index + blockSize)));
const info = {url: 'asset.bin', size: bytes.length, sha256: hash(bytes), blockSize, blocks};
let mutation = '', requests = 0, context;
const workerCode = fs.readFileSync(path.join(__dirname, 'web-content-worker.js'));
const server = http.createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (request.url.startsWith('/worker.js')) {
    response.setHeader('Content-Type', 'text/javascript'); response.end(workerCode);
  } else if (request.url.startsWith('/asset.bin')) {
    ++requests;
    const output = Buffer.from(bytes);
    if (mutation === 'first') output[7] ^= 1;
    if (mutation === 'middle') output[blockSize * 3 + 7] ^= 1;
    response.end(mutation === 'short' ? output.subarray(0, output.length - 1) : output);
  } else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Local IO test</title>'); }
});
const report = {date: new Date().toISOString(), pass: false, cases: []};
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(__dirname, 'build/browser-profiles/content-fast-')),
      {channel: 'msedge', headless: true});
    const page = context.pages()[0];
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    async function run(label, verification, corrupt, clear, expectFailure = false) {
      mutation = corrupt;
      const before = requests;
      const value = await page.evaluate(async ({info, verification, clear}) => {
        if (clear) {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry('ue-web-local-v1', {recursive: true}).catch(() => {});
        }
        const worker = new Worker('/worker.js');
        const pending = new Map();
        let sequence = 0, stats;
        worker.onmessage = event => {
          stats = event.data.stats;
          const job = pending.get(event.data.id);
          if (!job) return;
          pending.delete(event.data.id);
          event.data.error ? job.reject(new Error(event.data.error)) : job.resolve(event.data.result);
        };
        const call = (type, args = {}) => new Promise((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, {resolve, reject});
          worker.postMessage({id, type, ...args});
        });
        const start = performance.now();
        try {
          await call('init', {baseUrl: location.href, verification});
          await call('asset', {info});
          const assetMs = performance.now() - start;
          const data = new Uint8Array(await call('read', {sha256: info.sha256, offset: 19, size: 16 * 1024 * 1024}));
          const small = await Promise.all([0, 1, 2, 3].map(index =>
            call('read', {sha256: info.sha256, offset: index * 100, size: 128})));
          let invalidRangeRejected = false;
          try { await call('read', {sha256: info.sha256, offset: info.size, size: 1}); }
          catch { invalidRangeRejected = true; }
          return {assetMs, totalMs: performance.now() - start, length: data.length, first: data[0],
            last: data[data.length - 1], small: small.map(value => value.byteLength), invalidRangeRejected, stats};
        } catch (error) { return {failure: error.message, stats}; }
        finally { worker.terminate(); }
      }, {info, verification, clear});
      report.cases.push({label, requests: requests - before, ...value});
      assert.equal(Boolean(value.failure), expectFailure, JSON.stringify({label, value}));
      if (!expectFailure) {
        assert.equal(value.length, 16 * 1024 * 1024);
        assert.equal(value.first, bytes[19]);
        assert.equal(value.last, bytes[19 + value.length - 1]);
        assert(value.invalidRangeRejected && value.small.every(value => value === 128));
        assert(value.stats.memoryBytes <= value.stats.memoryLimit);
      }
      console.log(JSON.stringify({label, failure: value.failure, assetMs: value.assetMs,
        hashedBytes: value.stats.hashedBytes, requests: requests - before}));
      return value;
    }
    const fast = await run('sampled-valid', 'sampled', '', true);
    assert(fast.stats.hashedBytes < info.size / 16);
    const reused = await run('persistent-reuse', 'sampled', '', false);
    assert.equal(reused.stats.downloads, 0);
    assert.equal(report.cases.at(-1).requests, 0);
    const full = await run('full-valid', 'full', '', true);
    assert(full.stats.hashedBytes >= info.size);
    await run('sampled-first-corruption', 'sampled', 'first', true, true);
    await run('sampled-short-download', 'sampled', 'short', true, true);
    await run('full-middle-corruption', 'full', 'middle', true, true);
    await run('sampled-middle-boundary', 'sampled', 'middle', true);
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    const file = path.join(__dirname, 'results/web-content-fast-results.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
