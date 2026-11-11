'use strict';
// Compile the actual raster-bin selection code, including its original failure.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),engine=path.join(root,'reference-engine');
const relative='Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp';
const file=path.join(engine,relative),source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
const oldHead=cp.execFileSync('git',['rev-parse','ea3eff92d'],{cwd:engine,encoding:'utf8',windowsHide:true}).trim();
const old=cp.execFileSync('git',['show',oldHead+':'+relative],{cwd:engine,encoding:'utf8',windowsHide:true}).replace(/\r\n/g,'\n');
function extract(s,begin){const loop=s.indexOf('for (const auto& RasterBin : Pipelines)');assert(loop>=0);const at=s.indexOf(begin,loop);assert(at>=0);const end=s.indexOf('\n\t\t\tif (bFixedFunctionBin)\n',at);assert(end>at);return s.slice(at,end);}
const current=extract(source,'// Fixed bins are allocated contiguously');
const baseline=extract(old,'// Any bins within the fixed function bin mask are special cased');
const output=path.join(__dirname,'results/nanite-fixed-bins');fs.mkdirSync(output,{recursive:true});
const compiler='C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64';
const kernel='C:/Program Files (x86)/Windows Kits/10/Lib/10.0.22621.0/um/x64/kernel32.lib';
const results=[];
for(const [name,body] of [['old',baseline],['current',current]]){
 const code=`using uint32=unsigned int;
extern "C" __declspec(dllimport) __declspec(noreturn) void __stdcall ExitProcess(unsigned int);
uint32 Mask;
struct FGlobalResources {static uint32 GetFixedFunctionBinMask(){return Mask;}};
uint32 Actual(uint32 Index){
 struct {uint32 BinIndex;} RasterEntry{Index};
 for(uint32 Once=0;Once<1;++Once){
 ${body}
 return bFixedFunctionBin?1:2;
 }
 return 0;
}
extern "C" void Main(){
 uint32 Errors=0,Checked=0;
 for(uint32 Features=0;Features<4;++Features){
  Mask=15u|((Features&1)?16u:0u)|((Features&2)?32u:0u);
  for(uint32 Bin=0;Bin<65536;++Bin){
   // Independent specification: a reserved disabled-feature slot is skipped;
   // all bins after the reserved range remain material/programmable bins.
   const bool Reserved=Bin<(Features&2?48u:(Features&1?32u:16u))+(Features==3?16u:0u);
   const bool UnavailableVoxel=Reserved&&!(Features&1)&&(Bin&16u);
   uint32 Expected=UnavailableVoxel?0:(Reserved?1:2);
   Errors+=Actual(Bin)!=Expected;++Checked;
  }
 }
 ExitProcess(Checked!=262144?255:(Errors>254?254:Errors));
}
`;
 const cpp=path.join(output,name+'.cpp'),obj=path.join(output,name+'.obj'),exe=path.join(output,name+'.exe');fs.writeFileSync(cpp,code);
 const compile=cp.spawnSync(path.join(compiler,'cl.exe'),['/nologo','/c','/O2','/GS-','/Zl','/std:c++20','/Fo'+obj,cpp],{encoding:'utf8',windowsHide:true});
 fs.writeFileSync(path.join(output,name+'-compile.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,compile.stdout+compile.stderr);
 const link=cp.spawnSync(path.join(compiler,'link.exe'),['/nologo','/ENTRY:Main','/SUBSYSTEM:CONSOLE','/NODEFAULTLIB','/OUT:'+exe,obj,kernel],{encoding:'utf8',windowsHide:true});
 fs.writeFileSync(path.join(output,name+'-link.log'),link.stdout+link.stderr);assert.equal(link.status,0,link.stdout+link.stderr);
 const run=cp.spawnSync(exe,[],{encoding:'utf8',windowsHide:true});assert.equal(run.signal,null);
 assert.equal(run.status,name==='old'?16:0,'Actual reserved-bin classification '+name);
 results.push({name,exitCode:run.status,cases:262144,files:[cpp,obj,exe,path.join(output,name+'-compile.log'),path.join(output,name+'-link.log')].map(audit)});
}
const report={pass:true,source:audit(__filename),production:audit(file),oldHead,results,
 boundary:'Native executable tests all 16-bit bin IDs for all curve/voxel feature combinations. Full native scene rendering remains a separate requirement.'};
fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,cases:262144,oldMismatches:16});
