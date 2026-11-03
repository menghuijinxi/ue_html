'use strict';
const fs = require('node:fs'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const file = process.argv[2]; assert(file);
const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
const stats = values => {
  const sorted = values.slice().sort((a, b) => a - b), sum = values.reduce((a, b) => a + b, 0);
  return {count: values.length, sum, mean: sum / (values.length || 1),
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1)};
};
const runs = capture.runs.map(run => {
  const p = run.owner, groups = new Map();
  assert(p.pipelineDescriptors?.length, 'Capture does not include descriptor identities');
  for (const a of p.pipelines) {const group = groups.get(a.descriptorId) || []; group.push(a); groups.set(a.descriptorId, group);}
  const duplicates = [...groups].filter(([,g]) => g.length > 1).map(([descriptorId, attempts]) => ({descriptorId,
    attempts: attempts.map(a => ({...a, start: a.start - p.timeOrigin, end: a.end - p.timeOrigin, callEnd: a.callEnd - p.timeOrigin})),
    runtimeDuringAsync: attempts.some(a => !a.name.endsWith('Async') && attempts.some(b => b.name.endsWith('Async') && b.start < a.start && b.end > a.start)),
    runtimeBeforeAsync: attempts.some(a => !a.name.endsWith('Async') && attempts.some(b => b.name.endsWith('Async') && b.start > a.start)),
    runtimeAfterAsync: attempts.some(a => !a.name.endsWith('Async') && attempts.some(b => b.name.endsWith('Async') && b.end <= a.start))}));
  const ready = p.marks.find(m => m.name === 'native.ready')?.at;
  const native = p.marks.filter(m => m.name === 'native.pso.complete');
  const byNative = new Map(p.pipelines.filter(a => a.nativeId).map(a => [a.nativeId, a]));
  const issued = native.filter(m => m.detail.apiAt > 0);
  for (const m of issued) assert(byNative.has(m.detail.id), 'Native API request missing JS identity');
  const nativeStages = native.length ? {
    requests: native.length, issued: issued.length, rejectedBeforeAPI: native.length - issued.length,
    queueToProxyMs: stats(native.map(m => m.detail.proxyAt - m.detail.queuedAt)),
    proxyToOwnerTaskMs: stats(native.map(m => m.detail.ownerAt - m.detail.proxyAt)),
    descriptorPreparationMs: stats(issued.map(m => m.detail.apiAt - m.detail.ownerAt)),
    jsPromiseToNativeCallbackMs: stats(issued.map(m => m.at - byNative.get(m.detail.id).end)),
    worstQueue: [...native].sort((a,b) => (b.detail.ownerAt-b.detail.queuedAt)-(a.detail.ownerAt-a.detail.queuedAt))
      .slice(0,8).map(m => ({id: m.detail.id, queuedMs: m.detail.ownerAt-m.detail.queuedAt,
        startMs: m.detail.queuedAt-p.timeOrigin, endMs: m.detail.ownerAt-p.timeOrigin}))
  } : null;
  return {index: run.index, attempts: p.pipelines.length, descriptors: p.pipelineDescriptors.length,
    identityInstrumentationMs: stats(p.pipelines.map(p => p.identityMs)), nativeStages,
    methods: Object.fromEntries([...new Set(p.pipelines.map(p => p.name))].map(name => [name, {
      elapsed: stats(p.pipelines.filter(p => p.name === name).map(p => p.end - p.start)),
      apiCall: stats(p.pipelines.filter(p => p.name === name).map(p => p.callEnd - p.start)),
      beforeReady: p.pipelines.filter(p => p.name === name && p.start < ready).length}])),
    duplicateDescriptors: duplicates.length, runtimeDuringAsync: duplicates.filter(d => d.runtimeDuringAsync).length,
    runtimeBeforeAsync: duplicates.filter(d => d.runtimeBeforeAsync).length,
    runtimeAfterAsync: duplicates.filter(d => d.runtimeAfterAsync).length, duplicates,
    tail: p.pipelines.filter(p => p.name.endsWith('Async')).sort((a,b) => b.end - a.end).slice(0, 15)
      .map(a => ({...a, start: a.start - p.timeOrigin, end: a.end - p.timeOrigin}))};
});
const result = {date: new Date().toISOString(), input: audit(file), sources: [audit(__filename)], pass: capture.pass, runs,
  boundary: 'Exact descriptors and resource identity within one device. Omitted-default equivalence and separate identical shader modules are not merged. Promise duration includes scheduling and callback delay; sync API duration does not measure deferred GPU-process work.'};
fs.writeFileSync(file.replace(/\.json$/, '-identity-analysis.json'), JSON.stringify(result, null, 2));
for (const {duplicates, tail, ...run} of runs) console.log(JSON.stringify(run));
