'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const trace = path.resolve(process.argv[2]), prefix = trace.replace(/\.utrace$/, '');
assert(prefix !== trace);
function csv(file) {
  const rows = [], fields = []; let field = '', quoted = false;
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; ++i) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') {field += '"'; ++i;} else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) {
      fields.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') {rows.push(fields.splice(0));}
    } else field += c;
  }
  if (field || fields.length) {fields.push(field); rows.push(fields);}
  assert(!quoted);
  const header = rows.shift();
  return rows.filter(row => row.length > 1).map(row => Object.fromEntries(header.map((name, i) => [name, row[i]])));
}
(async () => {
  const threads = csv(prefix + '.threads.csv'), timers = csv(prefix + '.timers.csv');
  const report = {trace, threadCount: threads.length, timerCount: timers.length, threads,
    eventCount: 0, openEndedEvents: 0, firstEventSeconds: Infinity, lastEventSeconds: -Infinity, pass: false};
  const requiredThreads = ['GameThread', 'RenderThread', 'RHIThread'];
  const requiredTimers = ['WebGPU_CreateGroups', 'WebGPU_SetDrawBindings'];
  const seenThreads = new Set(), seenTimers = new Set();
  const lines = readline.createInterface({input: fs.createReadStream(prefix + '.events.csv'), crlfDelay: Infinity});
  let header = true;
  // Stream native Insights CSV instead of materializing millions of event objects.
  for await (const line of lines) {
    if (header) {assert(line.startsWith('ThreadId,ThreadName,TimerId,TimerName,')); header = false; continue;}
    if (!line) continue;
    const depthComma = line.lastIndexOf(','), durationComma = line.lastIndexOf(',', depthComma - 1);
    const endComma = line.lastIndexOf(',', durationComma - 1), startComma = line.lastIndexOf(',', endComma - 1);
    const start = Number(line.slice(startComma + 1, endComma)), end = Number(line.slice(endComma + 1, durationComma));
    if (line.slice(endComma + 1, durationComma) === '+inf') {
      // Stopping a trace inside a frame/scope leaves its final event open.
      assert(Number.isFinite(start)); ++report.openEndedEvents; ++report.eventCount; continue;
    }
    assert(Number.isFinite(start) && Number.isFinite(end) && end >= start,
      'Invalid native timing event: ' + line);
    report.firstEventSeconds = Math.min(report.firstEventSeconds, start);
    report.lastEventSeconds = Math.max(report.lastEventSeconds, end);
    for (const name of requiredThreads) if (line.includes(',' + name)) seenThreads.add(name);
    for (const name of requiredTimers) if (line.includes(',' + name + ',')) seenTimers.add(name);
    ++report.eventCount;
  }
  for (const name of requiredThreads) {
    assert(threads.some(thread => thread.Name.startsWith(name)), 'Missing native thread: ' + name);
    assert(seenThreads.has(name), 'Missing native events on: ' + name);
  }
  for (const name of requiredTimers) assert(seenTimers.has(name), 'Missing native backend scope: ' + name);
  report.captureSpanSeconds = report.lastEventSeconds - report.firstEventSeconds;
  assert(report.eventCount > 1000 && report.captureSpanSeconds >= 1 && report.captureSpanSeconds <= 120);
  assert(report.openEndedEvents < 1000, 'Too many events lack a closing boundary');
  const statistics = csv(prefix + '.statistics.csv');
  report.topExclusiveTimers = statistics.sort((a, b) => Number(b.Excl) - Number(a.Excl)).slice(0, 25);
  report.backendTimers = statistics.filter(item => item.Name.startsWith('WebGPU_'));
  report.pass = true;
  fs.writeFileSync(prefix + '.analysis.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: true, trace, threads: report.threadCount, timers: report.timerCount,
    events: report.eventCount, seconds: report.captureSpanSeconds, backendTimers: report.backendTimers}));
})().catch(error => {console.error(error); process.exitCode = 1;});
