'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseline = option('baseline') || 'triplex-project-distance-fields-threads';
const candidate = option('candidate') || 'villa-rhi-adaptation-candidate';
const tagPrefix = option('tag') || 'adaptation';
const warmupSeconds = Number(option('warmup-seconds') || 20);
const gpuSceneRecook = process.argv.includes('--allow-gpuscene-recook');
const manualFetchRecook = process.argv.includes('--allow-manual-fetch-recook');
assert(!(gpuSceneRecook && manualFetchRecook));
assert(warmupSeconds >= 0 && warmupSeconds <= 120);
assert([baseline, candidate, tagPrefix].every(value => /^[a-z0-9-]+$/.test(value)));
const root = path.join(__dirname, 'build');
const report = {date: new Date().toISOString(), settingsOverrides: [], warmupSeconds,
  gpuSceneRecook, manualFetchRecook,
  headless: process.argv.includes('--headless'),
  width: 1863, height: 1030, dpr: 1.25, order: ['baseline', 'candidate', 'candidate', 'baseline'],
  packages: {}, runs: [], pass: false};
const output = path.join(__dirname, 'results', tagPrefix + '-abba.json');
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
for (const [name, folder] of Object.entries({baseline, candidate})) {
  report.packages[name] = {folder, files: Object.fromEntries(['content.bin', 'config-files.json',
    'UEWebEngineThreads.wasm'].map(file => [file, audit(path.join(root, folder, file))]))};
}
if (gpuSceneRecook || manualFetchRecook) {
  // GPUScene changes material/global shader permutations, so the Cook payload must change.
  // Require matching project inputs and permit exactly the two SM5 capability changes.
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const cooks = {};
  for (const name of ['baseline', 'candidate']) {
    const file = option(name + '-cook');
    assert(file, 'Recook comparisons require --baseline-cook and --candidate-cook reports');
    const cook = read(file);
    assert(cook.pass && cook.useProjectSettings && cook.scene === 'Project' && cook.mode === 'WebGPU-SM5');
    assert.equal(cook.shaderInventory.detail.gpuSceneEnabled, manualFetchRecook || name === 'candidate');
    if (manualFetchRecook) assert.equal(cook.shaderInventory.detail.manualVertexFetchEnabled === true, name === 'candidate');
    assert.equal(audit(cook.projectSettings.file).sha256, cook.projectSettings.sha256);
    cooks[name] = {cook, settings: read(cook.projectSettings.file), report: audit(file)};
  }
  for (const key of ['project', 'map', 'distanceFields', 'textureCompression', 'compressHDRCubemaps',
    'disabledSkyLight', 'templateEnvironment']) assert.deepEqual(cooks.baseline.cook[key], cooks.candidate.cook[key]);
  assert.deepEqual(cooks.baseline.settings, cooks.candidate.settings);
  assert.deepEqual(cooks.candidate.settings.rendererOverrides, []);
  for (const item of cooks.candidate.settings.sourceFiles) assert.equal(audit(item.file).sha256, item.sha256);
  const configs = Object.fromEntries(['baseline', 'candidate'].map(name => [name,
    read(path.join(root, report.packages[name].folder, 'config-files.json'))]));
  const ddpi = '/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini';
  assert.deepEqual(configs.baseline.filter(item => item.path !== ddpi),
    configs.candidate.filter(item => item.path !== ddpi));
  const before = Buffer.from(configs.baseline.find(item => item.path === ddpi).data, 'base64').toString('utf8').replaceAll('\r\n', '\n');
  const after = Buffer.from(configs.candidate.find(item => item.path === ddpi).data, 'base64').toString('utf8').replaceAll('\r\n', '\n');
  const enable = text => text.replace(/(\[ShaderPlatform SP_WEBGPU_SM5\][\s\S]*?)(?=\[ShaderPlatform|$)/,
    section => manualFetchRecook ? section.replace('bSupportsManualVertexFetch=false', 'bSupportsManualVertexFetch=true') :
      section.replace('bSupportsGPUScene=false', 'bSupportsGPUScene=true')
        .replace('bSupportsVertexShaderSRVs=false', 'bSupportsVertexShaderSRVs=true'));
  assert.notEqual(before, after);
  assert.equal(enable(before), after);
  report.cookEvidence = Object.fromEntries(Object.entries(cooks).map(([name, value]) => [name,
    {report: value.report, projectSettings: value.cook.projectSettings,
      gpuSceneEnabled: value.cook.shaderInventory.detail.gpuSceneEnabled,
      manualVertexFetchEnabled: value.cook.shaderInventory.detail.manualVertexFetchEnabled === true}]));
} else {
  for (const file of ['content.bin', 'config-files.json'])
    assert.equal(report.packages.baseline.files[file].sha256, report.packages.candidate.files[file].sha256);
}
(async () => {
  try {
    for (const [i, name] of report.order.entries()) {
      const tag = tagPrefix + '-abba-' + i + '-' + name;
      const code = await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [path.join(__dirname, 'capture-web-performance.cjs'),
          '--folder=' + report.packages[name].folder, '--tag=' + tag, '--width=1863', '--height=1030',
          '--dpr=1.25', '--baseline-only', '--baseline-seconds=15', '--warmup-seconds=' + warmupSeconds,
          ...(report.headless ? ['--headless'] : []),
          ...(process.argv.includes('--binding-group-abba') ? ['--binding-group-mode=' + (name === 'candidate' ? 1 : 0)] : []),
          ...(name === 'candidate' && process.argv.includes('--require-candidate-bundles') ? ['--require-render-bundles'] : [])],
          {stdio: 'inherit', windowsHide: true});
        child.on('error', reject); child.on('close', resolve);
      });
      assert.equal(code, 0);
      const file = path.join(__dirname, 'results', 'performance-capture-' + tag + '.json');
      const value = JSON.parse(fs.readFileSync(file));
      assert(value.pass && value.cameraMode === 'original-spawn' && !value.errors.length);
      assert(value.externalInputIgnored && value.initialCamera);
      if (gpuSceneRecook) assert.equal(value.engineReady?.activeGPUSceneEnabled, name === 'candidate');
      if (manualFetchRecook && name === 'candidate') {
        assert.equal(value.afterBaseline.occlusion.manualVertexFetchEnabled, true);
        assert(value.afterBaseline.occlusion.manualVertexFetchDraws > value.before.occlusion.manualVertexFetchDraws);
      }
      if (report.runs.length) assert.deepEqual(value.initialCamera, report.runs[0].camera);
      if (report.runs.length) assert.deepEqual(value.before.settings, report.runs[0].settings);
      const view = value.before.view;
      const dimensions = [view.width, view.height, view.outputWidth, view.outputHeight, view.antiAliasing];
      if (report.runs.length) assert.deepEqual(dimensions, report.runs[0].dimensions);
      const perFrame = {};
      const counterFrames = value.afterBaseline.occlusion.sampleFrame === undefined ? value.baseline.frames :
        value.afterBaseline.occlusion.sampleFrame - value.before.occlusion.sampleFrame;
      assert(counterFrames > 0);
      for (const key of ['bindGroupsCreated', 'bindingEntriesPrepared', 'bindingEntriesReused',
        'uniformSnapshots', 'uniformWriteCalls', 'bindGroupCacheHits', 'draws', 'indirectDraws', 'dispatches',
        'resourceTableCommits', 'resourceTableBuffers', 'bindingRouteResolutions', 'manualVertexFetchDraws',
        'groupPreparationHits', 'groupPreparationValidated', 'groupFrameMisses', 'groupAccessMisses',
        'groupVersionMisses', 'groupTextureMisses']) {
        if (value.afterBaseline.occlusion[key] === undefined) continue;
        perFrame[key] = (value.afterBaseline.occlusion[key] - value.before.occlusion[key]) / counterFrames;
      }
      report.runs.push({name, file, dimensions, camera: value.initialCamera,
        settings: value.before.settings, engineReady: value.engineReady, perFrame, counterFrames,
        counterFramesEstimated: value.afterBaseline.occlusion.sampleFrame === undefined,
        baseline: value.baseline, samples: value.baselineSamples});
      save();
    }
    report.fps = Object.fromEntries(['baseline', 'candidate'].map(name => {
      const runs = report.runs.filter(run => run.name === name);
      return [name, runs.reduce((s, r) => s + r.baseline.frames, 0) /
        runs.reduce((s, r) => s + r.baseline.milliseconds, 0) * 1000];
    }));
    report.improvementPercent = (report.fps.candidate / report.fps.baseline - 1) * 100;
    report.rhiWorkMsPerFrame = Object.fromEntries(['baseline', 'candidate'].map(name => {
      const runs = report.runs.filter(run => run.name === name);
      return [name, runs.reduce((s, r) => s + r.baseline.rhiWorkMsPerFrame * r.baseline.frames, 0) /
        runs.reduce((s, r) => s + r.baseline.frames, 0)];
    }));
    report.pass = true;
    console.log(JSON.stringify({pass: true, fps: report.fps, improvementPercent: report.improvementPercent, output}));
  } finally { save(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
