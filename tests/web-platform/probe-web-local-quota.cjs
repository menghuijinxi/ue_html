'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {metadata, audit} = require('./content-file-metadata.cjs');
const name = process.argv.find(value => value.startsWith('--browser='))?.slice(10) || 'Chrome';
assert(['Chrome', 'Edge'].includes(name));
const source = fs.readFileSync(path.join(__dirname, 'web-content-worker.js'), 'utf8');
const fixture = path.join(__dirname, 'results/local-quota-fixture.bin');
const bytes = Buffer.alloc(9 * 1024 * 1024 + 19);
for (let i = 0; i < bytes.length; ++i) bytes[i] = (i * 37 + Math.floor(i / 65536) * 13) & 255;
fs.writeFileSync(fixture, bytes);
const info = metadata(fixture, 'results/local-quota-fixture.bin');
const report = {pass: false, date: new Date().toISOString(), browser: name,
  sources: [__filename, 'web-content-worker.js', 'web-content-io.js', 'content-file-metadata.cjs']
    .map(file => audit(path.resolve(__dirname, file))), fixture: audit(fixture), cases: []};
let browser;
(async () => {
  try {
    browser = await chromium.launch({headless: true, executablePath: name === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    for (const scenario of ['create', 'write', 'close', 'marker', 'exhausted', 'non-quota']) {
      const context = await browser.newContext(), page = await context.newPage();
      page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
      page.on('pageerror', error => console.error(error.stack));
      await page.route('**/local-quota-test', route => route.fulfill({contentType: 'text/html',
        headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'},
        body: '<!doctype html><title>Local storage quota regression</title>'}));
      // Exercise real OPFS files and Web Locks; inject only the browser's
      // allocation error at each writable-stream boundary.
      const injection = `
        const quotaTarget = ${JSON.stringify(info.sha256)}, quotaScenario = ${JSON.stringify(scenario)};
        let quotaRemaining = quotaScenario === 'exhausted' ? 2 : 1;
        const originalWritable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function(...args) {
          const target = this.name === quotaTarget + (quotaScenario === 'marker' ? '.json' : '.bin');
          const fail = () => {
            if (target && quotaRemaining > 0) {
              --quotaRemaining;
              throw new DOMException('Injected storage allocation failure',
                quotaScenario === 'non-quota' ? 'NotReadableError' : 'QuotaExceededError');
            }
          };
          if (['create', 'exhausted', 'non-quota'].includes(quotaScenario)) fail();
          const stream = await originalWritable.apply(this, args);
          let writes = 0;
          const write = stream.write.bind(stream), close = stream.close.bind(stream);
          stream.write = async (...values) => {
            if (quotaScenario === 'marker' || quotaScenario === 'write' && ++writes === 2) fail();
            return write(...values);
          };
          stream.close = async () => { if (quotaScenario === 'close') fail(); return close(); };
          return stream;
        };
      `;
      await page.route('**/quota-worker.js', route => route.fulfill({contentType: 'text/javascript',
        headers: {'Cross-Origin-Embedder-Policy': 'require-corp'}, body: injection + source}));
      await page.goto('http://127.0.0.1:8765/local-quota-test');
      await page.addScriptTag({url: 'http://127.0.0.1:8765/web-content-io.js'});
      const requests = [];
      page.on('request', request => { if (request.url().includes(info.url)) requests.push(request.url()); });
      const result = await page.evaluate(async ({info, scenario}) => {
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('ue-web-local-v1', {create: true});
        const put = async (name, value) => {
          const writer = await (await directory.getFileHandle(name, {create: true})).createWritable();
          await writer.write(value); await writer.close();
        };
        const seed = async (letter, orphan = false) => {
          const sha256 = letter.repeat(64), data = new Uint8Array(1024 * 1024).fill(letter.charCodeAt(0));
          await put(sha256 + '.bin', data);
          if (!orphan) await put(sha256 + '.json', JSON.stringify({sha256, size: data.length, used: 1, verification: 'sampled'}));
          return {sha256, size: data.length, blockSize: 256 * 1024, blocks: Array(4).fill('0'.repeat(64)), url: 'unreachable'};
        };
        const own = await seed('a'), other = await seed('b'), old = await seed('c'), orphan = await seed('d', true);
        await put('keep-user-file.txt', 'untouched');
        const io = new WebLocalContentIO('/quota-worker.js'), second = new WebLocalContentIO('/web-content-worker.js');
        await Promise.all([io.asset(own), second.asset(other)]);
        const first = await Promise.allSettled([io.asset(info), io.asset(info)]);
        const firstStats = {...io.stats};
        const namesAfterFirst = [];
        for await (const [name] of directory.entries()) namesAfterFirst.push(name);
        const firstErrors = first.map(value => value.status === 'rejected' ? value.reason.message : null);
        if (scenario === 'exhausted' || scenario === 'non-quota') await io.asset(info);
        const file = await io.asset(info), data = new Uint8Array(await file.arrayBuffer());
        const valid = data.length === info.size && data.every((value, i) => value === ((i * 37 + Math.floor(i / 65536) * 13) & 255));
        io.manifest = {pack: own}; second.manifest = {pack: other};
        const ownBytes = await io.read(0, 64), otherBytes = await second.read(0, 64);
        const names = []; for await (const [name] of directory.entries()) names.push(name);
        await io.call('stats');
        const result = {firstErrors, firstStats, namesAfterFirst, names, valid,
          ownLeasePreserved: ownBytes.every(value => value === 97), otherLeasePreserved: otherBytes.every(value => value === 98),
          sentinel: await (await directory.getFileHandle('keep-user-file.txt')).getFile().then(file => file.text()), stats: io.stats};
        io.worker.terminate(); second.worker.terminate();
        return result;
      }, {info, scenario});
      assert(result.valid && result.ownLeasePreserved && result.otherLeasePreserved);
      assert.equal(result.sentinel, 'untouched');
      if (scenario === 'exhausted' || scenario === 'non-quota') {
        assert(result.firstErrors.every(value => value && value.includes(scenario === 'exhausted' ? 'Insufficient browser storage' : 'Injected storage')));
        assert(!result.namesAfterFirst.some(name => name.startsWith(info.sha256)), 'Failed download left a cache file or marker');
      } else assert.deepEqual(result.firstErrors, [null, null]);
      for (const letter of ['a', 'b']) assert(result.names.includes(letter.repeat(64) + '.bin'));
      for (const letter of ['c', 'd']) assert.equal(result.names.includes(letter.repeat(64) + '.bin'), scenario === 'non-quota');
      assert.equal(result.stats.quotaRetries, scenario === 'non-quota' ? 0 : 1);
      assert.equal(result.stats.quotaFailures, scenario === 'exhausted' ? 1 : 0);
      assert.equal(result.stats.diskEvictions, scenario === 'non-quota' ? 0 : 2);
      assert.equal(result.stats.downloads, 1);
      assert.equal(requests.length, scenario === 'exhausted' ? 3 : 2);
      report.cases.push({scenario, ...result, requests: requests.length});
      console.log({scenario, pass: true});
      await context.close();
    }
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, `results/web-local-quota-${name.toLowerCase()}.json`), JSON.stringify(report, null, 2));
    console.log({pass: report.pass, cases: report.cases.length, failure: report.failure});
  }
})();
