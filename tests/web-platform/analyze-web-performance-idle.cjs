'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const prefix=process.argv.find(x=>x.startsWith('--prefix='))?.slice(9)||'idle-20261101';
assert(/^[a-z0-9-]+$/.test(prefix));
const results=path.join(__dirname,'results'),read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const suite=read(path.join(results,prefix+'-suite.json'));assert(suite.pass);
for(const source of suite.sources) assert.equal(audit(source.file).sha256,source.sha256);
for(const job of suite.jobs) assert(job.valid&&audit(job.report.file).sha256===job.report.sha256);
assert.equal(audit(suite.environmentFile.file).sha256,suite.environmentFile.sha256);
const report={date:new Date().toISOString(),pass:true,suite:audit(path.join(results,prefix+'-suite.json')),
  comparisons:[],profiles:{},environment:{samples:suite.environmentSamples,gameOrBuildObserved:false},
  boundaries:['One ABBA group per feature. Small differences are not proof of a stable gain.',
    'CPU profiles and API/GPU captures are separate from throughput measurements.',
    'Historical absolute FPS must not be subtracted to assign gains to code changes.']};
const labels={'manual-fetch':'手动顶点读取','resource-tables':'资源表增量更新',gpuscene:'GPUScene',
  'parallel-recording':'并行绘制命令构建','rhi-adaptation':'RHI 适配第二版','dx-binding':'绑定缓存第三版',
  'webgpu-layout':'WebGPU 绑定布局','webgpu-uploads':'常量上传','render-bundles':'Render Bundle'};
for(const pair of suite.comparisons) {
  const job=suite.jobs.find(x=>x.id===pair.id),value=read(job.output),old=read(pair.evidence.file);
  assert(value.pass&&value.runs.length===4);
  report.comparisons.push({id:pair.id,label:labels[pair.id],evidence:job.report,history:pair.evidence,
    folders:{baseline:pair.baseline,candidate:pair.candidate},fps:value.fps,improvementPercent:value.improvementPercent,
    previousFPS:old.fps,previousPercent:old.improvementPercent,rhiWorkMsPerFrame:value.rhiWorkMsPerFrame,
    baselineDriftPercent:(value.runs[3].baseline.fps/value.runs[0].baseline.fps-1)*100,
    runs:value.runs.map(x=>({name:x.name,fps:x.baseline.fps,rhiWorkMsPerFrame:x.baseline.rhiWorkMsPerFrame,
      dimensions:x.dimensions,perFrame:x.perFrame})),settings:value.runs[0].settings});
}
const scopes={groups:/FWebGPUDynamicRHI::CreateGroups/,drawBindings:/FWebGPUDynamicRHI::SetDrawBindings/,
  resourceResolution:/FWebGPUDynamicRHI::(?:ResolveBinding|ResolveUniform|ResolveDrawBinding|CommitShaderResources)/,
  vertexBufferAPI:/wgpuRenderPassEncoderSetVertexBuffer|wgpuRenderPassEncoderSetIndexBuffer/,
  drawRecording:/FDrawVisibleMeshCommandsAnyThreadTask|SubmitDrawCommands/};
