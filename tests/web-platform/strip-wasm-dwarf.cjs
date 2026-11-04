'use strict';
// Remove only DWARF custom sections. Preserve executable bytes, names, imports
// and exports exactly, so a -g3 link can diagnose name minification without a
// >1 GiB debug payload exceeding the browser's module-size limit.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [input,output,reportFile]=process.argv.slice(2);assert(input&&output&&reportFile&&input!==output&&!fs.existsSync(output));
const source=fs.openSync(input,'r'),dest=fs.openSync(output,'wx'),size=fs.fstatSync(source).size;
let position=0;const originalHash=crypto.createHash('sha256'),outputHash=crypto.createHash('sha256'),sections=[];
const buffer=Buffer.alloc(1024*1024);
function bytes(n){const b=Buffer.alloc(n);assert.equal(fs.readSync(source,b,0,n,position),n);position+=n;return b;}
function leb(){const values=[];let value=0,shift=0;for(;;){const b=bytes(1)[0];values.push(b);value+=(b&127)*2**shift;if(!(b&128))return {value,bytes:Buffer.from(values)};shift+=7;assert(shift<56);}}
function consume(b,keep){originalHash.update(b);if(keep){fs.writeSync(dest,b);outputHash.update(b);}}
try{
 const header=bytes(8);assert.equal(header.toString('hex'),'0061736d01000000');consume(header,true);
 while(position<size){
  const id=bytes(1),length=leb(),end=position+length.value;assert(end<=size);const parts=[id,length.bytes];let name='';
  if(id[0]===0){const n=leb();assert(n.value<=4096);const text=bytes(n.value);name=text.toString('utf8');parts.push(n.bytes,text);}
  const keep=!name.startsWith('.debug_');for(const b of parts)consume(b,keep);
  while(position<end){const n=Math.min(buffer.length,end-position);assert.equal(fs.readSync(source,buffer,0,n,position),n);position+=n;consume(buffer.subarray(0,n),keep);}
  sections.push({id:id[0],name,bytes:length.value,removed:!keep});
 }
}finally{fs.closeSync(source);fs.closeSync(dest);}
const expected=outputHash.digest('hex'),actual=crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');assert.equal(actual,expected);
// UBT may reuse a link product already stripped by a previous invocation.
// That is an idempotent copy; the preserved name section is still required.
assert(sections.some(x=>x.name==='name'&&!x.removed));
const result={pass:true,input:{file:input,sha256:originalHash.digest('hex'),bytes:size},output:{file:output,sha256:actual,bytes:fs.statSync(output).size},sections,boundary:'Only .debug_* custom sections removed. Every retained byte including name/import/export/code/data sections is copied unchanged and the output hash is checked.'};
fs.writeFileSync(reportFile,JSON.stringify(result,null,2));console.log(JSON.stringify({pass:true,before:size,after:result.output.bytes,removed:sections.filter(x=>x.removed).length}));
