'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const {profile,settings,runtimeAssets}=require('./web-accepted-defaults.cjs');
const root=path.resolve(__dirname,'../..'),base=path.join(__dirname,'build/villa-input-raw-free-20261107');
const dest=path.join(__dirname,'build/villa-default-20261107');
const manifest=folder=>JSON.parse(fs.readFileSync(path.join(folder,'asset-versions.json')));
const reference=manifest(base),products=manifest(dest);
for(const [name,item]of Object.entries(products)){
  assert.equal(audit(path.join(dest,name)).sha256,item.sha256,name);
  if(!['index.html','config-files.json','web-engine-host.js','web-engine-worker.js'].includes(name))
    assert.equal(item.sha256,reference[name].sha256,'Accepted binary/content changed: '+name);
}
const configs=folder=>JSON.parse(fs.readFileSync(path.join(folder,'config-files.json')));
const before=configs(base),after=configs(dest);
const decode=item=>Buffer.from(item.data,'base64').toString();
function systemSettings(items){
  const text=decode(items.find(c=>c.path==='/Engine/Platforms/Web/Config/WebEngine.ini'));
  return Object.fromEntries([...text.matchAll(/^([^;\s\[=]+)=([^\r\n]+)$/gm)].map(m=>[m[1],m[2]]));
}
assert.deepEqual(systemSettings(after),systemSettings(before),'Promotion must preserve all effective accepted settings');
for(const [key,value]of Object.entries(settings))assert.equal(systemSettings(after)[key],String(value));
for(const item of after){
  if(item.path==='/Engine/Platforms/Web/Config/WebEngine.ini'||item.path.endsWith('/UEWebEngine/Config/DefaultInput.ini'))continue;
  assert.deepEqual(item,before.find(c=>c.path===item.path),'Unrelated config changed: '+item.path);
}
const input=decode(after.find(c=>c.path.endsWith('/UEWebEngine/Config/DefaultInput.ini')));
assert.equal([...input.matchAll(/^bEnableMouseSmoothing=(\w+)/gmi)].at(-1)[1].toLowerCase(),'false');
const html=fs.readFileSync(path.join(dest,'index.html'),'utf8');
const assets=JSON.parse(html.match(/const localRuntimeAssets = (\{[^\n]+\});/)[1]);
for(const [key,value]of Object.entries(runtimeAssets))assert.equal(assets[key],value,key);
assert(html.includes('-WebPSOPrecacheTest'));
for(const name of ['web-engine-host.js','web-engine-worker.js'])
  assert.equal(products[name].sha256,audit(path.join(__dirname,name)).sha256);
assert(fs.readFileSync(path.join(base,'web-engine-worker.js'),'utf8').startsWith('globalThis.__webReuseReplayScratch=true;'));
const reportFile=path.join(__dirname,'results/accepted-default-mouse-20261107.json');
const report=JSON.parse(fs.readFileSync(reportFile));assert(report.pass&&report.defaultSettings);
const run=report.runs[0];assert.equal(new URL(run.url).search,'');
assert.equal(run.before.clock.mode,'page');assert.equal(run.inputBridge.mode,'direct-game-thread');
assert(run.before.history.enabled&&run.before.history.groupMotionQueries);
assert(run.after.history.motionQueriesGrouped>run.before.history.motionQueriesGrouped);
assert.equal(run.before.occlusion.groupAccessRevalidation,2);
assert(run.before.stagingReadbackPool.enabled&&run.before.optimization.psoPrecaching);
assert(run.after.ownerBudget[3]<=3&&run.after.ownerBudget[5]<=3&&run.after.ownerBudget[7]<=2);
assert(run.visibility&&run.recovery);assert.deepEqual(run.errors,[]);
assert(Math.abs(run.recovery.after.camera.yaw-run.spawn.yaw)<.0001);
const log=fs.readFileSync(path.join(__dirname,'results/accepted-default-mouse-20261107-1-page3.log'),'utf8');
for(const [key,value]of Object.entries(settings))assert(log.includes('Set CVar [['+key+':'+value+']]'),'CVar not applied: '+key);
const files=['tests/web-platform/web-accepted-defaults.cjs','tests/web-platform/build-web-engine.ps1',
  'tests/web-platform/package-web-project.cjs','tests/web-platform/package-web-default-template.cjs',
  'tests/web-platform/package-villa-parity-candidate.cjs','tests/web-platform/web-engine-host.js',
  'tests/web-platform/web-engine-worker.js','tests/web-platform/verify-web-accepted-defaults.cjs',
  'tests/web-platform/villa.html','tests/web-platform/villa-low-test.html',
  'tests/web-platform/results/villa-default-20261107-package.json',
  'tests/web-platform/results/accepted-default-mouse-20261107.json',
  'tests/web-platform/results/accepted-default-mouse-20261107-1-page3.log',
  'tests/web-platform/results/accepted-default-mouse-20261107-1-page3.png',
  'tests/web-platform/build/villa-default-20261107/asset-versions.json',
  'tests/web-platform/build/villa-input-raw-free-20261107/asset-versions.json'];
const evidence={date:'2026-11-07',pass:true,profile,defaultChanged:true,userAccepted:true,
  acceptance:'这版改善明显，可以用于默认值。之前的性能优化也都无异常情况，都用于默认值。',
  baseline:'villa-input-raw-free-20261107',folder:'villa-default-20261107',entry:'http://127.0.0.1:8765/villa.html',
  settings,runtimeAssets,retainedRuntimeAndCook:true,physicalLatencyMeasured:false,
  validation:{url:run.url,result:run.result,visibility:run.visibility,errors:run.errors,
    cameraReturnError:run.recovery.after.camera.yaw-run.spawn.yaw,defaultMode:run.before.clock,
    inputMode:run.inputBridge.mode,frameBudget:run.after.ownerBudget},
  files:files.map(file=>({...audit(path.join(root,file)),file})),
  boundary:'Promotes the exact manually accepted combination. Current release reuses accepted WASM/Cook. Normal threaded package scripts now apply this profile; mobile and explicit legacy/diagnostic packages keep their own settings. No new native engine build or physical display latency measurement.'};
const output=path.join(__dirname,'evidence/accepted-defaults-20261107.json');
if(process.argv.includes('--record'))fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
else {
  const saved=JSON.parse(fs.readFileSync(output));
  assert.deepEqual(saved,evidence,'Evidence changed; review before refreshing');
}
console.log(JSON.stringify({pass:true,profile,defaultUrl:run.url,runtimeAndCookUnchanged:true}));
