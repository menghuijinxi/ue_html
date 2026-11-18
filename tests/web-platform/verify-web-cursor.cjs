'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const template = fs.readFileSync(path.join(__dirname, 'web-default-template.html'), 'utf8');
const begin = template.indexOf('let canvasInputListeners;');
const end = template.indexOf("addEventListener('error', event => {", begin);
assert(begin >= 0 && end > begin, 'Missing production canvas click handler');
const clickHandler = template.slice(begin, end);
const profile = assertProjectOutputTree(path.join(__dirname, 'build/browser-profiles/cursor-regression'));
const output = assertProjectOutput(path.join(__dirname, 'results/web-cursor.json'));
const report = {pass: false, checks: []};
let context, server;
(async () => {
  try {
    server = require('./serve.cjs');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true,
      downloadsPath: assertProjectOutput(path.join(profile, 'downloads')),
      args: ['--disk-cache-dir=' + assertProjectOutput(path.join(profile, 'http-cache')),
        '--crash-dumps-dir=' + assertProjectOutput(path.join(profile, 'crashes'))]
    });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port + '/');
    await page.setContent('<canvas id="canvas" width="640" height="360" tabindex="0"></canvas>');
    await page.evaluate(() => {
      globalThis.Worker = class {
        constructor() { globalThis.testWorker = this; }
        postMessage(message) {
          if (message.type === 'inputs') queueMicrotask(() =>
            this.onmessage({data: {type: 'input-ack', sequence: message.sequence}}));
        }
        terminate() {}
      };
      globalThis.Module = {canvas: document.getElementById('canvas'), arguments: []};
      globalThis.loadingComplete = true;
      globalThis.loadingRender = () => {};
      globalThis.__webEngineReady = true;
      globalThis.lockRequests = 0;
      globalThis.lockExits = 0;
      // Track the browser boundary deterministically, without a GPU runtime.
      let locked = null;
      Object.defineProperty(document, 'pointerLockElement', {get: () => locked});
      Module.canvas.requestPointerLock = () => { lockRequests++; locked = Module.canvas; };
      document.exitPointerLock = () => { lockExits++; locked = null; };
      globalThis.completeLateLock = () => {
        locked = Module.canvas;
        document.dispatchEvent(new Event('pointerlockchange'));
      };
    });
    await page.addScriptTag({path: path.join(__dirname, 'web-engine-host.js')});
    await page.evaluate(() => startWebEngineWorker({
      assets: {versions: {'web-engine-worker.js': 'test'}}, module: Module,
      record() {}, failed(error) {throw Error(error);}, stage() {}, diagnostics: {}, render() {}
    }));
    await page.addScriptTag({content: clickHandler});
    const send = (command, state) => page.evaluate(({command, state}) =>
      testWorker.onmessage({data: {type: 'dom', command, ...state}}), {command, state});
    const check = async (name, expected) => {
      const actual = await page.evaluate(() => ({
        cursor: getComputedStyle(Module.canvas).cursor,
        locked: document.pointerLockElement === Module.canvas,
        requests: lockRequests, exits: lockExits
      }));
      assert.deepEqual(actual, expected, name);
      report.checks.push({name, ...actual});
    };
    await send('cursor', {cursor: {visible: true, type: 9, css: 'pointer'}});
    await page.locator('#canvas').click();
    await check('visible UI cursor does not capture clicks',
      {cursor: 'pointer', locked: false, requests: 0, exits: 0});
    await send('cursor', {cursor: {visible: false, type: 0, css: 'none'}});
    await page.locator('#canvas').click();
    await check('hidden cursor alone does not request raw input',
      {cursor: 'none', locked: false, requests: 0, exits: 0});
    await send('mouse-mode', {enabled: true});
    await page.locator('#canvas').click();
    await check('hidden game cursor captures on user click',
      {cursor: 'none', locked: true, requests: 1, exits: 0});
    await send('cursor', {cursor: {visible: true, type: 1, css: 'default'}});
    await check('opening UI releases pointer lock',
      {cursor: 'default', locked: false, requests: 1, exits: 1});
    await page.locator('#canvas').click();
    await check('UI confirmation click stays unlocked',
      {cursor: 'default', locked: false, requests: 1, exits: 1});
    await send('cursor', {cursor: {visible: true, type: 2, css: 'text'}});
    await check('cursor shape updates independently',
      {cursor: 'text', locked: false, requests: 1, exits: 1});
    await send('cursor', {cursor: {visible: false, type: 0, css: 'none'}});
    await page.locator('#canvas').click();
    await send('mouse-mode', {enabled: false});
    await check('disabling raw input releases pointer lock',
      {cursor: 'none', locked: false, requests: 2, exits: 2});
    await send('mouse-mode', {enabled: true});
    await send('cursor', {cursor: {visible: true, type: 1, css: 'default'}});
    await page.evaluate(() => completeLateLock());
    await check('late pointer lock cannot hide an open UI cursor',
      {cursor: 'default', locked: false, requests: 2, exits: 3});
    await page.evaluate(() => {
      const original = Module.canvas, replacement = original.cloneNode();
      original.replaceWith(replacement);
      Module.canvas = replacement;
      replacement.requestPointerLock = () => { lockRequests++; };
      document.dispatchEvent(new Event('web-engine-canvas-replaced'));
      original.click();
      replacement.click();
    });
    assert.equal(await page.evaluate(() => lockRequests), 2, 'Canvas replacement must preserve UI cursor behavior');
    await send('cursor', {cursor: {visible: false, type: 0, css: 'none'}});
    await page.locator('#canvas').click();
    assert.equal(await page.evaluate(() => lockRequests), 3, 'Replacement canvas must bind game input once');
    report.pass = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = error.stack;
    throw error;
  } finally {
    await context?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
