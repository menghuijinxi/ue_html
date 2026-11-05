'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = path.resolve(__dirname, '../../..');
const inputs = path.resolve(option('inputs')), prefix = path.resolve(option('prefix'));
const compiler = path.resolve(option('compiler')), output = path.resolve(option('output'));
const rounds = Number(option('rounds') || 3);
const stamp = option('stamp') ? '-' + option('stamp') : '';
const manifest = JSON.parse(fs.readFileSync(path.join(inputs, 'manifest.json')));
const sum = a => a.reduce((s, x) => s + x, 0);
const median = a => {const s = a.toSorted((a,b) => a-b); return (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2;};
async function scopes(file) {
  const events = [];
  for await (const line of readline.createInterface({input: fs.createReadStream(file), crlfDelay: Infinity})) {
    let e; try {e = JSON.parse(line.trim().replace(/,$/, ''));} catch {continue;}
    if (e.ph === 'X' && ['CompileShaderDXC', 'ShaderModuleD3D12::Compile',
      'CreatePipelineAsyncEvent::InitializeImpl', 'tint::hlsl::writer::Generate'].includes(e.name)) events.push(e);
  }
  return events.toSorted((a,b) => a.ts-b.ts);
}
(async () => {
  const report = {date: new Date().toISOString(), pass: false, compiler: audit(compiler), manifest: audit(path.join(inputs, 'manifest.json')),
    sources: ['diagnostics/benchmark-same-dxc.cpp', 'diagnostics/extract-dawn-hlsl.cjs', 'diagnostics/analyze-same-shader.cjs',
      'benchmark-web-pso-corpus.cjs', 'web-pso-replay-worker.js'].map(p => audit(path.join(root, 'tests/web-platform', p))),
    boundary: 'Exact exported HLSL, entry point, shader model, optimization flags and Edge DXC DLL. All 30 DXIL shader hashes verified against browser output. Browser detailed DXC scopes versus native Compile/GetStatus/GetResult. Serial per-pipeline execution; caches disabled for DXC workload equality. Neither side renders or runs UE. Native is a compiler baseline, not UE editor frame timing. Driver/global caches are retained. Trace is diagnostic. Wall-time remainder after nested shader scopes includes pipeline setup/cache/driver work, not pure driver time.',
    inputs: manifest.records, rounds: []};
  for (let i = 1; i <= rounds; i++) {
    const browserFile = `${prefix}-browser-serial-${i}${stamp}.json`;
    const nativeFile = `${prefix}-native-serial-${i}${stamp}.json`;
    const b = JSON.parse(fs.readFileSync(browserFile)), n = JSON.parse(fs.readFileSync(nativeFile));
    assert(b.pass && n.success && b.concurrency === 1 && n.concurrency === 1);
    assert(b.browserArgs.includes('--enable-dawn-features=disable_blob_cache'));
    assert(!b.dumpHlsl, 'Shader dumps must be disabled during timing');
    const trace = await scopes(b.runs[0].trace);
    const dxc = trace.filter(e => e.name === 'CompileShaderDXC');
    const init = trace.filter(e => e.name === 'CreatePipelineAsyncEvent::InitializeImpl');
    assert.equal(init.length * 2, manifest.records.length);
    assert.equal(dxc.length, manifest.records.length);
    assert.equal(n.rounds[0].shaders.length, manifest.records.length);
    const pairs = manifest.records.map((input, index) => {
      const s = n.rounds[0].shaders[index]; assert(s.success && s.matchesBrowser);
      assert.equal(s.index, index); assert.equal(s.dxilHash, input.dxilShaderHash);
      // One outstanding pipeline, with exactly two ordered compile scopes inside each pipeline.
      const parent = init[Math.floor(index / 2)], event = dxc[index];
      assert(event.pid === parent.pid && event.tid === parent.tid && event.ts >= parent.ts && event.ts + event.dur <= parent.ts + parent.dur);
      return {index, profile: input.profile, browserMs: event.dur/1000, browserCpuMs: event.tdur/1000,
        nativeMs: s.ms, nativeCpuMs: s.cpuMs, dxilHash: s.dxilHash};
    });
    const stageSum = name => sum(trace.filter(e => e.name === name).map(e => e.dur/1000));
    report.browser = b.browser;
    report.corpus = b.corpus;
    report.rounds.push({index: i, browserReport: audit(browserFile), nativeReport: audit(nativeFile), trace: audit(b.runs[0].trace),
      browserDxcMs: sum(pairs.map(s => s.browserMs)), browserDxcCpuMs: sum(pairs.map(s => s.browserCpuMs)),
      nativeDxcMs: sum(pairs.map(s => s.nativeMs)), nativeDxcCpuMs: sum(pairs.map(s => s.nativeCpuMs)),
      nativeBatchMs: n.rounds[0].wallMs, browserPipelineMs: b.runs[0].pipelineWallMs,
      browserTintMs: stageSum('tint::hlsl::writer::Generate'),
      browserInitializationRemainderMs: stageSum('CreatePipelineAsyncEvent::InitializeImpl') - stageSum('ShaderModuleD3D12::Compile'), pairs});
  }
  report.summary = {shaders: manifest.records.length, rounds,
    browserDxcMs: median(report.rounds.map(r => r.browserDxcMs)), nativeDxcMs: median(report.rounds.map(r => r.nativeDxcMs)),
    browserPipelineMs: median(report.rounds.map(r => r.browserPipelineMs)),
    browserTintMs: median(report.rounds.map(r => r.browserTintMs)),
    browserInitializationRemainderMs: median(report.rounds.map(r => r.browserInitializationRemainderMs)),
    perShader: manifest.records.map(({index,profile,dxilShaderHash}) => ({index,profile,dxilShaderHash,
      browserMs: median(report.rounds.map(r => r.pairs[index].browserMs)),
      nativeMs: median(report.rounds.map(r => r.pairs[index].nativeMs))}))};
  report.summary.browserToNativeRatio = report.summary.browserDxcMs / report.summary.nativeDxcMs;
  report.pass = true; fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary, null, 2));
})().catch(e => {console.error(e.stack); process.exitCode = 1;});