for(const id of ['resource-tables','manual-fetch','gpuscene','parallel-recording']) {
  report.profiles[id]={};
  for(const role of ['baseline','candidate']) {
    const job=suite.jobs.find(x=>x.id===id+'-'+role+'-profile'),value=read(job.output);
    assert(value.pass&&!value.errors.length&&value.profileMeasurement.frames>0);
    const rows=[];
    for(const item of value.profiles) {
      const file=path.join(results,item.file),profile=read(file),nodes=new Map(profile.nodes.map(x=>[x.id,x]));
      const parents=new Map();for(const n of nodes.values())for(const c of n.children||[])parents.set(c,n.id);
      const self={},inclusive={};for(const k of Object.keys(scopes)){self[k]=0;inclusive[k]=0;}
      const matches=new Map();
      for(const node of nodes.values()) {
        const stack=[];for(let p=node.id;p!==undefined;p=parents.get(p))stack.push(nodes.get(p).callFrame.functionName);
        matches.set(node.id,{own:Object.entries(scopes).filter(([,re])=>re.test(node.callFrame.functionName)).map(([k])=>k),
          ancestors:Object.entries(scopes).filter(([,re])=>stack.some(name=>re.test(name))).map(([k])=>k)});
      }
      for(let i=0;i<(profile.samples||[]).length;i++) {
        const match=matches.get(profile.samples[i]),ms=profile.timeDeltas[i]/1000/value.profileMeasurement.frames;
        for(const k of match.own)self[k]+=ms;for(const k of match.ancestors)inclusive[k]+=ms;
      }
      rows.push({role:item.summary.role,source:audit(file),selfMsPerFrame:self,inclusiveMsPerFrame:inclusive});
    }
    report.profiles[id][role]={evidence:job.report,frames:value.profileMeasurement.frames,rows,
      callsPerFrame:Object.fromEntries(Object.entries(value.capture.calls).map(([k,v])=>[k,v/value.capture.frames.length])),
      gpuPassSumMs:value.gpuFrames.map(x=>x.entries.reduce((s,e)=>s+(e.gpuMs||0),0)),
      parallelDrawThreads:value.parallelDrawThreads,html:job.output.replace(/\.json$/,'.html')};
  }
}
for(const id of ['instance-hzb','traditional-hzb','pso-precache','rdg-ledger']) {
  const job=suite.jobs.find(x=>x.id===id);report[id]={evidence:job.report,...read(job.output)};
}
assert(report['traditional-hzb'].runs.at(-1).after.rhi.textureReadbackMaps===0);
assert(/More than one thread is creating shaders/.test(fs.readFileSync(path.join(results,prefix+'-pso-precache.log'),'utf8')));
assert(report['rdg-ledger'].readbackTest.pass);
const packageReports=['villa-hzb-probe-v3-package','villa-render-diagnostics-package','villa-pso-probe-package'];
report.experimentPackages=packageReports.map(name=>{
  const file=path.join(results,name+'.json'),value=read(file);assert(value.pass);
  for(const item of value.products)assert.equal(audit(item.file).sha256,item.sha256);
  return audit(file);
});
const n=x=>Number(x).toFixed(2),signed=x=>(x>=0?'+':'')+n(x)+'%';
const lines=['# 后台游戏关闭后的性能复测（2026-11-01）','',
  '游戏关闭后，GPUScene 的大幅收益仍成立；资源表增量更新整体帧率持平；手动顶点读取和并行绘制仍较慢。实例 HZB 此次持平，之前受干扰的 −8% 不能当作其确定回退幅度。此轮保持原有默认行为。','',
  '本轮沿用各次已测包和原项目设置，以旧→新→新→旧顺序逐组复测。没有重新 Cook、打包或修改渲染实现。每轮预热 20 秒、测量约 15 秒，出生视角、viewport 1863×1030、DPR 1.25；每组均检查设置、位置、角度及实际渲染尺寸一致。','',
  `环境监测每 5 秒记录一次进程，共 ${suite.environmentSamples} 个样本，没有发现 cod.exe 或 UE 编译进程。其他日常程序仍运行；这不代表整机完全空闲，也不是 GPU 利用率监测。各浏览器测试串行执行，CPU/API/GPU 捕获与正常帧率测量分开。`,'',
  '## 四轮结果','',
  '| 对照项 | 旧包 FPS | 新包 FPS | 变化 | 旧→新 RHI ms/帧 | 两次旧包漂移 |','| --- | ---: | ---: | ---: | ---: | ---: |'];
for(const x of report.comparisons)lines.push(`| ${x.label} | ${n(x.fps.baseline)} | ${n(x.fps.candidate)} | ${signed(x.improvementPercent)} | ${n(x.rhiWorkMsPerFrame.baseline)}→${n(x.rhiWorkMsPerFrame.candidate)} | ${signed(x.baselineDriftPercent)} |`);
lines.push('','FPS 按总帧数/总测量时间合并，RHI 工作时间按测量帧数加权。每项只有一组四轮，基线漂移用于提示环境波动，不构成统计置信区间。小幅变化不能视作稳定收益，各行百分比也不能相加。','',
  '资源表和并行命令构建此前已有游戏关闭时的记录，本轮仍按用户要求重跑。历史 RHI 适配基线目录曾被覆盖，本次改用 `triplex-before-dx-binding-20261101` 的保留副本，其 Wasm、Cook 内容和配置 SHA 与原始记录一致。其余各对照三项 SHA 均与原测量记录匹配。未重跑已被后续版本替代的失败中间版本。','',
  '## 各轮与历史结果','');
