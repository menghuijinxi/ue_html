const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, originalCrashFixed: false,
  source: audit(__filename), checks: [], knownFailures: []};
function checked(name, verify) {
  const file = path.join(directory, name);
  const value = read(file);
  assert(value.pass, name);
  verify(value);
  report.checks.push(audit(file));
}
try {
  const original = path.join(directory, 'user-bindgroup-crash-20261023.json');
  const user = read(original);
  assert(user.frames === 991 && user.errors.some(error =>
    error.stack?.includes('_wgpuRenderPassEncoderSetBindGroup')));
  report.userCrash = audit(original);
  checked('web-engine-full-build-results.json', value => {
    assert(value.buildSucceeded && value.fullLinkAttempted && value.sourceFiles.every(valid) &&
      value.products.every(valid) && valid(value.log));
  });
  for (const name of ['web-project-triplex-house-villa-package-results.json',
    'web-default-template-package-results.json']) {
    checked(name, value => {
      assert(value.sourceFiles.every(valid) && value.products.every(valid));
      const html = value.products.find(item => path.basename(item.file) === 'index.html');
      assert(fs.readFileSync(html.file, 'utf8').includes('gpuHandles: globalThis.__webGPUHandleDiagnostics'));
    });
  }
  checked('web-bindgroup-lifetime-results.json', value => {
    assert(value.sources.every(valid) && valid(value.build));
    const build = read(value.build.file);
    assert(build.pass && build.sources.every(valid) && build.variants.every(variant =>
      variant.products.every(valid) && valid(variant.log)));
    assert(value.runs.length === 16 && value.runs.every(run => run.pass));
  });
  for (const browser of ['edge', 'chrome']) {
    checked(`web-project-triplex-house-villa-handle-diagnostics-final-${browser}-results.json`, value => {
      assert(valid(value.source) && valid(value.packageReport) && valid(value.screenshot));
      assert(value.final.frame > value.initial.frame + 60 && value.requireHandles &&
        value.samples.every(sample => sample.handles?.version === 1 && !sample.handles.failure &&
          !sample.failure && !sample.gpu.errors.length && !sample.gpu.deviceLosses.length));
    });
  }
  checked('web-default-scene-results.json', value => {
    assert(valid(value.packageReport) && value.browserRuns.length === 2 &&
      value.browserRuns.every(run => run.pass && !run.failure && !run.errors.length));
  });
  for (const name of [
    'web-project-triplex-house-villa-bindgroup-fast-churn-before-edge-results.json',
    'web-project-triplex-house-villa-handle-churn-debug-edge-results.json']) {
    const file = path.join(directory, name), value = read(file);
    assert(!value.pass && value.failure);
    report.knownFailures.push({...audit(file), failure: value.failure,
      boundary: 'Synthetic budget/resize stress failure; not a reproduction of the user handle assertion.'});
  }
  report.boundary = 'Verified bounded diagnostic capture and normal rendering only. Original frame-991 handle ' +
    'assertion remains unresolved. Injected release/invalid-pointer faults verify reporting, not a production fix. ' +
    'Synthetic per-frame budget/resize stress also produced renderer exit/timeouts; they remain unresolved.';
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(directory, 'web-handle-diagnostics-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, originalCrashFixed: report.originalCrashFixed,
    checks: report.checks.length, knownFailures: report.knownFailures.length, failure: report.failure}));
  process.exitCode = report.pass ? 0 : 1;
}
