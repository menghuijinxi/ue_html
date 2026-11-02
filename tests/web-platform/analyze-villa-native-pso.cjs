'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function csv(line) {
  const out = []; let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { out.push(value); value = ''; }
    else value += c;
  }
  out.push(value); return out;
}
function stats(events) {
  if (!events.length) return { count: 0 };
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const durations = events.map(e => e.duration * 1000).sort((a, b) => a - b);
  let union = 0, start = sorted[0].start, end = sorted[0].end, peak = 0, live = 0;
  for (const e of sorted.slice(1)) {
    if (e.start > end) { union += end - start; start = e.start; end = e.end; }
    else end = Math.max(end, e.end);
  }
  union += end - start;
  for (const p of events.flatMap(e => [[e.start, 1], [e.end, -1]]).sort((a,b) => a[0]-b[0] || a[1]-b[1])) {
    live += p[1]; peak = Math.max(peak, live);
  }
  return { count: events.length, firstStartS: sorted[0].start, lastEndS: end,
    spanS: end - sorted[0].start, activeUnionS: union,
    summedCallS: durations.reduce((a,b) => a+b, 0)/1000,
    medianCallMs: durations[Math.floor(durations.length*.5)], p95CallMs: durations[Math.floor(durations.length*.95)],
    maxCallMs: durations.at(-1), peakConcurrentCalls: peak,
    threadCount: new Set(events.map(e => e.threadId)).size,
    threadNames: [...new Set(events.map(e => e.thread))],
    over1ms: durations.filter(d => d > 1).length, over10ms: durations.filter(d => d > 10).length,
    over100ms: durations.filter(d => d > 100).length };
}
async function analyze(prefix) {
  const launch = JSON.parse(fs.readFileSync(`${prefix}-launch.json`, 'utf8').replace(/^\uFEFF/, ''));
  const complete = JSON.parse(fs.readFileSync(`${prefix}-complete.json`, 'utf8').replace(/^\uFEFF/, ''));
  const events = [], apiEvents = [], mapEvents = [], initEvents = [], ticks = [];
  const lines = readline.createInterface({ input: fs.createReadStream(`${prefix}.events.csv`), crlfDelay: Infinity });
  for await (const line of lines) {
    const c = csv(line);
    if (!/^\d+$/.test(c[0])) continue;
    const e = {threadId:+c[0],thread:c[1],name:c[3],start:+c[4],end:+c[5],duration:+c[6],depth:+c[7]};
    if (!Number.isFinite(e.duration)) throw Error(`Invalid timing row: ${line}`);
    if (e.name.startsWith('PSOPrecache:')) events.push(e);
    if (e.name === 'Create time') apiEvents.push(e);
    if (e.name.includes('LoadMap')) mapEvents.push(e);
    if (e.name === 'FEngineLoop::Init') initEvents.push(e);
    if (e.name === 'FEngineLoop::Tick') ticks.push(e);
  }
  if (!apiEvents.length && fs.existsSync(`${prefix}.api.csv`)) {
    for (const line of fs.readFileSync(`${prefix}.api.csv`, 'utf8').split(/\r?\n/)) {
      const c = csv(line);
      if (c[3] === 'Create time') apiEvents.push({threadId:+c[0],thread:c[1],name:c[3],start:+c[4],end:+c[5],duration:+c[6],depth:+c[7]});
    }
  }
  const groups = {};
  for (const name of new Set(events.map(e => e.name))) groups[name] = stats(events.filter(e => e.name === name));
  const log = fs.readFileSync(`${prefix}.log`, 'utf8');
  const csvLines = fs.readFileSync(`${prefix}.csv`, 'utf8').split(/\r?\n/).filter(Boolean).map(csv);
  const header = csvLines[0], frameTimeColumn = header.indexOf('FrameTime');
  if (frameTimeColumn < 0) throw Error('Native CSV FrameTime column missing.');
  const rows = csvLines.slice(1).filter(c => /^\d+(\.\d+)?$/.test(c[frameTimeColumn]));
  const counters = {};
  for (let i = 0; i < header.length; i++) if (/PSOPrecacheCompiling\//.test(header[i])) {
    const values = rows.map(r => +r[i]).filter(Number.isFinite);
    counters[header[i]] = {first:values[0],last:values.at(-1),max:Math.max(...values)};
  }
  const settings = log.split(/\r?\n/).filter(l => /(?:r\.(?:pso|AntiAliasing|ScreenPercentage|RayTracing|GenerateMeshDistanceFields|DistanceField|DynamicGlobalIlluminationMethod|ReflectionMethod|Shadow.Virtual|Streaming.PoolSize)|D3D12.PSO)\S* =|Not using .*pipeline state disk cache|Not using driver-optimized|Creating PSO|PSO.*thread pool|Metadata set : (?:rhi|shaderplatform|gpu)|Bringing World .*play|Took .*LoadMap|Engine Initialization\) Total time/i.test(l));
  if (!complete.configUnchanged || (complete.exitCode !== 0 && !complete.lateExitFailure)) throw Error('Incomplete native capture.');
  if (!groups['PSOPrecache: Precaching']?.count) throw Error('No automatic PSO precaching trace events.');
  if (!/D3D12/.test(log) || !/PCD3D_SM6/.test(log)) throw Error('Expected original project DX12 SM6 configuration.');
  if (!launch.warmup) {
    if (counters['PSOPrecacheCompiling/PSOPrecompileQueueLength']?.last !== 0) throw Error('PSO queue did not drain before measurement ended.');
    if (counters['PSOPrecacheCompiling/TotalCompletedPSOPrecompiles']?.last !== groups['PSOPrecache: Precaching'].count) throw Error('PSO completion counter and trace disagree.');
    if (!apiEvents.length) throw Error('Direct D3D12 CreatePipelineState timer missing.');
    if (launch.precompileThreadCap && groups['PSOPrecache: Precaching'].threadCount !== launch.precompileThreadCap) throw Error('Actual precache thread count does not match requested cap.');
  }
  return {prefix:path.basename(prefix),warmup:launch.warmup,configUnchanged:true,exitCode:complete.exitCode,
    cleanExit:complete.exitCode===0,lateExitFailure:!!complete.lateExitFailure,
    precompileThreadCap:launch.precompileThreadCap || 0,d3d12CreatePipelineState:stats(apiEvents),
    d3d12PrecacheCreatePipelineState:stats(apiEvents.filter(e=>e.thread.startsWith('PSOPrecompilePool'))),
    d3d12OtherCreatePipelineState:stats(apiEvents.filter(e=>!e.thread.startsWith('PSOPrecompilePool'))),
    allCreation:stats(events),groups,counters,settings,initialization:initEvents,loadMap:mapEvents,
    firstTick:ticks[0],lastTick:ticks.at(-1),frameCount:ticks.length,
    slowest:events.toSorted((a,b) => b.duration-a.duration).slice(0,12),
    note:'PSOPrecache trace scopes include UE RHI creation, driver work and scheduling; retained caches are not proof of per-entry driver cache hits. Span includes asset-driven gaps between requests. Summed call time overlaps across threads.'};
}
(async () => {
  const label = process.argv[2] || 'villa-native-pso-v1';
  const count = +(process.argv[3] || 3);
  const results = path.join(__dirname, 'results');
  const runs = [];
  for (let i=0; i<count; i++) runs.push(await analyze(path.join(results,`${label}-run${i}`)));
  const report = {date:new Date().toISOString(),pass:true,measurementValid:true,
    cleanExit:runs.every(r=>r.cleanExit),label,runs,
    webUserReported:{verificationS:2,mapLoadingS:18,psoS:6,totalS:26},
    limitations:['Native cooked Development DX12 SM6 versus Web SM5, original project settings on both. Pipeline sets differ.',
      'Native scopes measure actual RHI compilation calls; Web UI phase is a stage duration. Compare scopes and counts before claiming a speed ratio.',
      'Runs marked warmup are excluded from repeat statistics; no caches cleared.',
      ...(runs.some(r=>r.lateExitFailure) ? ['Some native launches have a late crash-reporting thread failure (777003) after CSV completion and log closure. Startup and PSO queues completed, but this is not a clean-exit stability pass.'] : [])]};
  fs.writeFileSync(path.join(results,`${label}-summary.json`),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({pass:report.pass,runs:runs.map(r=>({prefix:r.prefix,warmup:r.warmup,pso:r.groups['PSOPrecache: Precaching'],firstTick:r.firstTick,loadMap:r.loadMap,counters:r.counters}))},null,2));
})().catch(e => {console.error(e);process.exitCode=1;});
