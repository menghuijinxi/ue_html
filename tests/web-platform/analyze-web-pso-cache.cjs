'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const files = process.argv.slice(2); assert(files.length);
const result = {date: new Date().toISOString(), pass: true, source: audit(__filename), reports: [],
  boundary: 'All rounds recreate a device after restarting the browser. Timings tagged browserTrace include instrumentation. Worker duration is cumulative across parallel tasks, not wall time. Generic cache lookups are not a final PSO hit-rate counter. Memory dump sizes use hexadecimal trace values.'};
for (const file of files) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8')); assert(report.pass, file);
  const summary = {input: audit(file), browser: report.browser, corpus: report.corpus,
    browserArgs: report.browserArgs, moduleFence: report.moduleFence, browserTrace: report.browserTrace,
    profileName: report.profileName, settleCacheMs: report.settleCacheMs, runs: []};
  for (const run of report.runs) {
    const {attempts, trace, ...metrics} = run;
    const analyzed = {...metrics};
    if (trace) {
      const events = JSON.parse(fs.readFileSync(trace, 'utf8')).traceEvents;
      const workers = events.filter(e => e.name === 'DawnPlatformImpl::RunWorkerTask' && e.ph === 'X');
      const memoryCaches = [];
      for (const e of events.filter(e => e.ph === 'v'))
        for (const [name, value] of Object.entries(e.args.dumps?.allocators || {}))
          if (name.includes('webgpu_cache')) memoryCaches.push({pid: e.pid, name,
            bytes: parseInt(value.attrs.size.value, 16), entries: parseInt(value.attrs.object_count.value, 16)});
      const blobs = name => events.filter(e => e.name === name && e.args.handle_type === 1).length;
      const endpoints = workers.flatMap(w => [[w.ts,1], [w.ts+w.dur,-1]]).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
      let active = 0, maxActive = 0;
      for (const [, delta] of endpoints) {active += delta; maxActive = Math.max(maxActive, active);}
      analyzed.trace = {input: audit(trace), memoryCaches, workerTasks: workers.length,
        cumulativeWorkerMs: workers.reduce((s,e) => s+e.dur, 0)/1000, maxParallelWorkers: maxActive,
        genericCacheHitScopes: events.filter(e => e.name === 'DawnCachingInterface::CacheHit' && e.ph === 'X').length,
        loadedWebGPUBlobs: blobs('GpuHostImpl::LoadedBlob'), storedWebGPUBlobs: blobs('GpuHostImpl::StoreBlobToDisk')};
    }
    summary.runs.push(analyzed);
  }
  result.reports.push(summary);
}
const output = files[0].replace(/\.json$/, '-cache-analysis.json'); assert(!fs.existsSync(output));
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({output: path.resolve(output), reports: result.reports.map(r => ({file:r.input.file,
  runs:r.runs.map(v => ({index:v.index, pipelineMs:v.pipelineWallMs, moduleReadyMs:v.moduleReadyMs, trace:v.trace}))}))}));
