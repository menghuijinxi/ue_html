'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = n => process.argv.find(v => v.startsWith('--' + n + '='))?.slice(n.length + 3);
const files = option('reports').split(','), output = option('output');
assert(output && !fs.existsSync(output),'Use a fresh evidence path');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const verified = item => {assert.equal(audit(item.file).sha256,item.sha256,item.file);return item;};
const reports = files.map(read); assert(reports.every(r => r.pass));
const runs = reports.flatMap(r => r.runs); assert(runs.every(r => r.pass));
const root = path.resolve(__dirname, '../..');
const portable = f => ({file: path.relative(root, path.resolve(f)).replaceAll('\\', '/'), sha256: audit(f).sha256});
const reference = reports[0].packageFiles;
const stableView = v => Object.fromEntries(Object.entries(v).filter(([k]) => !['frame','threadId'].includes(k)));
for (const r of reports) {
  verified(r.source);r.packageFiles.forEach(verified);
  assert(!r.tour && r.qualityOverrides.length===0);
  assert.deepEqual(r.packageFiles.map(f => f.sha256), reference.map(f => f.sha256));
  for (const run of r.runs) {
    assert(!run.errors.length && !run.after.failure);
    assert(run.idleGpu.adapters?.every(v=>v.utilization<=50));
    assert(run.before.streaming.pending===0 && run.after.streaming.pending===0);
    assert.deepEqual(run.before.camera,runs[0].before.camera);
    assert.deepEqual(run.before.settings,runs[0].before.settings);
    assert.deepEqual(stableView(run.before.view),stableView(runs[0].before.view));
    assert.deepEqual(run.before.culling,run.after.culling);
  }
}
const mean = (rs, field, key) => rs.reduce((s, r) => s + (key ? r[field][key] : r[field]) * r.measurement.frames, 0) /
  rs.reduce((s, r) => s + r.measurement.frames, 0);
function distribution(values) {
  const sorted = [...values].sort((a,b) => a-b), tail = sorted.slice(-Math.ceil(sorted.length * .01));
  return {count: sorted.length, low1Fps: tail.length * 1000 / tail.reduce((s,v) => s+v,0),
    p50Ms: sorted[Math.floor(sorted.length * .5)], p99Ms: sorted[Math.floor(sorted.length * .99)], maxMs: sorted.at(-1)};
}
const summary = {};
for (const mode of new Set(runs.map(r => r.mode))) {
  const rs = runs.filter(r => r.mode === mode);
  const entry = summary[mode] = {runs: rs.map(r => ({fps:r.fps, low1Fps:r.frameMs.low1Fps})),
    fps: rs.reduce((s,r) => s+r.measurement.frames,0)*1000 / rs.reduce((s,r) => s+r.measurement.end-r.measurement.start,0),
    intervals: distribution(rs.flatMap(r => r.intervals)), rhiMs: mean(rs,'rhiMs'), workload:{}, history:{}};
  for (const k of Object.keys(rs[0].workload)) entry.workload[k] = rs.reduce((s,r)=>s+r.after.occlusion[k]-r.before.occlusion[k],0) /
    rs.reduce((s,r)=>s+r.after.occlusion.sampleFrame-r.before.occlusion.sampleFrame,0);
  for (const k of Object.keys(rs[0].history)) entry.history[k] = rs.reduce((s,r)=>s+r.after.history[k]-r.before.history[k],0) /
    rs.reduce((s,r)=>s+r.after.history.frame-r.before.history.frame,0);
  entry.pendingFraction = entry.workload.pending / (entry.workload.pending + entry.workload.ready);
}
for (const [mode, entry] of Object.entries(summary)) {
  const control = summary[mode.endsWith('-local') ? 'control-local' : 'control'];
  if (control) entry.relativeToSameClockControl = {fpsPercent:(entry.fps/control.fps-1)*100,
    low1Percent:(entry.intervals.low1Fps/control.intervals.low1Fps-1)*100};
}
const packageFile = path.join(__dirname, 'results', reports[0].folder + '-package.json');
const pkg = read(packageFile); assert(pkg.pass);verified(pkg.build);
const build=read(pkg.build.file);assert(build.pass && build.buildSucceeded && build.allocator==='mimalloc');
const evidence = {date:new Date().toISOString(), pass:true, experimentCompleted:true, acceptedForDefault:false,
  performanceValidated:true,implementationBuilt:true,engineCommit:'76fc69d1e',
  manualVisualAcceptance:'pending', analysisSource:portable(__filename), inputs:files.map(portable), package:portable(packageFile),
  previousAttempts:(option('previous')||'').split(',').filter(Boolean).map(portable),
  build:portable(pkg.build.file),executedSources:reports.map(r=>({file:path.relative(root,r.source.file).replaceAll('\\','/'),sha256:r.source.sha256})),
  packageFiles:reference.map(f => ({file:path.relative(root,f.file).replaceAll('\\','/'),sha256:f.sha256})),
  order:reports.map(r=>({input:path.basename(files[reports.indexOf(r)]),modes:r.modes,seconds:r.seconds,warmup:r.warmup})),
  idleGpuBeforeRuns:reports.flatMap(r=>r.runs.map(run=>({input:path.basename(files[reports.indexOf(r)]),index:run.index,
    mode:run.mode,...run.idleGpu}))),
  settings:{camera:runs[0].before.camera,view:runs[0].before.view,renderer:runs[0].before.settings,threads:runs[0].before.threads},
  qualityOverrides:[], summary,
  checks:{completedResults: runs.filter(r => r.before.history.enabled).every(r => r.history.hits>0 && r.history.ready>0),
    hzbRing: runs.filter(r => r.mode.startsWith('hzb')).every(r => r.history.hzbCompleted>0),
    noQueryWait:runs.every(r => r.before.queryWait.budgetMs===0 && r.after.queryWait.budgetMs===0), runtimeErrors:runs.flatMap(r => r.errors)},
  limits:[
    'FPS measures RHI submission throughput, not GPU completion, physical display or input latency.',
    'Fixed camera, 2289x1287, original Cook/config and lighting; OS GPU utilization sampled before each test browser starts.',
    'Candidates reject camera/projection/rect changes, movable or WPO targets, changed bounds and results older than 8 engine frames or 80 ms.',
    'Moving occluders, temporal disocclusion and fast gameplay remain manual visual acceptance items.',
    'Local Game clock has no new GPU-completion budget; retained as a diagnostic entry and defaults off.'
  ]};
assert(evidence.checks.completedResults && evidence.checks.hzbRing && evidence.checks.noQueryWait && !evidence.checks.runtimeErrors.length);
fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k,v]) => [k,{fps:v.fps,
  low1:v.intervals.low1Fps,gain:v.relativeToSameClockControl,draws:v.workload.draws,hits:v.history.hits,
  hzbCompleted:v.history.hzbCompleted}]))));
