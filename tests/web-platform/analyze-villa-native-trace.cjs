'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const prefix = path.resolve(process.argv[2]);
const names = ['RHI_Translate', 'FDrawVisibleMeshCommandsAnyThreadTask', 'FMeshDrawCommandPassSetupTask'];

async function analyze(state) {
  const source = prefix + '-' + state;
  const verified = JSON.parse(fs.readFileSync(source + '.analysis.json', 'utf8'));
  assert(verified.pass && verified.backend === 'native');
  const events = Object.fromEntries(names.map(name => [name, []])), ticks = [];
  const lines = readline.createInterface({input: fs.createReadStream(source + '.events.csv'), crlfDelay: Infinity});
  for await (const line of lines) {
    // Selected timer names and native thread names contain no CSV separators.
    // Leave the other millions of exported events on disk.
    const name = names.find(name => line.includes(',' + name + ','));
    if (!name && !line.includes(',FEngineLoop::Tick,')) continue;
    const fields = line.split(',');
    assert.equal(fields.length, 8, 'Unexpected selected CSV event');
    const start = Number(fields[4]), end = Number(fields[5]);
    if (!Number.isFinite(end)) continue; // Trace.Stop can leave its current frame open.
    assert(Number.isFinite(start) && end >= start);
    const event = {threadId: Number(fields[0]), thread: fields[1], start, end};
    if (name) events[name].push(event);
    else if (event.thread === 'GameThread') ticks.push(event);
  }
  ticks.sort((a,b) => a.start - b.start);
  assert(ticks.length >= 180);
  // UE's trace tail contains events from before Trace.File. Use the last 160
  // complete game frames, inside the requested 180-frame on/off capture.
  const frames = ticks.slice(-160), start = frames[0].start, end = frames.at(-1).end;
  const result = {source, fullTraceEvents: verified.eventCount, completeGameFrames: ticks.length,
    measuredFrames: frames.length, start, end, seconds: end - start, timers: {}};
  for (const name of names) {
    const byThread = {}, boundaries = [];
    for (const event of events[name]) {
      const a = Math.max(start, event.start), b = Math.min(end, event.end);
      if (b <= a) continue;
      const thread = byThread[event.thread] ??= {threadId: event.threadId, count: 0, totalMs: 0};
      ++thread.count; thread.totalMs += (b - a) * 1000;
      boundaries.push([a,1],[b,-1]);
    }
    boundaries.sort((a,b) => a[0] - b[0] || a[1] - b[1]);
    let concurrent = 0, maximum = 0, parallelSeconds = 0, previous = start;
    for (const [time,delta] of boundaries) {
      if (concurrent >= 2) parallelSeconds += time - previous;
      concurrent += delta; maximum = Math.max(maximum, concurrent); previous = time;
    }
    assert.equal(concurrent, 0);
    const threads = Object.entries(byThread).map(([name, value]) => ({name, ...value,
      msPerFrame: value.totalMs / frames.length})).sort((a,b) => b.totalMs - a.totalMs);
    result.timers[name] = {count: threads.reduce((n,t) => n + t.count, 0), threads,
      totalMsPerFrame: threads.reduce((n,t) => n + t.msPerFrame, 0),
      maximumConcurrency: maximum, parallelOverlapMs: parallelSeconds * 1000};
  }
  return result;
}

(async () => {
  // Stream the large files sequentially to avoid disk and memory contention.
  const on = await analyze('on'), off = await analyze('off');
  const a = on.timers.RHI_Translate, b = off.timers.RHI_Translate;
  assert(a.threads.some(t => t.name.includes('Worker')) && a.maximumConcurrency >= 2,
    'Parallel translation did not run on task workers');
  assert(b.threads.length === 1 && b.threads[0].name === 'RHIThread' && b.maximumConcurrency === 1,
    'Disabled translation was not serialized on RHIThread');
  const log = fs.readFileSync(prefix + '.log', 'utf8');
  const resolution = log.match(/TemporalSuperResolution\(sg\.AntiAliasingQuality=\d\) (\d+)x(\d+) -> (\d+)x(\d+)/);
  assert(resolution, 'Missing native GPU profile resolution');
  const report = {pass: true, on, off,
    internalResolution: resolution.slice(1,3).map(Number), outputResolution: resolution.slice(3,5).map(Number),
    limitations: ['Detailed named-event trace is separate from the normal FPS capture.',
      'Only the final 160 complete game frames are measured; pre-capture trace tail is excluded.',
      'Summed inclusive worker durations measure CPU thread occupancy and can include preemption; they are not the frame critical path.']};
  fs.writeFileSync(prefix + '-thread-analysis.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({pass: true, internalResolution: report.internalResolution,
    on: {threads: a.threads.length, concurrency: a.maximumConcurrency, cpuMsPerFrame: a.totalMsPerFrame},
    off: {threads: b.threads.length, concurrency: b.maximumConcurrency, cpuMsPerFrame: b.totalMsPerFrame}}));
})().catch(error => {console.error(error); process.exitCode = 1;});
