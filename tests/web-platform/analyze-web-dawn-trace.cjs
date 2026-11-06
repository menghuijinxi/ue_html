'use strict';
const fs=require('node:fs'),readline=require('node:readline'),assert=require('node:assert/strict');
const input=process.argv[2],output=process.argv[3];assert(input&&output);
(async()=>{
  const totals=new Map(),stacks=new Map(),long=[],categories=new Map();
  for await(const line of readline.createInterface({input:fs.createReadStream(input)})) {
    let event;try{event=JSON.parse(line.replace(/,$/,''));}catch{continue;}
    categories.set(event.cat,(categories.get(event.cat)||0)+1);
    if(!event.cat?.includes('gpu.dawn'))continue;
    const key=event.pid+':'+event.tid;
    if(event.ph==='B') {
      if(!stacks.has(key))stacks.set(key,[]);
      stacks.get(key).push(event);continue;
    }
    if(event.ph==='E') {
      const begin=stacks.get(key)?.pop();if(!begin)continue;
      event={...begin,dur:event.ts-begin.ts};
    }
    if(event.dur===undefined)continue;
    const total=totals.get(event.name)||{count:0,totalMs:0,maxMs:0};
    ++total.count;total.totalMs+=event.dur/1000;total.maxMs=Math.max(total.maxMs,event.dur/1000);
    totals.set(event.name,total);
    if(event.dur>2000)long.push(event);
  }
  const result={input,categories:[...categories],totals:[...totals].sort((a,b)=>b[1].totalMs-a[1].totalMs),
    long:long.sort((a,b)=>b.dur-a.dur),boundary:'Inclusive CPU trace durations. Nested categories overlap; do not add their totals or interpret as GPU execution time.'};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({categories:result.categories,totals:result.totals.slice(0,35),long:result.long.slice(0,8)},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