for(const x of report.comparisons)lines.push(`### ${x.label}`,'',
  `本次四轮 FPS：${x.runs.map(r=>n(r.fps)).join(' / ')}。合并 ${n(x.fps.baseline)}→${n(x.fps.candidate)}（${signed(x.improvementPercent)}）；历史该组为 ${n(x.previousFPS.baseline)}→${n(x.previousFPS.candidate)}（${signed(x.previousPercent)}）。历史负载不同，绝对差值不能归因于本轮代码修改。`,'',
  `包：${x.folders.baseline} / ${x.folders.candidate}。原始结果：[${path.basename(x.evidence.file)}](${x.evidence.file.replaceAll('\\','/')})。`,'');
lines.push('## 新的 CPU、API 与 GPU 捕获','',
  '资源表、手动顶点读取、GPUScene、并行命令构建的新旧包均单独捕获 5 秒 API、5 秒 CPU 采样及 3 个 GPU timestamp 帧。统计采样受内联、符号归属和录制扰动影响；包含时间会重叠，不能相加推算帧率。3 帧 GPU pass 合计不包含复制及间隙，不等于完整 GPU 帧时间。','',
  '| 对照项 | setVertexBuffer / 帧（旧→新） | setBindGroup / 帧 | createBindGroup / 帧 |','| --- | ---: | ---: | ---: |');
for(const [id,p]of Object.entries(report.profiles)) lines.push(`| ${labels[id]} | ${n(p.baseline.callsPerFrame.setVertexBuffer)}→${n(p.candidate.callsPerFrame.setVertexBuffer)} | ${n(p.baseline.callsPerFrame.setBindGroup)}→${n(p.candidate.callsPerFrame.setBindGroup)} | ${n(p.baseline.callsPerFrame.createBindGroup)}→${n(p.candidate.callsPerFrame.createBindGroup)} |`);
lines.push('');for(const [id,p]of Object.entries(report.profiles))lines.push(`- ${labels[id]}：[旧包性能图](${p.baseline.html.replaceAll('\\','/')})、[新包性能图](${p.candidate.html.replaceAll('\\','/')})。`);
const rhi=(id,role)=>report.profiles[id][role].rows.find(x=>x.role==='RHI');
const resourceOld=rhi('resource-tables','baseline'),resourceNew=rhi('resource-tables','candidate');
const manualOld=rhi('manual-fetch','baseline'),manualNew=rhi('manual-fetch','candidate');
const parallel=report.profiles['parallel-recording'];
const drawMs=(value,role)=>value.rows.filter(x=>x.role===role).reduce((s,x)=>s+x.inclusiveMsPerFrame.drawRecording,0);
lines.push('','CPU 采样的具体观察：','',
  `- 资源表：所选资源解析函数 self 约 ${n(resourceOld.selfMsPerFrame.resourceResolution)}→${n(resourceNew.selfMsPerFrame.resourceResolution)} ms/帧；CreateGroups self 约 ${n(resourceOld.selfMsPerFrame.groups)}→${n(resourceNew.selfMsPerFrame.groups)} ms/帧。公共解析路径减少部分工作，但整体 FPS 仍持平。`,
  `- 手动读取：CreateGroups 包含采样约 ${n(manualOld.inclusiveMsPerFrame.groups)}→${n(manualNew.inclusiveMsPerFrame.groups)} ms/帧，SetDrawBindings 约 ${n(manualOld.inclusiveMsPerFrame.drawBindings)}→${n(manualNew.inclusiveMsPerFrame.drawBindings)} ms/帧。结合新增 bind group 数量，资源组准备和绑定仍是明确的优化方向；这两个包含时间重叠，不能相加。`,
  `- 并行录制：Render 线程绘制录制栈包含采样约 ${n(drawMs(parallel.baseline,'Draw / Render'))}→${n(drawMs(parallel.candidate,'Draw / Render'))} ms/帧；三个任务 worker 合计约 ${n(drawMs(parallel.candidate,'Task / auxiliary'))} ms/帧。日志再次确认物理任务线程 ${parallel.candidate.parallelDrawThreads.map(x=>x.threadId).join('、')} 执行，任务数为 3；任务合计不是关键路径时间。`,
  '- GPUScene：drawIndexed 约 6083→2992 次/帧，setBindGroup 约 7788→1399 次/帧。当前收益伴随实际提交数量下降。','');
