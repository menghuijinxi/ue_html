'use strict';
// Read captures after browser runs finish; this does not run a benchmark.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(v => v.startsWith('--' + name + '='))?.slice(name.length + 3);
const captureFile = option('capture'), profileFile = option('profile'), output = option('output');
assert(captureFile && profileFile && output && !fs.existsSync(output),
  'Use --capture=capture.json --profile=benchmark.json --output=new-summary.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const capture = read(captureFile), benchmark = read(profileFile);
const analysisFile = captureFile.replace(/\.json$/, '-analysis.json'), analysis = read(analysisFile);
assert(capture.pass && benchmark.pass && analysis.pass);
assert.equal(capture.folder, benchmark.folder);
assert.deepEqual(capture.qualityOverrides, []);
assert.deepEqual(benchmark.qualityOverrides, []);
const run = benchmark.runs[0];
assert.equal(benchmark.runs.length, 1);
const prefix = profileFile.replace(/\.json$/, '-1-workers');
const costsFile = option('costs');
const costs = costsFile ? read(costsFile) : null;
const counters = ['bindGroupCacheHits', 'bindGroupsCreated', 'bindingEntriesPrepared', 'bindingEntriesReused',
  'resourceTableCommits', 'resourceTableBuffers', 'groupPreparationHits', 'groupFrameMisses',
  'groupAccessMisses', 'groupVersionMisses', 'groupTextureMisses', 'uniformSnapshots', 'uniformWriteCalls'];
const sampleFrames = run.after.occlusion.sampleFrame - run.before.occlusion.sampleFrame;
assert(sampleFrames > 0);
const perFrame = Object.fromEntries(counters.map(k => [k,
  (run.after.occlusion[k] - run.before.occlusion[k]) / sampleFrames]));
const groupChecks = ['groupPreparationHits', 'groupFrameMisses', 'groupAccessMisses',
  'groupVersionMisses', 'groupTextureMisses'].reduce((s, k) => s + perFrame[k], 0);
const patterns = {
  drawBindings: /FWebGPUDynamicRHI::SetDrawBindings\(/,
  groups: /FWebGPUDynamicRHI::CreateGroups\(/,
  commitResources: /FWebGPUDynamicRHI::CommitShaderResources\(/,
  allocation: /FMemory::(?:Malloc|Realloc|Free)\(|FMallocAnsi::|(?:^|_)mi_/,
  bufferCreation: /FWebGPUDynamicRHI::CreateBuffer\(|^createBuffer$/,
  frameCleanup: /FWebGPUDynamicRHI::(?:RHIEndFrame|ReleaseFrameBindings)\(/,
  resourceRetirement: /flushRetired|__webFlushRetiredGPUResources|^emwgpuDelete$/,
  accessValidation: /FWebGPUDynamicRHI::(?:ValidateAccess|RequireAccess|ValidateTextureBinding)\(/,
  rdgValidation: /FRDGUserValidation::|FRDGBarrierValidation::/,
  tlv: /InjectTranslucencyLightingVolume|FTranslucentLightInjection|FWebTranslucentLighting/,
  memoryStats: /FGenericPlatformMemory::GetStats\(/,
  logging: /FMsg::|UE::Logging::|FOutputDevice|FormatLogLine|^_emscripten_out$/,
  heapViewCheck: /^growMemViews$/,
  commandReplay: /^_ueWGPUReplay$/
};
const threads = [];
const targetsFile = prefix + '-targets.json', targets = read(targetsFile);
for (let i = 0; i < targets.length; ++i) {
  const file = prefix + '-' + i + '.cpuprofile', p = read(file);
  const names = p.nodes.map(n => n.callFrame.functionName).join('\n');
  const role = /FRHIThread::WebPump/.test(names) ? 'RHI' : /EngineFrame\(void/.test(names) ? 'Game' :
    /RenderingThreadMain|FRenderingThread::Run/.test(names) ? 'Render' : null;
  if (!role) continue;
  const nodes = new Map(p.nodes.map(n => [n.id, n])), parents = new Map();
  for (const n of p.nodes) for (const child of n.children || []) parents.set(child, n.id);
  const totals = Object.fromEntries(Object.keys(patterns).map(k => [k, {inclusiveUs: 0, selfUs: 0, longSampleUs: 0}]));
  let totalUs = 0, longestSampleUs = 0, totalLongSampleUs = 0;
  const longSamples = [];
  for (let j = 0; j < p.samples.length; ++j) {
    const id = p.samples[j], us = p.timeDeltas[j];
    totalUs += us; longestSampleUs = Math.max(longestSampleUs, us);
    const stack = [];
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor))
      stack.push(nodes.get(cursor).callFrame.functionName);
    if (us > 20000) {
      totalLongSampleUs += us;
      longSamples.push({ms: us / 1000, stack: stack.slice(0, 8)});
    }
    for (const [key, pattern] of Object.entries(patterns)) {
      if (stack.some(n => pattern.test(n))) {
        totals[key].inclusiveUs += us;
        if (us > 20000) totals[key].longSampleUs += us;
      }
      if (pattern.test(stack[0])) totals[key].selfUs += us;
    }
  }
  threads.push({role, source: audit(file), durationMs: totalUs / 1000, longestSampleMs: longestSampleUs / 1000,
    longSampleMs: totalLongSampleUs / 1000, longSamples,
    paths: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, {
      inclusiveMs: v.inclusiveUs / 1000, inclusivePercent: v.inclusiveUs / totalUs * 100,
      selfMs: v.selfUs / 1000, selfPercent: v.selfUs / totalUs * 100,
      longSampleMs: v.longSampleUs / 1000,
      inclusivePercentWithoutLongSamples: (v.inclusiveUs - v.longSampleUs) / (totalUs - totalLongSampleUs) * 100
    }]))});
}
assert.deepEqual(threads.map(t => t.role).sort(), ['Game', 'RHI', 'Render']);
const threadNames = new Map(analysis.trace.threads.map(e => [e.pid + ':' + e.tid, e.args.name]));
const longFrames = analysis.trace.marks.map(mark => {
  const match = /^UE long frame (\d+) ([\d.]+)ms$/.exec(mark.name); assert(match);
  const frame = capture.phases.flatMap(p => p.data.frames).find(f => f.frame === Number(match[1])); assert(frame);
  const end = mark.ts, begin = end - frame.ms * 1000;
  // Only non-nested RunTask scopes. Never add nested WebGPU/Flush scopes again.
  const gpuTasks = analysis.trace.long.filter(e => e.name === 'ThreadControllerImpl::RunTask' &&
    threadNames.get(e.pid + ':' + e.tid) === 'CrGpuMain' && e.ts < end && e.ts + e.dur > begin);
  return {frame: frame.frame, intervalMs: frame.ms, markTimestampUs: mark.ts,
    gpuTasks: gpuTasks.map(e => ({timestampUs: e.ts, durationMs: e.dur / 1000,
      threadCpuMs: e.tdur / 1000, overlapMs: (Math.min(end, e.ts + e.dur) - Math.max(begin, e.ts)) / 1000}))};
});
for (const p of Object.values(benchmark.packages)) for (const file of Object.values(p.files))
  assert.equal(audit(file.file).sha256, file.sha256, 'Package changed after capture');
const phaseSummaries = capture.phases.map(p => {
  assert(p.data.frames.length > 1 && !p.data.errors.length);
  const first = p.data.frames[0], last = p.data.frames.at(-1), intervals = p.data.frames.length - 1;
  return {name: p.name, frames: p.summary.frames, fps: p.summary.fps, low1Fps: p.summary.low,
    p99Ms: p.summary.p99, maximumMs: p.summary.maximum,
    minimumRolling5sLow: analysis.phases.find(a => a.name === p.name).minimumRolling5sLow,
    creations: p.summary.creations,
    // Counter deltas exclude the first recorded frame; use that same denominator.
    creationsPerFrame: Object.fromEntries(Object.entries(p.summary.creations).map(([k, n]) => [k, n / intervals])),
    diskReads: last.io.diskReads - first.io.diskReads,
    diskReadBytes: last.io.diskReadBytes - first.io.diskReadBytes,
    newPipelineEvents: p.data.events.filter(e => /Pipeline/.test(e.name))};
});
const logFile = captureFile.replace(/\.json$/, '.log'), log = fs.readFileSync(logFile, 'utf8');
const result = {date: new Date().toISOString(), pass: true, source: audit(__filename),
  inputs: [captureFile, analysisFile, profileFile, targetsFile, logFile, ...(costsFile ? [costsFile] : [])].map(audit),
  package: benchmark.packages[capture.folder], browser: capture.browser, environment: capture.environment,
  viewport: {width: capture.width, height: capture.height, dpr: capture.dpr, view: run.before.view},
  phases: phaseSummaries, longFrames,
  trace: {source: audit(captureFile.replace(/\.json$/, '-chrome-trace.json')), events: analysis.trace.events,
    gcMaximumMs: analysis.trace.gcMaximumMs, cacheHits: analysis.trace.cacheHits.length},
  normalFixedView: {fps: run.fps, low1Fps: run.frameMs.low1Fps, rhiWorkMs: run.rhiWorkMs,
    workload: run.workload, perFrame, wholeGroupHitFraction: perFrame.groupPreparationHits / groupChecks,
    wasmCapacityBytes: [run.before.wasmCapacityBytes, run.after.wasmCapacityBytes]},
  memoryStatsWarnings: (log.match(/FGenericPlatformMemory::GetStats not implemented/g) || []).length,
  threads, existingFrameCosts: costs?.threads.map(t => ({role: t.role, exclusive: t.exclusive, inclusive: t.inclusive})),
  boundary: 'Single diagnostic run and separate fixed-view measurement/profile, not an optimization A/B. Rare object wrappers and per-frame snapshots affect stutter capture; tour also has browser tracing. Worker profiler starts after normal timing. Inclusive paths overlap; thread windows differ; samples include scheduling and profiler effects. RHI work is a wall-clock pump total, not CPU-only time or a per-present critical path. It updates after present and can cover multiple submissions: per-frame rhiDelta cannot locate a stall. Trace long-task list is truncated to the 80 longest scopes, so absent overlaps do not rule out shorter GPU-service work. CPU GPU-service tasks are not GPU execution time. No GPU utilization/full GPU frame measured; observed 60% is user-reported. Buffer creation counts do not prove allocator/retirement is the dominant cause. GetStats warning costs require isolated A/B; heap view checks do not mean memory grew. Browser/driver caches retained; no batch PSO prewarm or quality override. Ordinary page keeps async PSO-cache consolidation; benchmark full mode disables it.'};
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({output, phases: phaseSummaries.map(({newPipelineEvents, ...p}) => p),
  fixedView: result.normalFixedView, memoryStatsWarnings: result.memoryStatsWarnings,
  paths: threads.map(t => ({role: t.role, paths: t.paths})), longFrames}, null, 2));
