'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const results = path.join(__dirname, 'results');
const read = name => JSON.parse(fs.readFileSync(path.join(results, name+'.json'), 'utf8'));
const instance = read('instance-hzb-abba');
const hzb = read('hzb-submit-flush-check');
const pso = read('pso-precache-check');
const memory = read('rdg-ledger-verified');
const capabilities = read('webgpu-optimization-capabilities');
const packaged = read('villa-render-diagnostics-package');
assert(instance.pass && memory.pass && memory.readbackTest.pass);
assert(!hzb.pass && hzb.failure.includes('HZB must consume real readbacks'));
assert(hzb.runs[1].after.rhi.textureReadbacksReady > 0 && hzb.runs[1].after.rhi.textureReadbackMaps === 0);
assert(!pso.pass && /More than one thread is creating shaders/.test(fs.readFileSync(path.join(results, 'pso-precache-check.log'), 'utf8')));
assert.deepEqual(memory.ledgerEnd.unknownFormats, []);
assert.deepEqual(memory.end.settings,memory.start.settings);
for(const run of instance.runs) {
  assert.deepEqual(run.after.settings,instance.start.settings);
  assert.deepEqual(run.after.camera,instance.start.camera);
}
assert(packaged.pass && !packaged.psoPrecache && packaged.projectQualityOverrides.length === 0);
for (const item of [...packaged.products, packaged.build]) assert.equal(audit(item.file).sha256, item.sha256);
const percentile = (values, ratio) => {
  const sorted = values.filter(x=>x>0).sort((a,b)=>a-b);
  return sorted.length ? sorted[Math.min(sorted.length-1, Math.floor(sorted.length*ratio))] : null;
};
const capture = item => ({mode:item.mode,frames:item.capture.frames.length,
  callsPerFrame:Object.fromEntries(Object.entries(item.capture.calls).map(([k,v])=>[k,v/item.capture.frames.length]))});
const ledger = value => ({textureCount:value.textures, bufferCount:value.buffers,
  textureBytes:value.textureBytes,bufferBytes:value.bufferBytes,byFormat:value.byFormat,byLabel:value.byLabel,top:value.top.slice(0,12)});
const report = {date:new Date().toISOString(),evidenceChecksPass:true,defaultEnableRecommendation:false,
  boundary:'A diagnosed failed experiment is not a working feature. Background game remains running. Logical API allocation estimates are not physical VRAM.',
  evidence:['instance-hzb-abba.json','hzb-submit-flush-check.json','pso-precache-check.json',
    'pso-precache-check.log','rdg-ledger-verified.json','villa-render-diagnostics-package.json',
    'webgpu-optimization-capabilities.json'].map(f=>audit(path.join(results,f))),
  instanceHZB:{status:'no-throughput-gain-in-this-view',order:instance.runs.map(x=>({mode:x.mode,fps:x.fps,rhiMsPerFrame:x.rhiMsPerFrame})),
    summary:instance.summary,deltaPercent:(instance.summary[2].fps/instance.summary[0].fps-1)*100,
    baselineDriftPercent:(instance.runs[3].fps/instance.runs[0].fps-1)*100,
    api:instance.api.filter(x=>[0,2].includes(x.mode)).map(capture)},
  traditionalHZB:{status:'blocked-readback-not-consumed',counters:hzb.runs[1].after.rhi,
    readbackDataTest:memory.readbackTest,performanceComparisonValid:false},
  pso:{status:'blocked-shader-creation-thread-contract',asyncImplemented:false,
    observedBaselineTour:memory.tour.map(x=>({yawDelta:x.yawDelta,frames:x.capture.frames.length,
      newGraphicsPipelines:(x.capture.calls.createRenderPipeline||0),
      p50FrameMs:percentile(x.capture.frames.map(f=>f.intervalMs),.5),
      p95FrameMs:percentile(x.capture.frames.map(f=>f.intervalMs),.95),
      maxFrameMs:percentile(x.capture.frames.map(f=>f.intervalMs),1)}))},
  rdg:{status:'pool-already-reuses-resources-native-heap-aliasing-unavailable',physicalVRAM:false,
    before:ledger(memory.ledgerStart),afterForcedGC:ledger(memory.ledgerEnd),pool:memory.end.optimization,
    streaming:memory.end.streaming},capabilities,browserVersion:memory.browserVersion};
const output=path.join(results,'render-optimization-summary.json');
fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({evidenceChecksPass:true,output,instanceHZB:report.instanceHZB.summary,
  readback:report.traditionalHZB.readbackDataTest,pool:report.rdg.pool,
  textureMiB:report.rdg.afterForcedGC.textureBytes/1048576,bufferMiB:report.rdg.afterForcedGC.bufferBytes/1048576}));
