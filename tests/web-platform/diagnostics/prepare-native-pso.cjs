'use strict';
const fs=require('node:fs'), assert=require('node:assert/strict');
const [input, output]=process.argv.slice(2), corpus=JSON.parse(fs.readFileSync(input));
const formats={'float32x3':'R32G32B32_FLOAT','snorm8x4':'R8G8B8A8_SNORM','unorm8x4-bgra':'B8G8R8A8_UNORM',
  'float16x4':'R16G16B16A16_FLOAT','float16x2':'R16G16_FLOAT','uint32':'R32_UINT','float32x4':'R32G32B32A32_FLOAT',
  'float32x2':'R32G32_FLOAT','rgba16unorm':'R16G16B16A16_UNORM','rgba16float':'R16G16B16A16_FLOAT',
  'rgb10a2unorm':'R10G10B10A2_UNORM','bgra8unorm':'B8G8R8A8_UNORM','bgra8unorm-srgb':'B8G8R8A8_UNORM_SRGB'};
const format=f=>{assert(formats[f],f);return 'DXGI_FORMAT_'+formats[f];};
const compare={'greater-equal':'GREATER_EQUAL','equal':'EQUAL','always':'ALWAYS'};
const factor={'zero':'ZERO','one':'ONE','src-alpha':'SRC_ALPHA','one-minus-src-alpha':'INV_SRC_ALPHA'};
const enumValue=(map,v,prefix)=>{assert(map[v],v);return prefix+map[v];};
const lines=['// Generated from captured WebGPU render descriptors. Used only by the native DXIL-ready diagnostic.',
  'static std::vector<NativePSO> Descriptors() { std::vector<NativePSO> result;'];
for (const request of corpus.requests) {
  const d=corpus.descriptors.find(d=>d.id===request.descriptorId).descriptor;
  assert(d.primitive.topology==='triangle-list'&&!d.primitive.unclippedDepth);
  lines.push('{ NativePSO n; auto& d=n.desc;');
  for(const [slot,b]of d.vertex.buffers.entries())for(const a of b.attributes)
    lines.push(`n.inputs.push_back({"TEXCOORD",${a.shaderLocation},${format(a.format)},${slot},${a.offset},D3D12_INPUT_CLASSIFICATION_PER_${b.stepMode==='instance'?'INSTANCE':'VERTEX'}_DATA,${b.stepMode==='instance'?1:0}});`);
  lines.push(`d.RasterizerState.CullMode=D3D12_CULL_MODE_${d.primitive.cullMode.toUpperCase()};`,
    `d.RasterizerState.FrontCounterClockwise=${d.primitive.frontFace==='ccw'?'TRUE':'FALSE'};`,
    `d.SampleMask=${d.multisample.mask}u;d.SampleDesc.Count=${d.multisample.count};`,
    `d.BlendState.AlphaToCoverageEnable=${d.multisample.alphaToCoverageEnabled?'TRUE':'FALSE'};`,
    'd.BlendState.IndependentBlendEnable=TRUE;',`d.NumRenderTargets=${d.fragment.targets.length};`);
  for(const [i,t]of d.fragment.targets.entries()){
    lines.push(`d.RTVFormats[${i}]=${format(t.format)};d.BlendState.RenderTarget[${i}].RenderTargetWriteMask=${t.writeMask};`);
    if(t.blend){lines.push(`d.BlendState.RenderTarget[${i}].BlendEnable=TRUE;`);
      for(const [kind,suffix]of [['color',''],['alpha','Alpha']]){
        const b=t.blend[kind];assert(b.operation==='add');
        lines.push(`d.BlendState.RenderTarget[${i}].SrcBlend${suffix}=${enumValue(factor,b.srcFactor,'D3D12_BLEND_')};`,
          `d.BlendState.RenderTarget[${i}].DestBlend${suffix}=${enumValue(factor,b.dstFactor,'D3D12_BLEND_')};`);
      }
    }
  }
  if(d.depthStencil){const s=d.depthStencil;assert(s.format==='depth24plus-stencil8');
    lines.push('d.DSVFormat=DXGI_FORMAT_D24_UNORM_S8_UINT;d.DepthStencilState.DepthEnable=TRUE;',
      `d.DepthStencilState.DepthWriteMask=D3D12_DEPTH_WRITE_MASK_${s.depthWriteEnabled?'ALL':'ZERO'};`,
      `d.DepthStencilState.DepthFunc=${enumValue(compare,s.depthCompare,'D3D12_COMPARISON_FUNC_')};`,
      `d.DepthStencilState.StencilReadMask=${s.stencilReadMask&255};d.DepthStencilState.StencilWriteMask=${s.stencilWriteMask&255};`,
      `d.RasterizerState.DepthBias=${s.depthBias};d.RasterizerState.DepthBiasClamp=${s.depthBiasClamp};d.RasterizerState.SlopeScaledDepthBias=${s.depthBiasSlopeScale};`);
    for(const [key,face]of [['stencilFront','FrontFace'],['stencilBack','BackFace']]){
      const f=s[key];if(Object.keys(f).length){assert(f.failOp==='keep'&&f.depthFailOp==='keep'&&f.passOp==='replace');
        lines.push('d.DepthStencilState.StencilEnable=TRUE;',
          `d.DepthStencilState.${face}.StencilPassOp=D3D12_STENCIL_OP_REPLACE;`,
          `d.DepthStencilState.${face}.StencilFunc=${enumValue(compare,f.compare,'D3D12_COMPARISON_FUNC_')};`);
      }
    }
  }
  lines.push('result.push_back(std::move(n)); }');
}
lines.push('return result; }');fs.writeFileSync(output,lines.join('\n')+'\n');
console.log(JSON.stringify({pipelines:corpus.requests.length,output}));
