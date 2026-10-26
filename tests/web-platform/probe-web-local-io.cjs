const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {metadata} = require('./content-file-metadata.cjs');
const directory = path.join(__dirname, 'results');
const name = process.argv.find(value => value.startsWith('--browser='))?.slice(10) || 'Chrome';
assert(['Chrome', 'Edge'].includes(name));
const fixtureUrl = `results/local-io-fixture-${name.toLowerCase()}.bin`;
const fixture = path.join(__dirname, fixtureUrl);
const size = 20 * 1024 * 1024 + 19;
const bytes = Buffer.alloc(size);
for (let index = 0; index < size; ++index) bytes[index] = (index * 37 + Math.floor(index / 65536) * 13) & 255;
fs.writeFileSync(fixture, bytes);
const info = metadata(fixture, fixtureUrl);
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, browsers: [],
  sourceFiles: [__filename, ...['content-file-metadata.cjs', 'web-content-io.js', 'web-content-worker.js']
    .map(file => path.join(__dirname, file))].map(audit)};
let browser;
(async () => {
  try {
    browser = await chromium.launch({headless: true, executablePath: name === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage();
    await page.route('**/local-io-test', route => route.fulfill({contentType: 'text/html',
      headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'},
      body: '<!doctype html><title>Local IO regression</title>'}));
    await page.goto('http://127.0.0.1:8765/local-io-test');
    await page.addScriptTag({url: 'http://127.0.0.1:8765/web-content-io.js'});
    const requests = [];
    page.on('request', request => { if (request.url().includes(fixtureUrl)) requests.push(request.url()); });
    const cold = await page.evaluate(async info => {
      const io = globalThis.io = new WebLocalContentIO('/web-content-worker.js');
      await io.asset(info);
      io.manifest = {pack: info};
      for (let offset = 0; offset < info.size; offset += info.blockSize) {
        const bytes = await io.read(offset, Math.min(info.blockSize, info.size - offset));
        if (!bytes.every((value, index) =>
          value === (((index + offset) * 37 + Math.floor((index + offset) / 65536) * 13) & 255)))
          throw new Error('Local disk bytes differ');
      }
      await io.call('stats');
      return io.stats;
    }, info);
    assert.equal(requests.length, 1);
    assert.equal(cold.downloadedBytes, info.size);
    assert(cold.evictions > 0 && cold.memoryBytes <= 16 * 1024 * 1024);
    assert(cold.peakMemoryBytes <= cold.memoryLimit && cold.peakActiveReads <= 4);
    const mountChecks = await page.evaluate(async info => {
      const platforms = ['SP_WEBGPU_ES31', 'SP_WEBGPU_SM5'];
      const checks = [];
      for (const shaderPlatform of platforms) {
        const mounted = new Map();
        const filesystem = {
          mkdirTree() {},
          open(path) { mounted.set(path, new Uint8Array(64)); return path; },
          write(path, bytes, offset, length, position) {
            mounted.get(path).set(bytes.subarray(offset, offset + length), position);
          },
          close() {}
        };
        const cachePath = `/Engine/GlobalShaderCache-${shaderPlatform}.bin`;
        const manifest = {shaderPlatform, pack: info, files: [{path: cachePath, offset: 0, size: 64}]};
        await io.mount(manifest, filesystem);
        if (!mounted.get(cachePath)?.every((value, index) => value === ((index * 37) & 255)))
          throw new Error(`Shader cache mount differs: ${shaderPlatform}`);
        let rejected = 0;
        for (const file of [
          {path: `/Engine/GlobalShaderCache-${platforms.find(value => value !== shaderPlatform)}.bin`, offset: 0, size: 64},
          {path: '/Engine/Content/../escape.bin', offset: 0, size: 64},
          {path: '/Engine/Content/outside.bin', offset: info.size, size: 64}
        ]) {
          try { await io.mount({...manifest, files: [file]}, filesystem); }
          catch (error) {
            if (!/Invalid content entry/.test(error.message)) throw error;
            ++rejected;
          }
        }
        if (rejected !== 3) throw new Error(`Invalid mount accepted: ${shaderPlatform}`);
        checks.push({shaderPlatform, shaderCacheMounted: true, invalidEntriesRejected: rejected});
      }
      try { await io.mount({shaderPlatform: 'SP_UNKNOWN', pack: info, files: []}, {}); }
      catch (error) {
        if (/Invalid content shader platform/.test(error.message)) return checks;
        throw error;
      }
      throw new Error('Unknown shader platform was accepted');
    }, info);
    await page.evaluate(async () => {
      io.worker.terminate();
      globalThis.io = new WebLocalContentIO('/web-content-worker.js');
      await io.ready;
    });
    await page.context().setOffline(true);
    const warm = await page.evaluate(async info => {
      const local = io;
      await local.asset(info);
      local.manifest = {pack: info};
      const bytes = await local.read(info.blockSize - 11, 93);
      if (!bytes.every((value, index) => value === (((index + info.blockSize - 11) * 37 +
          Math.floor((index + info.blockSize - 11) / 65536) * 13) & 255)))
        throw new Error('Offline cross-block read differs');
      local.files.set('/cancel.ubulk', {offset: 0, size: info.size});
      local.filesystem = {lookupPath: path => ({path: path.replace('/../../../', '/')})};
      let callbacks = 0;
      local.copy = () => { ++callbacks; };
      local.complete = () => { ++callbacks; };
      local.readRequest(1, '/../../../cancel.ubulk', 0, 64, 0);
      local.cancelRequest(1);
      await local.call('stats');
      await local.call('stats');
      return {stats: local.stats, callbacks};
    }, info);
    assert.equal(warm.stats.downloadedBytes, 0);
    assert.equal(warm.stats.persistentHits, 1);
    assert.equal(warm.callbacks, 0, 'Cancelled IO must not copy into a freed destination');
    assert.equal(requests.length, 1);
    await page.context().setOffline(false);
    bytes[0] = 1;
    fs.writeFileSync(fixture, bytes);
    const revised = metadata(fixture, fixtureUrl);
    const updated = await page.evaluate(async info => {
      await io.asset(info);
      io.manifest = {pack: info};
      const bytes = await io.read(0, 16);
      return {first: bytes[0], stats: io.stats};
    }, revised);
    assert.equal(updated.first, 1);
    assert.equal(updated.stats.downloads, 1);
    assert.equal(requests.length, 2, 'A changed file should download exactly once');
    const corrupt = await page.evaluate(async info => {
      io.worker.terminate();
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('ue-web-local-v1');
      const writer = await (await directory.getFileHandle(info.sha256 + '.bin')).createWritable({keepExistingData: true});
      await writer.write({type: 'write', position: 0, data: new Uint8Array([255])});
      await writer.close();
      const local = globalThis.io = new WebLocalContentIO('/web-content-worker.js');
      local.manifest = {pack: info};
      try { await local.read(0, 64); return false; } catch (error) { return /corrupt/.test(error.message); }
    }, info);
    assert(corrupt, 'Corrupt local blocks were accepted');
    report.browsers.push({browser: name, cold, mountChecks, warm, updated, corruptRejected: corrupt,
      networkPackRequests: requests.length});
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, `web-local-io-${name.toLowerCase()}-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
