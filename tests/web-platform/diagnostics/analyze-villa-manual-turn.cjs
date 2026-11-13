'use strict';
const {initializeProjectOutput, assertProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const base = path.resolve(__dirname, '..');
function analyze(file) {
  const input = JSON.parse(fs.readFileSync(file));
  assert.equal(input.kind, 'villa-manual-turn');
  return {source: audit(file), records: input.records.map(record => {
    const {metadata, frames, contexts, events} = record;
    const intervals = frames.filter(frame => frame.ms !== null), sorted = intervals.map(frame => frame.ms).sort((a, b) => a - b);
    const tail = sorted.slice(-Math.ceil(sorted.length * .01)), first = contexts[0], last = contexts.at(-1);
    assert(intervals.every(frame => Number.isFinite(frame.ms) && frame.ms > 0));
    for (let i = 1; i < frames.length; ++i) assert(Math.abs(frames[i].ms - (frames[i].time - frames[i - 1].time)) < 1e-6);
    const pack = JSON.parse(fs.readFileSync(path.join(base, 'build', metadata.folder, 'pipeline-prewarm.json')));
    assert.equal(audit(path.join(base, 'build', metadata.folder, 'pipeline-prewarm.json')).sha256, metadata.prewarm.sha256);
    const pipelineLabel = descriptor => [descriptor.vertex?.entryPoint, descriptor.fragment?.entryPoint].filter(Boolean).join(' / ');
    const delta = (a, b, key) => typeof a?.[key] === 'number' && typeof b?.[key] === 'number' ? b[key] - a[key] : null;
    const missingLabels = [...new Set(events.filter(event => event.name === 'createRenderPipeline').map(event => event.label))]
      .map(label => ({label, presentInOwnPack: pack.descriptors.some(item => pipelineLabel(item.descriptor) === label)}));
    return {mode: metadata.mode, label: metadata.label, metadata,
      summary: {frames: frames.length, durationMs: frames.at(-1).time - frames[0].time,
        p50Ms: sorted[Math.floor(sorted.length * .5)], p99Ms: sorted[Math.floor(sorted.length * .99)],
        maxMs: sorted.at(-1), low: tail.length * 1000 / tail.reduce((sum, ms) => sum + ms, 0),
        over50: sorted.filter(ms => ms > 50).length, over100: sorted.filter(ms => ms > 100).length,
        renderPipelineCalls: events.filter(event => event.name === 'createRenderPipeline').length,
        computePipelineCalls: events.filter(event => event.name.includes('ComputePipeline')).length,
        prewarmPipelines: pack.descriptors.length, prewarmMisses: delta(first.prewarm, last.prewarm, 'misses'),
        diskReadMiB: delta(first.io, last.io, 'diskReadBytes') / 1048576,
        diskReadMs: delta(first.io, last.io, 'diskReadMs'), downloads: delta(first.io, last.io, 'downloads'),
        rhiMsPerSubmission: delta(first.stages, last.stages, 'rhiWorkMilliseconds') / delta(first.stages, last.stages, 'presented')},
      missingLabels,
      worst: intervals.toSorted((a, b) => b.ms - a.ms).slice(0, 8).map(frame => {
        const context = contexts[frame.context], previous = contexts[frame.context - 1];
        return {time: frame.time, sinceRecordingMs: frame.time + record.timeOrigin - record.startEpoch,
          ms: frame.ms, context: frame.context, camera: context.camera, gameMs: context.gameMs,
          batchRhiMs: delta(previous?.stages, context.stages, 'rhiWorkMilliseconds'),
          batchSubmissions: delta(previous?.stages, context.stages, 'presented'),
          batchReadMiB: delta(previous?.io, context.io, 'diskReadBytes') / 1048576,
          batchReadMs: delta(previous?.io, context.io, 'diskReadMs'),
          pendingTextures: context.streaming.pending, prewarm: context.prewarm,
          eventsWithin200msBefore: events.filter(event => event.start <= frame.time && event.end >= frame.time - 200)};
      }),
      failures: [...new Set(contexts.map(context => context.failure).filter(Boolean))],
      interruptions: record.interruptions,
      renderSizes: [...new Set(contexts.map(context =>
        [context.view.width, context.view.height, context.view.outputWidth, context.view.outputHeight, context.view.antiAliasing].join('x')))]};
  })};
}
if (require.main === module) {
  const [output, ...inputs] = process.argv.slice(2);
  assert(output && inputs.length, 'Usage: node analyze-villa-manual-turn.cjs output.json recordings...');
  const result = {date: new Date().toISOString(), captures: inputs.map(analyze),
    boundary: 'Recorded human input, no rerun. Routes and durations differ. RHI and IO deltas are sampled batch counters, not exact per-frame costs. API events do not measure deferred driver compilation.'};
  fs.writeFileSync(assertProjectOutput(output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.captures.map(capture => ({file: capture.source.file,
    records: capture.records.map(record => ({mode: record.mode, ...record.summary}))})), null, 2));
}
module.exports = {analyze};
