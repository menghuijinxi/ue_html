const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const replayFile = path.join(results, 'web-material-cook-results.json');
const replay = read(replayFile), baseline = read(replay.baseline.file);
const verificationFile = path.join(results, 'web-resource-only-uniform-results.json');
const verification = read(verificationFile);
assert(valid(replay.baseline) && valid(replay.log) && valid(replay.inventory) &&
  replay.sourceFiles.every(valid) && replay.hostProducts.every(valid) && valid(replay.shaderSourcesReport));
assert(verification.pass && valid(verification.cook) && verification.cook.sha256 === sha(replayFile) &&
  verification.sourceFiles.every(valid) && verification.shaderEligibilityUnchanged);
assert(replay.pass && !replay.cookSucceeded && replay.exitCode === 3 && !replay.jobCacheAssertionObserved &&
  replay.jobCacheDDCDisabled && replay.debugValidationRetained);
assert.deepEqual(read(replay.inventory.file), baseline.shaderInventory.detail);
assert(valid(baseline.hostPreparationReport) && valid(baseline.hostPreparationLog) &&
  valid(baseline.nativeRenderCoreBuildReport));
const report = {
  ...baseline, date: replay.date, pass: false, output: replay.output, arguments: replay.arguments,
  exitCode: replay.exitCode, log: replay.log, sourceFiles: [...replay.sourceFiles, audit(__filename)],
  hostProducts: replay.hostProducts, shaderSourcesReport: replay.shaderSourcesReport,
  shaderInventory: {artifact: replay.inventory, detail: read(replay.inventory.file)},
  shaderFailures: replay.shaderFailures, failure: 'Material Cook failed with the installed Renderer parameter mismatch and unsupported material permutations; see the actual log.',
  diagnosticReplay: audit(replayFile), materialBindingVerification: audit(verificationFile),
  materialHostBuildReport: replay.nativeBuild, observedJobs: verification.observedJobs,
  jobCacheDDCDisabled: true, jobCacheAssertionObserved: false,
  boundary: 'Actual ES31 standard CookCommandlet execution from replay-web-material-cook.ps1, published without rerunning or altering jobs. Original package, shader eligibility, renderer settings and full job validation are retained. Per-job DDC is disabled to avoid the validation/cache assertion. Global and material jobs are reported separately. Cook failed; browser remains SM5 and a complete UE scene is not verified.',
};
fs.writeFileSync(path.join(results, 'web-engine-webgpu-es31-cook-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, exitCode: report.exitCode, observedJobs: report.observedJobs}, null, 2));
