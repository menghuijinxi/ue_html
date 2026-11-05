'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder') || 'triplex-project-lumen-optimized-20261104';
const tag = option('tag');
const mode = option('mode') || 'capture';
assert([folder, tag].every(value => typeof value === 'string' && /^[a-z0-9-]+$/.test(value)));
assert(['capture', 'dom'].includes(mode));
const output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(output + '.json'), 'Use a new capture tag');
const recorder = fs.readFileSync(path.join(__dirname, 'web-startup-profile.js'), 'utf8');
const report = {date: new Date().toISOString(), folder, mode, pass: false, errors: [],
  sources: [__filename, path.join(__dirname, 'web-startup-profile.js')].map(audit),
  settingsOverrides: [], viewport: {width: 2552, height: 1308}, dpr: 1.5,
  boundary: 'Diagnostic API capture; original rendering settings and default CPU scheduling. Not a performance measurement.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
let context;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', tag),
      {channel: 'msedge', headless: false, viewport: report.viewport, deviceScaleFactor: report.dpr});
    await context.exposeBinding('__saveCrashCapture', (_, value) => {
      report.corpus = output + '-corpus.json';
      fs.writeFileSync(report.corpus, JSON.stringify(value.corpus));
      report.capture = value.profile;
      save();
    });
    await context.addInitScript(() => {
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          if (String(args[0]).includes('web-engine-worker.js'))
            this.addEventListener('message', event => {
              if (event.data?.type === 'startup-crash-capture')
                globalThis.__crashCaptureSaved = globalThis.__saveCrashCapture(event.data.value);
            });
        }
      };
    });
    if (mode === 'dom') await context.route('**/index.html', async route => {
      const response = await route.fetch();
      let html = await response.text();
      const args = html.match(/arguments: (\[[^\n]+\]),/);
      assert(args);
      html = html.replace(args[0], 'arguments: ' +
        JSON.stringify([...JSON.parse(args[1]), '-WebShaderMetadataDOM']) + ',');
      await route.fulfill({response, body: html});
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      const capture = `
const crashPostMessage = globalThis.postMessage.bind(globalThis);
globalThis.postMessage = function(message, ...args) {
  if (message?.type === 'failure' && globalThis.__webStartupProfile) {
    const profile = globalThis.__webStartupProfile;
    crashPostMessage({type: 'startup-crash-capture', value: {
      corpus: profile.exportPSOCorpus(true),
      profile: {pipelines: profile.pipelines, modules: profile.modules, errors: profile.errors}
    }});
  }
  return crashPostMessage(message, ...args);
};`;
      await route.fulfill({response, body: 'globalThis.__webStartupPSOCorpus = true;\n' +
        recorder + '\n' + capture + '\n' + await response.text()});
    });
    const page = context.pages()[0];
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    const start = Date.now();
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 180,
      null, {timeout: 180000});
    report.elapsedMs = Date.now() - start;
    report.state = await page.evaluate(() => ({frames: globalThis.__webEngineFrames,
      failure: globalThis.__webEngineFailure, surface: globalThis.__webEngineSurface,
      diagnostics: typeof startupSnapshot === 'function' ? startupSnapshot() : null}));
    await page.evaluate(async () => {await globalThis.__crashCaptureSaved;});
    if (!report.state.failure) {
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
      assert(owner);
      const value = await owner.evaluate(() => ({
        corpus: __webStartupProfile.exportPSOCorpus(true),
        profile: {pipelines: __webStartupProfile.pipelines, modules: __webStartupProfile.modules,
          errors: __webStartupProfile.errors},
      }));
      report.corpus = output + '-corpus.json';
      fs.writeFileSync(report.corpus, JSON.stringify(value.corpus));
      report.capture = value.profile;
    }
    assert(!report.state.failure, report.state.failure);
    assert.deepEqual(report.errors, []);
    report.pass = true;
  } catch (error) {report.failure = error.stack; process.exitCode = 1;}
  finally {
    save();
    await context?.close();
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, corpus: report.corpus,
      pipelines: report.capture?.pipelines.length, output: output + '.json'}));
  }
})();