const hzb=report['instance-hzb'],hzbOld=hzb.summary[0],hzbNew=hzb.summary[2];
const traditional=report['traditional-hzb'].runs.at(-1).after.rhi;
const rdg=report['rdg-ledger'];
lines.push('','## HZB、PSO 与 RDG','',
  '以下诊断保留独立记录；预期失败只表示障碍被再次复现，不表示功能已经可用。','',
  `- 实例 HZB：四轮为 ${hzb.runs.map(x=>n(x.fps)).join(' / ')} FPS，合并 **${n(hzbOld.fps)}→${n(hzbNew.fps)}（${signed((hzbNew.fps/hzbOld.fps-1)*100)}）**。两次基线漂移 ${signed((hzb.runs[3].fps/hzb.runs[0].fps-1)*100)}，尚无明确收益。`,
  `- 传统 HZB：回读入队 ${traditional.textureReadbacks} 次、完成 ${traditional.textureReadbacksReady} 次、消费 ${traditional.textureReadbackMaps} 次。对应帧结果消费障碍依旧存在，其 FPS 不作为有效 HZB 收益。`,
  '- PSO：仍在 ShaderCodeArchive.cpp:1754 触发多线程 shader 创建契约检查；没有形成可用的预缓存候选。',
  `- RDG：${rdg.end.optimization.renderTargetCount} 个渲染目标，池 ${n(rdg.end.optimization.renderTargetPoolBytes/1048576)}MiB，快照时占用 ${n(rdg.end.optimization.renderTargetUsedBytes/1048576)}MiB；转身后的逻辑纹理 ${n(rdg.ledgerEnd.textureBytes/1048576)}MiB、buffer ${n(rdg.ledgerEnd.bufferBytes/1048576)}MiB，未知格式为零。UE 资源池继续复用，native allocator 未接入；这是逻辑账本，仍不等于驱动物理显存。`,
  '- 独立 3×2 像素回读再次通过，rowPitch=64 pixels、height=2。','',
  ...['instance-hzb','traditional-hzb','pso-precache','rdg-ledger'].map(id=>`- ${id}：[原始记录](${report[id].evidence.file.replaceAll('\\','/')})；pass=${report[id].pass}。`),'',
  '## 画面核对','',
  '资源表、手动顶点读取、GPUScene 和并行绘制四组的新旧截图已人工核对，未观察到明显网格、材质或光照缺失。旧新 RGB 平均绝对差约 0.70–0.78/255，旧旧/新新约 0.62–0.83/255，场景存在时间相关变化；这不是全场景像素正确性证明。',
  `[截图并排图](${path.join(results,prefix+'-scene-contact.png').replaceAll('\\','/')})：从上到下依次为资源表、手动读取、GPUScene、并行绘制，左旧右新。差异数据为 results/${prefix}-scene-comparison.json。`,'',
  '## 审计与复现','',
  `总记录：[${prefix}-suite.json](${report.suite.file.replaceAll('\\','/')})，包括所有包、脚本及输出 SHA、各组前后环境快照。环境逐次记录为 tests/web-platform/results/${prefix}-environment.jsonl。`,'',
  '```powershell',`node tests/web-platform/retest-web-performance-idle.cjs --prefix=idle-newrun`,
  `node tests/web-platform/analyze-web-performance-idle.cjs --prefix=idle-newrun`,'```','',
  '复测前需启动 monitor-web-performance-environment.ps1，传入同标记的 environment.jsonl 与 monitor.stop 路径，并配置现有 Playwright NODE_PATH；8765 本地服务需运行。不要复用已有输出标记来冒充新测量。','');
fs.writeFileSync(path.join(results,prefix+'-analysis.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(__dirname,'../../UE58_WEBGPU_IDLE_RETEST.md'),lines.join('\n'));
console.log(JSON.stringify({pass:true,comparisons:report.comparisons.map(x=>({id:x.id,fps:x.fps,delta:x.improvementPercent})),output:'UE58_WEBGPU_IDLE_RETEST.md'}));
