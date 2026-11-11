'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
const root=path.resolve(__dirname,'../..'),out=path.join(__dirname,'build/nanite-release-20261111');
const evidenceNames=['nanite-disocclusion-20261111','nanite-core-lifecycle-20261111','nanite-disocclusion-native-20261111'];
const proofs=evidenceNames.map(n=>{const file=path.join(__dirname,'evidence',n+'.json'),r=read(file);assert(r.pass);r.artifacts.forEach(a=>verify(a.archive));return{file,report:r};});
for(const p of proofs.slice(1)){verify(p.report.runtimeEvidence);assert.equal(p.report.runtimeEvidence.sha256,audit(proofs[0].file).sha256);}
const sources=[],packages={};
for(const [scene,folder] of [['default','nanite-core-default'],['villa','nanite-core-scene']]){
 const meta=proofs[0].report.packages[folder].package;verify(meta);const pkg=read(meta.file);assert(pkg.pass);pkg.products.forEach(verify);pkg.sources.forEach(verify);
 packages[scene]={meta,pkg};
 for(const browser of ['msedge','chrome']){
  const f=path.join(__dirname,`results/web-browser-lifecycle-${browser}-nanite-final-${scene}-results.json`),r=read(f);
  assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,meta.sha256);assert.equal(r.runs,2);assert.equal(r.samples.length,4);
  assert.deepEqual(r.errors,[]);assert.deepEqual(r.crashes,[]);assert.deepEqual(r.settingsOverrides,[]);assert.equal(r.affinityMask,0);
  assert.deepEqual(r.extraArgs,[]);if(r.browserExecutable)verify(r.browserExecutable);
  sources.push(f,r.source.file,r.screenshot);
 }
}
assert(!fs.existsSync(out),'Release output already exists; do not overwrite a delivered build');fs.mkdirSync(out,{recursive:true});
for(const [scene,{meta,pkg}] of Object.entries(packages)){
 const dir=path.join(out,scene);fs.mkdirSync(dir);
 for(const p of pkg.products){const dest=path.join(dir,path.basename(p.file));fs.copyFileSync(p.file,dest);assert.equal(audit(dest).sha256,p.sha256);}
 fs.copyFileSync(meta.file,path.join(dir,'source-package.json'));
}
fs.copyFileSync(path.join(__dirname,'serve.cjs'),path.join(out,'serve.cjs'));
// Windows PowerShell 5.1 needs a BOM for Chinese messages; keep batch contents ASCII.
fs.writeFileSync(path.join(out,'start.ps1'),'\uFEFF'+fs.readFileSync(path.join(__dirname,'nanite-release-launcher.ps1'),'utf8').replace(/^\uFEFF/,''));
for(const [scene,title] of [['default','默认关卡'],['villa','Villa']])fs.writeFileSync(path.join(out,`打开${title}.cmd`),`@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Scene ${scene}\r\nif errorlevel 1 pause\r\n`);
fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nanite 测试版</title><style>body{max-width:680px;margin:12vh auto;padding:24px;background:#141718;color:#f1f5f3;font:17px/1.7 system-ui}a{display:block;padding:20px;margin:18px 0;background:#253a32;color:#a5efcd;border-radius:8px;text-decoration:none}small{color:#b6c6c0}</style><h1>Nanite 测试版</h1><p>选择测试场景。</p><a href="default/index.html">打开默认关卡</a><a href="villa/index.html">打开 Villa</a><small>点击画面后使用 WASD 移动，鼠标转向，Esc 释放鼠标。也可按住右键拖动视角。</small></html>\n`);
const fps=proofs[0].report.profiles[1].samples.map(s=>s.fps.toFixed(2));
fs.writeFileSync(path.join(out,'测试说明.md'),`Nanite 普通场景测试版，2026-11-11。包含 Template_Default 和 Villa 的完整运行时与资源。\n\n双击“打开默认关卡.cmd”或“打开Villa.cmd”。启动器使用本机 Node.js 提供 localhost 服务，并打开独立 Edge 配置；也可执行“start.ps1 -Scene default”或“-Scene villa”。\n\n点击画面后用 WASD 移动，鼠标转向，Esc 释放鼠标；鼠标锁定不可用时按住右键拖动。默认关卡用 E/Q 升降，Villa 沿用原游戏的空格跳跃。\n\n已验证两种原子配置的场景正确性、遮挡解除当帧恢复、有限页池流送、真实 GPU 设备恢复、原生画面对照，以及普通 Edge/Chrome 启动和重载。本机 1280×720、DPR 1 的 Villa 两个固定视角为 ${fps.join('/')} FPS。原灯光、天空和实际材质保留。此交付范围为上述普通 Nanite 场景，历史实验性扩展的支持状态见仓库兼容记录。GPU 故障恢复会重建运行时和关卡并恢复相机；其他动态游戏状态需要应用显式检查点。\n\nvalidation 目录保存对应验收报告，manifest.json 保存源码版本及全部文件哈希。\n`);
const validation=path.join(out,'validation');fs.mkdirSync(validation);for(const f of [...proofs.map(p=>p.file),...new Set(sources)])fs.copyFileSync(f,path.join(validation,path.basename(f)));
const browserTool=path.join(__dirname,'results/nanite-core/chrome-testing.json');
const tool=read(browserTool);verify(tool.executable);verify(tool.versions);fs.copyFileSync(browserTool,path.join(validation,'chrome-testing.json'));
function products(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(d=>{const f=path.join(dir,d.name);return d.isDirectory()?products(f):[{path:path.relative(out,f).replaceAll('\\','/'),bytes:fs.statSync(f).size,sha256:audit(f).sha256}];});}
const revision=dir=>cp.execFileSync('git',['rev-parse','HEAD'],{cwd:dir,encoding:'utf8'}).trim();
const manifest={pass:true,date:new Date().toISOString(),mainRevision:revision(root),engineRevision:revision(path.join(root,'reference-engine')),
 sources:[__filename,path.join(__dirname,'nanite-release-launcher.ps1'),path.join(__dirname,'serve.cjs')].map(audit),
 packages:Object.fromEntries(Object.entries(packages).map(([n,p])=>[n,p.meta])),evidence:proofs.map(p=>audit(p.file)),products:products(out)};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),output:out,manifest:audit(path.join(out,'manifest.json')),products:manifest.products,
 boundary:'Byte-identical versioned copies of the accepted runtime and Cook products. Source packages, same-runtime visual/device evidence and normal Edge/Chrome reloads are verified before creating the release.'};
fs.writeFileSync(path.join(__dirname,'results/nanite-release-20261111.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,output:out,files:manifest.products.length});
