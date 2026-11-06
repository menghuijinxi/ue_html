'use strict';
// Read only section headers/imports: avoid loading a large UE module into RAM.
const fs=require('node:fs'),assert=require('node:assert/strict');
function auditMemory(file){
  const fd=fs.openSync(file,'r'),size=fs.fstatSync(fd).size,buffer=Buffer.alloc(65536);
  let position=0,base=-1,length=0;
  function byte(){
    assert(position<size,'Truncated Wasm');
    if(position<base||position>=base+length){base=position;length=fs.readSync(fd,buffer,0,buffer.length,base);}
    return buffer[position++-base];
  }
  function leb(){let v=0n,shift=0n,b;do{b=byte();v|=BigInt(b&127)<<shift;shift+=7n;assert(shift<=70n);}while(b&128);assert(v<=BigInt(Number.MAX_SAFE_INTEGER));return Number(v);}
  function name(){const n=leb();let value='';for(let i=0;i<n;i++)value+=String.fromCharCode(byte());return value;}
  function refType(){const type=byte();if(type===0x63||type===0x64)leb();}
  function limits(){const flags=leb();assert(!(flags&~7),'Unsupported limits flags');return {flags,addressBits:flags&4?64:32,shared:!!(flags&2),minimum:leb(),maximum:flags&1?leb():null};}
  const memories=[],tables=[];
  try{
    assert.deepEqual(Array.from({length:8},byte),[0,97,115,109,1,0,0,0]);
    while(position<size){
      const id=byte(),bytes=leb(),end=position+bytes;assert(end<=size);
      if(id===2){
        for(let i=0,n=leb();i<n;i++){
          const module=name(),field=name(),kind=byte();
          if(kind===0)leb();
          else if(kind===1){refType();tables.push({module,field,...limits()});}
          else if(kind===2)memories.push({module,field,...limits()});
          else if(kind===3){refType();byte();}
          else if(kind===4){byte();leb();}
          else throw Error('Unknown import kind '+kind);
        }
      }else if(id===4){for(let i=0,n=leb();i<n;i++){refType();tables.push(limits());}}
      else if(id===5){for(let i=0,n=leb();i<n;i++)memories.push(limits());}
      assert(position<=end,'Section overrun');position=end;
      if(id===10)break;
    }
    return {file,size,memories:memories.map(m=>({...m,minimumBytes:m.minimum*65536,maximumBytes:m.maximum===null?null:m.maximum*65536})),tables};
  }finally{fs.closeSync(fd);}
}
module.exports={auditMemory};
if(require.main===module)for(const file of process.argv.slice(2))console.log(JSON.stringify(auditMemory(file)));
