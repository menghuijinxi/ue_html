'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const corpusFile = path.resolve(option('corpus')), tag = option('tag'), concurrency = Number(option('concurrency') || 8);
const rounds = Number(option('rounds') || 2);
const gpuCacheKB = option('gpu-cache-kb') === undefined ? null : Number(option('gpu-cache-kb'));
const disableCache = process.argv.includes('--disable-cache');
const moduleFence = process.argv.includes('--module-fence');
const browserTrace = process.argv.includes('--browser-trace');
const requestLimit = option('requests') === undefined ? null : Number(option('requests'));
const profileName = option('profile') || 'stutters', settleCacheMs = Number(option('settle-cache-ms') || 0);
const inProcessGPU = process.argv.includes('--in-process-gpu');
assert(/^[a-z0-9-]+$/.test(tag) && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8 && Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
assert(gpuCacheKB === null || (Number.isInteger(gpuCacheKB) && gpuCacheKB >= 1024));
assert(requestLimit === null || (Number.isInteger(requestLimit) && requestLimit > 0));
assert(/^[a-z0-9-]+$/.test(profileName) && settleCacheMs >= 0 && settleCacheMs <= 30000);
const relative = path.relative(__dirname, corpusFile).replaceAll('\\', '/'); assert(!relative.startsWith('..'));
const output = path.join(__dirname, 'results', tag + '.json'); assert(!fs.existsSync(output));
const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
const browserArgs = [...(gpuCacheKB === null ? [] : ['--gpu-disk-cache-size-kb=' + gpuCacheKB]),
  ...(disableCache ? ['--disable-gpu-shader-disk-cache'] : []), ...(inProcessGPU ? ['--in-process-gpu'] : [])];
const report = {date: new Date().toISOString(), pass: false, corpus: audit(corpusFile), concurrency, browserArgs, moduleFence, browserTrace, requestLimit, profileName, settleCacheMs,
  sources: [__filename, path.join(__dirname, 'web-pso-replay-worker.js'), path.join(__dirname, 'web-pso-replay.html')].map(audit), runs: [],
  boundary: 'Fresh browser process and device each round, persistent profile and normal browser/driver caches retained. Exact captured UE shaders/layouts/async requests. Corpus fetch/JSON parsing/device request excluded from pipeline timings; module/layout API times reported separately. No UE or rendering. Cache-hit rate inside Dawn is not exposed.'};
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
(async () => {
  for (let index = 0; index < rounds; index++) {
    const context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', profileName), {
      channel: 'msedge', headless: false, viewport: {width: 1000, height: 700}, args: browserArgs});
    try {
      const page = context.pages()[0]; await page.goto('http://127.0.0.1:8765/web-pso-replay.html'); await page.bringToFront();
      const cdp = await context.newCDPSession(page);
      report.browser = await cdp.send('Browser.getVersion');
      report.browserCommand = await cdp.send('Browser.getBrowserCommandLine').catch(e => ({unavailable: e.message, requestedAdditionalArguments: browserArgs}));
      if (browserTrace) await cdp.send('Tracing.start', {categories: 'disabled-by-default-gpu.dawn,gpu,toplevel,disabled-by-default-memory-infra',
        options: 'record-until-full', transferMode: 'ReturnAsStream'});
      const run = await page.evaluate(({url, concurrency, moduleFence, requestLimit}) => new Promise((resolve, reject) => {
        const worker = new Worker('web-pso-replay-worker.js');
        const timeout = setTimeout(() => {worker.terminate(); reject(Error('PSO replay timeout'));}, 180000);
        worker.onerror = e => {clearTimeout(timeout); reject(Error(e.message));};
        worker.onmessage = ({data}) => {clearTimeout(timeout); data.error ? reject(Error(data.error)) : resolve(data.result);};
        worker.postMessage({url, concurrency, moduleFence, requestLimit});
      }), {url: relative, concurrency, moduleFence, requestLimit});
      assert.deepEqual(run.errors, []);
      const requests = corpus.requests.slice(0, requestLimit || corpus.requests.length);
      assert.equal(run.attempts.length, requests.length);
      // The same eight speculative workgroup-limit rejections must reproduce.
      const expectedFailures = new Set(requests.filter(r => !r.success).map(r => r.id));
      assert.deepEqual(new Set(run.attempts.filter(r => !r.success).map(r => r.id)), expectedFailures);
      report.runs.push({index, ...run}); save();
      if (browserTrace) {
        run.memoryDump = await cdp.send('Tracing.requestMemoryDump', {levelOfDetail: 'detailed'});
        const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.end'); const {stream} = await complete;
        run.trace = path.join(__dirname, 'results', tag + `-${index}-browser-trace.json`);
        const fd = fs.openSync(run.trace, 'w');
        try {for (;;) {const chunk = await cdp.send('IO.read', {handle: stream});
          fs.writeSync(fd, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data); if (chunk.eof) break;}}
        finally {fs.closeSync(fd); await cdp.send('IO.close', {handle: stream});}
      }
      Object.assign(report.runs.at(-1), run); save();
      const {attempts, ...summary} = run; console.log(JSON.stringify({index, ...summary}));
      if (settleCacheMs) await page.waitForTimeout(settleCacheMs);
    } finally {await context.close();}
  }
  report.pass = true;
})().catch(e => {report.error = e.stack; console.error(e); process.exitCode = 1;}).finally(save);
