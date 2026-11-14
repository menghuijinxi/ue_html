'use strict';
const {initializeProjectOutput, assertProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const base = path.resolve(__dirname, '..');
const input = relative => {
  const file = path.join(base, relative);
  return {value: JSON.parse(fs.readFileSync(file, 'utf8')), source: audit(file)};
};
const experiments = ['villa-alloff-pressure-20261112', 'villa-all-webopts-off-20261112',
  'villa-alloff-dawn-20261112', 'villa-alloff-abba-space-20261112',
  'villa-alloff-framebudget-abba-20261112', 'villa-alloff-computepass-abba-20261112',
  'villa-alloff-computepass-abba-retry-20261112'].map(name => {
  const {value, source} = input('results/' + name + '/result.json');
  const runs = value.runs.map(run => {
    for (const phase of run.phases) {
      assert(phase.summary && phase.gpuCompletionSummary);
      assert.equal(phase.before.prewarm.counts.misses, phase.after.prewarm.counts.misses);
      assert.deepEqual(phase.capture.creations, []);
      assert.equal(phase.after.streaming.pending, 0);
      if (phase.kind === 'input') assert(phase.yawTravel > 50 && phase.after.player.active);
      assert.deepEqual([phase.after.view.width, phase.after.view.height, phase.after.view.outputWidth,
        phase.after.view.outputHeight, phase.after.view.antiAliasing], [1400, 788, 1920, 1080, 4]);
      for (const setting of ['gi', 'reflections', 'virtualShadows', 'virtualTextures'])
        assert.equal(phase.after.settings[setting], 1);
    }
    return {name: run.name, index: run.index, gpuBefore: run.gpuBefore, gpuAfterClose: run.gpuAfterClose,
      search: run.search,
      errors: run.errors,
      measured: run.phases.length === 2, overrides: run.overrides, resources: run.initial?.resources,
      phases: run.phases.map(phase => {
        const times = phase.capture.times, details = phase.capture.details;
        const worst = details?.length ? times.slice(1).map((time, index) => ({
          intervalMs: time - times[index], rhiWorkMs: details[index + 1].rhiMs - details[index].rhiMs,
          gameTickMs: details[index + 1].gameMs, pendingTextures: details[index + 1].pendingTextures,
          scheduler: details[index + 1].scheduler,
        })).sort((a, b) => b.intervalMs - a.intervalMs).slice(0, 5) : [];
        return {kind: phase.kind, summary: phase.summary, gpuCompletion: phase.gpuCompletionSummary,
          gpu: phase.gpu, yawTravel: phase.yawTravel, noMeasuredPipelineMiss: true, worst};
      })};
  });
  return {name, source, fullExperimentPassed: value.pass, error: value.error, seconds: value.seconds,
    retainCooks: value.retainCooks, order: value.order,
    startupFailures: value.startupFailures, runs};
});
assert(experiments[2].fullExperimentPassed);
assert(!experiments[0].fullExperimentPassed && !experiments[1].fullExperimentPassed);
assert(experiments[3].fullExperimentPassed && experiments[3].runs.length === 4 &&
  experiments[3].runs.every(run => run.measured) && experiments[3].retainCooks);
assert(experiments[4].fullExperimentPassed && experiments[4].runs.every(run => run.measured));
assert.deepEqual(experiments[4].order, ['previous', 'previous4', 'previous4', 'previous']);
const frameBudgetRejected = ['turning', 'input'].every(kind => {
  const low = name => experiments[4].runs.filter(run => run.name === name)
    .map(run => run.phases.find(phase => phase.kind === kind).summary.low1);
  return Math.max(...low('previous4')) < Math.min(...low('previous'));
});
assert(frameBudgetRejected);
assert(!experiments[5].fullExperimentPassed);
assert(experiments[5].runs.some(run => run.errors.some(message => /external Instance reference/.test(message))));
assert(experiments[6].fullExperimentPassed && experiments[6].runs.every(run => run.measured));
assert.deepEqual(experiments[6].order, ['previous', 'passoff', 'passoff', 'previous']);
const oldFolder = 'build/villa-vsm-sampling-adaptive-20261112/';
const newFolder = 'build/villa-tsr-tiles-20261112/';
const oldContent = input(oldFolder + 'content-files.json');
const newContent = input(newFolder + 'content-files.json');
const oldFiles = new Map(oldContent.value.files.map(file => [file.path, file]));
assert.equal(oldFiles.size, newContent.value.files.length);
const changed = newContent.value.files.filter(file => {
  assert(oldFiles.has(file.path));
  return oldFiles.get(file.path).sha256 !== file.sha256;
}).map(file => file.path);
assert.equal(changed.length, 2);
assert(changed.some(file => file.endsWith('/GlobalShaderCache-SP_WEBGPU_SM5.bin')));
assert(changed.some(file => file.endsWith('/ShaderArchive-Global-SF_WEBGPU_SM5-SP_WEBGPU_SM5.ushaderbytecode')));
const oldWorkerFile = path.join(base, oldFolder, 'web-engine-worker.js');
const replacementLine = fs.readFileSync(oldWorkerFile, 'utf8').split('\n').find(line => line.startsWith('})([{'));
assert(replacementLine?.endsWith('],true);'));
const replacements = JSON.parse(replacementLine.slice(3, -7));
const corpus = input(newFolder + 'pipeline-prewarm.json');
const normalized = code => code.replaceAll('\r\n', '\n').trim().replace(/\bmain_[a-f0-9_]+\b/g, 'main');
const adaptiveShaders = replacements.map(variant => {
  const code = normalized(variant.replacements[0].adaptive);
  const matches = corpus.value.modules.filter(module => normalized(module.descriptor.code) === code);
  assert.equal(matches.length, 1);
  return {oldEntry: variant.entry, permutation: variant.permutation, identicalExceptEntryAndWhitespace: true};
});
assert.deepEqual(adaptiveShaders.map(shader => shader.permutation).sort(), [17, 18]);
const qa = input('results/villa-isolation-live-20261112/result.json');
const packages = input('results/villa-optimization-isolation-packages-20261112.json');
assert(qa.value.pass && packages.value.pass); assert.deepEqual(qa.value.errors, []);
for (const mode of ['off', 'plain']) {
  const record = qa.value.states.find(state => state.page.mode === mode); assert(record);
  assert(record.tsrGroups[256] > 0 && !record.tsrGroups[1024]);
  assert.equal(record.rhi.indirectDrawReuse, 0); assert.equal(record.rhi.vsmPageOptimization, 0);
  assert.equal(record.isolation.mode, mode);
  if (mode === 'plain') assert.equal(record.rhi.reuseComputePass, false);
  assert.equal(audit(packages.value.variants[mode].manifest.file).sha256,
    packages.value.variants[mode].manifest.sha256);
}
const traceFile = input('results/villa-alloff-dawn-20261112/result.json').value.runs[0].trace;
assert.equal(audit(traceFile.file).sha256, traceFile.sha256);
const events = JSON.parse(fs.readFileSync(traceFile.file, 'utf8')).traceEvents;
const trace = ['WebGPU', 'v8.callFunction', 'MinorGC', 'MajorGC'].map(name => {
  const entries = events.filter(event => event.ph === 'X' && event.name === name);
  return {name, count: entries.length, totalMs: entries.reduce((sum, event) => sum + event.dur / 1000, 0),
    maxMs: Math.max(...entries.map(event => event.dur / 1000))};
});
const gpuNames = input('evidence/vsm-remaining-costs-20261111.json');
const gpuProbes = ['villa-alloff-gpu-20261112', 'villa-alloff-gpu-dense-20261112'].map(name => {
  const record = input('results/' + name + '/result.json'), value = record.value;
  assert(value.pass);
  assert.deepEqual(value.errors, []);
  assert.deepEqual(value.gpuValidationErrors, []);
  const catalog = JSON.parse(fs.readFileSync(value.catalog.file, 'utf8'));
  assert.equal(audit(value.catalog.file).sha256, value.catalog.sha256);
  return {name, source: record.source, phases: value.phases.map(phase => {
    assert.equal(phase.gpuFrames.length, value.gpuSamples || 6);
    assert.equal(phase.after.prewarm.counts.misses, phase.before.prewarm.counts.misses);
    assert.equal(phase.after.occlusion.vsmPageOptimization, 0);
    assert.equal(phase.after.occlusion.indirectDrawReuse, 0);
    assert.equal(phase.after.occlusion.reuseComputePass, false);
    assert.deepEqual([phase.after.view.width, phase.after.view.height, phase.after.view.outputWidth,
      phase.after.view.outputHeight, phase.after.view.antiAliasing], [1400, 788, 1920, 1080, 4]);
    for (const setting of ['gi', 'reflections', 'virtualShadows', 'virtualTextures'])
      assert.equal(phase.after.settings[setting], 1);
    const groups = {};
    const frames = phase.gpuFrames.map(({capture}) => {
      assert(capture.entries.length && capture.entries.length < 1024);
      for (const entry of capture.entries) {
        assert(Number.isFinite(entry.gpuMs) && entry.gpuMs >= 0);
        const code = catalog[entry.pipeline];
        const label = gpuNames.value.shaderNames[entry.pipeline]?.name ||
          (code?.includes('WebTSRAnyThreadResult') ? 'FTSRRejectShadingCS' :
            code?.includes('SMRTAdaptive') ? 'FVirtualShadowMapProjectionCS' :
              entry.pipeline || entry.target?.label || entry.label);
        groups[label] = (groups[label] || 0) + entry.gpuMs;
      }
      return {frame: capture.presented, totalPassMs: capture.totalPassMs,
        spanMs: Math.max(...capture.entries.map(entry => entry.gpuStartMs + entry.gpuMs)),
        submissionIntervalMs: capture.submissionIntervalMs};
    });
    const mean = key => frames.reduce((sum, frame) => sum + frame[key], 0) / frames.length;
    return {name: phase.name, samples: frames.length, meanPassMs: mean('totalPassMs'),
      meanSpanMs: mean('spanMs'), maxSpanMs: Math.max(...frames.map(frame => frame.spanMs)),
      correlatedFrames: frames.filter(frame => Number.isFinite(frame.submissionIntervalMs)).length,
      sampledSubmissionOver40ms: frames.filter(frame => frame.submissionIntervalMs > 40).length,
      longestSampledSubmission: frames.filter(frame => Number.isFinite(frame.submissionIntervalMs))
        .sort((a, b) => b.submissionIntervalMs - a.submissionIntervalMs).slice(0, 5),
      topPasses: Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([name, total]) => ({name, meanMs: total / frames.length}))};
  })};
});
const evidence = {date: new Date().toISOString(), pass: true, diagnosticOnly: true,
  causeIsolated: false, completeStutterFixProven: false, productionDefaultsChanged: false,
  rejectedFrameBudget4: frameBudgetRejected,
  narrowedTo: 'GPU completion / browser GPU service and frame scheduling; exact shader or driver call unresolved',
  page: 'http://127.0.0.1:8765/villa-smoothness-live.html#off',
  measuredBoundary: 'Earlier partial experiments retain completed windows and failed final runs. A new 30-second ' +
    'old/off/off/old ABBA passed after disk space was released, with both Cooks retained in diagnostic cache. ' +
    'Old-version Low varied substantially between its two runs; no stable regression percentage is claimed. ' +
    'GPU resource byte estimates are not ' +
    'driver residency; browser WebGPU trace spans measure service CPU work, not hardware shader execution. ' +
    'The trace is separate from FPS windows. Diagnostic startup overrides can miss original prewarm at startup, ' +
    'but measured phases have no new pipeline creation or misses. Temporal history restarts after mode changes.',
  experiments, qa: qa.source, inputChecks: qa.value.checks.filter(check => check.mode), packages: packages.source,
  inputComparison: {sources: [oldContent.source, newContent.source, audit(oldWorkerFile), corpus.source],
    files: oldFiles.size, changed, adaptiveShaders},
  trace: {source: traceFile, groups: trace},
  gpuProbes: {names: gpuNames.source, runs: gpuProbes,
    boundary: 'Split compute passes and timestamp queries change workload and readback cadence. Dense sampled ' +
      'frames did not reproduce the original long tail; selected sample intervals do not describe every frame. ' +
      'These captures are not production FPS results and do not exclude GPU work during unobserved long frames.'},
  sources: ['diagnostics/benchmark-villa-release-regression.cjs', 'diagnostics/villa-gpu-memory-observer.cjs',
    'diagnostics/verify-villa-gpu-memory-observer.cjs', 'diagnostics/prepare-villa-optimization-isolation.cjs',
    'diagnostics/probe-vsm-remaining-costs.cjs', 'web-performance-capture-observer.cjs',
    'diagnostics/summarize-villa-optimization-isolation.cjs', 'villa-smoothness-live.html',
    'villa-smoothness-live.js', 'verify-villa-smoothness-live.cjs'].map(file => audit(path.join(base, file)))};
const output = assertProjectOutput(path.join(base, 'evidence/villa-optimization-isolation-20261112.json'));
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, causeIsolated: false, output}));
