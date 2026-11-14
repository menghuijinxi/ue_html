'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), {audit} = require('./content-file-metadata.cjs');
const {readPage, coreFiles} = require('./web-pipeline-prewarm-package.cjs');
const followup = process.argv.includes('--followup'), tag = followup ? 'prewarm2' : 'prewarm', expectedAdded = followup ? 2 : 8;
const base = __dirname, folder = path.join(base, 'build/villa-tsr-turn-' + tag + '-20261113');
const source = path.join(base, 'build/' + (followup ? 'villa-tsr-turn-prewarm-20261113' : 'villa-tsr-tiles-20261112'));
const pack = JSON.parse(fs.readFileSync(path.join(folder, 'pipeline-prewarm.json')));
const original = JSON.parse(fs.readFileSync(path.join(source, 'pipeline-prewarm.json')));
const report = {date: new Date().toISOString(), pass: false, errors: [], package: audit(path.join(folder, 'asset-versions.json')),
  boundary: 'Compile only the ' + expectedAdded + ' supplemental graphics pipelines. No engine scene, camera automation or performance comparison.'};
let browser;
(async () => {
  try {
    const page = readPage(folder), before = readPage(source);
    assert.deepEqual(page.args, before.args);
    for (const name of coreFiles) assert.equal(audit(path.join(folder, name)).sha256, audit(path.join(source, name)).sha256);
    assert.deepEqual(pack.descriptors.slice(0, original.descriptors.length), original.descriptors);
    assert.deepEqual(pack.descriptors.filter(item => item.kind === 'compute'), original.descriptors.filter(item => item.kind === 'compute'));
    assert.equal(pack.descriptors.length - original.descriptors.length, expectedAdded);
    assert.equal(page.assets.pipelinePrewarm.sha256, audit(path.join(folder, 'pipeline-prewarm.json')).sha256);
    assert.equal(page.assets.diagnosticOnly, true);
    const profile = assertProjectOutputTree(path.join(base, 'build/browser-profiles/turn-' + tag + '-compile'));
    browser = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
      downloadsPath: assertProjectOutput(path.join(profile, 'downloads'))});
    const tab = browser.pages()[0] || await browser.newPage();
    await tab.route('**/pipeline-verification', route => route.fulfill({contentType: 'text/html',
      headers: {'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin'},
      body: '<!doctype html><title>Pipeline compile verification</title>'}));
    await tab.goto('http://127.0.0.1:8765/pipeline-verification');
    const added = pack.descriptors.slice(original.descriptors.length);
    report.gpu = await tab.evaluate(async ({pack, added}) => {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      if (!adapter) throw Error('No WebGPU adapter');
      const device = await adapter.requestDevice(pack.devices[0].descriptor), errors = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      const resources = new Map([...pack.modules, ...pack.layouts].map(item => [item.id, item])), objects = new Map();
      function decode(value) {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(decode);
        if (value.$gpu) {
          if (!objects.has(value.id)) {
            const item = resources.get(value.id), method = {module: 'createShaderModule',
              bindGroupLayout: 'createBindGroupLayout', pipelineLayout: 'createPipelineLayout'}[item.$gpu];
            objects.set(value.id, device[method](decode(item.descriptor)));
          }
          return objects.get(value.id);
        }
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
      }
      const completed = [];
      for (const item of added) {
        device.pushErrorScope('validation');
        await device.createRenderPipelineAsync(decode(item.descriptor));
        const error = await device.popErrorScope(); if (error) errors.push(error.message);
        completed.push(item.id);
      }
      await device.queue.onSubmittedWorkDone();
      device.destroy(); return {completed, errors, resources: objects.size};
    }, {pack, added});
    assert.equal(report.gpu.completed.length, expectedAdded); assert.deepEqual(report.gpu.errors, []);
    report.pass = true; report.coreUnchanged = true; report.computeUnchanged = true;
    report.actualTurnAcceptance = 'Pending human retest';
    console.log(JSON.stringify(report));
  } catch (error) {report.errors.push(error.stack); throw error;}
  finally {
    await browser?.close();
    fs.writeFileSync(assertProjectOutput(path.join(base, 'results/villa-turn-' + tag + '-verification.json')), JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
