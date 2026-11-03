'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const directory = path.join(__dirname, 'build/web-log-proxy');
const source = path.join(__dirname, 'web-log-proxy.cpp');
const sdk = path.join(root, '.tools/emsdk').replaceAll('\\', '/');
const headers = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'};
fs.mkdirSync(directory, {recursive: true});
const report = {date: new Date().toISOString(), pass: false, cases: [], sources: [source, __filename].map(audit)};
(async () => {
  let browser;
  try {
    for (const direct of [false, true]) {
      const mode = direct ? 'direct' : 'stdio';
      const build = cp.spawnSync(path.join(root, '.tools/emsdk/python/3.13.3_64bit/python.exe'),
        [path.join(root, '.tools/emsdk/upstream/emscripten/emcc.py'), source,
          '-m64', '-O2', '-pthread', '-sPTHREAD_POOL_SIZE=1', '-sENVIRONMENT=worker',
          '-sEXIT_RUNTIME=0', '-sALLOW_MEMORY_GROWTH=1', `-DDIRECT_LOG=${Number(direct)}`,
          '-o', path.join(directory, mode + '.js')], {encoding: 'utf8', windowsHide: true,
          env: {...process.env, WEB_EMSDK_ROOT: sdk, EM_CONFIG: sdk + '/.emscripten'}});
      assert.equal(build.status, 0, build.stdout + build.stderr);
    }
    browser = await chromium.launch({channel: 'msedge', headless: true});
    for (const mode of ['stdio', 'direct']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [], logs = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => logs.push(message.text()));
      await page.route('**/log-proxy.html', route => route.fulfill({headers, contentType: 'text/html',
        body: `<script>globalThis.result={};const w=new Worker('/build/web-log-proxy/${mode}-worker.js');
        w.onmessage=e=>{if(e.data.complete!==undefined)result=e.data;else console.log(JSON.stringify(e.data));};</script>`}));
      await page.route(`**/${mode}-worker.js`, route => route.fulfill({headers, contentType: 'text/javascript',
        body: `addEventListener('error',e=>postMessage({workerError:e.message,filename:e.filename,stack:e.error?.stack}));
        const OriginalWorker=Worker;
        globalThis.Worker=class extends OriginalWorker{constructor(...args){
        if(args[1]?.name==='em-pthread')args[0]=new URL('${mode}.js',location.href).href;super(...args);
        this.addEventListener('error',e=>postMessage({pthreadError:e.message,filename:e.filename,stack:e.error?.stack}));}};
        globalThis.Module={mainScriptUrlOrBlob:new URL('${mode}.js',location.href).href};importScripts('${mode}.js');`}));
      await page.goto('http://127.0.0.1:8765/log-proxy.html');
      let complete = false;
      try {
        await page.waitForFunction(() => globalThis.result.complete, null, {timeout: 5000});
        complete = true;
      } catch (error) { assert(error.name === 'TimeoutError'); }
      report.cases.push({mode, complete, errors, logs});
      assert.deepEqual(errors, []);
      assert(logs.includes('background-enter') && logs.includes('owner-enter'),
        'Both threads must reach the proxy callback');
      assert(!logs.some(value => /workerError|pthreadError/.test(value)), logs.join('\n'));
      assert.equal(complete, mode === 'direct');
      assert.equal(logs.includes('owner-log'), mode === 'direct');
      await context.close();
    }
    report.pass = true;
  } finally {
    await browser?.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-log-proxy.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
