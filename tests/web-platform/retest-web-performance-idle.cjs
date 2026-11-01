'use strict';
// Serial historical-package comparisons after the interfering game was closed.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const results=path.join(__dirname,'results'),build=path.join(__dirname,'build');
const option=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
const prefix=option('prefix')||'idle-20261101';assert(/^[a-z0-9-]+$/.test(prefix));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const reportFile=path.join(results,prefix+'-suite.json');
const report={date:new Date().toISOString(),pass:false,prefix,qualityOverrides:[],jobs:[],packages:{},
  sources:['retest-web-performance-idle.cjs','compare-web-rhi-adaptation.cjs','capture-web-performance.cjs',
    'probe-web-render-optimizations.cjs','web-performance-capture-observer.cjs','monitor-web-performance-environment.ps1'].map(f=>audit(path.join(__dirname,f))),
  boundary:'Serial browser runs; historical Cook/runtime packages, identical view/settings within each comparison. Process monitoring samples every 5 seconds; this is not a controlled laboratory environment.'};
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
const pairs=[
  {id:'manual-fetch',history:'manual-fetch-abba',recook:'manual-fetch',baselineCook:'manual-fetch-baseline-cook',candidateCook:'manual-fetch-candidate-cook'},
  {id:'resource-tables',history:'resource-tables-v3-abba'},
  {id:'gpuscene',history:'gpuscene-abba',recook:'gpuscene',baselineCook:'gpuscene-before-web-project-triplex-project-desktop-cook-results',candidateCook:'gpuscene-after-cook-results'},
  {id:'parallel-recording',history:'parallel-recording-v2-abba'},
  {id:'rhi-adaptation',history:'adaptation-v2-abba',baseline:'triplex-before-dx-binding-20261101'},
  {id:'dx-binding',history:'dx-binding-v3-abba'},
  {id:'webgpu-layout',history:'webgpu-layout-abba'},
  {id:'webgpu-uploads',history:'webgpu-uploads-fixed-camera-abba'},
  {id:'render-bundles',history:'webgpu-bundles-v3-abba',bundles:true}
];
const environment=()=>{
  const file=path.join(results,prefix+'-environment.jsonl');
  const lines=fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x.replace(/^\uFEFF/,'')));
  const last=lines.at(-1);assert(last&&Date.now()-Date.parse(last.utc)<20000,'Environment monitor must be running');
  assert.deepEqual(last.blockers,[],'Game/build process detected');return last;
};
async function run(id,script,args,output,expectedFailure) {
  const before=environment(),file=path.join(results,output+'.json');
  const job={id,script,args,before,started:new Date().toISOString(),output:file};
  if(fs.existsSync(file)) {
    const previous=read(file);
    // Adopt the first comparison started interactively; also permit safe resume.
    assert(previous.pass || expectedFailure?.test(previous.failure||''),'Existing output is incomplete; use a fresh tag');
    job.adoptedExisting=true;
  } else {
    const logFile=path.join(results,prefix+'-'+id+'-console.log');
    const log=fs.openSync(logFile,'w');job.log=logFile;
    console.log(JSON.stringify({event:'start',id,utc:job.started}));
    try { job.exitCode=await new Promise((resolve,reject)=>{
      const child=cp.spawn(process.execPath,[path.join(__dirname,script),...args],{stdio:['ignore',log,log],windowsHide:true});
      child.on('error',reject);child.on('close',resolve);
    }); } finally {fs.closeSync(log);}
  }
  const value=read(file);job.after=environment();job.finished=new Date().toISOString();job.report=audit(file);
  job.expectedFailure=!!expectedFailure;job.valid=expectedFailure ? !value.pass&&expectedFailure.test(value.failure||'') : value.pass===true;
  job.fps=value.fps||value.summary;job.improvementPercent=value.improvementPercent;
  report.jobs.push(job);save();console.log(JSON.stringify({event:'finish',id,valid:job.valid,fps:job.fps,improvementPercent:job.improvementPercent}));
  assert(job.valid,'Unexpected test outcome: '+id);return value;
}
(async()=>{try {
  if(process.argv.includes('--adopt-manual')) {
    const file=path.join(results,prefix+'-manual-fetch-abba.json');
    const start=Date.now();
    while(!fs.existsSync(file)||!read(file).pass) {
      assert(Date.now()-start<1200000,'Initial manual-fetch comparison did not finish');
      environment();await new Promise(resolve=>setTimeout(resolve,5000));
    }
  }
  environment();
  const cache=new Map();
  for(const pair of pairs) {
    const file=path.join(results,pair.history+'.json'),historical=read(file);assert(historical.pass);
    pair.baseline ||= historical.packages.baseline.folder;pair.candidate=historical.packages.candidate.folder;
    pair.evidence=audit(file);
    for(const role of ['baseline','candidate']) {
      const folder=pair[role];
      for(const [name,expected] of Object.entries(historical.packages[role].files)) {
        const item=path.join(build,folder,name);if(!cache.has(item))cache.set(item,audit(item));
        assert.equal(cache.get(item).sha256,expected.sha256,folder+'/'+name+' differs from measured history');
      }
      report.packages[folder]={files:Object.fromEntries(['index.html','content.bin','content-files.json','config-files.json',
        'UEWebEngineThreads.wasm','UEWebEngineThreads.js','web-engine-worker.js','web-engine-host.js'].map(name=>{
        const item=path.join(build,folder,name);if(!cache.has(item))cache.set(item,audit(item));return [name,cache.get(item)];
      }))};
    }
  }
  report.comparisons=pairs;save();
  for(const pair of pairs) {
    await run(pair.id,'compare-web-rhi-adaptation.cjs',[
      '--baseline='+pair.baseline,'--candidate='+pair.candidate,'--tag='+prefix+'-'+pair.id,'--headless','--warmup-seconds=20',
      ...(pair.recook?['--allow-'+pair.recook+'-recook','--baseline-cook='+path.join(results,pair.baselineCook+'.json'),
        '--candidate-cook='+path.join(results,pair.candidateCook+'.json')]:[]),...(pair.bundles?['--require-candidate-bundles']:[])
    ],prefix+'-'+pair.id+'-abba');
  }
  const experiments=[
    {id:'instance-hzb',folder:'villa-hzb-probe-v3',modes:'0,2,2,0',extra:['--capture-api']},
    {id:'traditional-hzb',folder:'villa-render-diagnostics',modes:'0,1',extra:[],failure:/HZB must consume real readbacks/},
    {id:'pso-precache',folder:'villa-pso-probe',modes:'0',extra:['--tour'],failure:/unreachable/},
    {id:'rdg-ledger',folder:'villa-render-diagnostics',modes:'0,0',extra:['--resource-ledger','--tour','--readback-test']}
  ];
  for(const item of experiments) await run(item.id,'probe-web-render-optimizations.cjs',[
    '--folder='+item.folder,'--tag='+prefix+'-'+item.id,'--modes='+item.modes,
    '--warmup=20','--seconds=15','--environment-label=game-closed',...item.extra
  ],prefix+'-'+item.id,item.failure);
  for(const id of ['resource-tables','manual-fetch','gpuscene','parallel-recording']) {
    const pair=pairs.find(x=>x.id===id);
    for(const role of ['baseline','candidate']) await run(id+'-'+role+'-profile','capture-web-performance.cjs',[
      '--folder='+pair[role],'--tag='+prefix+'-'+id+'-'+role+'-profile','--headless',
      '--width=1863','--height=1030','--dpr=1.25','--warmup-seconds=20','--seconds=5'
    ],'performance-capture-'+prefix+'-'+id+'-'+role+'-profile');
  }
  fs.writeFileSync(path.join(results,prefix+'-monitor.stop'),'complete\n');
  await new Promise(resolve=>setTimeout(resolve,5500));
  report.environmentFile=audit(path.join(results,prefix+'-environment.jsonl'));
  const samples=fs.readFileSync(report.environmentFile.file,'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x.replace(/^\uFEFF/,'')));
  assert(samples.every(x=>x.blockers.length===0),'Environment contained game/build processes');
  report.environmentSamples=samples.length;report.completed=new Date().toISOString();report.pass=true;
} catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  fs.writeFileSync(path.join(results,prefix+'-monitor.stop'),'complete\n');save();
  console.log(JSON.stringify({pass:report.pass,jobs:report.jobs.length,failure:report.failure,reportFile}));
}})();
