'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const [corpusPath, outputPath, optimizer] = process.argv.slice(2);
assert(corpusPath && outputPath);
const corpus = JSON.parse(fs.readFileSync(corpusPath));
const output = path.resolve(outputPath); fs.mkdirSync(output, {recursive:true});
const tint = path.resolve('.tools/dawn-v20261009.190412/bin/tint.exe');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const normalized = s => s.replaceAll('\r\n','\n').replace(/^\uFEFF/,'');
const originals = new Map(corpus.modules.map(m => [sha(normalized(m.descriptor.code)), m.id]));
const found = new Map();
for (const f of execFileSync('rg',['--files','tests/web-platform/build','-g','output.wgsl'], {encoding:'utf8',maxBuffer:32*1024*1024}).trim().split(/\r?\n/)) {
  const id = originals.get(sha(normalized(fs.readFileSync(f,'utf8'))));
  if (id !== undefined && !found.has(id) && fs.existsSync(path.join(path.dirname(f),'input.spv'))) found.set(id,f);
  if(found.size === corpus.modules.length) break;
}
fs.writeFileSync(path.join(output,'matches.json'),JSON.stringify([...found],null,2));
const report = {corpus:corpusPath, modules:corpus.modules.length, matched:found.size, variants:[]};
const variants = ['minify','ir-roundtrip',...(optimizer ? ['spirv-O','spirv-Os','spirv-clean'] : [])];
for (const variant of variants) {
  const dir = path.join(output,variant); fs.mkdirSync(dir,{recursive:true});
  const clone = structuredClone(corpus), result = {variant,errors:[],modules:[]};
  for (const m of clone.modules) {
    const input = path.join(dir,m.id+'-input.wgsl'), destination=path.join(dir,m.id+'.wgsl');
    fs.writeFileSync(input,m.descriptor.code);
    try {
      if (variant.startsWith('spirv-')) {
        assert(found.has(m.id), 'Original Cook SPIR-V not found');
        const source = path.join(path.dirname(found.get(m.id)),'input.spv'), spv=path.join(dir,m.id+'.spv');
        const flags = variant==='spirv-clean' ? ['--eliminate-dead-code-aggressive','--simplify-instructions','--ccp','--redundancy-elimination','--cfg-cleanup'] : [variant==='spirv-O' ? '-O':'-Os'];
        execFileSync(optimizer,[source,spv,...flags],{windowsHide:true,stdio:'pipe'});
        execFileSync(tint,[spv,'--format','wgsl','--allow-non-uniform-derivatives','true','-o',destination],{windowsHide:true,stdio:'pipe'});
      } else {
        execFileSync(tint,[input,'--format','wgsl','--'+variant,'true','-o',destination],{windowsHide:true,stdio:'pipe'});
      }
      const code=fs.readFileSync(destination,'utf8');
      result.modules.push({id:m.id,before:m.descriptor.code.length,after:code.length,beforeSha:sha(m.descriptor.code),afterSha:sha(code)});
      m.descriptor.code=code;
    } catch(e) {result.errors.push({id:m.id,message:String(e.stderr||e.message).slice(0,2500)});}
  }
  result.complete=result.errors.length===0;
  if(result.complete)fs.writeFileSync(path.join(output,variant+'.json'),JSON.stringify(clone));
  report.variants.push(result);
  console.log(JSON.stringify({variant,complete:result.complete,errors:result.errors.slice(0,2),chars:result.modules.reduce((s,m)=>s+m.after,0)}));
}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
