'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {verifyBuildDefaults,installOptimizationContract,verifyOptimizationContract,verifyNativeDefaults}=require('./web-optimization-contract.cjs');
const build=JSON.parse(fs.readFileSync(path.join(__dirname,'results/web-engine-full-thread-build-results.json'),'utf8').replace(/^\uFEFF/,''));
const wasm=build.products.find(item=>item.file.endsWith('.wasm')).sha256;
const checked=verifyBuildDefaults(build,wasm);assert(Object.keys(checked.defaults).length>=17);
const missing={...build,sourceFiles:build.sourceFiles.filter(item=>!item.file.endsWith('TemporalSuperResolution.cpp'))};
assert.throws(()=>verifyBuildDefaults(missing,wasm),/Missing or stale optimization source/);
assert.throws(()=>verifyBuildDefaults(build,'other-runtime'),/does not match/);
const folder=fs.mkdtempSync(path.join(__dirname,'build/optimization-contract-'));
const config=JSON.stringify([{path:'/Engine/Platforms/Web/Config/WebEngine.ini',
 data:Buffer.from('[SystemSettings]\nr.WebGPU.BindingPlan=0\n').toString('base64')}]);
fs.writeFileSync(path.join(folder,'config-files.json'),config);
const page={assets:{wasm:{sha256:wasm},versions:{}}};
const contract=installOptimizationContract(folder,build,page);
assert.equal(fs.readFileSync(path.join(folder,'config-files.json'),'utf8'),config,'Auditing changed project configuration');
assert.equal(contract.explicitOverrides['r.WebGPU.BindingPlan'].value,0);
verifyOptimizationContract(folder,page);
const state={rhi:{groupAccessRevalidation:2,dynamicGlobalsGroupReuse:true,bindingPlanEnabled:false,
 indirectDrawReuse:2,vsmPageOptimization:3,reuseComputePass:true},history:{groupMotionQueries:true,motionQueryInterval:0},
 upload:{enabled:true},readback:{enabled:true}};
verifyNativeDefaults(contract,state);
assert.throws(()=>verifyNativeDefaults(contract,{...state,rhi:{...state.rhi,indirectDrawReuse:0}}),/Runtime lost optimization/);
assert.throws(()=>verifyNativeDefaults(contract,{...state,upload:undefined}),/Missing native optimization readback/);
page.assets.gameFrameClock='page';
assert.throws(()=>verifyOptimizationContract(folder,page),/Runtime scheduling\/reuse changed/);
delete page.assets.gameFrameClock;
fs.appendFileSync(path.join(folder,'config-files.json'),' ');
assert.throws(()=>verifyOptimizationContract(folder,page),/configuration changed/);
console.log(JSON.stringify({pass:true,defaults:Object.keys(checked.defaults).length,
 missingBuildSourceRejected:true,wrongRuntimeRejected:true,missingRuntimeOptimizationRejected:true,
 explicitProjectOverridePreserved:true,schedulingDriftRejected:true,configurationDriftRejected:true}));
