'use strict';
const {initializeProjectOutput, assertProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const base = path.resolve(__dirname, '..');
const load = relative => {
  const file = path.join(base, relative);
  return {value: JSON.parse(fs.readFileSync(file, 'utf8')), source: audit(file)};
};
const parameters = load('results/villa-package-parameters-20261113.json');
assert(parameters.value.pass && parameters.value.historicalLinkFlags.identical);
assert.equal(parameters.value.changedContent.length, 2);
const experiments = ['villa-runtime-isolation-abba-20261113', 'villa-package-factors-20261113',
  'villa-runtime-factor-retry-20261113', 'villa-runtime-factor-package-abba-20261113',
  'villa-runtime-factor-incompatible-20261113'].map(name => {
  const {value, source} = load('results/' + name + '/result.json');
  assert(!value.pass, 'These attempts did not complete the planned experiment');
  assert.equal(audit(value.source.file).sha256, value.source.sha256);
  return {name, source, fullExperimentPassed: value.pass,
    expectedIncompatibilityFailure: name === 'villa-runtime-factor-incompatible-20261113',
    error: value.error, order: value.order,
    seconds: value.seconds, runs: value.runs.map(run => {
      const measured = run.phases.filter(phase => phase.summary);
      for (const phase of measured) {
        assert.equal(phase.before.prewarm.counts.misses, phase.after.prewarm.counts.misses);
        assert.deepEqual(phase.capture.creations, []);
        assert.deepEqual([phase.after.view.width, phase.after.view.height,
          phase.after.view.outputWidth, phase.after.view.outputHeight, phase.after.view.antiAliasing],
        [1400, 788, 1920, 1080, 4]);
        for (const key of ['gi', 'reflections', 'virtualShadows', 'virtualTextures'])
          assert.equal(phase.after.settings[key], 1);
        assert(phase.yawTravel > 50 || phase.kind !== 'input');
        const times = phase.capture.times;
        const intervals = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => b - a);
        const slow = intervals.slice(0, Math.ceil(intervals.length * .01));
        assert.equal(phase.summary.low1, 1000 * slow.length / slow.reduce((sum, value) => sum + value, 0));
      }
      return {name: run.name, actualStartup: run.actualStartup, errors: run.errors,
        completeMeasuredWindows: measured.length === value.phases.length,
        phases: measured.map(phase => ({kind: phase.kind, summary: phase.summary,
          prewarmMissesBefore: phase.before.prewarm.counts.misses,
          prewarmMissesAfter: phase.after.prewarm.counts.misses, gpu: phase.gpu}))};
    })};
});
const flagComparison = experiments[1].runs.filter(run => run.completeMeasuredWindows);
assert.deepEqual(flagComparison.map(run => run.name), ['oldforced', 'old']);
for (const run of flagComparison)
  assert.equal(run.actualStartup.arguments.includes('-ForceRes'), run.name === 'oldforced');
assert.equal(flagComparison[0].actualStartup.wasm, flagComparison[1].actualStartup.wasm);
assert.equal(flagComparison[0].actualStartup.content, flagComparison[1].actualStartup.content);
const compatibility = experiments.at(-1);
assert.equal(compatibility.runs[0].phases.length, 0);
assert.equal(compatibility.runs[0].actualStartup.wasm, parameters.value.packages.off.wasm.sha256);
assert.equal(compatibility.runs[0].actualStartup.content, parameters.value.packages.old.content);
const compatibilityLog = path.join(base, 'results', compatibility.name, 'run-1-0.log');
assert.match(fs.readFileSync(compatibilityLog, 'utf8'),
  /Missing global shader FTSRRejectShadingCS's permutation 19/);
const missingRuntime = path.join(base, 'build/villa-vsm-pages-final-20261112');
const missingManifest = path.join(missingRuntime, 'asset-versions.json');
assert(fs.lstatSync(missingRuntime).isSymbolicLink());
assert(!fs.existsSync(missingManifest));
const output = assertProjectOutput(path.join(base, 'evidence/villa-package-parameters-20261113.json'));
const evidence = {date: new Date().toISOString(), pass: true, diagnosticOnly: true,
  productionDefaultsChanged: false, archivedPackagesModified: false, performanceRegressionFixed: false,
  source: audit(__filename), parameters: parameters.source, findings: {
    hostAndCacheCodeIdentical: true, frameClockAndBudgetIdentical: true, fixedOutputIdentical: true,
    historicalLinkFlagsIdentical: true,
    plainDisablesEarlierEnabledSettings: parameters.value.effectiveSettingDifferences.filter(item =>
      /^r\.Web(GPU)?\./.test(item.key) && Number(item.values.old) > 0 &&
      item.values.off === item.values.old && item.values.plain === '0').map(item => item.key),
    flagComparison, flagComparisonBoundary: 'One valid pair with mixed Low directions; full six-run plan failed. ' +
      'No systematic slowdown established and no general exclusion claimed.',
    currentRuntimeOldCookCompatible: false, incompatibility: 'FTSRRejectShadingCS permutation 19 missing',
    compatibilityLog: audit(compatibilityLog), repeatedIncompatibilityVerified: true,
    missingPreTSRRuntime: missingManifest,
    nextRequiredIsolation: 'Restore or rebuild a pre-TSR compatible runtime with matching Cook. ' +
      'Runtime switch-off does not restore the compiled permutation domain.',
  }, experiments,
  boundary: 'Audit and evidence verification passed. All four planned performance experiments remain failed; ' +
    'only individually completed windows are reported. No definitive cause or repair of sustained Low regression.'};
assert.equal(evidence.findings.plainDisablesEarlierEnabledSettings.length, 13);
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, fullPerformanceExperimentsPassed: 0,
  plainDisablesEarlierEnabledSettings: evidence.findings.plainDisablesEarlierEnabledSettings.length}));
