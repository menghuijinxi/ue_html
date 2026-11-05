'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const corpus = path.resolve(option('corpus'));
const tag = option('tag');
const browserArgs = option('browser-args') ? JSON.parse(option('browser-args')) : [];
assert(Array.isArray(browserArgs) && browserArgs.every(value => typeof value === 'string'));
assert(typeof tag === 'string' && /^[a-z0-9-]+$/.test(tag));
const output = path.join(__dirname, 'results', tag + '.json');
assert(!fs.existsSync(output), 'Use a new replay tag');
const relative = path.relative(__dirname, corpus).replaceAll('\\', '/');
assert(!relative.startsWith('..'));
const report = {date: new Date().toISOString(), pass: false, corpus: audit(corpus),
  browserArgs,
  targetEntry: option('entry') || null, asyncPipelines: process.argv.includes('--async'),
  moduleFence: process.argv.includes('--module-fence'), progress: [], sources: [
    __filename, path.join(__dirname, 'web-pso-replay-worker.js')].map(audit),
  boundary: 'Pipeline replay only. Synchronous API returns do not prove compiler completion; no scene draws are submitted.'};
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
let context;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', tag),
      {channel: 'msedge', headless: false, viewport: {width: 1000, height: 700},
        args: browserArgs});
    const page = context.pages()[0];
    await page.exposeFunction('__replayProgress', value => {report.progress.push(value); save();});
    await page.goto('http://127.0.0.1:8765/web-pso-replay.html');
    report.result = await page.evaluate(options => new Promise((resolve, reject) => {
      const worker = new Worker('web-pso-replay-worker.js');
      const timer = setTimeout(() => {worker.terminate(); reject(Error('Replay timed out'));}, 90000);
      worker.onerror = event => {clearTimeout(timer); reject(Error(event.message));};
      worker.onmessage = ({data}) => {
        if (data.progress) {globalThis.__replayProgress(data.progress); return;}
        clearTimeout(timer);
        if (data.error) {worker.terminate(); reject(Error(data.error));}
        else resolve(data.result);
      };
      worker.postMessage(options);
    }), {url: relative, concurrency: 1, progress: true, targetEntry: report.targetEntry,
      asyncPipelines: report.asyncPipelines, moduleFence: report.moduleFence});
    assert.equal(report.result.failed, 0);
    assert.deepEqual(report.result.errors, []);
    report.pass = true;
  } catch (error) {report.failure = error.stack; process.exitCode = 1;}
  finally {
    save();
    await context?.close();
    console.log(JSON.stringify({pass: report.pass, failure: report.failure,
      attempted: report.progress.length, successful: report.result?.successful, output}));
  }
})();
