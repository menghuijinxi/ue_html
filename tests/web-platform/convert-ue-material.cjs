const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const buildName = process.env.P1_PLATFORM === '1' ? 'ue-platform-material' : 'ue-material';
const build = path.join(__dirname, 'build', buildName);
const tools = path.join(root, '.tools/dawn-v20261009.190412/bin');
const host = JSON.parse(fs.readFileSync(path.join(build, 'ue-material-results.json'), 'utf8'));
const verification = JSON.parse(fs.readFileSync(path.join(__dirname, 'results/material-source-verification.json'), 'utf8'));
const verified = new Map(verification.files.map(file => [file.source, file]));
const audit = [...new Set(host.cases.flatMap(item => item.includeFiles))].sort().map(virtual => {
  const source = virtual.replace(/^\/Engine\//, 'Engine/Shaders/');
  return {virtual, verified: verified.has(source), ...verified.get(source)};
});
const types = {0: 'Sampler', 2: 'SampledTexture', 6: 'UniformBuffer'};
const assert = (condition, message) => { if (!condition) throw Error(message); };
function resourceTokens(item) {
  const tokens = [];
  for (const category of ['textures', 'samplers', 'srvs', 'uavs']) {
    const stream = item.resourceTable[category];
    for (const parameter of item.ueParameterMap.filter(parameter => parameter.type === 1)) {
      const index = parameter.bufferIndex;
      if (!(item.resourceTable.bits & (1 << index))) continue;
      let cursor = stream[index];
      if (!cursor) continue;
      assert(cursor < stream.length, 'Invalid resource table stream offset');
      while (cursor < stream.length && (stream[cursor] >>> 24) === index) {
        const token = stream[cursor++];
        const resourceIndex = (token >>> 8) & 65535, binding = token & 255;
        const entry = item.uniformResourceEntries.find(entry =>
          entry.uniformBuffer === parameter.name && entry.resourceIndex === resourceIndex);
        const reflected = item.spirvBindings.find(native => native.binding === binding &&
          native.name === entry?.name);
        assert(entry && reflected, `${item.name}: resource table token does not match SPIR-V`);
        assert(reflected.descriptorType === ({textures: 2, samplers: 0, srvs: 7, uavs: 7})[category],
          `${item.name}: resource table category changed`);
        tokens.push({category, uniformBuffer: parameter.name, resourceIndex,
          name: entry.name, group: reflected.group, binding});
      }
    }
  }
  assert(item.spirvBindings.filter(binding => binding.descriptorType !== 6).length === tokens.length,
    `${item.name}: resource table did not cover all texture/sampler bindings`);
  return tokens;
}
const cases = host.cases.map(item => {
  const result = {...item, pass: false};
  try {
    const wgsl = path.join(build, `${item.name}.wgsl`);
    const conversion = cp.spawnSync(path.join(tools, 'tint.exe'),
      [path.join(build, `${item.name}.spv`), '--format', 'wgsl', '-o', wgsl], {encoding: 'utf8'});
    result.diagnostics = (conversion.stdout || '') + (conversion.stderr || '');
    fs.writeFileSync(path.join(build, `${item.name}.tint.log`), result.diagnostics);
    assert(conversion.status === 0, `${item.name}: Tint conversion failed`);
    result.reflection = JSON.parse(cp.execFileSync(path.join(tools, 'tint_info.exe'), ['--json', wgsl], {encoding: 'utf8'}));
    fs.writeFileSync(path.join(build, `${item.name}.reflection.json`), JSON.stringify(result.reflection, null, 2));
    const entry = result.reflection.entry_points[0];
    result.webEntry = entry.name;
    assert(entry.name === item.nativeEntry, 'Entry point changed');
    assert(entry.bindings.length === item.spirvBindings.length, 'Descriptor count changed');
    for (const native of item.spirvBindings) {
      const web = entry.bindings.find(binding => binding.group === native.group && binding.binding === native.binding);
      assert(web?.resource_type === types[native.descriptorType], `${native.name}: descriptor changed`);
      if (native.descriptorType === 6) {
        assert(web.size <= native.paddedSize, `${native.name}: allocation too small`);
        // Tint may absorb inactive gaps into @size on the preceding matrix.
        const structure = result.reflection.structures.find(structure => native.members.every(member =>
          structure.members.some(webMember => webMember.name === member.name &&
            webMember.offset === member.offset && webMember.size >= member.size && webMember.size <= member.paddedSize)));
        assert(structure, `${native.name}: active uniform offsets or storage sizes changed`);
        assert(native.members.every(member => !member.members.length), 'Nested layout requires a separate audit');
      }
    }
    for (const parameter of item.ueParameterMap) {
      assert(parameter.type === 1, 'Unexpected non-UB parameter');
      const binding = item.spirvBindings.find(binding => binding.name === parameter.name);
      assert(binding?.binding === parameter.bufferIndex, `UE ParameterMap mismatch: ${parameter.name}`);
    }
    result.resourceTokens = resourceTokens(item);
    const materialBinding = item.spirvBindings.find(binding => binding.name === 'Material');
    if (materialBinding) assert(materialBinding.size <= item.materialConstantBytes, 'Material constants too small');
    result.wgslSha256 = crypto.createHash('sha256').update(fs.readFileSync(wgsl)).digest('hex');
    result.bindingContractVerified = true;
    result.pass = item.nativeCompiled && item.preprocessed && item.spirvExported;
  } catch (error) { result.failure = error.message; }
  console.log(`${item.name}: pass=${result.pass}${result.failure ? ` ${result.failure}` : ''}`);
  return result;
});
const uniformArtifacts = ['UnlitColor', 'UnlitTexture'].flatMap(material =>
  ['uniform', 'override.uniform'].map(suffix => {
    const filename = `${material}.${suffix}.bin`, bytes = fs.readFileSync(path.join(build, filename));
    return {material, filename, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
  }));
const layoutFile = 'uniform-layouts.json';
const layouts = JSON.parse(fs.readFileSync(path.join(build, layoutFile), 'utf8'));
assert(layouts.source === 'UE runtime FRHIUniformBufferLayout', 'Runtime layout source missing');
for (const item of cases) for (const parameter of item.ueParameterMap.filter(p => p.type === 1)) {
  const layout = layouts[`${item.material}:${parameter.name}`];
  assert(layout && layout.hash === item.resourceTable.layoutHashes[parameter.bufferIndex],
    `${item.name}: runtime uniform layout/hash mismatch`);
}
const uniformLayoutArtifact = {filename: layoutFile,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(build, layoutFile))).digest('hex')};
const report = {kind: 'ue-material-shader-conversion', testDate: '2026-10-14',
  hostEngine: host.hostEngine, nativeFormat: host.format, targetRevision: verification.revision,
  shaderPlatform: host.shaderPlatform, shaderPlatformEnum: host.shaderPlatformEnum,
  sourceBoundary: '5.8.3 target shader snapshot; material translator, generated metadata and compiler from installed 5.8.0 host.',
  materialGraphTranslated: host.materialTranslated, uniformEvaluation: 'UE FUniformExpressionSet::FillUniformBuffer',
  uniformArtifacts, uniformLayoutArtifact, vertexFactory: 'FLocalVertexFactory', cases, includeAudit: audit,
  allIncludesMatchTarget: audit.every(file => file.verified),
  shaderCount: cases.length, bindingContractCount: cases.filter(item => item.bindingContractVerified).length,
  completeWebShaderFormat: false, completeUEScene: false, shaderCompileWorkerIPCVerified: false,
  pass: host.pass && cases.length === 8 && cases.every(item => item.pass) && audit.every(file => file.verified)};
fs.writeFileSync(path.join(build, 'web-manifest.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(__dirname, `results/${buildName}-build-results.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, shaderCount: report.shaderCount,
  bindingContractCount: report.bindingContractCount, includeCount: audit.length,
  failures: cases.filter(item => !item.pass).map(item => ({name: item.name, failure: item.failure}))}, null, 2));
process.exitCode = report.pass ? 0 : 1;
