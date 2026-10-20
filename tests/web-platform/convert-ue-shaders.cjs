const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const workspace = path.resolve(__dirname, '../..');
const buildName = process.env.P1_PLATFORM === '1' ? 'ue-platform-full' : 'ue-full';
const build = path.join(__dirname, 'build', buildName);
const dawn = path.join(workspace, '.tools/dawn-v20261009.190412/bin');
const host = JSON.parse(fs.readFileSync(path.join(build, 'ue-host-results.json'), 'utf8'));
const verification = JSON.parse(fs.readFileSync(path.join(__dirname, 'results/ue-shader-source-verification.json'), 'utf8'));
const verified = new Map(verification.verified.map(file => [file.source, file]));
const unavailable = new Map(verification.unavailable.map(file => [file.source, file]));
const descriptorTypes = {0: 'Sampler', 2: 'SampledTexture', 3: 'WriteOnlyStorageTexture',
  6: 'UniformBuffer', 7: 'StorageBuffer'};
const includes = [...new Set(host.cases.flatMap(item => item.includeFiles))].sort();
const includeAudit = includes.map(virtual => {
  const source = virtual.replace(/^\/Engine\//, 'Engine/Shaders/');
  return {virtual, verified: verified.has(source), ...verified.get(source),
    ...unavailable.get(source)};
});
const failures = [];
function requireCheck(condition, message) {
  if (!condition) throw Error(message);
}
const cases = host.cases.map(item => {
  const wgsl = path.join(build, `${item.name}.wgsl`);
  const conversion = cp.spawnSync(path.join(dawn, 'tint.exe'),
    [path.join(build, `${item.name}.spv`), '--format', 'wgsl', '-o', wgsl], {encoding: 'utf8'});
  const diagnostics = (conversion.stdout || '') + (conversion.stderr || '');
  fs.writeFileSync(path.join(build, `${item.name}.tint.log`), diagnostics);
  const typedBuffer = item.spirvBindings.some(binding => binding.descriptorType === 4 || binding.descriptorType === 5);
  const rejectionCategory = typedBuffer && /SampledBuffer|OpTypeImage/.test(diagnostics) ? 'typed-buffer' :
    item.name === 'TScreenVSForGS_true_' && /SPV_EXT_shader_viewport_index_layer/.test(diagnostics) ?
      'vertex-render-target-array-index' : null;
  const expectedRejection = conversion.status !== 0 && rejectionCategory !== null;
  const result = {...item, tintExit: conversion.status, expectedRejection, diagnostics,
    rejectionCategory, converted: conversion.status === 0, bindingContractVerified: false};
  if (conversion.status === 0) {
    try {
      const output = cp.execFileSync(path.join(dawn, 'tint_info.exe'), ['--json', wgsl], {encoding: 'utf8'});
      const reflection = JSON.parse(output);
      result.reflection = reflection;
      fs.writeFileSync(path.join(build, `${item.name}.reflection.json`), JSON.stringify(reflection, null, 2));
      const entry = reflection.entry_points[0];
      result.webEntry = entry.name;
      requireCheck(entry.name === item.nativeEntry, `${item.name}: entry point changed`);
      requireCheck(entry.bindings.length === item.spirvBindings.length, `${item.name}: binding count changed`);
      for (const native of item.spirvBindings) {
        const web = entry.bindings.find(binding => binding.group === native.group && binding.binding === native.binding);
        requireCheck(web, `${item.name}: binding missing ${native.group}:${native.binding}`);
        const expected = descriptorTypes[native.descriptorType];
        requireCheck(web.resource_type === expected ||
          (native.descriptorType === 3 && ['ReadWriteStorageTexture', 'WriteOnlyStorageTexture'].includes(web.resource_type)),
          `${item.name}: resource type changed ${native.name} ${web.resource_type}`);
        if (native.descriptorType === 6) {
          requireCheck(web.size <= native.paddedSize, `${item.name}: UE uniform allocation too small`);
          const structure = reflection.structures.find(structure => native.members.every(member =>
            structure.members.some(candidate => candidate.name === member.name &&
              candidate.offset === member.offset && candidate.size === member.size)));
          requireCheck(structure, `${item.name}: uniform member layout differs: ${native.name}`);
        }
      }
      for (const parameter of item.ueParameterMap) {
        if (parameter.type === 0) {
          const globals = item.spirvBindings.find(binding => binding.name === '$Globals');
          const member = globals?.members.find(member => member.name === parameter.name);
          requireCheck(member && parameter.bufferIndex === globals.binding &&
            parameter.baseIndex === member.offset && parameter.size === member.size,
          `${item.name}: loose parameter layout differs: ${parameter.name}`);
        } else {
          const binding = item.spirvBindings.find(binding => binding.name === parameter.name);
          requireCheck(binding && binding.binding === (parameter.type === 1 ? parameter.bufferIndex : parameter.baseIndex),
            `${item.name}: resource allocation differs: ${parameter.name}`);
        }
      }
      result.wgslSha256 = crypto.createHash('sha256').update(fs.readFileSync(wgsl)).digest('hex');
      result.bindingContractVerified = true;
      if (item.fallbackOf) {
        const original = host.cases.find(candidate => candidate.name === item.fallbackOf);
        const parameterSignature = parameters => JSON.stringify([...parameters].sort((a, b) => a.name.localeCompare(b.name)));
        requireCheck(original && parameterSignature(item.ueParameterMap) === parameterSignature(original.ueParameterMap),
          `${item.name}: fallback changed UE parameter map`);
        requireCheck(item.spirvBindings.every(binding => {
          const previous = original.spirvBindings.find(previous => previous.name === binding.name);
          return previous && previous.group === binding.group && previous.binding === binding.binding &&
            ((previous.descriptorType === 5 && binding.descriptorType === 7) ||
              previous.descriptorType === binding.descriptorType);
        }), `${item.name}: fallback resource contract changed`);
        result.fallbackContractVerified = true;
      }
    } catch (error) {
      result.contractFailure = error.message;
    }
  }
  result.pass = item.preprocessed && item.nativeCompiled && item.spirvExported &&
    (expectedRejection || (result.converted && result.bindingContractVerified && !result.contractFailure));
  if (!result.pass) failures.push(item.name);
  console.log(`${item.name}: native=${item.nativeCompiled} tint=${conversion.status} contract=${result.bindingContractVerified} expectedRejection=${expectedRejection}`);
  return result;
});
const report = {kind: 'ue-global-shader-conversion', testDate: '2026-10-14',
  hostEngine: host.hostEngine, nativeFormat: host.format, targetRevision: verification.revision,
  shaderPlatform: host.shaderPlatform, shaderPlatformEnum: host.shaderPlatformEnum,
  compilerExecution: 'In-process UE Editor commandlet using registered shader types and IShaderFormat',
  shaderCompileWorkerIPCVerified: false,
  fullUEPreprocessing: true, fullUEParameterMap: true, completeWebShaderFormat: false,
  completeUEScene: false, sourceBoundary: 'Launcher 5.8.0 host; checked-in shader/include inputs audited against 5.8.3 fork; generated environment comes from host.',
  includeAudit, allIncludesMatchTarget: includeAudit.every(file => file.verified),
  shaderCount: cases.length, convertedCount: cases.filter(item => item.converted).length,
  originalCount: cases.filter(item => !item.fallbackOf).length,
  originalConvertedCount: cases.filter(item => !item.fallbackOf && item.converted).length,
  fallbackConvertedCount: cases.filter(item => item.fallbackOf && item.fallbackContractVerified).length,
  expectedRejectionCount: cases.filter(item => item.expectedRejection).length,
  bindingContractCount: cases.filter(item => item.bindingContractVerified).length,
  failures, cases, pass: host.pass && !failures.length && includeAudit.every(file => file.verified)};
const compilerFiles = ['Engine/Binaries/Win64/UnrealEditor-VulkanShaderFormat.dll',
  'Engine/Binaries/Win64/UnrealEditor-ShaderCompilerCommon.dll',
  'Engine/Binaries/ThirdParty/ShaderConductor/Win64/ShaderConductor.dll'];
report.compilerBinaries = compilerFiles.map(source => ({source,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(verification.installedEngine, source))).digest('hex')}));
report.expectedMatrixPresent = report.originalCount === 56 && host.cases.filter(item => item.fallbackOf).length === 15;
report.pass &&= report.expectedMatrixPresent;
fs.writeFileSync(path.join(__dirname, `results/${buildName}-shader-build-results.json`), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(build, 'web-manifest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, shaderCount: report.shaderCount,
  convertedCount: report.convertedCount, expectedRejectionCount: report.expectedRejectionCount,
  bindingContractCount: report.bindingContractCount, includeCount: includeAudit.length,
  allIncludesMatchTarget: report.allIncludesMatchTarget, failures}, null, 2));
process.exitCode = report.pass ? 0 : 1;
