'use strict';
(function (root) {
  function createRecorder() {
    const records = [];
    let active = null, previous = null, lastBatch = null;
    function stop(reason = 'manual') {
      if (!active) return;
      active.reason = reason; active.stopped = new Date().toISOString();
      active.summary = summarize(active);
      active = null; previous = lastBatch = null;
    }
    function summarize(record) {
      const intervals = record.frames.filter(frame => frame.ms !== null), sorted = intervals.map(frame => frame.ms).sort((a, b) => a - b);
      const tail = sorted.slice(-Math.ceil(sorted.length * .01));
      return {frames: record.frames.length, intervals: sorted.length,
        durationMs: record.frames.length > 1 ? record.frames.at(-1).time - record.frames[0].time : 0,
        maxMs: sorted.at(-1) ?? null, p99Ms: sorted[Math.floor(sorted.length * .99)] ?? null,
        low: tail.length ? tail.length * 1000 / tail.reduce((a, b) => a + b, 0) : null,
        over50: sorted.filter(ms => ms > 50).length, over100: sorted.filter(ms => ms > 100).length,
        pipelineEvents: record.events.length,
        worst: intervals.toSorted((a, b) => b.ms - a.ms).slice(0, 12)};
    }
    return {
      records,
      get active() {return active;},
      start(metadata, epoch) {
        stop('new-recording');
        active = {metadata, started: new Date().toISOString(), startEpoch: epoch,
          frames: [], contexts: [], events: [], interruptions: [], summary: null,
          live: {frames: 0, intervals: 0, maxMs: null, over50: 0, over100: 0}};
        records.push(active); previous = lastBatch = null;
        return active;
      },
      ingest(pacing, context) {
        if (!active || !pacing || !Array.isArray(pacing.times)) return;
        if (!Number.isFinite(pacing.timeOrigin) || !Number.isFinite(pacing.at)) return;
        if (lastBatch !== null && pacing.at <= lastBatch) return;
        if (active.timeOrigin !== undefined && active.timeOrigin !== pacing.timeOrigin) {stop('worker-clock-changed'); return;}
        active.timeOrigin = pacing.timeOrigin; lastBatch = pacing.at;
        const contextIndex = active.contexts.length;
        active.contexts.push({at: pacing.at, ...context});
        for (const time of pacing.times) {
          if (!Number.isFinite(time) || time + pacing.timeOrigin < active.startEpoch || previous !== null && time <= previous) continue;
          const ms = previous === null ? null : time - previous;
          active.frames.push({time, ms, context: contextIndex});
          ++active.live.frames;
          if (ms !== null) {
            ++active.live.intervals; active.live.maxMs = Math.max(active.live.maxMs || 0, ms);
            if (ms > 50) ++active.live.over50;
            if (ms > 100) ++active.live.over100;
          }
          previous = time;
        }
        for (const event of pacing.events || []) if (event.start + pacing.timeOrigin >= active.startEpoch)
          active.events.push({...event, context: contextIndex});
        if (pacing.at + pacing.timeOrigin - active.startEpoch >= 120000 || active.frames.length >= 20000)
          stop('recording-limit');
      },
      interrupt(reason) {
        if (active) {active.interruptions.push({reason, at: Date.now()}); stop(reason);}
      },
      stop,
      summary() {return active ? active.live : records.at(-1)?.summary;},
      export() {
        return {version: 1, kind: 'villa-manual-turn', date: new Date().toISOString(), records,
          boundary: 'Exact owner-worker RHI submission intervals, not display scanout or GPU duration. ' +
            'Contexts are sampled about every 100 ms; each frame references its delivery batch. Camera and engine ' +
            'counters may update more slowly. Pipeline events cover API calls, not deferred driver compilation. ' +
            'First interval is omitted. The final unreported worker batch may be absent. No per-draw hooks or GPU waits.'};
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = {createRecorder};
  if (typeof document === 'undefined') return;
  const element = id => document.getElementById(id), recorder = createRecorder();
  root.__villaTurnRecorder = recorder;
  let attached, saving = false;
  function live() {return root.__villaGitHistory;}
  function child() {return document.querySelector('iframe')?.contentWindow;}
  function context(scene) {
    return {camera: scene.__webDefaultCamera, player: scene.__webPlayerView,
      gameFrame: scene.__webEngineFrames, gameMs: scene.__webThreadFrameTimes?.at(-1),
      view: scene.__webRenderView, stages: scene.__webThreadStages,
      scheduler: scene.__webFrameScheduler, io: scene.__webLocalContentStats,
      streaming: scene.__webTextureStreaming, prewarm: scene.__webPipelinePrewarm?.counts,
      pso: scene.__webOptimizationRHI, failure: scene.__webEngineFailure || null};
  }
  function attach(scene) {
    let latestPacing = scene.__webFramePacing;
    Object.defineProperty(scene, '__webFramePacing', {configurable: true, enumerable: true,
      get() {return latestPacing;},
      set(value) {
        latestPacing = value;
        // Object.assign publishes scheduler and IO fields after pacing. Wait for
        // the complete message, keeping work outside every draw and GPU submission.
        queueMicrotask(() => {
          if (attached === scene) recorder.ingest(value, context(scene));
        });
      }});
    attached = scene;
  }
  function update() {
    const state = live(), scene = child(), ready = state?.ready && !state.busy && !state.error;
    if (recorder.active && (!ready || recorder.active.metadata.mode !== state.mode || attached !== scene))
      recorder.interrupt('version-switch-or-scene-unavailable');
    if (ready && scene !== attached) attach(scene);
    if (recorder.active && scene?.__webEngineFailure) recorder.interrupt('engine-failure');
    element('record').disabled = !ready || saving;
    element('record').textContent = recorder.active ? '■ 停止记录' : '● 开始记录';
    element('save-capture').disabled = !recorder.records.some(record => record.frames.length > 1) || saving;
    const summary = recorder.summary(), count = recorder.records.length;
    element('capture-status').textContent = count ? `${recorder.active ? '记录中' : '已记录'} · ${count} 段 · ` +
      `${summary?.frames || 0} 帧 · 最长 ${summary?.maxMs?.toFixed(1) ?? '—'} ms · >100ms ${summary?.over100 || 0}` : '尚未记录';
    const metrics = scene?.__webLivePerformance?.submitted;
    element('max-frame').textContent = Number.isFinite(metrics?.maxMs) ? metrics.maxMs.toFixed(1) + ' ms' : '待采样';
  }
  element('record').onclick = () => {
    if (recorder.active) recorder.stop();
    else {
      const scene = child(), state = live();
      if (!state?.ready || state.busy) return;
      if (scene !== attached) attach(scene);
      const source = [...scene.document.scripts].map(script => script.textContent).join('\n');
      const match = source.match(/const localRuntimeAssets\s*=\s*(\{[^\n]+\});/);
      if (!match) {element('capture-file').textContent = '未读到版本身份，请刷新后重试'; return;}
      const assets = JSON.parse(match[1]);
      const args = source.match(/arguments: (\[[^\n]+\]),/);
      recorder.start({mode: state.mode, label: root.__villaHistoryVariants[state.mode].label,
        folder: root.__villaHistoryVariants[state.mode].folder,
        wasm: assets?.wasm?.sha256, prewarm: assets?.pipelinePrewarm,
        runtime: assets?.versions, arguments: args ? [...args[1].matchAll(/['"]([^'"]+)['"]/g)].map(value => value[1]) : [],
        clock: assets.gameFrameClock, frameBudget: assets.pageFrameBudget,
        fixedRenderSize: assets.fixedRenderSize, renderSizing: assets.renderSizing,
        settings: scene.__webProjectSettings, renderView: scene.__webRenderView,
        rhi: scene.__webOcclusionRHI, sampling: scene.__webVSMAdaptiveSampling,
        prewarmState: scene.__webPipelinePrewarm, camera: scene.__webDefaultCamera,
        player: scene.__webPlayerView, dpr: scene.devicePixelRatio,
        userAgent: navigator.userAgent}, performance.timeOrigin + performance.now());
    }
    update();
    child()?.document.getElementById('canvas')?.focus({preventScroll: true}); child()?.focus();
  };
  element('save-capture').onclick = async () => {
    recorder.stop('export'); saving = true; update();
    const output = element('capture-file'); output.textContent = '正在导出'; output.removeAttribute('href');
    try {
      const response = await fetch('/__diagnostics/villa-turn', {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(recorder.export())});
      const data = await response.json();
      if (!response.ok) throw Error(data.error || '导出失败');
      output.textContent = '已导出：' + data.file; output.href = data.url; output.target = '_blank';
      output.title = data.path;
    } catch (error) {output.textContent = error.message + '；记录仍保留，可重试';}
    finally {saving = false; update();}
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) recorder.interrupt('page-hidden');
  });
  setInterval(update, 100); update();
})(globalThis);
