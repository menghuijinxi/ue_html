'use strict';
// Compile the actual affected functions, including distinct FPU float/int types.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),engine=path.join(root,'reference-engine/Engine/Source/Runtime');
const output=path.resolve(__dirname,'../../results/nanite-curves/vectorvm');
const files={fpu:path.join(engine,'Core/Public/Math/UnrealMathFPU.h'),sse:path.join(engine,'Core/Public/Math/UnrealMathSSE.h'),
 web:path.join(engine,'VectorVM/Private/Platforms/VectorVMPlatformWeb.h'),runtime:path.join(engine,'VectorVM/Private/VectorVMRuntime.cpp')};
const sources=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,fs.readFileSync(v,'utf8')]));
function functionText(source,name){
 const matches=[...source.matchAll(new RegExp('^(?:VM_FORCEINLINE|FORCEINLINE) [^\\n]*\\b'+name+'\\s*\\([^\\n]*','gm'))];
 assert.equal(matches.length,1,name);
 const start=matches[0].index,open=source.indexOf('{',start);let depth=1,end=open+1;
 while(depth&&end<source.length){const c=source[end++];if(c==='{')++depth;if(c==='}')--depth;}
 assert.equal(depth,0,name);return source.slice(start,end);
}
function macro(source,name){const m=source.match(new RegExp('^#define '+name+'\\([^\\n]*','m'));assert(m,name);return m[0];}
const operations=['VVM_Exec3i_clampi','VVM_Exec1i_i2b','VVM_Exec1i_b2i','VVM_Exec1i_b2i_2x'];
const funcs=operations.map(n=>functionText(sources.runtime,n)).join('\n');
const structure=name=>{const m=sources.fpu.match(new RegExp('struct (?:alignas\\(16\\) )?'+name+'\\s*\\{[^}]*\\};'));assert(m,name);return m[0];};
let header='#pragma once\n#include <stdint.h>\n#include <algorithm>\n#ifndef __EMSCRIPTEN__\n#include <immintrin.h>\n#endif\n#define FORCEINLINE inline\n#define VM_FORCEINLINE inline\n';
header+='namespace IntegerWeb {\nusing int32=int32_t; using uint32=uint32_t;\nnamespace FMath {using std::min; using std::max; template<class T> T Min(T a,T b){return min(a,b);} template<class T> T Max(T a,T b){return max(a,b);}}\n';
header+=structure('VectorRegister4Int')+'\n'+structure('VectorRegister4Float')+'\nusing VectorRegister4i=VectorRegister4Int; struct FVectorVMBatchState {};\n';
for(const name of ['MakeVectorRegisterInt','VectorIntAnd','VectorIntXor','VectorIntCompareGT','VectorIntSelect','VectorIntMin','VectorIntMax'])header+=functionText(sources.fpu,name)+'\n';
header+=macro(sources.fpu,'VectorIntSet1')+'\n'+functionText(sources.web,'VectorIntClamp')+'\n'+funcs+'\n#undef VectorIntSet1\n}\n';
header+='#ifndef __EMSCRIPTEN__\nnamespace IntegerDesktop {\nusing VectorRegister4Int=__m128i;using VectorRegister4i=__m128i;struct FVectorVMBatchState {};\n';
for(const name of ['VectorIntSelect','VectorIntMin','VectorIntMax','VectorIntClamp'])header+=functionText(sources.sse,name)+'\n';
for(const name of ['VectorIntSet1','VectorIntCompareGT'])header+=macro(sources.sse,name)+'\n';
header+=funcs+'\n#undef VectorIntSet1\n#undef VectorIntCompareGT\n}\n#endif\n';
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'integer-contract.h'),header);
fs.writeFileSync(path.join(output,'integer-contract-sources.json'),JSON.stringify(Object.values(files),null,2)+'\n');
console.log({pass:true,functions:operations.length,output});
