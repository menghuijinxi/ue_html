'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag');
assert(tag && /^[a-z0-9-]+$/.test(tag));
const workerFile = path.resolve(option('worker') || path.join(__dirname, 'web-content-worker.js'));
const output = path.join(__dirname, 'results', 'content-multitab-' + tag + '.json');
assert(!fs.existsSync(output), 'Use a fresh evidence tag');
const temporary = path.join(__dirname, 'build/test-tmp');
fs.mkdirSync(temporary, {recursive: true});
process.env.TEMP = process.env.TMP = temporary;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixtures = new Map();
for (const [index, name] of ['warm', 'cold', 'retry', 'full'].entries()) {
  const bytes = Buffer.alloc(512 * 1024 + 17, index + 1);
  fixtures.set('/' + name + '.bin', {bytes, requests: 0, info: {
    url: name + '.bin', size: bytes.length, sha256: sha(bytes), blockSize: 256 * 1024,
    blocks: Array.from({length: 3}, (_, block) => sha(bytes.subarray(block * 256 * 1024, (block + 1) * 256 * 1024)))
  }});
}
const report = {date: new Date().toISOString(), worker: audit(workerFile), pass: false, cases: []};
const server = http.createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const pathname = new URL(request.url, 'http://local').pathname;
  if (pathname === '/web-content-worker.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(fs.readFileSync(workerFile)); return;
  }
  const fixture = fixtures.get(pathname);
  if (fixture) {
    if (++fixture.requests === 1 && pathname === '/retry.bin') {
      response.writeHead(503).end('Deliberate download failure'); return;
    }
    response.end(fixture.bytes); return;
  }
  response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Content lock regression</title>');
});
let context;
const deadline = async promise => {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) =>
    {timer = setTimeout(() => reject(new Error('Second page blocked on a held cache lock')), 5000);})]);}
  finally {clearTimeout(timer);}
};
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    context = await chromium.launchPersistentContext(
      path.join(__dirname, 'build/browser-profiles/content-multitab-' + tag),
      {channel: 'chrome', headless: true});
    async function page(verification = 'sampled') {
      const value = await context.newPage(); await value.goto(url);
      await value.evaluate(async verification => {
        const worker = globalThis.worker = new Worker('web-content-worker.js');
        const pending = new Map(); let sequence = 0;
        globalThis.rpc = (type, args = {}) => new Promise((resolve, reject) => {
          const id = ++sequence; pending.set(id, {resolve, reject});
          worker.postMessage({id, type, ...args});
        });
        worker.onmessage = ({data}) => {
          globalThis.stats = data.stats;
          const job = pending.get(data.id);
          if (job) {pending.delete(data.id); data.error ? job.reject(new Error(data.error)) : job.resolve(data.result);}
        };
        worker.onerror = event => {for (const job of pending.values()) job.reject(new Error(event.message)); pending.clear();};
        await rpc('init', {baseUrl: location.href, verification});
      }, verification);
      return value;
    }
    const open = (page, fixture) => page.evaluate(async info => {
      const file = await rpc('asset', {info});
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
        value => value.toString(16).padStart(2, '0')).join('');
      return {sha256: hash, stats: globalThis.stats};
    }, fixture.info);
    const first = await page(), second = await page(), warm = fixtures.get('/warm.bin');
    assert.equal((await open(first, warm)).sha256, warm.info.sha256);
    const pending = open(second, warm);
    pending.catch(() => {});
    try {
      const value = await deadline(pending);
      assert.equal(value.sha256, warm.info.sha256);
      assert.equal(value.stats.downloads, 0);
      assert.equal(value.stats.persistentHits, 1);
    } catch (error) {
      report.blockedLocks = await first.evaluate(() => navigator.locks.query());
      await first.close();
      report.resumesWhenFirstCloses = (await deadline(pending)).sha256 === warm.info.sha256;
      throw error;
    }
    const shared = await second.evaluate(() => navigator.locks.query());
    assert.equal(shared.held.filter(lock => lock.name === 'ue-web-local-' + warm.info.sha256 &&
      lock.mode === 'shared').length, 2);
    const protectedWhileOpen = await second.evaluate(name =>
      navigator.locks.request(name, {ifAvailable: true}, lock => !lock), 'ue-web-local-' + warm.info.sha256);
    assert(protectedWhileOpen);
    assert.equal(warm.requests, 1);
    report.cases.push({name: 'warm readers coexist and exclude eviction', requests: warm.requests, pass: true});
    const cold = fixtures.get('/cold.bin');
    const coldResults = await deadline(Promise.all([open(first, cold), open(second, cold)]));
    assert(coldResults.every(value => value.sha256 === cold.info.sha256));
    assert.equal(cold.requests, 1);
    report.cases.push({name: 'simultaneous cold opens download once', requests: cold.requests, pass: true});
    const validating = await page('full');
    await assert.rejects(deadline(open(validating, warm)), /another page is using it/);
    assert.equal((await second.evaluate(() => navigator.locks.query())).pending.length, 0);
    report.cases.push({name: 'rebuild of an in-use cache fails explicitly without leaving a queued writer', pass: true});
    const retry = fixtures.get('/retry.bin');
    const retried = await deadline(Promise.allSettled([open(first, retry), open(second, retry)]));
    assert.equal(retried.filter(value => value.status === 'rejected' && /503/.test(value.reason.message)).length, 1);
    assert.equal(retried.find(value => value.status === 'fulfilled').value.sha256, retry.info.sha256);
    assert.equal((await deadline(open([first, second][retried.findIndex(value => value.status === 'rejected')], retry))).sha256,
      retry.info.sha256, 'A failed worker can retry after another worker populated the cache');
    report.cases.push({name: 'failed download releases preparation lock', requests: retry.requests, pass: true});
    const third = await page('full'), fourth = await page('full'), full = fixtures.get('/full.bin');
    await open(third, full);
    const reused = await deadline(open(fourth, full));
    assert.equal(reused.sha256, full.info.sha256);
    assert.equal(reused.stats.persistentHits, 1);
    assert.equal(full.requests, 1);
    await first.close();
    const bytes = await second.evaluate(async info => {
      const data = new Uint8Array(await rpc('read', {sha256: info.sha256, offset: 262140, size: 32}));
      await rpc('clear-memory');
      return Array.from(data);
    }, warm.info);
    assert(bytes.every(byte => byte === 1));
    await second.close();
    const released = await third.evaluate(name =>
      navigator.locks.request(name, {ifAvailable: true}, lock => !!lock), 'ue-web-local-' + warm.info.sha256);
    assert(released);
    const upgraded = await deadline(open(validating, warm));
    assert.equal(upgraded.sha256, warm.info.sha256);
    assert.equal(upgraded.stats.verification, 'full');
    report.cases.push({name: 'full verification cache reused and closed pages release leases', pass: true});
    report.pass = true;
  } catch (error) {report.error = error.stack; process.exitCode = 1;}
  finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
})();
