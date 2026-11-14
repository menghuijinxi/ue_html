const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {audit} = require('./content-file-metadata.cjs');
function validateTSRTileInventory(cook) {
  if (cook.mode !== 'WebGPU-SM5') return;
  const types = cook.shaderInventory?.detail?.types;
  const minimums = {FTSRRejectShadingCS: 48, FTSRDetectThinGeometryCS: 24, FTSRWeightRelaxationCS: 8};
  for (const [name, minimum] of Object.entries(minimums))
    assert(types?.some(type => type.name === name && type.permutations >= minimum),
      'Cook lacks the current 16x16/32x32 TSR permutations; rerun the native Renderer build and Cook: ' + name);
}
function validateCook(cook, reuse, report) {
  validateTSRTileInventory(cook);
  const valid = item => fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
  assert(cook.pass && cook.sourceFiles.every(valid) && cook.products.every(valid),
    'Cook inputs or cooked products changed');
  const changed = cook.hostProducts.filter(item => !valid(item));
  if (!changed.length) return;
  const allowed = new Set(['UnrealEditor-WebCookTargetPlatform.dll', 'UnrealEditor-WebCookTargetPlatformSettings.dll',
    'UnrealEditor-TextureFormatWebCloud.dll', 'UnrealEditor-WebGPUShaderFormat.dll']);
  assert(reuse && changed.every(item => allowed.has(path.basename(item.file)) && fs.existsSync(item.file)),
    'Cook host binaries changed; use --reuse-cook only for unchanged audited source and cooked products');
  report.reusedCook = {unchangedAuditedSources: cook.sourceFiles.length,
    unchangedCookedProducts: cook.products.length,
    recompiledHostBinaries: changed.map(item => ({historical: item, current: audit(item.file)})),
    boundary: 'Reuses historical Cook output with identical source/config/shader/resource audits. Host binaries were recompiled; Cook was not rerun.'};
}
module.exports = {validateCook, validateTSRTileInventory};
