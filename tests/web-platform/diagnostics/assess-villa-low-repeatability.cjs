'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {initializeProjectOutput, assertProjectOutput} = require('../project-output.cjs');
const {audit} = require('../content-file-metadata.cjs');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function low(times) {
  const intervals = times.slice(1).map((value, index) => value - times[index]);
  assert(intervals.length && intervals.every(value => value > 0 && Number.isFinite(value)));
  intervals.sort((a, b) => b - a);
  const slow = intervals.slice(0, Math.ceil(intervals.length * .01));
  assert(slow.length && slow.every(value => value > 0 && Number.isFinite(value)));
  return 1000 * slow.length / slow.reduce((sum, value) => sum + value, 0);
}

function assess(report, baseline = 'old', candidate = 'liveoff') {
  const runs = report.runs.map(run => {
    const phase = run.phases.find(value => value.kind === 'input');
    assert(phase?.after && phase.capture?.times, 'Every run needs a completed native input measurement');
    assert.deepEqual(run.errors || [], []);
    assert(phase.yawTravel > 50 && phase.after.player.active);
    assert(phase.samples.length >= 45 &&
      phase.samples.every(sample => !sample.page.hidden && sample.page.focused),
      'Every sample must belong to a visible foreground scene');
    const times = phase.capture.times, windows = [];
    assert(times.at(-1) - times[0] >= 55000, 'Keep the entire measured minute, including stalls');
    const measuredLow = low(times);
    if (phase.summary) assert.equal(measuredLow, phase.summary.low1);
    for (let end = times[0] + 5000; end <= times.at(-1); end += 5000) {
      // Keep the interval crossing the window's leading edge, as the live HUD does.
      const startIndex = times.findIndex(time => time > end - 5000);
      const window = times.slice(Math.max(0, startIndex - 1)).filter(time => time <= end);
      windows.push(low(window));
    }
    assert(windows.length >= 10, 'Use at least 55 seconds of native input per run');
    // Let the live HUD's preceding warmup frames leave its rolling window.
    const settledSamples = phase.samples.slice(5);
    const hud = settledSamples.map(sample => sample.page.live?.submitted)
      .filter(sample => sample?.seconds >= 4.5 && Number.isFinite(sample.low));
    const pageLows = settledSamples.map(sample => sample.page.live?.visual?.low).filter(Number.isFinite);
    const refresh = settledSamples.map(sample => sample.page.live?.refresh?.fps).filter(Number.isFinite);
    const intervals = times.slice(1).map((value, index) => value - times[index]);
    return {index: run.index, name: run.name,
      fps: 1000 * intervals.length / (times.at(-1) - times[0]), low1: measuredLow,
      fiveSecondLows: windows, medianFiveSecondLow: median(windows),
      liveHudLowMedian: hud.length ? median(hud.map(value => value.low)) : null,
      gpuCompletionLow: phase.gpuCompletionSummary?.low1 ??
        (phase.capture.completions?.length > 100 ? low(phase.capture.completions
          .filter((value, index, values) => index === 0 || value > values[index - 1])) : null),
      pageObservedLowMedian: pageLows.length ? median(pageLows) : null,
      pageRefreshHzMedian: refresh.length ? median(refresh) : null,
      over50: intervals.filter(value => value > 50).length,
      prewarmMissDelta: phase.after.prewarm.counts.misses - phase.before.prewarm.counts.misses,
      pipelineCreations: phase.capture.creations, gpuBefore: run.gpuBefore, gpuDuring: phase.gpu,
      yawTravel: phase.yawTravel, canvasBox: phase.canvasBox, actualStartup: run.actualStartup};
  });
  assert(report.pass && report.lean && report.foreground && runs.length >= 6 && runs.length % 2 === 0);
  const pairs = [];
  for (let index = 0; index < runs.length; index += 2) {
    const values = runs.slice(index, index + 2);
    assert.deepEqual(values.map(value => value.name).sort(), [baseline, candidate].sort());
    const old = values.find(value => value.name === baseline);
    const next = values.find(value => value.name === candidate);
    assert(Math.abs(old.canvasBox.width - next.canvasBox.width) < 1,
      'Native horizontal input amplitudes must match');
    pairs.push({order: values.map(value => value.name),
      wholeRunLowDrop: 1 - next.low1 / old.low1,
      fiveSecondMedianDrop: 1 - next.medianFiveSecondLow / old.medianFiveSecondLow});
  }
  const counterbalanced = pairs.some(pair => pair.order[0] === baseline) &&
    pairs.some(pair => pair.order[0] === candidate);
  const usableForBisection = counterbalanced &&
    pairs.every(pair => pair.wholeRunLowDrop >= .10 && pair.fiveSecondMedianDrop >= .10);
  return {measurementPassed: true, usableForBisection, baseline, candidate,
    criterion: 'At least three sequential counterbalanced pairs. Each pair must show >=10% ' +
      'lower candidate whole-run 1% Low AND median of disjoint five-second Low windows. ' +
      'No measured run is retried, discarded or reordered. This is an operational gate, not statistical proof.',
    runs, pairs, counterbalanced,
    allWindowsPrewarmed: runs.every(run => !run.prewarmMissDelta && !run.pipelineCreations.length),
    medianWholeRunDrop: 1 - median(runs.filter(run => run.name === candidate).map(run => run.low1)) /
      median(runs.filter(run => run.name === baseline).map(run => run.low1)),
    boundary: 'Native right-drag at a fixed possessed-camera starting pose. RHI submission timing ' +
      'does not measure physical presentation or input latency. Existing published packages are used ' +
      'without exchanging runtime/Cook files. Shader/resource observers are disabled except creation counts.'};
}

