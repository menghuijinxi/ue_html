const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const argument = name => {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  assert(process.argv[index + 1], `Missing value for ${name}`);
  return path.resolve(process.argv[index + 1]);
};
const sm5File = argument('--sm5') || path.join(results, 'web-engine-webgpu-cook-results.json');
const es31File = argument('--es31') || path.join(results, 'web-engine-webgpu-es31-cook-results.json');
const baselineFile = argument('--baseline');
const output = argument('--output') || path.join(results, 'web-engine-shader-profiles-results.json');
const report = {date: new Date().toISOString(), comparisonVerified: false,
  webgpuShaderCookVerified: false, hardwareEngineTickVerified: false,
  fullNormalUBTBuildVerified: false, completeUEScene: false};

function summarize(file) {
  const cook = read(file);
  assert(cook.shaderInventory && valid(cook.log) && valid(cook.shaderInventory.artifact),
    `Cook log and inventory must match: ${file}`);
  const inventory = read(cook.shaderInventory.artifact.file);
  assert.deepEqual(inventory, cook.shaderInventory.detail);
  assert.equal(inventory.types.length, inventory.registeredTypes);
  assert.equal(inventory.types.filter(item => item.permutations > 0).length, inventory.compiledTypes);
  assert.equal(inventory.types.reduce((total, item) => total + item.permutations, 0), inventory.permutations);
  const groups = new Map();
  for (const failure of cook.shaderFailures || []) {
    assert(valid(failure.diagnostic));
    assert.deepEqual(read(failure.diagnostic.file), failure.detail);
    const detail = failure.detail;
    const error = detail.error.split(/\r?\n/)[0];
    const key = JSON.stringify([detail.source, error]);
    if (!groups.has(key)) groups.set(key, {source: detail.source, error, count: 0,
      shaders: new Set(), jobs: new Set(), examples: []});
    const group = groups.get(key);
    ++group.count;
    group.shaders.add(detail.shaderName);
    group.jobs.add(detail.shader);
    if (group.examples.length < 2) group.examples.push(failure.diagnostic);
  }
  const directory = path.join(cook.output, 'ShaderConversion');
  const attempts = fs.readdirSync(directory, {withFileTypes: true}).filter(item => item.isDirectory());
  const count = name => attempts.filter(item => fs.existsSync(path.join(directory, item.name, name))).length;
  const inputs = attempts.filter(item => fs.existsSync(path.join(directory, item.name, 'input.json')))
    .map(item => ({directory: item.name, detail: read(path.join(directory, item.name, 'input.json'))}));
  const wgslWithoutRecordedFailure = attempts.filter(item =>
    fs.existsSync(path.join(directory, item.name, 'output.wgsl')) &&
    !fs.existsSync(path.join(directory, item.name, 'failure.json'))).length;
  const jobSummary = global => {
    const jobs = inputs.filter(item => item.detail.shader.startsWith('Global/') === global);
    const failures = (cook.shaderFailures || []).filter(item => item.detail.shader.startsWith('Global/') === global);
    return {distinctAttemptedJobs: new Set(jobs.map(item => item.detail.shader)).size,
      distinctFailedJobs: new Set(failures.map(item => item.detail.shader)).size,
      recordedFailures: failures.length};
  };
  return {
    report: audit(file), log: cook.log, inventory: cook.shaderInventory.artifact,
    cookPass: cook.pass, exitCode: cook.exitCode, stopOnShaderError: cook.stopOnShaderError,
    mode: cook.mode, format: inventory.format, platformEnum: inventory.platformEnum,
    mobile: inventory.mobile, supportsGeometryShaders: inventory.supportsGeometryShaders,
    minimalRendererSettingsVerified: cook.minimalRendererSettingsVerified ?? null,
    registeredTypes: inventory.registeredTypes, compiledTypes: inventory.compiledTypes,
    permutations: inventory.permutations, diagnosticAttempts: attempts.length,
    distinctAttemptedJobs: new Set(inputs.map(item => item.detail.shader)).size,
    settings: inventory.settings || null,
    spirvInputs: count('input.spv'), wgslOutputs: count('output.wgsl'),
    wgslWithoutRecordedFailure, recordedFailures: (cook.shaderFailures || []).length,
    distinctFailedJobs: new Set((cook.shaderFailures || []).map(item => item.detail.shader)).size,
    globalJobs: jobSummary(true), materialJobs: jobSummary(false),
    currentInputsMatch: [...cook.sourceFiles, ...cook.hostProducts].every(valid),
    failureGroups: [...groups.values()].sort((a, b) => b.count - a.count).map(group =>
      ({...group, distinctFailedJobs: group.jobs.size,
        shaders: [...group.shaders].sort(), jobs: [...group.jobs].sort()})),
    types: inventory.types
  };
}

function compare(before, after) {
  const prior = new Map(before.types.map(item => [item.name, item]));
  return {
    removedPermutations: before.permutations - after.permutations,
    reductionPercent: Math.round((1 - after.permutations / before.permutations) * 10000) / 100,
    changedTypes: after.types.filter(item => prior.get(item.name)?.permutations !== item.permutations)
      .map(item => ({name: item.name, source: item.source,
        before: prior.get(item.name)?.permutations ?? null, after: item.permutations})),
    newlyRegisteredTypes: after.types.filter(item => !prior.has(item.name)).map(item => item.name),
    missingRegisteredTypes: before.types.filter(item => !after.types.some(next => next.name === item.name))
      .map(item => item.name)
  };
}

try {
  report.sm5 = summarize(sm5File);
  report.es31 = summarize(es31File);
  assert.equal(report.sm5.format, 'SF_WEBGPU_SM5');
  assert.equal(report.es31.format, 'SF_WEBGPU_ES31');
  report.sm5ToES31 = compare(report.sm5, report.es31);
  if (baselineFile) {
    report.es31Baseline = summarize(baselineFile);
    assert.equal(report.es31Baseline.format, 'SF_WEBGPU_ES31');
    report.es31ConfigurationChange = compare(report.es31Baseline, report.es31);
  }
  for (const profile of [report.sm5, report.es31, report.es31Baseline].filter(Boolean)) delete profile.types;
  report.webgpuShaderCookVerified = report.es31.cookPass;
  report.sourceFiles = [audit(__filename)];
  report.boundary = 'Read-only comparison of actual native Cook inventories and recorded conversion failures. ' +
    'An inventory enumerates eligible permutations at capture time, not successful shaders or actual unique jobs. ' +
    'Repeated attempts of one shader job are counted separately from distinct failed jobs. WGSL files without a failure ' +
    'diagnostic are not proof of a complete shader map, archive, browser load or rendering. ' +
    'The browser build remains SM5; ES31 is an isolated Cook experiment on the installed 5.8.0 host.';
  report.comparisonVerified = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({comparisonVerified: report.comparisonVerified,
    webgpuShaderCookVerified: report.webgpuShaderCookVerified,
    sm5: report.sm5 && {permutations: report.sm5.permutations, cookPass: report.sm5.cookPass},
    es31: report.es31 && {permutations: report.es31.permutations,
      recordedFailures: report.es31.recordedFailures, distinctFailedJobs: report.es31.distinctFailedJobs,
      minimalRendererSettingsVerified: report.es31.minimalRendererSettingsVerified,
      cookPass: report.es31.cookPass},
    reductionPercent: report.sm5ToES31?.reductionPercent,
    configurationReduction: report.es31ConfigurationChange?.removedPermutations, failure: report.failure}, null, 2));
}
