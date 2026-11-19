'use strict';
// Compare the shipped packages and isolate the retained scene opt-in flag.
// Default performance runs observe viewport submissions without GPU wrappers or
// frozen clocks. Explicit diagnostic switches are recorded separately.
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const crypto = require('node:crypto');
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const origin = option('origin') || 'http://127.0.0.1:8765';
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
const modes = (option('modes') || 'legacy,off,no-scene').split(',');
const candidateFolder = option('folder');
const gameFrameClocks = option('game-frame-clocks')?.split(',');
assert(!gameFrameClocks || (gameFrameClocks.length === modes.length &&
  gameFrameClocks.every(v => ['owner', 'page'].includes(v)) && modes.every(m => m === 'candidate')));
const runtimeDefaultModes = option('runtime-defaults')?.split(',');
assert(!runtimeDefaultModes || (runtimeDefaultModes.length === modes.length &&
  runtimeDefaultModes.every(v => ['off', 'on'].includes(v)) && modes.every(m => m === 'candidate')));
const backendDefaultModes = option('backend-defaults')?.split(',');
assert(!backendDefaultModes || (backendDefaultModes.length === modes.length &&
  backendDefaultModes.every(v => ['off', 'on', 'disabled'].includes(v)) && modes.every(m => m === 'candidate')));
