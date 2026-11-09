'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const result=name=>path.join(__dirname,'results',name);
const prepareFile=result('web-project-nanite-full-scene-prepare-results.json');
const beforeFile=result('nanite-full-scene-inventory.json'),afterFile=result('nanite-full-scene-conversion.json');
const prepared=read(prepareFile),before=read(beforeFile),after=read(afterFile);
const report={pass:false,sources:[],originalFiles:[],convertedFiles:[],changes:[],fallbackChanges:[]};
const verifiedFile=result('nanite-full-scene-conversion-verified.json');
const previous=fs.existsSync(verifiedFile)?read(verifiedFile):null;
try{
  assert(prepared.pass&&prepared.originalProjectUnmodified&&prepared.useProjectSettings);
  const root=path.dirname(prepared.project);assert.equal(root,path.join(__dirname,'build/projects/nanite-full-scene'));
  assert(before.pass&&!before.converted&&after.pass&&after.converted);
  assert.equal(after.map,before.map);assert.equal(after.levels,before.levels);assert.equal(after.components,before.components);
  assert(after.components>2000);assert.equal(after.meshes.length,before.meshes.length);
  const assetFile=p=>path.join(root,'Content',p.slice('/Game/'.length).split('.')[0]+'.uasset');
  const allowed=new Set();
  for(const m of after.meshes){
    const b=before.meshes.find(x=>x.path===m.path);assert(b);assert.equal(m.components,b.components);
    if(m.path.startsWith('/Game/')){assert(m.nanite&&m.clusters>0&&m.rootPages>0&&m.pages>=m.rootPages);allowed.add(assetFile(m.path));}
    else assert.deepEqual(m,b);
    if(m.fallbackTriangles!==b.fallbackTriangles){
      // Full source fallback can exceed an asset's previously reduced LOD0.
      assert(m.fallbackTriangles>=b.fallbackTriangles);
      report.fallbackChanges.push({mesh:m.path,before:b.fallbackTriangles,after:m.fallbackTriangles});
    }
  }
  assert.equal(after.materials.length,before.materials.length);
  for(const m of after.materials){
    assert.deepEqual(m,before.materials.find(x=>x.path===m.path),'Authored material properties must remain unchanged');
    if((m.opaque||m.masked)&&m.base.startsWith('/Game/'))allowed.add(assetFile(m.base));
  }
  for(const item of prepared.sourceFiles){assert.equal(audit(item.file).sha256,item.sha256,item.file);report.originalFiles.push(item);}
  for(const item of [...prepared.copiedFiles,prepared.descriptor]){
    assert.equal(fs.statSync(item.file).nlink,1);const current=audit(item.file);report.convertedFiles.push(current);
    if(current.sha256!==item.sha256){assert(allowed.has(item.file),'Unexpected scene edit: '+item.file);report.changes.push({before:item,after:current});}
  }
  const local=after.meshes.filter(m=>m.path.startsWith('/Game/'));
  assert.equal(report.changes.filter(c=>local.some(m=>assetFile(m.path)===c.after.file)).length,local.length);
  const logFile=result('nanite-full-scene-conversion.log'),log=fs.readFileSync(logFile,'utf8');
  assert(log.includes('LogExit: Exiting.')&&!/Fatal error:|Assertion failed:|Ensure condition failed:/.test(log));
  assert.equal((log.match(/WEB_NANITE_SCENE_ASSET:/g)||[]).length,after.meshes.length);
  const host=path.join(__dirname,'../ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  report.creationHost=previous?.creationHost||previous?.sources?.find(s=>s.file===host)||audit(host);
  const recheck=process.argv.find(a=>a.startsWith('--recheck='))?.slice(10);
  if(report.creationHost.sha256!==audit(host).sha256||recheck){
    assert(recheck,'A changed native host requires a fresh read-only inventory of the converted project');
    const currentFile=path.resolve(recheck),current=read(currentFile);
    assert(current.pass&&!current.converted);assert.equal(current.components,after.components);assert.equal(current.map,after.map);
    assert.equal(current.levels,after.levels);assert.equal(current.meshes.length,after.meshes.length);
    for(const m of current.meshes){const c=after.meshes.find(x=>x.path===m.path);assert(c);
      assert.deepEqual({...m,originalNanite:c.originalNanite},c);}
    assert.equal(current.materials.length,after.materials.length);
    for(const m of current.materials)assert.deepEqual(m,after.materials.find(x=>x.path===m.path));
    const recheckLog=currentFile.replace(/\.json$/,'.log'),text=fs.readFileSync(recheckLog,'utf8');
    assert(text.includes('LogExit: Exiting.')&&!/Fatal error:|Assertion failed:|Ensure condition failed:/.test(text));
    report.recheck={inventory:audit(currentFile),log:audit(recheckLog),host:audit(host)};
  }
  report.sources=[__filename,prepareFile,beforeFile,path.join(root,'.web-nanite-project-copy.json'),
    path.join(__dirname,'prepare-nanite-full-scene.cjs'),path.join(__dirname,'../ue-shader-host/Source/UEShaderHost/Private/WebNaniteSceneAssets.cpp'),
    path.join(__dirname,'../ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp')].map(audit);
  if(report.recheck)report.sources.push(...Object.values(report.recheck));
  else report.sources.push(audit(host));
  report.report=audit(afterFile);report.log=audit(logFile);
  report.summary={components:after.components,localMeshes:local.length,uniqueClusters:local.reduce((s,m)=>s+m.clusters,0),
    rootPages:local.reduce((s,m)=>s+m.rootPages,0),pages:local.reduce((s,m)=>s+m.pages,0),
    potentialInstanceClusters:local.reduce((s,m)=>s+m.clusters*m.components,0),
    opaque:after.materials.filter(m=>m.opaque).length,masked:after.materials.filter(m=>m.masked).length,
    pdoConnected:after.materials.filter(m=>m.pdoConnected).length,wpoConnected:after.materials.filter(m=>m.wpoConnected).length};
  report.boundary='Asset conversion and unchanged original project only; rendering and full Nanite compatibility require separate validation.';
  report.pass=true;console.log(report.summary);
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{fs.writeFileSync(verifiedFile,JSON.stringify(report,null,2));}