module.exports = {assess, low, median};

if (require.main === module) {
  initializeProjectOutput();
  const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
  const files = (option('reports') || option('report')).split(',').map(value => path.resolve(value));
  const segments = files.map(file => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(audit(value.source.file).sha256, value.source.sha256);
    if (!value.pass) {
      // A strict warm-only assertion fired after capture; preserve this measured
      // window and continue the original order without rerunning any version.
      const line = Number(value.error.match(/benchmark-villa-release-regression\.cjs:(\d+):/)?.[1]);
      const source = fs.readFileSync(value.source.file, 'utf8').split(/\r?\n/)[line - 1];
      assert.match(source || '', /assert\.equal\(phase\.before\.prewarm\.counts\.misses, phase\.after\.prewarm\.counts\.misses\)/);
      const last = value.runs.at(-1).phases.at(-1);
      assert(last.after.prewarm.counts.misses > last.before.prewarm.counts.misses);
      assert(last.capture.creations.length > 0);
    }
    return {value, source: audit(file)};
  });
  const first = segments[0].value;
  for (const {value} of segments) {
    for (const field of ['browser', 'seconds', 'foreground', 'lean', 'retainCooks'])
      assert.equal(value[field], first[field]);
    assert.deepEqual(value.packages, first.packages);
  }
  const report = {...first, pass: true, runs: segments.flatMap(({value}) => value.runs)
    .map((run, index) => ({...run, index: index + 1}))};
  if (segments.length > 1) assert.deepEqual(report.runs.map(run => run.name), first.order,
    'Continuation must preserve the original planned order without retrying measured windows');
  const result = {...assess(report, option('baseline'), option('candidate')),
    date: new Date().toISOString(), assessmentSource: audit(__filename),
    segments: segments.map(({value, source}) => ({
      source, fullSegmentPassed: value.pass, originalError: value.error || null,
      benchmarkSource: value.source, measuredRuns: value.runs.length})),
    productionDefaultsChanged: false, gitVersionBuildsStarted: false};
  const output = assertProjectOutput(path.resolve(option('output')));
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
