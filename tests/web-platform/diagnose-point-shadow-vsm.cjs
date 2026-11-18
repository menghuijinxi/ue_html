'use strict';
// Isolation only: remove the VSM tail of three captured point-shadow fragment
// shaders in this exact Nanite-off Cook. This is not a production shader fix.
module.exports = function diagnosePointShadowVSM() {
  const state = globalThis.__pointShadowDiagnostic = {patched:[]};
  const entries = ['main_000024cc_9814fd1b','main_000024cc_13bafd8b','main_00001ff8_c869331a'];
  const create = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(desc) {
    const entry = entries.find(e => desc.code.includes('fn '+e+'('));
    if (entry) {
      const begin = desc.code.search(/^  let \w+ = ShadowDepthPass_PackedNaniteViews\./m);
      if (begin < 0 || !desc.code.includes('@fragment') || !desc.code.includes('atomicMax('))
        throw Error('Unexpected point-shadow diagnostic shader');
      state.patched.push(entry);
      desc = {...desc,code:desc.code.slice(0,begin)+'  return;\n}\n'};
    }
    return create.call(this,desc);
  };
};
