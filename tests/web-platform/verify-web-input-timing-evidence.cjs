'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const evidence=JSON.parse(fs.readFileSync(path.join(__dirname,'evidence/mouse-input-timing-20261107.json')));
for(const item of evidence.files)assert.equal(audit(item.file).sha256,item.sha256,item.file);
for(const pair of evidence.nativeSources){
  assert.equal(audit(pair.native.file).sha256,pair.native.sha256);
  assert.equal(audit(pair.web.file).sha256,pair.web.sha256);
  assert.equal(pair.native.sha256,pair.web.sha256);
}
const checked=new Map();
for(const item of evidence.packages){
  const folder=path.join(__dirname,'build',item.folder),manifest=JSON.parse(fs.readFileSync(path.join(folder,'asset-versions.json')));
  const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'build',item.baseline,'asset-versions.json')));
  assert.deepEqual(Object.keys(manifest).sort(),Object.keys(baseline).sort());
  for(const [name,metadata]of Object.entries(manifest)){
    const file=path.join(folder,name),stat=fs.statSync(file,{bigint:true}),key=stat.dev+':'+stat.ino;
    if(!checked.has(key))checked.set(key,audit(file).sha256);
    assert.equal(checked.get(key),metadata.sha256,file);
    if(!['index.html','config-files.json'].includes(name))assert.equal(metadata.sha256,baseline[name].sha256,'Delivery changed runtime/assets: '+name);
  }
  const assets=JSON.parse(fs.readFileSync(path.join(folder,'index.html'),'utf8').match(/const localRuntimeAssets = (\{[^\n]+\});/)[1]);
  assert.equal(assets.pageFrameMaxFPS,item.maxFPS);
  const configs=JSON.parse(fs.readFileSync(path.join(folder,'config-files.json')));
  const input=Buffer.from(configs.find(c=>c.path.endsWith('/UEWebEngine/Config/DefaultInput.ini')).data,'base64').toString();
  assert.equal([...input.matchAll(/^bEnableMouseSmoothing=(\w+)/gmi)].at(-1)[1].toLowerCase(),String(item.smoothing));
  const engine=Buffer.from(configs.find(c=>c.path==='/Engine/Platforms/Web/Config/WebEngine.ini').data,'base64').toString();
  assert.equal([...engine.matchAll(/^r.MotionBlurQuality=(\d+)/gm)].at(-1)[1],'0');
}
for(const file of evidence.diagnostics){
  const report=JSON.parse(fs.readFileSync(file));assert(report.pass);
  for(const run of report.runs){
    assert.deepEqual(run.errors,[]);assert(run.inputFrames.length>100);
    const events=run.motion.raw,frames=run.inputFrames;
    assert(Math.abs(events[0][0]-frames[0][1])<5000);
    assert.equal(frames.reduce((s,f)=>s+f[4],0),events.reduce((s,e)=>s+e[1],0));
    assert.equal(frames.reduce((s,f)=>s+Math.abs(f[4]),0),events.reduce((s,e)=>s+Math.abs(e[1]),0));
    assert(frames.every(f=>f.length===15&&f.every(Number.isFinite)));
    for(let i=1;i<frames.length;i++)assert(frames[i][0]===frames[i-1][0]+1&&frames[i][1]>frames[i-1][1]);
    if(run.smoothing===1){
      for(const f of frames)assert(Math.abs(f[6]-f[4]*.069993)<.00001);
    }else assert(frames.some(f=>Math.abs(f[6]-f[4]*.069993)>.01));
  }
}
for(const file of evidence.releaseChecks){
  const report=JSON.parse(fs.readFileSync(file));assert(report.pass);
  const run=report.runs[0];assert(run.visibility&&run.recovery);assert.deepEqual(run.errors,[]);
  assert(Math.abs(run.spawn.yaw-run.recovery.after.camera.yaw)<.0001,'Closed mouse path must restore orientation');
}
console.log(JSON.stringify({pass:true,packages:evidence.packages.length,diagnosticRuns:6,releaseChecks:2,
  nativeSourceFiles:evidence.nativeSources.length,visualFeelAccepted:false}));
