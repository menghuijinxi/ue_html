'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const {WebFrameSamples} = require('./web-engine-host.js');
const [input,trace] = process.argv.slice(2);
if(!input)throw Error('Usage: node analyze-web-stutters.cjs capture.json [chrome-trace.json]');
(async()=>{
  const capture=JSON.parse(fs.readFileSync(input,'utf8'));
  const output={input,pass:capture.pass,phases:capture.phases.map(phase=>{
    const samples=new WebFrameSamples();let minimum=Infinity;
    for(const frame of phase.data.frames){samples.add(frame.time);const low=samples.read(frame.time).low;
      if(low!==null)minimum=Math.min(minimum,low);}
    return {name:phase.name,summary:phase.summary,minimumRolling5sLow:Number.isFinite(minimum)?minimum:null};
  })};
  if(trace){
    // Chromium writes one event per line. Stream large GPU traces instead of
    // constructing a JS string that can exceed V8's 512-MB string limit.
    const stacks=new Map(),long=[],marks=[],threads=[],cacheHits=[];
    let count=0,gcMaximumMs=0,gcCount=0;
    const lines=readline.createInterface({input:fs.createReadStream(trace),crlfDelay:Infinity});
    for await (let line of lines){
      line=line.trim().replace(/,$/,'');if(!line.startsWith('{"'))continue;
      let event;try{event=JSON.parse(line);}catch{continue;}
      ++count;
      const key=event.pid+':'+event.tid;
      if(event.name==='thread_name')threads.push(event);
      if(event.name?.startsWith('UE long frame'))marks.push(event);
      if(event.name==='DawnCachingInterface::CacheHit')cacheHits.push(event);
      if(event.ph==='B'){
        if(!stacks.has(key))stacks.set(key,[]);stacks.get(key).push(event);
      }else if(event.ph==='E'){
        const begin=stacks.get(key)?.pop();
        if(begin)event={...begin,ph:'X',dur:event.ts-begin.ts};
      }
      if(event.ph!=='X')continue;
      if(['MinorGC','MajorGC'].includes(event.name)){
        ++gcCount;gcMaximumMs=Math.max(gcMaximumMs,event.dur/1000);
      }
      if(event.dur>20000){long.push(event);long.sort((a,b)=>b.dur-a.dur);long.length=Math.min(long.length,80);}
    }
    output.trace={file:trace,events:count,threads,long,marks,gcCount,gcMaximumMs,cacheHits};
  }
  const destination=input.replace(/\.json$/,'')+'-analysis.json';
  fs.writeFileSync(destination,JSON.stringify(output,null,2));
  console.log(JSON.stringify({destination,phases:output.phases.map(p=>({name:p.name,
    fps:p.summary.fps,low:p.summary.low,maximum:p.summary.maximum,minimumRolling5sLow:p.minimumRolling5sLow})),
    trace:output.trace?{events:output.trace.events,gcMaximumMs:output.trace.gcMaximumMs}:undefined}));
})().catch(error=>{console.error(error);process.exitCode=1;});
