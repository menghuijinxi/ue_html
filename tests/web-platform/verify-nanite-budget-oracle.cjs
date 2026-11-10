'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const compare=require('./verify-nanite-budget-coverage.cjs'),{audit}=require('./content-file-metadata.cjs');
const beforeFile=path.join(__dirname,'results/nanite-skinning/failure-budget-cracks/browser.json');
const afterFile=path.join(__dirname,'results/nanite-skinning/failure-weld-silhouette/browser.json');
const before=JSON.parse(fs.readFileSync(beforeFile)),after=JSON.parse(fs.readFileSync(afterFile));
assert(before.failure.includes('31 !== 0'));assert(after.failure.includes('differentCoverage<=50'));
const reference=after.budgets[0].tests[1],coarse=after.budgets[0].tests[2],checks=[];
function accept(name,fn){fn();checks.push({name,pass:true,rejected:false});}
function reject(name,fn,pattern){assert.throws(fn,pattern);checks.push({name,pass:true,rejected:true});}
const clone=()=>({...reference,pixels:reference.pixels.slice(),totalPages:coarse.totalPages,rootPages:coarse.rootPages});
const has=(x,y)=>!!reference.pixels[(y*reference.width+x)*12];
let center;
for(let y=2;y<reference.height-2&&!center;y++)for(let x=2;x<reference.width-2&&!center;x++)
 if([[0,0],[0,-1],[0,1],[-1,0],[1,0]].every(([dx,dy])=>has(x+dx,y+dy)))center=(y*reference.width+x)*12;
assert(center!==undefined);
accept('observed coarse boundary remains inside one sampling cell',()=>{
 const r=compare(reference,coarse,1);assert.equal(r.differentCoverage,90);assert.equal(r.missingCore,0);assert.equal(r.extraCore,0);assert.equal(r.outsideEnvelope,0);
});
accept('fully resident geometry remains exact',()=>compare(reference,clone(),24));
reject('original native binding cracks still fail',()=>compare(before.budgets[0].tests[1],before.budgets[0].tests[2],1),/closed parent geometry/);
reject('single interior hole',()=>{const t=clone();t.pixels[center]=0;compare(reference,t,1);},/closed parent geometry/);
reject('empty selected geometry',()=>{const t=clone();t.pixels.fill(0);compare(reference,t,1);},/closed parent geometry/);
reject('remote one-pixel island',()=>{const t=clone();assert(!has(0,0));t.pixels[0]=1;compare(reference,t,1);},/one sampling cell/);
reject('added filled region',()=>{const t=clone();for(let y=1;y<4;y++)for(let x=1;x<4;x++){assert(!has(x,y));t.pixels[(y*t.width+x)*12]=1;}compare(reference,t,1);},/add an interior region/);
reject('depth drift',()=>{const t=clone();const f=new Float32Array(new Uint32Array([t.pixels[center+1]]).buffer)[0];t.pixels[center+1]=new Uint32Array(new Float32Array([f+.003]).buffer)[0];compare(reference,t,1);},/close to resident/);
reject('shading mask mismatch',()=>{const t=clone();t.pixels[center+3]^=1;compare(reference,t,1);},/shading mask/);
reject('stencil mismatch',()=>{const t=clone();t.pixels[center+11]^=1;compare(reference,t,1);},/stencil/);
reject('full budget cannot use the coarse silhouette',()=>compare(reference,coarse,24),/Expected values to be strictly equal/);
const result={pass:true,checks,source:audit(__filename),verifier:audit(require.resolve('./verify-nanite-budget-coverage.cjs')),
 inputs:[audit(beforeFile),audit(afterFile)],reason:'Replace a perimeter-dependent 50-point limit with a symmetric one-cell silhouette envelope; preserve zero interior holes, material/stencil equality, depth bound and exact full residency.'};
fs.writeFileSync(path.join(__dirname,'results/nanite-skinning/budget-oracle.json'),JSON.stringify(result,null,2));
console.log({pass:true,checks:checks.length,rejections:checks.filter(c=>c.rejected).length});
