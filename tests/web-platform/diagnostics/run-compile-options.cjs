'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {audit}=require('../content-file-metadata.cjs');
const [stage,tag]=process.argv.slice(2); assert(['native','browser','scheduling'].includes(stage)&&/^[a-z0-9-]+$/.test(tag));
const root=path.resolve(__dirname,'../../..'),results=path.join(root,'tests/web-platform/results');
const corpus=path.join(results,'runtime-pso-detail-async-20261105-1-async-corpus.json');
const variants=path.join(results,'compile-variants-20261105');
const compiler='C:/Program Files (x86)/Microsoft/Edge/Application/156.0.4314.58/dxcompiler.dll';
const run=(file,args)=>execFileSync(file,args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,timeout:240000});
const cases=stage==='native' ? [
  ...['O3','O0','O1','O2','Od'].map(o=>({name:o.toLowerCase(),optimization:o,concurrency:1})),
  ...[3,6,8].map(concurrency=>({name:'parallel-'+concurrency,optimization:'O3',concurrency}))
] : stage==='scheduling' ? [3,6,8,16].flatMap(concurrency=>['fifo','shared','largest','shared-largest'].map(schedule=>({name:schedule+'-'+concurrency,schedule,concurrency,blobCache:true}))) : [
  {name:'serial',concurrency:1}, {name:'minify',concurrency:1,variant:'minify'},
  {name:'ir',concurrency:1,variant:'ir-roundtrip'},
  {name:'skip-opt',concurrency:1,features:'d3d_skip_shader_optimizations'},
  ...[3,6,8,16].map(concurrency=>({name:'parallel-'+concurrency,concurrency})),
  ...[1,3,6,8,16].map(concurrency=>({name:'cache-'+concurrency,concurrency,blobCache:true}))
];
const report={date:new Date().toISOString(),stage,tag,compiler:audit(compiler),corpus:audit(corpus),cases,rounds:[],pass:false,
  boundary:'Real first-tour 15 PSO / 30 stage requests. Fresh process each trial, disk shader cache disabled in all browser trials; native compiler has no shader cache. Browser cases without cache-* also disable Dawn blob cache. OS file and driver caches retained. Diagnostic traces; no rendering. Interleaved case order rotated each round. No concurrent builds or benchmarks.'};
const output=path.join(results,tag+'-'+stage+'-suite.json');assert(!fs.existsSync(output));
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
try {
  for(let round=0;round<3;round++)for(let i=0;i<cases.length;i++) {
    const c=cases[(i+round*3)%cases.length],name=`${tag}-${stage}-${c.name}-${round+1}`;
    const gpu=run('nvidia-smi',['--query-gpu=utilization.gpu,temperature.gpu','--format=csv,noheader,nounits']).trim();
    assert(gpu.split(/\r?\n/).every(l=>Number(l.split(',')[0])<=50),'GPU busy before '+name);
    let text;
    if(stage==='native')text=run(path.join(results,'benchmark-same-dxc.exe'),[compiler,path.join(results,'same-shader-inputs-20261105'),'2018','1',String(c.concurrency),path.join(results,name+'.json'),path.join(results,name+'-dxil'),c.optimization]);
    else text=run(process.execPath,[path.join(root,'tests/web-platform/benchmark-web-pso-corpus.cjs'),
      '--corpus='+(c.variant?path.join(variants,c.variant+'.json'):corpus),'--tag='+name,
      '--concurrency='+c.concurrency,'--rounds=1','--profile=compile-options','--module-fence','--browser-trace','--disable-cache',
      ...(c.blobCache?[]:['--disable-blob-cache']),...(c.features?['--dawn-features='+c.features]:[]),...(c.schedule?['--schedule='+c.schedule]:[])]);
    const f=path.join(results,name+'.json'),result=JSON.parse(fs.readFileSync(f));
    assert(stage==='native'?result.success:result.pass);
    report.rounds.push({round:round+1,case:c.name,gpu,report:audit(f)});save();
    console.log(JSON.stringify({stage,round:round+1,case:c.name,ms:stage==='native'?result.rounds[0].wallMs:result.runs[0].pipelineWallMs}));
  }
  report.pass=true;
} finally {save();}
