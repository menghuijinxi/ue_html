'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), {audit} = require('./content-file-metadata.cjs');
const tag = process.argv[2]; assert(tag && /^[a-z0-9-]+$/.test(tag));
const output = path.join(__dirname, 'results', tag + '.json'); assert(!fs.existsSync(output));
const report = {date: new Date().toISOString(), pass: false, errors: [],
  sources: [__filename, 'draw-api-webgpu.cpp', 'build/draw-api/draw-wasm.js', 'build/draw-api/draw-wasm.wasm',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUCommandStream.h',
    '../../reference-engine/Engine/Platforms/Web/Build/WebGPUCommandStream.js']
    .map(file => audit(path.resolve(__dirname, file)))};
let context;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', tag),
      {channel: 'msedge', headless: false, args: ['--window-position=-32000,-32000']});
    await context.route('**/draw-api-wasm-worker.js', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: (await response.text()).replace('importScripts(',
        "Module.arguments=['--preflight-only'];\nimportScripts(")});
    });
    const page = await context.newPage();
    for (const previous of context.pages()) if (previous !== page) await previous.close();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto('http://127.0.0.1:8765/draw-api-benchmark.html');
    report.gpu = await page.evaluate(() => runDrawBenchmark('wasm'));
    assert(report.gpu.pass && report.gpu.indirectTemplates);
    assert.deepEqual(report.errors, []); report.pass = true;
    console.log(JSON.stringify(report));
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {fs.writeFileSync(output, JSON.stringify(report, null, 2)); await context?.close();}
})();