const recordIdleStatus = process.argv.includes('--idle-status') || !!(runtimeDefaultModes || backendDefaultModes);
const packagedFolder = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const baselineFolder = option('baseline-folder');
assert(!baselineFolder || packagedFolder.test(baselineFolder));
assert(modes.every(m => ['legacy', 'off', 'no-scene','candidate'].includes(m)));
assert(!modes.includes('candidate') || (candidateFolder && packagedFolder.test(candidateFolder)));
const hierarchyBatches = option('hierarchy-batches')?.split(',');
assert(!hierarchyBatches || (hierarchyBatches.length === modes.length && hierarchyBatches.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
const occlusionBatches = option('occlusion-batches')?.split(',');
assert(!occlusionBatches || (occlusionBatches.length === modes.length && occlusionBatches.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
const packBatches = option('pack-batches')?.split(',');
assert(!packBatches || (packBatches.length === modes.length && packBatches.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
const microBatches = option('micro-batches')?.split(',');
assert(!microBatches || (microBatches.length === modes.length && microBatches.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
const fixedMerges = option('fixed-merges')?.split(',');
assert(!fixedMerges || (fixedMerges.length === modes.length && fixedMerges.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
const programmableMerges = option('programmable-merges')?.split(',');
assert(!programmableMerges || (programmableMerges.length === modes.length && programmableMerges.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
const shadeBinnings = option('shade-binnings')?.split(',');
assert(!shadeBinnings || (shadeBinnings.length === modes.length && shadeBinnings.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
// Generic same-package A/B of one startup console variable, one value per run.
const cvarName = option('cvar'), cvarValues = option('cvar-values')?.split(',');
assert(!cvarName === !cvarValues);
assert(!cvarName || (/^[A-Za-z0-9_.]+$/.test(cvarName) && cvarValues.length === modes.length && cvarValues.every(v=>/^-?[0-9.]+$/.test(v)) && modes.every(m=>m==='candidate')));
const nanites = option('nanites')?.split(',');
assert(!nanites || (nanites.length === modes.length && nanites.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
const materialPrecaches = option('material-precaches')?.split(',');
assert(!materialPrecaches || (materialPrecaches.length === modes.length && materialPrecaches.every(v=>v==='0'||v==='1') && modes.every(m=>m==='candidate')));
assert(!nanites || ![packBatches,microBatches,fixedMerges,programmableMerges,shadeBinnings,hierarchyBatches,occlusionBatches,materialPrecaches].some(Boolean),'Isolate the Nanite switch');
const tour = process.argv.includes('--tour');
const interactive = process.argv.includes('--interactive');
const gpuTransfers = process.argv.includes('--gpu-transfers');
const commandLists = process.argv.includes('--command-lists');
assert(!commandLists || (interactive && !gpuTransfers));
const indirectReuse = option('indirect-reuse')?.split(',');
const renderTiming = option('render-timing')?.split(',');
assert(!renderTiming || (interactive && renderTiming.length === modes.length &&
  renderTiming.every(value => ['on', 'off'].includes(value)) && modes.every(mode => mode === 'candidate')));
assert(!indirectReuse || (interactive && !backendDefaultModes && !cvarName && indirectReuse.length === modes.length &&
  indirectReuse.every(value => ['0', '2'].includes(value)) && modes.every(mode => mode === 'candidate')));
const distanceFieldUpdates = option('distance-field-updates')?.split(',');
assert(!option('radiosity-temporal'), 'The Villa radiosity temporal comparison was retired');
const atlasFormats = option('atlas-formats')?.split(',');
assert(!atlasFormats || (interactive && !gpuTransfers && !distanceFieldUpdates && atlasFormats.length === modes.length &&
  modes.every(mode => mode === 'candidate') && atlasFormats.every(format => ['r32float', 'r8unorm'].includes(format))));
assert(!distanceFieldUpdates || (interactive && distanceFieldUpdates.length === modes.length &&
  distanceFieldUpdates.every(value => ['0', '1'].includes(value))));
const dpr = Number(option('dpr') || 1);
assert(Number.isFinite(dpr) && dpr >= 1 && dpr <= 3);
assert(!gpuTransfers || interactive, '--gpu-transfers requires an interactive route');
const pagePacing = process.argv.includes('--page-pacing');
assert(!pagePacing || interactive, '--page-pacing needs a headed interactive run');
const frameBudgets = option('frame-budgets')?.split(',').map(Number);
assert(!frameBudgets || (pagePacing && frameBudgets.length === modes.length &&
  frameBudgets.every(value => Number.isInteger(value) && value >= 1 && value <= 4) &&
  (!gameFrameClocks || gameFrameClocks.every(value => value === 'page'))));
const interactiveRoute = option('interactive-route') || 'spawn';
assert(['spawn', 'living'].includes(interactiveRoute) && (interactive || interactiveRoute === 'spawn'));
const livingRoute = interactiveRoute === 'living';
const captureTurn = process.argv.includes('--capture-turn');
assert(!captureTurn || livingRoute, 'Capture the moving image from the living room start');
const livingStart = {x: -20, y: 200, pitch: 12, yaw: -35};
const motionBlurModes = option('motion-blur')?.split(',');
const mouseSmoothingModes = option('mouse-smoothing')?.split(',');
const inputPhases = [
  ['idle', false, false],
  ['walk-turn-first', true, true],
  ['walk-turn-repeat', true, true],
  ['turn-only', false, true],
  ['walk-only', true, false],
];
const selectedPhases = option('interactive-phases')?.split(',');
const occlusionModes = option('occlusion-modes')?.split(',');
assert(!occlusionModes || (interactive && occlusionModes.length === modes.length &&
  occlusionModes.every(mode => ['history', 'control'].includes(mode))));
const parallelRecording = option('parallel-recording')?.split(',');
assert(!parallelRecording || (interactive && !runtimeDefaultModes && parallelRecording.length === modes.length &&
  parallelRecording.every(value => ['off', 'on'].includes(value)) && modes.every(mode => mode === 'candidate')));
for (const settings of [motionBlurModes, mouseSmoothingModes]) {
  assert(!settings || (interactive && settings.length === modes.length &&
    settings.every((setting, index) => setting === 'shipped' || (setting === 'off' && modes[index] === 'candidate'))));
}
assert(!selectedPhases || (interactive && new Set(selectedPhases).size === selectedPhases.length &&
  selectedPhases.every(name => inputPhases.some(phase => phase[0] === name))), 'Select valid interactive phases');
const walk = process.argv.includes('--walk') || tour || interactive, headed = process.argv.includes('--headed');
assert(!interactive || (headed && !tour), '--interactive needs a headed browser and its own input route');
const browser = option('browser') || 'msedge';
const affinity = Number(option('affinity') || 0);
assert(['chrome', 'msedge'].includes(browser));
assert(Number.isSafeInteger(affinity) && affinity >= 0 &&
  (!affinity || (browser === 'chrome' && process.platform === 'win32')));
const checkAffinity = affinity ? require('./comparison-browser-affinity.cjs') : null;
const trace = process.argv.includes('--trace'), gpuProbe = process.argv.includes('--gpu-probe');
const traceStart = Number(option('trace-start') || 0), traceSeconds = Number(option('trace-seconds') || 0);
const gpuTimestamps = process.argv.includes('--gpu-timestamps');
const gpuStart = Number(option('gpu-start') || 28), gpuEnd = Number(option('gpu-end') || 41);
assert(!gpuTimestamps || (gpuStart >= 0 && gpuEnd > gpuStart));
const observeMotionGPU = gpuTimestamps ? require('./observe-nanite-motion-gpu.cjs') : null;
const pointOnly = process.argv.includes('--shadow-point-only');
const pointDiagnostic = pointOnly ? require('./diagnose-point-shadow-vsm.cjs') : null;
assert(!pointOnly || modes.every(m=>m==='off'));
assert(!trace || walk); assert(!gpuProbe || walk);
assert(!interactive || !(trace || gpuProbe || gpuTimestamps), 'Measure interactive performance without diagnostic instrumentation');
const width = Number(option('width') || 1280), height = Number(option('height') || 720);
const seconds = Number(option('seconds') || 60);
assert(Number.isInteger(width) && width >= 640 && width <= 3840);
assert(Number.isInteger(height) && height >= 480 && height <= 2160);
assert(Number.isFinite(seconds) && seconds >= 16 && seconds <= 180);
assert(!tour || seconds <= 60);
assert(!pagePacing || seconds <= 28, 'The HUD keeps a rolling 30-second window');
const tag = option('tag') || 'nanite-off-regression-20261111';
assert(/^[a-z0-9-]+$/.test(tag));
const profileNames = option('profiles')?.split(',');
assert(!profileNames || (profileNames.length === modes.length &&
  profileNames.every(name => /^[a-z0-9-]+$/.test(name))), 'Specify one browser profile name per run');
initializeProjectOutput();
const output = assertProjectOutputTree(path.join(__dirname, 'results', tag));
assert(!fs.existsSync(path.join(output, 'report.json')), 'Use a new result tag');
fs.mkdirSync(output, {recursive: true});
fs.copyFileSync(__filename, path.join(output, 'source.cjs'));
if (gpuTimestamps) fs.copyFileSync(require.resolve('./observe-nanite-motion-gpu.cjs'), path.join(output,'gpu-observer.cjs'));
if (pointOnly) fs.copyFileSync(require.resolve('./diagnose-point-shadow-vsm.cjs'), path.join(output,'point-diagnostic.cjs'));
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), origin, runtimeDefaultModes, backendDefaultModes, recordIdleStatus, baselineFolder, hierarchyBatches, occlusionBatches, packBatches, microBatches, fixedMerges, programmableMerges, shadeBinnings, cvarName, cvarValues, nanites, materialPrecaches, walk, tour, interactive, headed, browser, affinity, trace, traceStart, traceSeconds, gpuProbe, gpuTimestamps, pointOnly, width, height, seconds, runs: [],
  boundary: `Serial fresh browser contexts at the recorded viewport, DPR ${dpr}. Viewport submission intervals, not physical display timestamps. `
    + 'All intervals retained, including stalls. No-scene changes only the HTML -WebNaniteScene argument of the shipped Nanite-off package. '
    + 'Legacy also has different runtime and Cook, so its difference cannot be assigned to one code change. '
    + (interactive ? 'Headed browser keyboard and mouse input, sampled actual camera poses, and separate idle, first/repeated combined, turn and walk windows. Pass indicates successful capture, not performance acceptance. ' :
      tour ? 'Existing native game-frame camera tour through the interior: simultaneous position and rotation, without keyboard input or route warmup. ' : walk ?
      'Simultaneous keyboard movement and horizontal/vertical mouse input through the packaged bridge. First movement is measured without a route warmup. '
      + 'Identical requested inputs do not guarantee identical world trajectories; sampled camera coordinates are retained.' :
      'Mouse-only DOM input follows the same absolute trajectory; actual camera state and event count are retained.')};
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
if (occlusionModes) report.boundary += ' Explicit per-run occlusion mode for diagnosis.';
if (parallelRecording) report.boundary += ' Explicit per-run draw recording startup flag for diagnosis.';
if (pagePacing) report.boundary += ' Existing HUD animation-frame and observed update samples, not display timestamps.';
if (renderTiming) {
  report.renderTiming = renderTiming;
  report.boundary += ' Only the per-view render duration notification is skipped before the Emscripten thread proxy. The native render graph callback still executes.';
}
if (indirectReuse) {
  report.indirectReuse = indirectReuse;
  report.boundary += ' Per-run indirect draw reuse is verified by native readback before movement.';
}
if (frameBudgets) report.boundary += ' Explicit page clock frame budgets for diagnosis.';
report.dpr = dpr;
if (distanceFieldUpdates)
  report.boundary += ' Explicit r.AOUpdateGlobalDistanceField override for diagnosing scheduled clipmap updates.';
if (atlasFormats)
  report.boundary += ' Device-side atlas format experiment. Package files and quantization are unchanged; textures, storage declarations and layout bindings match the selected format. Native UE accounting still describes the shipped format.';
if (gpuTransfers) {
  report.gpuTransfers = true;
  report.boundary += ' Diagnostic API calls and estimated logical copy extents. Excludes shader memory accesses, driver traffic and physical residency. Instrumented FPS is excluded from acceptance.';
}
if (commandLists) {
  report.commandLists = audit(require.resolve('./diagnostics/villa-command-lists.cjs'));
  report.boundary += ' Command lists and actual GPUQueue.submit batches are sampled for six frames; exclude instrumented FPS from acceptance.';
}
if (interactive) report.interactiveRoute = interactiveRoute;
if (selectedPhases) {
  report.selectedPhases = selectedPhases;
  report.boundary += ' Selected interactive windows only, for diagnosis.';
}
if ([motionBlurModes, mouseSmoothingModes].some(modes => modes?.includes('off')))
  report.boundary += ' Explicit per-run motion blur and mouse smoothing overrides are diagnostic.';
if(occlusionBatches)report.boundary='Serial fresh Edge contexts, same package and enabled Nanite/hierarchy batching, native occlusion batch switch verified in both HZB stages. Normal advancing clocks; viewport submission intervals include all stalls. No CPU/GPU profiler or WebGPU method wrapper unless explicitly requested as diagnostic. First movement/turn route without warmup; actual camera samples retained.';
if(baselineFolder)report.boundary+=' Explicit baseline-folder overrides the predefined baseline directories; mode names do not change its r.Nanite setting. Compare recorded package/configuration provenance.';
if(profileNames)report.boundary+=' Explicit browser profiles may reuse persistent caches between runs.';
if(gameFrameClocks)report.boundary+=' Explicit Game frame clock via the host URL parameter; page clock uses the default frame budget.';
if(runtimeDefaultModes)report.boundary+=' Runtime-defaults comparison changes only browser scheduling, input delivery and replay scratch reuse in localRuntimeAssets. Runtime, cooked content, configuration, resolution and startup arguments remain identical.';
if(backendDefaultModes)report.boundary+=' Explicit backend diagnostic changes only r.WebGPU.* and r.Web.* optimization controls in the intercepted configuration. Authored quality settings are retained. This is a diagnostic override, not a deliverable package.';
if(hierarchyBatches)report.boundary='Serial fresh Edge contexts, same package, Nanite enabled, native hierarchy batch switch independently verified. '
  +'Normal advancing clocks; viewport submission intervals include every stall. '
  +(!(trace||gpuProbe||gpuTimestamps)?'No CPU/GPU profiler or WebGPU method wrapper in the measured window. ':'Instrumented diagnostic; exclude its FPS from game-performance acceptance. ')
  +'First native camera tour includes simultaneous translation and rotation, with no route warmup. Actual sampled trajectories are retained.';
if(materialPrecaches)report.boundary='Serial fresh Edge contexts, same package and enabled Nanite/hierarchy/HZB batching. Material precache set in WebEngine.ini before engine startup and verified by native readback. Normal advancing clocks; first simultaneous movement/turn route without warmup. All viewport submission intervals retained. Explicit diagnostics are excluded from FPS acceptance.';
if(packBatches)report.boundary='Serial fresh Edge contexts, same package with enabled Nanite/hierarchy/HZB/material precache. Native cluster pack switch independently verified. Normal advancing clocks, first simultaneous movement/turn route without warmup, all viewport submission intervals retained. Explicit diagnostics are excluded from FPS acceptance.';
if(microBatches)report.boundary='Serial fresh Edge contexts, same package with enabled Nanite/hierarchy/HZB/packing/material precache. Only native micro batch switch changes; actual indirect workgroups are read back before capture. Normal clocks, first simultaneous movement/turn route without warmup, all viewport submission intervals retained. Explicit diagnostics are excluded from FPS acceptance.';
if(fixedMerges)report.boundary='Serial fresh Edge contexts, same package with Nanite and previous optimizations enabled. Only native fixed draw merge switch changes; actual draw counts and arguments read back before capture. Normal clocks, first movement/turn route without warmup, all viewport submission intervals retained. Explicit diagnostics excluded from FPS acceptance.';
if(programmableMerges)report.boundary='Serial fresh Edge contexts, same package with Nanite and previous optimizations enabled. Only native programmable draw merge switch changes; actual draw counts and arguments read back before capture. Normal clocks, first movement/turn route without warmup, all viewport submission intervals retained. Explicit diagnostics excluded from FPS acceptance.';
if(shadeBinnings)report.boundary='Serial fresh Edge contexts, same package with Nanite and previous optimizations enabled. Only native shade binning switch changes; actual binned and legacy material draw counts read back before capture. Normal clocks, first movement/turn route without warmup, all viewport submission intervals retained. Explicit diagnostics excluded from FPS acceptance.';
if(cvarName)report.boundary='Serial fresh Edge contexts, same package with Nanite and all other settings unchanged. Only the recorded console variable is written to WebEngine.ini before engine startup; this probe does not read it back natively. Normal clocks, first movement/turn route without warmup, all viewport submission intervals retained. Explicit diagnostics excluded from FPS acceptance.';
if(nanites)report.boundary='Serial fresh Edge contexts, identical runtime/Cook/configuration except r.Nanite set before startup and verified by native readback. Scene opt-in and all optimization settings retained. Normal clocks, first simultaneous movement/turn route without warmup, all viewport submission intervals retained. Nanite-off uses the same converted assets\' cooked fallback geometry. Explicit diagnostics are excluded from FPS acceptance.';
if (gpuTimestamps) { report.gpuWindow = {start:gpuStart,end:gpuEnd}; report.boundary += ' GPU timestamp instrumentation is diagnostic and is excluded from game-performance acceptance.'; }
if (trace) report.boundary += ' DevTools trace instrumentation is diagnostic.';
function installObserver(detailed, interactive) {
  const state = globalThis.__naniteOffFrames = {active: false, times: [], frames: [], samples: [], gpu: []};
  let sampled = 0;
  let count = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, enumerable: true,
    get: () => count, set(next) {
      if (state.active && next > count) {
        const now = performance.now(); state.times.push(now);
        if (detailed) {
          state.frames.push([next, now, globalThis.__webEngineFrames,
            globalThis.__webThreadStages?.rhiWorkMilliseconds, globalThis.__webThreadFrameTimes?.at(-1),
            globalThis.__webThreadStages?.renderWorkMilliseconds, globalThis.__webThreadStages?.renderCommands]);
          if (now - sampled >= 200) {
            sampled = now;
            state.samples.push({time:now, frame:next, camera:{...globalThis.__webDefaultCamera},
              player:interactive ? globalThis.__webPlayerView : undefined,
              history:{...globalThis.__webOcclusionHistory}, rhi:{...globalThis.__webOcclusionRHI},
              optimization:{...globalThis.__webOptimizationRHI}, streaming:{...globalThis.__webTextureStreaming},
              io:{...globalThis.__webContentIO?.stats}, stages:{...globalThis.__webThreadStages}});
          }
        }
      }
      count = next;
    }});
}
function mouseMotion(options) {
  const {seconds, walk} = options;
  const canvas = document.querySelector('canvas'); canvas.focus();
  const state = globalThis.__naniteOffMotion = {start: performance.now(), events: 0, done: false, keyEvents:[]};
  const mouse = (type, dx, dy = 0) => canvas.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true,
    button: 2, buttons: type === 'mouseup' ? 0 : 2, clientX: innerWidth / 2, clientY: innerHeight / 2,
    movementX: dx, movementY: dy}));
  const key = (type, value) => {
    state.keyEvents.push({time:performance.now(), type, value});
    canvas.dispatchEvent(new KeyboardEvent(type, {bubbles:true, cancelable:true, key:value.toLowerCase(),
      code:'Key'+value, keyCode:value.charCodeAt(0), which:value.charCodeAt(0)}));
  };
  mouse('mousedown', 0); let previous = 0, previousY = 0, currentKey = null;
  const timer = setInterval(() => {
    const elapsed = (performance.now() - state.start) / 1000;
    if (elapsed >= seconds) {
      if (currentKey) key('keyup', currentKey);
      mouse('mousemove', -previous, -previousY); mouse('mouseup', 0); clearInterval(timer);
      state.done = true; state.end = performance.now(); return;
    }
    const x = Math.round(650 * Math.sin(elapsed * Math.PI / 4));
    const y = walk ? Math.round(65 * Math.sin(elapsed * Math.PI / 3)) : 0;
    const nextKey = walk ? ['W','W','D','S','S','A'][Math.floor(elapsed / 2) % 6] : null;
    if (currentKey !== nextKey) {
      if (currentKey) key('keyup', currentKey);
      if (nextKey) key('keydown', nextKey);
      currentKey = nextKey;
    }
    mouse('mousemove', x - previous, y - previousY); previous = x; previousY = y; state.events++;
  }, 16);
}
function statistics(times) {
  const intervals = times.slice(1).map((v, i) => v - times[i]);
  assert(intervals.length > 50);
  const sorted = intervals.toSorted((a, b) => a - b), tail = sorted.slice(-Math.ceil(sorted.length / 100));
  return {frames: intervals.length, fps: 1000 * intervals.length / (times.at(-1) - times[0]),
    low1Fps: 1000 * tail.length / tail.reduce((a, b) => a + b, 0),
    p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)],
    p99Ms: sorted[Math.floor(sorted.length * .99)], maxMs: sorted.at(-1),
    over33Ms: intervals.filter(v => v > 1000 / 30).length, over50Ms: intervals.filter(v => v > 50).length,
    over100Ms: intervals.filter(v => v > 100).length};
}

const cameraDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const yawDistance = (a, b) => Math.abs((a.yaw - b.yaw + 540) % 360 - 180);

async function browserMotion(page, box, seconds, {translate, rotate, livingRoute}) {
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  const started = performance.now();
  let key, moves = 0, buttonDown = false;
  try {
    if (rotate) {
      await page.mouse.move(x, y);
      await page.mouse.down({button: 'right'});
      buttonDown = true;
    }
    for (;;) {
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed >= seconds) break;
      if (translate) {
        const next = livingRoute
          ? ['a', 'd'][Math.floor(elapsed / 4) % 2]
          : ['s', 'd', 'w', 'a'][Math.floor(elapsed / 2) % 4];
        if (next !== key) {
          if (key) await page.keyboard.up(key);
          key = next;
          await page.keyboard.down(key);
        }
      }
      if (rotate) {
        const angle = livingRoute ? elapsed * Math.PI * 3 / 4 : elapsed * Math.PI / 2;
        await page.mouse.move(x + box.width * .20 * Math.sin(angle),
          y + box.height * .04 * Math.sin(elapsed * Math.PI / 3));
        ++moves;
      }
      await page.waitForTimeout(20);
    }
  } finally {
    if (key) await page.keyboard.up(key);
    if (buttonDown) await page.mouse.up({button: 'right'});
  }
  return {translate, rotate, moves};
}

async function captureLivingTurn(page, box, owner, prefix) {
  const pose = () => owner.evaluate(() => ({frame: globalThis.__webRHIFrames,
    yaw: globalThis.__webDefaultCamera.yaw, time: performance.now()}));
  const x = box.x + box.width * .25, y = box.y + box.height * .5;
  const frames = [];
  await page.mouse.move(x, y);
  await page.mouse.down({button: 'right'});
  const start = performance.now();
  try {
    // Capture during a constant-speed sweep, after the five performance windows.
    const capture = async () => {
      await page.waitForTimeout(300);
      for (let i = 0; i < 8 && performance.now() - start < 1950; ++i) {
        const before = await pose();
        const file = `${prefix}-turn-${i}.png`;
        await page.screenshot({path: assertProjectOutput(path.join(output, file)), clip: box, scale: 'css'});
        frames.push({file, before, after: await pose()});
        await page.waitForTimeout(70);
      }
    };
    const sweep = async () => {
      for (let ms = 0; ms < 2400; ms = performance.now() - start) {
        await page.mouse.move(x + box.width * .5 * ms / 2400, y);
        await page.waitForTimeout(12);
      }
    };
    await Promise.all([sweep(), capture()]);
    assert(frames.length >= 2 && yawDistance(frames[0].before, frames.at(-1).after) > 10,
      'Screenshots must span an actual camera turn');
    return frames;
  } finally { await page.mouse.up({button: 'right'}); }
}
(async () => {
  try {
    for (const [index, mode] of modes.entries()) {
      const folder = mode === 'candidate' ? candidateFolder : baselineFolder || (mode === 'legacy' ? 'villa-default-20261107' : 'villa-nanite-off-20261111');
      const run = {index, mode, folder, errors: [], phases: [], assets: []}; report.runs.push(run);
      const motionBlur = motionBlurModes?.[index];
      if (distanceFieldUpdates) run.distanceFieldUpdates = {value: Number(distanceFieldUpdates[index]), logged: []};
      const mouseSmoothing = mouseSmoothingModes?.[index];
      if (motionBlur) run.motionBlur = {mode: motionBlur, loggedQuality: []};
      if (mouseSmoothing) run.mouseSmoothing = {mode: mouseSmoothing};
      for (const file of ['index.html', 'asset-versions.json', 'config-files.json'])
        run.assets.push(audit(path.join(__dirname, 'build', folder, file)));
      run.browserProfile = profileNames?.[index] || `${tag}-${index}`;
      const profile = assertProjectOutputTree(path.join(__dirname, 'build/browser-profiles', run.browserProfile));
      const context = await chromium.launchPersistentContext(profile, {
        channel: browser, headless: !headed, viewport: {width, height}, deviceScaleFactor: dpr,
        downloadsPath: path.join(profile, 'downloads'),
        args: ['--disk-cache-dir=' + path.join(profile, 'http-cache'),
          '--crash-dumps-dir=' + path.join(profile, 'crashes')]});
      const log = fs.createWriteStream(path.join(output, index + '-' + mode + '.log'));
      try {
        run.browser = context.browser().version();
        if (checkAffinity) run.affinityBefore = checkAffinity(profile, affinity, true);
        if (renderTiming?.[index] === 'off') {
          await context.route('**/index.html', async route => {
            const response = await route.fetch(), html = await response.text();
            const manifest = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
            assert(manifest, 'Expected the packaged runtime manifest');
            const assets = JSON.parse(manifest[1]);
            assert.equal(assets.runtime, 'UEWebEngineThreads.js');
            const source = fs.readFileSync(path.join(__dirname, 'build', folder, assets.runtime), 'utf8');
            assert.equal(crypto.createHash('sha256').update(source).digest('hex'), assets.versions[assets.runtime]);
            const entries = [...source.matchAll(/^\s*(\d+): \$0 => \{\s*const stages = globalThis\.__webThreadStages \|\|= \{\};\s*stages\.renderWorkMilliseconds =/gm)];
            const proxy = 'var runMainThreadEmAsm = (emAsmAddr, sigPtr, argbuf, sync) => {';
            assert.equal(entries.length, 1, 'Expected a single render duration callback');
            assert.equal(source.split(proxy).length, 2, 'Expected the Emscripten main thread proxy');
            // Give nested pthread workers the same script as the engine owner.
            const file = assertProjectOutput(path.join(output, index + '-no-render-timing.js'));
            fs.writeFileSync(file, source.replace(proxy, proxy + `\n  if (emAsmAddr === ${entries[0][1]}) return;`));
            run.diagnosticRuntime = audit(file);
            assets.runtime = '/results/' + tag + '/' + path.basename(file);
            assets.versions[assets.runtime] = run.diagnosticRuntime.sha256;
            await route.fulfill({response, body:html.replace(manifest[0], () => 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';')});
          });
        }
        if (parallelRecording) {
          const enabled = parallelRecording[index] === 'on', flag = '-WebParallelDrawRecording';
          run.parallelRecording = {enabled};
          await context.route('**/index.html', async route => {
            const response = await route.fetch(), html = await response.text();
            const match = html.match(/^( +arguments: )(\[[^\r\n]+\]),$/m);
            assert(match, 'Could not locate the shipped startup arguments');
            const args = JSON.parse(match[2]).filter(arg => arg !== flag);
            if (enabled) args.push(flag);
            await route.fulfill({response, body: html.replace(match[0], match[1] + JSON.stringify(args) + ',')});
          });
        }
        if (pagePacing) await context.route('**/web-engine-host.js?*', async route => {
          const response = await route.fetch(), body = await response.text();
          const marker = '  let contexts = [], events = [], renderView = null;';
          assert.equal(body.split(marker).length, 2, 'Expected the shipped frame timing HUD');
          await route.fulfill({response, body: body.replace(marker,
            '  globalThis.__comparisonPagePacing = {visual, refresh};\n' + marker)});
        });
        if (runtimeDefaultModes) await context.route('**/index.html', async route => {
          const response = await route.fetch(), html = await response.text();
          const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/); assert(match);
          const assets = JSON.parse(match[1]);
          if (runtimeDefaultModes[index] === 'on') {
            Object.assign(assets, require('./web-accepted-defaults.cjs').runtimeAssets);
            delete assets.gameFrameBridge;
          }
          const body = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
          run.runtimeDefaults = {mode: runtimeDefaultModes[index], assets,
            htmlSha256: crypto.createHash('sha256').update(body).digest('hex')};
          await route.fulfill({response, body});
        });
        if (materialPrecaches || nanites || cvarName) await context.route('**/config-files.json*', async route => {
          const response = await route.fetch(), files = await response.json();
          const file = files.find(f => f.path === '/Engine/Platforms/Web/Config/WebEngine.ini'); assert(file);
          const setting = cvarName || (nanites ? 'r.Nanite' : 'r.Nanite.WebMaterialPrecache');
          const value = Number((cvarValues || nanites || materialPrecaches)[index]);
          const data = Buffer.from(Buffer.from(file.data, 'base64').toString() +
            '\n[SystemSettings]\n' + setting + '=' + value + '\n');
          file.data = data.toString('base64'); file.sha256 = crypto.createHash('sha256').update(data).digest('hex');
          run.startupConfig = {path:file.path, sha256:file.sha256, [cvarName?'value':nanites?'nanite':'materialPrecache']:value, setting};
          await route.fulfill({response, body:JSON.stringify(files)});
        });
        await context.route('**/web-engine-worker.js?*', async route => {
          const response = await route.fetch();
          let body = await response.text();
          const iniSettings = {};
          if (indirectReuse) iniSettings['r.WebGPU.IndirectDrawReuse'] = Number(indirectReuse[index]);
          if (backendDefaultModes) {
            const settings = backendDefaultModes[index] !== 'off' ? Object.fromEntries(
              Object.entries(require('./web-accepted-defaults.cjs').settings).filter(([key]) => /^r\.Web(?:GPU)?\./.test(key))
                .map(([key, value]) => [key, backendDefaultModes[index] === 'disabled' ? 0 : value])) : {};
            run.backendDefaults = {mode: backendDefaultModes[index], settings};
            Object.assign(iniSettings, settings);
          }
          if (motionBlur === 'off') iniSettings['r.MotionBlurQuality'] = 0;
          if (distanceFieldUpdates) iniSettings['r.AOUpdateGlobalDistanceField'] = run.distanceFieldUpdates.value;
          if (Object.keys(iniSettings).length) {
            const marker = "        removeRunDependency('worker-content');";
            assert.equal(body.split(marker).length, 2);
            const ini = '\n[SystemSettings]\n' + Object.entries(iniSettings).map(([key, value]) => key + '=' + value).join('\n') + '\n';
            // Override the virtual INI after integrity checks on the packaged configuration.
            body = body.replace(marker, "        const diagnosticIni = '/Engine/Platforms/Web/Config/WebEngine.ini';\n" +
              '        FS.writeFile(diagnosticIni, FS.readFile(diagnosticIni, {encoding:"utf8"}) + ' + JSON.stringify(ini) + ');\n' + marker);
          }
          if (gpuProbe) {
            const marker = '  frameScheduler.queue.onSubmittedWorkDone().then(() => {';
            assert.equal(body.split(marker).length, 2);
            body = body.replace(marker, `  const probe = __naniteOffFrames.active ? {sequence:submitted,
    frame:globalThis.__webRHIFrames, submitted:performance.now(), pending:submitted-Atomics.load(state,0)} : null;
  if (probe) __naniteOffFrames.gpu.push(probe);
${marker}
    if (probe) probe.completed = performance.now();`);
          }
          await route.fulfill({response, body: `(${installObserver.toString()})(${walk}, ${interactive});\n` +
            (atlasFormats ? `(${require('./diagnostics/villa-distance-field-atlas.cjs')})(${JSON.stringify(atlasFormats[index])});\n` : '') +
            (gpuTransfers ? `(${require('./web-gpu-memory-observer.cjs')})(${require('./observe-gpu-transfers.cjs')});\n` : '') +
            (commandLists ? `(${require('./diagnostics/villa-command-lists.cjs')})();\n` : '') +
            (pointOnly ? `(${pointDiagnostic.toString()})();\n` : '') +
            (gpuTimestamps ? `(${observeMotionGPU.toString()})(${JSON.stringify({start:gpuStart,end:gpuEnd})});\n` : '') + body});
        });
        if (mode === 'no-scene') await context.route('**/index.html', async route => {
          const response = await route.fetch(), html = await response.text();
          assert(html.includes('"-WebNaniteScene",'));
          await route.fulfill({response, body: html.replace('"-WebNaniteScene",', '')});
        });
        const page = context.pages()[0];
        const cdp = await context.newCDPSession(page);
        if (!interactive) await cdp.send('Emulation.setFocusEmulationEnabled', {enabled:true});
        page.on('pageerror', e => run.errors.push(e.message));
        page.on('crash', () => run.errors.push('Page crashed'));
        page.on('console', m => {
          log.write(m.text() + '\n');
          const blurQuality = motionBlur && m.text().match(/Set CVar \[\[r\.MotionBlurQuality:(\d+)\]\]/);
          if (blurQuality) run.motionBlur.loggedQuality.push(Number(blurQuality[1]));
          const fieldUpdates = distanceFieldUpdates && m.text().match(/Set CVar \[\[r\.AOUpdateGlobalDistanceField:(\d+)\]\]/);
          if (fieldUpdates) run.distanceFieldUpdates.logged.push(Number(fieldUpdates[1]));
          if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text())) run.errors.push(m.text());
        });
        const startupBegin = Date.now();
        const url = new URL(`/build/${folder}/index.html`, origin);
        if (occlusionModes) {
          run.occlusionMode = occlusionModes[index];
          url.searchParams.set('occlusion', run.occlusionMode);
        }
        if (gameFrameClocks) {
          run.gameFrameClock = gameFrameClocks[index];
          url.searchParams.set('clock', run.gameFrameClock);
        }
        if (frameBudgets) {
          run.frameBudget = frameBudgets[index];
          url.searchParams.set('clock', 'page');
          url.searchParams.set('framebudget', run.frameBudget);
        }
        const response = await page.goto(url.href, {waitUntil: 'commit'});
        assert(response?.ok(), 'Package entry HTTP ' + response?.status());
        await page.waitForFunction(() => globalThis.__webEngineFailure ||
          (globalThis.__webEngineFrames >= 180 && globalThis.__webPSOPrecacheReady &&
            document.getElementById('loading')?.hidden), null, {timeout: 300000});
        const startupFailure = await page.evaluate(() => globalThis.__webEngineFailure);
        assert(!startupFailure, startupFailure);
        run.startupReadyMs = Date.now() - startupBegin;
        const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
        if (renderTiming) {
          run.renderTiming = {mode:renderTiming[index], commands:await owner.evaluate(() => globalThis.__webThreadStages?.renderCommands || 0)};
          assert.equal(run.renderTiming.commands > 0, renderTiming[index] === 'on', 'Render timing cross-thread notification');
        }
        if (parallelRecording) {
          run.parallelRecording.arguments = await owner.evaluate(() => Module.arguments);
          assert.equal(run.parallelRecording.arguments.includes('-WebParallelDrawRecording'), run.parallelRecording.enabled);
        }
        if (motionBlur === 'off') assert.equal(run.motionBlur.loggedQuality.at(-1), 0, 'Motion blur override did not take effect');
        if (distanceFieldUpdates)
          assert.equal(run.distanceFieldUpdates.logged.at(-1), run.distanceFieldUpdates.value, 'Distance field update override did not take effect');
        if (mouseSmoothing) {
          const inputMode = await page.evaluate(value => __webEngineRPC('WebMotionBenchmarkControl', 7, value),
            mouseSmoothing === 'off' ? 1 : 0);
          assert(inputMode === 1 || inputMode === 2, 'Mouse smoothing readback failed');
          run.mouseSmoothing.enabled = inputMode === 2;
          if (mouseSmoothing === 'off') assert(!run.mouseSmoothing.enabled, 'Mouse smoothing override did not take effect');
        }
        const idleStatus = async () => {
          const previous = await owner.evaluate(() => globalThis.__webNaniteIdleStatus?.sequence || 0);
          assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteIdleStatusTest')), 1);
          let status; const deadline = Date.now() + 10000;
          do {
            await page.waitForTimeout(50);
            status = await owner.evaluate(() => globalThis.__webNaniteIdleStatus);
          } while (!(status?.sequence > previous) && Date.now() < deadline);
          assert(status?.sequence > previous); return status;
        };
        const inspectNanite = recordIdleStatus || (gpuTransfers && mode === 'candidate');
        if (indirectReuse) {
          run.indirectDrawReuse = await owner.evaluate(() => globalThis.__webOcclusionRHI?.indirectDrawReuse);
          assert.equal(run.indirectDrawReuse, Number(indirectReuse[index]), 'Native indirect draw reuse mode');
        }
        if (inspectNanite) run.naniteIdleBefore = await idleStatus();
        if (hierarchyBatches || occlusionBatches || packBatches || microBatches || fixedMerges || programmableMerges || shadeBinnings || materialPrecaches || nanites || cvarName) {
          for(const [values,fn] of [[hierarchyBatches,'WebNaniteHierarchyBatchTest'],[occlusionBatches,'WebNaniteOcclusionBatchTest'],[packBatches,'WebNanitePackBatchTest'],[microBatches,'WebNaniteMicroBatchTest'],[fixedMerges,'WebNaniteFixedMergeTest'],[programmableMerges,'WebNaniteProgrammableMergeTest'],[shadeBinnings,'WebNaniteShadeBinningTest']])
            if(values)assert.equal(await page.evaluate(a => __webEngineRPC(a[0],a[1]), [fn,Number(values[index])]), 1);
          assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteAutomaticSceneTest', 1)), 1);
          await page.waitForFunction(() => __webPSOPrecacheReady, null, {timeout:180000});
          const start = Date.now(); let state;
          do {
            await page.waitForTimeout(100); assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteAutomaticSceneTest', 0)), 1);
            state = await owner.evaluate(() => globalThis.__webNaniteAutomaticSceneTest);
          } while (state?.step !== 1 && Date.now() - start < 120000);
          assert.equal(state?.step, 1);
          if(nanites){const enabled=Number(nanites[index]);assert.equal(state.enabled,!!enabled);
            assert(state.hierarchyBatch&&state.occlusionBatch&&state.packBatch&&state.materialPrecache);
            if(enabled)assert(state.entries>1&&state.registered>1&&state.packBatchedEntries>0);
            else {assert.equal(state.entries,0);assert.equal(state.registered,0);}
            run.nanite={enabled,registered:state.registered,entries:state.entries,packDispatchBuffers:state.packDispatchBuffers,fixedDrawCalls:state.fixedDrawCalls,programmableDrawCalls:state.programmableDrawCalls,programmableMergedEntries:state.programmableMergedEntries,shadeBinnedDraws:state.shadeBinnedDraws,shadeBinLegacyDraws:state.shadeBinLegacyDraws,materialDraws:state.materialDraws,
              hierarchyBatch:state.hierarchyBatch,occlusionBatch:state.occlusionBatch,packBatch:state.packBatch,materialPrecache:state.materialPrecache};
          } else assert(state.enabled && state.entries > 1);
          if(packBatches){const enabled=Number(packBatches[index]);
            assert.equal(state.packBatch,!!enabled);assert(state.hierarchyBatch&&state.occlusionBatch&&state.materialPrecache);
            assert.equal(state.packBatchedEntries>0,!!enabled);
            run.pack={enabled,registered:state.registered,entries:state.entries,batchedEntries:state.packBatchedEntries,dispatchBuffers:state.packDispatchBuffers};}
          if(microBatches){const enabled=Number(microBatches[index]);
            assert.equal(state.microBatch,!!enabled);assert(state.hierarchyBatch&&state.occlusionBatch&&state.packBatch&&state.materialPrecache);
            assert.equal(state.microBatchedEntries>0,!!enabled);
            run.micro={enabled,registered:state.registered,entries:state.entries,batchedEntries:state.microBatchedEntries,
              dispatchBuffers:state.microDispatchBuffers,directGroups:state.microDirectGroups,indirectArguments:state.microDispatchArguments};}
          if(fixedMerges){const enabled=Number(fixedMerges[index]);
            assert.equal(state.fixedMerge,!!enabled);assert(state.hierarchyBatch&&state.occlusionBatch&&state.packBatch&&state.microBatch&&state.materialPrecache);
            assert.equal(state.fixedMergedEntries>0,!!enabled);
            run.fixed={enabled,registered:state.registered,entries:state.entries,mergedEntries:state.fixedMergedEntries,
              drawCalls:state.fixedDrawCalls,indirectArguments:state.fixedDrawArguments};}
          if(cvarName)run.cvar={name:cvarName,value:Number(cvarValues[index]),registered:state.registered,entries:state.entries,programmableDrawCalls:state.programmableDrawCalls,
            shadeBinnedDraws:state.shadeBinnedDraws,materialDraws:state.materialDraws};
          if(shadeBinnings){const enabled=Number(shadeBinnings[index]);
            assert.equal(state.shadeBinning,!!enabled);assert.equal(state.shadeBinnedDraws>0,!!enabled);
            run.shade={enabled,registered:state.registered,entries:state.entries,binnedDraws:state.shadeBinnedDraws,legacyDraws:state.shadeBinLegacyDraws,materialDraws:state.materialDraws};}
          if(programmableMerges){const enabled=Number(programmableMerges[index]);
            assert.equal(state.programmableMerge,!!enabled);assert(state.hierarchyBatch&&state.occlusionBatch&&state.packBatch&&state.microBatch&&state.fixedMerge&&state.materialPrecache);
            if(!enabled)assert.equal(state.programmableMergedEntries,0);
            run.programmable={enabled,registered:state.registered,entries:state.entries,mergedEntries:state.programmableMergedEntries,
              drawCalls:state.programmableDrawCalls,indirectArguments:state.programmableDrawArguments};}
          if(materialPrecaches){const enabled=Number(materialPrecaches[index]);
            assert.equal(state.materialPrecache,!!enabled);assert(state.hierarchyBatch&&state.occlusionBatch);
            run.materialPrecache={enabled,registered:state.registered,entries:state.entries,
              hierarchyBatch:state.hierarchyBatch,occlusionBatch:state.occlusionBatch};}
          if(hierarchyBatches){const enabled=Number(hierarchyBatches[index]);
            assert.equal(state.hierarchyBatch, !!enabled); assert.equal(state.hierarchyBatchedEntries > 0, !!enabled);
            run.hierarchy = {enabled, registered:state.registered, entries:state.entries, batchedEntries:state.hierarchyBatchedEntries, dispatchBuffers:state.hierarchyDispatchBuffers};}
          if(occlusionBatches){const enabled=Number(occlusionBatches[index]);
            assert.equal(state.occlusionBatch,!!enabled);assert(state.hierarchyBatch);
            for(const prefix of ['mainOcclusion','finalOcclusion']){assert.equal(state[prefix+'Frame'],state.frame);assert.equal(state[prefix+'BatchedEntries']>0,!!enabled);}
            run.occlusion={enabled,hierarchyBatch:state.hierarchyBatch,registered:state.registered,entries:state.entries,
              batchedEntries:state.finalOcclusionBatchedEntries,dispatchBuffers:state.finalOcclusionDispatchBuffers};}
        }
        const snapshot = () => owner.evaluate(() => ({time: performance.now(), timeOrigin: performance.timeOrigin,
          stages: globalThis.__webThreadStages,
          frame: globalThis.__webRHIFrames, view: globalThis.__webRenderView, camera: globalThis.__webDefaultCamera,
          player: globalThis.__webPlayerView,
          settings: globalThis.__webProjectSettings, history: globalThis.__webOcclusionHistory,
          occlusion: globalThis.__webOcclusionRHI, optimization: globalThis.__webOptimizationRHI,
          pool: globalThis.__webStagingReadbackPool, clock: globalThis.__webGameFrameClock,
          visualClock: globalThis.__webVisualTestClock, failure: globalThis.__webEngineFailure}));
        async function measure(name, action) {
          assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
          let traceDone, traceWindowMark;
          const beginTrace = async () => {
            traceDone = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
            await cdp.send('Tracing.start', {categories:'toplevel,devtools.timeline,v8,blink.user_timing,gpu,disabled-by-default-v8.gc,disabled-by-default-gpu.service,disabled-by-default-gpu.dawn,gpu.dawn,disabled-by-default-gpu.decoder,disabled-by-default-gpu.debug',
              transferMode:'ReturnAsStream'});
          };
          if (trace && !traceStart) {
            await beginTrace();
            await page.waitForTimeout(1000);
          }
          const before = await snapshot();
          const schedulerBefore = pagePacing ? await page.evaluate(() => globalThis.__webFrameSchedulerPage) : undefined;
          if (frameBudgets) assert.equal(schedulerBefore?.maxAhead, run.frameBudget);
          if (run.occlusionMode) assert.equal(before.history?.enabled, run.occlusionMode === 'history');
          console.log(JSON.stringify({index, mode, name, status:'measuring', seconds:walk ? seconds : 20}));
          const traceMark = await owner.evaluate(() => {__naniteOffFrames.times = []; __naniteOffFrames.frames = [];
            __naniteOffFrames.samples = []; __naniteOffFrames.gpu = [];
            const time = performance.now(); performance.mark('UE motion capture begin');
            globalThis.__webGPUTransferCapture?.start();
            globalThis.__villaCommandLists?.start();
            __naniteOffFrames.active = true; return time;});
          const delayedTrace = trace && traceStart ? (async () => {
            assert(traceSeconds > 0 && traceStart + traceSeconds < seconds);
            await page.waitForTimeout(traceStart * 1000); await beginTrace();
            traceWindowMark = await owner.evaluate(() => {const now = performance.now();
              performance.mark('UE motion trace window'); return now;});
            await page.waitForTimeout(traceSeconds * 1000); await cdp.send('Tracing.end');
          })() : null;
          const input = await action(); await delayedTrace;
          const capture = await owner.evaluate(() => {
            __naniteOffFrames.active = false;
            return {...__naniteOffFrames, transfers: globalThis.__webGPUTransferCapture?.stop(),
              commandLists:globalThis.__villaCommandLists?.stop()};
          });
          const {times} = capture;
          const after = await snapshot();
          if (checkAffinity) (run.affinityAfter ||= []).push(checkAffinity(profile, affinity, false));
          for (const s of [before, after]) {
            assert(!s.failure && !s.visualClock?.renderTimeFrozen && !s.visualClock?.materialTimeFrozen);
            assert.equal(s.view.outputWidth, width); assert.equal(s.view.outputHeight, height);
            if (run.gameFrameClock) assert.equal(s.clock?.mode, run.gameFrameClock);
          }
          const result = statistics(times);
          result.rhiMs = (after.stages.rhiWorkMilliseconds - before.stages.rhiWorkMilliseconds) /
            (after.stages.presented - before.stages.presented);
          result.renderMs = (after.stages.renderWorkMilliseconds - before.stages.renderWorkMilliseconds) /
            (after.stages.presented - before.stages.presented);
          const phase = {name, before, after, result, times, traceMark};
          if (commandLists) {
            phase.commandLists = capture.commandLists;
            assert.equal(new Set(phase.commandLists.map(batch => batch.frame)).size, 6);
            assert(phase.commandLists.some(batch => batch.lists.some(list => list && Object.keys(list).length)));
          }
          if (gpuTransfers) {
            phase.transfers = capture.transfers;
            assert(phase.transfers.some(row => row.calls && row.bytes > 0), 'No GPU transfers recorded');
            phase.allocation = await owner.evaluate(() => {
              const {live, totals, errors} = __webGPUMemorySnapshot();
              const groups = new Map();
              for (const {kind, label, format, bytes} of live) {
                const key = JSON.stringify([kind, label, format]);
                const row = groups.get(key) || {kind, label, format, count: 0, bytes: 0};
                ++row.count;
                row.bytes += bytes || 0;
                groups.set(key, row);
              }
              return {totals, errors, groups: [...groups.values()]};
            });
            assert.deepEqual(phase.allocation.errors, []);
          }
          if (interactive) {
            phase.input = input;
            phase.page = await page.evaluate(() => ({visible: document.visibilityState === 'visible',
              focused: document.hasFocus(), pointerLock: document.pointerLockElement?.id ?? null,
              dpr: devicePixelRatio, inputMode: globalThis.__webInputBridge?.mode}));
            if (pagePacing) {
              phase.pagePacing = await page.evaluate(({begin, end}) => {
                const window = samples => samples.samples.slice(samples.head).map(sample => sample.time)
                  .filter(time => time + performance.timeOrigin >= begin && time + performance.timeOrigin <= end);
                return {visual: window(__comparisonPagePacing.visual), refresh: window(__comparisonPagePacing.refresh),
                  schedulerAfter: globalThis.__webFrameSchedulerPage, queue: globalThis.__webFrameScheduler};
              }, {begin: before.timeOrigin + times[0], end: before.timeOrigin + times.at(-1)});
              phase.pagePacing.schedulerBefore = schedulerBefore;
              phase.pagePacing.visualResult = statistics(phase.pagePacing.visual);
              phase.pagePacing.refreshResult = statistics(phase.pagePacing.refresh);
            }
          }
          if (walk) {
            phase.frameColumns = ['rhiFrame','time','gameFrame','rhiTotalMs','lastGameMs','renderTotalMs','renderCommands'];
            phase.frames = capture.frames; phase.samples = capture.samples;
            if (gpuProbe) phase.gpu = capture.gpu;
            const cameras = [before.camera, ...capture.samples.map(s => s.camera), after.camera];
            phase.travelCm = cameras.slice(1).reduce((s,c,i) => s + cameraDistance(c,cameras[i]), 0);
            phase.radiusCm = Math.max(...cameras.map(c => cameraDistance(c,cameras[0])));
            phase.turnDegrees = cameras.slice(1).reduce((s,c,i) => s + yawDistance(c,cameras[i]), 0);
            phase.pitchRange = Math.max(...cameras.map(c=>c.pitch))-Math.min(...cameras.map(c=>c.pitch));
            // The real camera has an approximately 80 cm rotation orbit. Require
            // displacement beyond that orbit to prove keyboard translation.
            assert(interactive || (phase.radiusCm > 150 && phase.travelCm > 500 && phase.turnDegrees > 180 && phase.pitchRange > 5),
              'Simultaneous translation and camera rotation must actually occur');
          }
          run.phases.push(phase); save();
          if (interactive) {
            assert(phase.page.visible && phase.page.focused && Math.abs(phase.page.dpr - dpr) < .001,
              'Interactive page lost focus or changed DPR');
            const players = [before.player, ...capture.samples.map(s => s.player), after.player];
            assert(players.every(p => p?.active), `${name}: playable camera lost control`);
            phase.playerRadiusCm = Math.max(...players.map(p => cameraDistance(p, players[0])));
            phase.playerTravelCm = players.slice(1).reduce((sum, p, i) => sum + cameraDistance(p, players[i]), 0);
            save();
            if (input?.translate) assert(phase.playerRadiusCm > 60 && phase.playerTravelCm > 150,
              `${name}: keyboard translation did not occur`);
            else assert(phase.playerRadiusCm < 5, `${name}: unexpected player translation`);
            if (input?.rotate) assert(phase.turnDegrees > 45 && phase.pitchRange > 3, `${name}: mouse look did not occur`);
            if (!input?.rotate) assert(phase.turnDegrees < 2, `${name}: unexpected camera rotation`);
            if (livingRoute && input?.translate) assert(phase.playerRadiusCm >= 300 && phase.playerTravelCm >= 700,
              `${name}: keyboard movement did not cover the living room (${phase.playerRadiusCm.toFixed(0)} cm radius)`);
          }
          console.log(JSON.stringify({index, mode, name, ...result,
            playerRadiusCm:phase.playerRadiusCm, radiusCm:phase.radiusCm, turnDegrees:phase.turnDegrees}));
          if (trace) {
            if (!traceStart) await cdp.send('Tracing.end');
            phase.traceWindowMark = traceWindowMark;
            const {stream} = await traceDone;
            const file = path.join(output, `${index}-${mode}-trace.json`), fd = fs.openSync(file,'w');
            try {
              for (;;) {
                const chunk = await cdp.send('IO.read',{handle:stream,size:1024*1024});
                fs.writeSync(fd,Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8'));
                if(chunk.eof)break;
              }
            } finally {fs.closeSync(fd); await cdp.send('IO.close',{handle:stream});}
            phase.trace = audit(file); save();
          }
        }
        const motion = async seconds => {
          await page.evaluate(mouseMotion, {seconds, walk});
          await page.waitForFunction(() => __naniteOffMotion.done, null, {timeout: (seconds + 30) * 1000});
        };
        if (interactive) {
          await page.bringToFront();
          await page.locator('#canvas').focus();
        }
        await page.waitForTimeout(10000);
        // Recorded outside the measured window: CPU speed and desktop state.
        run.environmentBefore = await require('./sample-test-environment.cjs')(page);
        await page.waitForTimeout(1000);
        run.initial = await snapshot();
        save();
        if (interactive) {
          const canvas = page.locator('#canvas');
          const box = await canvas.boundingBox();
          assert(box && box.width > 0 && box.height > 0);
          const initial = run.initial.camera;
          const setPlayer = async (args) => {
            const serial = await page.evaluate(values => __webEngineRPC('WebPlayerViewControl', ...values), args);
            assert(serial > 0, 'Playable camera control is unavailable');
            await page.waitForFunction(id => globalThis.__webPlayerView?.serial === id &&
              globalThis.__webPlayerView.active, serial, {timeout: 10000});
          };
          await setPlayer([0, ...Array(9).fill(0)]);
          const {player} = await snapshot();
          assert(player?.active);
          if (livingRoute) {
            await setPlayer([1, livingStart.x, livingStart.y, player.z, 0, livingStart.yaw, 0,
              livingStart.pitch, livingStart.yaw, 0]);
            await page.waitForTimeout(500);
            run.routeStart = await snapshot();
            assert(cameraDistance(run.routeStart.player, {...livingStart, z:player.z}) < 50 &&
              yawDistance(run.routeStart.camera, livingStart) < 1 &&
              Math.abs(run.routeStart.camera.pitch - livingStart.pitch) < 1,
              'Could not place the playable camera in the living room');
            await page.screenshot({path:path.join(output, `${index}-${mode}-living-start.png`)});
          }
          const reset = async () => {
            const start = run.routeStart?.player || player;
            await setPlayer([1, start.x, start.y, start.z, start.pitch, start.yaw, start.roll,
              start.controlPitch, start.controlYaw, start.controlRoll]);
            await page.waitForTimeout(300);
            const {camera} = await snapshot();
            const startCamera = run.routeStart?.camera || initial;
            assert(cameraDistance(camera, startCamera) < 5 && yawDistance(camera, startCamera) < 1 &&
              Math.abs(camera.pitch - startCamera.pitch) < 1, 'Could not restore the same starting camera');
          };
          for (const [name, translate, rotate] of inputPhases) {
            if (selectedPhases && !selectedPhases.includes(name)) continue;
            if (name === 'idle') {
              await measure(name, () => page.waitForTimeout(seconds * 1000));
            } else {
              if (name !== 'walk-turn-first') await reset();
              await measure(name, () => browserMotion(page, box, seconds, {translate, rotate, livingRoute}));
            }
          }
          if (inspectNanite) run.naniteIdleAfter = await idleStatus();
          if (atlasFormats) {
            run.atlas = await owner.evaluate(() => globalThis.__villaAtlasFormat);
            assert(run.atlas?.textures.length && run.atlas.shaders && run.atlas.storageGroups);
            assert(run.atlas.textures.every(texture => texture.format === atlasFormats[index]));
            assert(run.phases.every(phase => phase.after.optimization.asyncPrecacheFailed === 0));
          }
          run.environmentAfter = await require('./sample-test-environment.cjs')(page);
          if (captureTurn) {
            await reset();
            run.movingImages = await captureLivingTurn(page, box, owner, `${index}-${mode}`);
          }
          await page.screenshot({path:path.join(output, index + '-' + mode + '.png')});
          assert.deepEqual(run.errors, []);
          run.pass = true; save();
          continue;
        }
        if (walk) {
          await measure(tour ? 'interior-tour-first' : 'walk-and-turn-first', async () => {
            if (!tour) return motion(seconds);
            assert(await page.evaluate(s => __webEngineRPC('WebMotionBenchmarkControl', 3, s), seconds));
            await page.waitForFunction(() => globalThis.__webMotionBenchmark?.completed &&
              !globalThis.__webMotionBenchmark.active, null, {timeout:(seconds+30)*1000});
          });
          run.motion = await page.evaluate(isTour => isTour ? globalThis.__webMotionBenchmark : __naniteOffMotion, tour);
          run.environmentAfter = await require('./sample-test-environment.cjs')(page);
          if (recordIdleStatus) run.naniteIdleAfter = await idleStatus();
          if (pointOnly) {
            run.pointDiagnostic = await owner.evaluate(() => globalThis.__pointShadowDiagnostic);
            assert.equal(new Set(run.pointDiagnostic.patched).size,3);
          }
          if (gpuTimestamps) {
            // A long window holds more pass records than one message can carry;
            // --gpu-summary reduces them to per-frame and per-pass totals in the worker.
            run.gpuTimestamps = await owner.evaluate(summary => {
              const s = globalThis.__motionGPU; if (!summary) return s;
              const frames = new Map(), groups = {}; let invalid = 0;
              for (const r of s.results) {
                let f = frames.get(r.frame); if (!f) frames.set(r.frame, f = {ns:0, passes:0, draws:0, dispatches:0});
                for (const p of r.passes) {
                  if (!(p.ns >= 0 && p.ns < 1e9)) { invalid++; continue; }
                  f.ns += p.ns; f.passes++; f.draws += p.draws; f.dispatches += p.dispatches;
                  const key = (p.kind === 'beginComputePass' ? 'compute:' : 'render:') + (p.label || p.pipelines[0] || '');
                  const g = groups[key] ??= {ns:0, passes:0, draws:0, dispatches:0};
                  g.ns += p.ns; g.passes++; g.draws += p.draws; g.dispatches += p.dispatches;
                }
              }
              const totals = [...frames.values()].map(f => f.ns / 1e6).sort((a, b) => a - b), n = totals.length;
              const at = q => n ? totals[Math.min(n - 1, Math.floor(q * n))] : null;
              const mean = k => n ? [...frames.values()].reduce((sum, f) => sum + f[k], 0) / n : null;
              return {summary:true, window:s.window, pending:s.pending, errors:s.errors, frames:n, invalidPasses:invalid,
                passMs:{mean:n ? totals.reduce((a, b) => a + b, 0) / n : null, p50:at(.5), p95:at(.95), p99:at(.99), max:n ? totals[n - 1] : null},
                passesPerFrame:mean('passes'), drawsPerFrame:mean('draws'), dispatchesPerFrame:mean('dispatches'),
                groups:Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, {msPerFrame:g.ns / 1e6 / n, passesPerFrame:g.passes / n,
                  drawsPerFrame:g.draws / n, dispatchesPerFrame:g.dispatches / n}]).sort((a, b) => b[1].msPerFrame - a[1].msPerFrame)),
                pipelineCreations:s.pipelineCreations, slowCalls:s.slowCalls};
            }, process.argv.includes('--gpu-summary'));
            assert.equal(run.gpuTimestamps.pending, 0);
            assert.equal(run.gpuTimestamps.errors.length, 0, run.gpuTimestamps.errors.slice(0,3).join('\n'));
          }
          await page.screenshot({path:path.join(output,index+'-'+mode+'.png')});
          assert.deepEqual(run.errors, []); run.pass = true; save();
          continue;
        }
        await measure('spawn', () => page.waitForTimeout(20000));
        await motion(8); await page.waitForTimeout(1000);
        await measure('mouse', () => motion(16));
        run.motion = await page.evaluate(() => __naniteOffMotion);
        await page.waitForTimeout(500);
        run.returnedCamera = (await snapshot()).camera;
        assert(Math.abs(run.returnedCamera.yaw - run.initial.camera.yaw) < .01);
        assert.equal(await page.evaluate(() => __webEngineRPC('WebProjectViewTest', -175, -80, 160, -5, 50)), 1);
        await page.waitForTimeout(10000);
        await measure('room', () => page.waitForTimeout(20000));
        await page.screenshot({path: path.join(output, index + '-' + mode + '.png')});
        assert.deepEqual(run.errors, []); run.pass = true; save();
      } finally {await context.close(); log.end();}
    }
    report.pass = true;
  } catch (e) {report.failure = e.stack; process.exitCode = 1; console.error(e.stack);}
  finally {save(); console.log(JSON.stringify({pass: report.pass, output, failure: report.failure}));}
})();
