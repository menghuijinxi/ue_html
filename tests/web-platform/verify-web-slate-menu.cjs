const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename),
  slateTransitionCrashFixed: false, previousBindGroupCrashFixed: false, checks: []};
function checked(name, verify) {
  const file = path.join(directory, name);
  const value = read(file);
  verify(value);
  report.checks.push(audit(file));
}
try {
  checked('user-slate-transition-crash-20261023.json', value => {
    assert(value.frames === 308 && value.failure === 'unreachable');
    assert(value.engineLog.some(line =>
      line.includes('Unsupported transition resource=SlateElementIndexBuffer before=0x8 after=0x70')));
    assert(!value.gpuHandles.failure);
  });
  checked('web-project-triplex-house-villa-slate-transition-before-edge-results.json', value => {
    assert(!value.pass && value.slateMenu && value.errors.some(error => error.includes('RHICreateTransition')));
    assert(value.diagnostics.engineLog.some(line =>
      line.includes('Unsupported transition resource=SlateElementIndexBuffer before=0x8 after=0x70')));
  });
  checked('web-slate-transitions-before-native-results.json', value => {
    assert(!value.pass && valid(value.runtime) && valid(value.log));
    const runtime = read(value.runtime.file);
    assert.deepEqual(runtime.errors, []);
    assert.deepEqual(runtime.transitions.checks.filter(check => !check.pass).map(check => check.name),
      ['slate-index-rdg-epilogue']);
  });
  checked('web-project-triplex-house-villa-slate-transition-after-smoke-edge-results.json', value => {
    assert(!value.pass && value.diagnostics.engineLog.some(line =>
      line.includes('WebGPU vertex element type unsupported: 15')));
  });
  checked('web-slate-transitions-native-results.json', value => {
    assert(value.pass && value.checks.length === 9 && value.checks.every(check => check.pass));
    assert(value.sources.every(valid) && value.products.every(valid) && valid(value.runtime) && valid(value.log));
    const runtime = read(value.runtime.file);
    assert(runtime.pass && runtime.errors.length === 0 && runtime.transitions.pass);
    assert(runtime.transitions.created === runtime.transitions.released && runtime.pendingTransitionCount === 0);
  });
  for (const name of ['web-static-uniforms-native-results.json', 'web-texture-streaming-native-results.json',
    'web-occlusion-native-results.json']) {
    checked(name, value => {
      assert(value.pass && value.sources.every(valid) && value.products.every(valid));
      for (const run of value.runs || [value]) {
        assert(valid(run.runtime) && valid(run.log) && read(run.runtime.file).pass);
      }
    });
  }
  checked('web-engine-full-build-results.json', value => {
    assert(value.pass && value.buildSucceeded && value.fullLinkAttempted);
    assert(value.sourceFiles.every(valid) && value.products.every(valid) && valid(value.log));
  });
  for (const name of ['web-project-triplex-house-villa-package-results.json',
    'web-default-template-package-results.json']) {
    checked(name, value => {
      assert(value.pass && value.sourceFiles.every(valid) && value.products.every(valid));
      assert(valid(value.buildReport));
    });
  }
  for (const browser of ['edge', 'chrome']) {
    checked(`web-project-triplex-house-villa-slate-menu-final-${browser}-results.json`, value => {
      assert(value.pass && value.slateMenu && value.resize && value.seconds >= 60 && value.requireHandles);
      assert(valid(value.source) && valid(value.packageReport) && valid(value.screenshot));
      assert(value.menu.gpu.slatePipelines > 0 && value.menu.gpu.slateDraws > 0);
      assert(value.widget.gpu.slateDraws > 0 && value.final.frame > value.widget.frame + 60 &&
        value.final.gpu.slateDraws > value.widget.gpu.slateDraws);
      assert(value.samples.some(sample => sample.label === 'slate-widget-closed'));
      assert(value.errors.length === 0 && value.engineErrors.length === 0 && value.samples.every(sample =>
        !sample.failure && !sample.handles?.failure && !sample.gpu.errors.length && !sample.gpu.deviceLosses.length));
    });
  }
  checked('web-default-scene-results.json', value => {
    assert(value.pass && value.packaged && valid(value.packageReport));
    assert(value.browserRuns.length === 2 && value.browserRuns.every(run =>
      run.pass && !run.failure && !run.errors.length));
  });
  report.slateTransitionCrashFixed = true;
  report.boundary = 'Verified the frame-308 Slate transition assertion and the subsequent UShort2 pipeline gap. ' +
    'Map travel also reports InvalidURL and falls back to reloading the scene; this is not fixed here. ' +
    'The material widget submits repeated Slate draws but is not correctly visible in the screenshot; UI appearance is not accepted. ' +
    'The earlier bind-group handle crash and synthetic streaming/resize stress failures remain unresolved.';
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(directory, 'web-slate-menu-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = report.pass ? 0 : 1;
}
