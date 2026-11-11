'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const [output, ...directories] = process.argv.slice(2);
assert(output && directories.length === 2);
const base = path.resolve(__dirname, '..'), read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const evidence = read(path.join(base, 'evidence/vsm-remaining-costs-20261111.json'));
const corpusFile = path.join(base, 'build/villa-shadow-on-20261111-sparse/pipeline-prewarm.json');
const corpus = read(corpusFile), variants = [];
const report = {date: new Date().toISOString(), diagnosticOnly: true, pass: false,
  sources: [__filename, corpusFile].map(audit), variants,
  boundary: 'Only two projection modules are substituted in browser memory. This is not a Cook or a release prewarm corpus.'};
const normalize = code => code.replaceAll('\r\n', '\n').trim();
const memberLayout = ({paddedSize, members, ...layout}) =>
  ({...layout, members: (members || []).map(memberLayout)});
for (const directory of directories) {
  const probeFile = path.join(path.dirname(directory), 'probe-results.json');
  const probe = read(probeFile.replaceAll('\\', '/'));
  assert(probe.pass && probe.adaptiveProbe);
  report.sources.push(audit(probeFile));
  const shaders = fs.readdirSync(directory, {withFileTypes: true}).filter(e => e.isDirectory());
  assert.equal(shaders.length, 1);
  const input = path.join(directory, shaders[0].name, 'input.json');
  const wgsl = path.join(directory, shaders[0].name, 'output.wgsl');
  const candidate = read(input), permutation = Number(candidate.shader.split('/')[2].split(':')[0]);
  assert([17, 18].includes(permutation));
  const original = Object.entries(evidence.shaderNames).find(([, v]) =>
    v.shader.startsWith('Global/FVirtualShadowMapProjectionCS/' + permutation + ':'));
  assert(original);
  const [entry, record] = original, metadata = read(record.metadata.file).metadata;
  assert.equal(metadata.packedGlobalsSize, candidate.metadata.packedGlobalsSize);
  const bindings = metadata => metadata.spirvBindings.map(b =>
    ({name: b.name, group: b.group, binding: b.binding, type: b.descriptorType,
      size: b.size, paddedSize: b.paddedSize, readOnlyStorage: b.readOnlyStorage,
      storageElementStride: b.storageElementStride})).sort((a, b) => a.binding - b.binding);
  assert.deepEqual(bindings(metadata), bindings(candidate.metadata), 'Bindings and uniform byte ranges must match');
  for (const binding of metadata.spirvBindings) {
    const next = candidate.metadata.spirvBindings.find(b => b.name === binding.name);
    for (const member of binding.members || []) {
      if (member.name.startsWith('tint_pad')) continue;
      const retained = next.members?.find(m => m.name === member.name);
      // Reflection padding shrinks when an existing, previously unused member becomes live.
      if (retained) assert.deepEqual(memberLayout(retained), memberLayout(member),
        'Retained uniform members must keep their byte offsets, sizes and strides');
    }
  }
  assert(candidate.metadata.spirvBindings.some(b => b.members?.some(m =>
    m.name === 'VirtualShadowMap_SMRTAdaptiveRayCount' && m.offset === 164)));
  let code = normalize(fs.readFileSync(wgsl, 'utf8'));
  assert.match(code, /subgroupAll\(/); assert.match(code, /enable subgroups/);
  code = code.replaceAll(candidate.metadata.webEntry, entry);
  const originals = corpus.modules.map(m => m.descriptor.code).filter(c => c.includes('fn ' + entry + '('));
  assert(originals.length);
  const originalWGSL = path.join(path.dirname(record.metadata.file), 'output.wgsl');
  originals.push(fs.readFileSync(originalWGSL, 'utf8'));
  const replacements = originals.map(originalCode => {
    let variantCode = code;
    const textures = [...originalCode.matchAll(/var (\w+) : texture_storage_(\w+)<(\w+), (\w+)>/g)];
    for (const match of textures) {
      const re = new RegExp('var ' + match[1] + ' : texture_storage_' + match[2] + '<\\w+, \\w+>');
      assert(re.test(variantCode)); variantCode = variantCode.replace(re, match[0]);
    }
    return {original: normalize(originalCode), adaptive: variantCode};
  });
  variants.push({entry, permutation, replacements, sources: [input, wgsl, record.metadata.file, originalWGSL].map(audit)});
}
assert.deepEqual(variants.map(v => v.permutation).sort(), [17, 18]);
report.pass = true;
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, modules: variants.length}));
