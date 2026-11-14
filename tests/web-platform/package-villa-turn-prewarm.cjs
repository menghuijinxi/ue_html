'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {readPage, writePage, replaceFile, coreFiles} = require('./web-pipeline-prewarm-package.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const followup = process.argv.includes('--followup'), tag = followup ? 'prewarm2' : 'prewarm';
const base = __dirname, source = path.join(base, 'build/' +
  (followup ? 'villa-tsr-turn-prewarm-20261113' : 'villa-tsr-tiles-20261112'));
const output = assertProjectOutputTree(path.join(base, 'build/villa-tsr-turn-' + tag + '-20261113'));
assert(!fs.existsSync(output), 'Preserve existing diagnostic packages');
const parse = file => JSON.parse(fs.readFileSync(file));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const labels = followup ? [
  'main_00000d80_35b2d539 / main_000159dc_52178f7c',
  'main_00000358_683e3579 / main_00000ee0_ddf80c9f',
] : [
  'main_00001dc0_c525be22 / main_00003aa4_79c6efa3',
  'main_00001f00_a30a26d4 / main_000045b0_769410c6',
  'main_00001bd8_e02fd6df / main_000009f4_2d0d1a47',
  'main_000007c0_d889bb5b / main_000004e8_31236922',
  'main_0000548c_25787371 / main_000110a4_f094ac0f',
  'main_00001d84_18961c06 / main_00001ac0_643db501',
  'main_000055bc_931ef210 / main_00005e8c_312b1082',
  'main_00001ec4_56192608 / main_00001a7c_b30566da',
];
const pack = parse(path.join(source, 'pipeline-prewarm.json'));
const label = descriptor => [descriptor.vertex?.entryPoint, descriptor.fragment?.entryPoint].filter(Boolean).join(' / ');
const donors = [{file: path.join(base, 'build/villa-git-pages-20261113/pipeline-prewarm.json'),
  labels: followup ? labels.slice(0, 1) : labels}];
if (followup) donors.push({
  file: path.join(base, 'results/villa-startup-20261109-prewarm-input-capture/0-corpus.json'),
  labels: labels.slice(1),
});
function semanticKey(corpus, descriptor) {
  const resources = new Map([...corpus.modules, ...corpus.layouts].map(item => [item.id, item]));
  function expand(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(expand);
    if (value.$gpu) {
      const item = resources.get(value.id); assert(item && item.$gpu === value.$gpu);
      return {$gpu: item.$gpu, descriptor: expand(item.descriptor)};
    }
    return Object.fromEntries(Object.keys(value).sort().filter(key => key !== 'label')
      .map(key => [key, expand(value[key])]));
  }
  return hash(JSON.stringify(expand(descriptor)));
}
const existing = new Set(pack.descriptors.map(item => semanticKey(pack, item.descriptor)));
const sourceResources = new Map(), selected = [];
for (const [index, donor] of donors.entries()) {
  const recorded = parse(donor.file);
  assert.equal(recorded.devices.length, 1);
  for (const [name, value] of Object.entries(recorded.devices[0].descriptor.requiredLimits))
    assert.equal(pack.devices[0].descriptor.requiredLimits[name], value, 'Device limit differs: ' + name);
  assert(recorded.devices[0].descriptor.requiredFeatures.every(feature =>
    pack.devices[0].descriptor.requiredFeatures.includes(feature)), 'Donor requires unavailable features');
  for (const resource of [...recorded.modules, ...recorded.layouts])
    sourceResources.set(index + ':' + resource.id, resource);
  for (const name of donor.labels) {
    // Labels can describe both front/back or depth-state variants. Compare full
    // descriptors with resolved resources before selecting the missing variant.
    const matches = recorded.descriptors.filter(item => item.kind === 'render' &&
      label(item.descriptor) === name && !existing.has(semanticKey(recorded, item.descriptor)));
    assert.equal(matches.length, 1, 'Require one recorded missing descriptor: ' + name);
    selected.push({record: matches[0], sourceIndex: index});
  }
}
const selectedModules = new Set(selected.flatMap(({record, sourceIndex}) =>
  [record.descriptor.vertex.module.id, record.descriptor.fragment.module.id].map(id => sourceIndex + ':' + id)));
// Verify shader bytes against the target Cook, not just labels from another runtime.
const manifest = parse(path.join(source, 'content-files.json'));
const wanted = new Map();
for (const id of selectedModules) {
  const digest = hash(sourceResources.get(id).descriptor.code);
  if (!wanted.has(digest)) wanted.set(digest, []);
  wanted.get(digest).push(id);
}
const shaderProof = [];
const fd = fs.openSync(path.join(source, manifest.pack.url), 'r');
const read = (offset, size) => {
  const bytes = Buffer.alloc(size); assert.equal(fs.readSync(fd, bytes, 0, size, offset), size); return bytes;
};
try {
  for (const file of manifest.files.filter(item => item.path.endsWith('.ushaderbytecode'))) {
    assert.equal(read(file.offset, 4).readUInt32LE(), 3);
    let cursor = 4; const arrays = {};
    for (const [name, stride] of [['mapHashes', 8], ['shaderHashes', 8], ['maps', 16], ['shaders', 17], ['preload', 16], ['indices', 4]]) {
      const count = read(file.offset + cursor, 4).readUInt32LE();
      assert(count > 0 && cursor + 4 + count * stride <= file.size);
      cursor += 4; arrays[name] = {count, offset: cursor}; cursor += count * stride;
    }
    const rows = read(file.offset + arrays.shaders.offset, arrays.shaders.count * 17);
    for (let index = 0; index < arrays.shaders.count; ++index) {
      const row = index * 17, start = Number(rows.readBigUInt64LE(row)), size = rows.readUInt32LE(row + 8);
      assert.equal(size, rows.readUInt32LE(row + 12), 'Require uncompressed Web shaders');
      const offset = file.offset + cursor + start;
      assert(cursor + start + size <= file.size);
      const header = read(offset, 28); assert.equal(header.readUInt32LE(), 0x53475057);
      const metadata = header.readUInt32LE(20), length = header.readUInt32LE(24);
      assert(28 + metadata + length <= size);
      const digest = hash(read(offset + 28 + metadata, length));
      for (const id of wanted.get(digest) || [])
        shaderProof.push({moduleId: id, sha256: digest, archive: file.path, shaderIndex: index});
    }
  }
} finally {fs.closeSync(fd);}
assert.equal(new Set(shaderProof.map(item => item.moduleId)).size, selectedModules.size,
  'All added WGSL modules must be byte-identical to target Cook shaders');
let next = Math.max(...pack.modules.map(item => item.id), ...pack.layouts.map(item => item.id));
const remapped = new Map(), original = structuredClone(pack);
function transfer(value, sourceIndex) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(child => transfer(child, sourceIndex));
  if (value.$gpu) {
    const key = sourceIndex + ':' + value.id;
    if (remapped.has(key)) return remapped.get(key);
    const resource = sourceResources.get(key); assert(resource && resource.$gpu === value.$gpu);
    const reference = {$gpu: resource.$gpu, id: ++next}; remapped.set(key, reference);
    const descriptor = transfer(resource.descriptor, sourceIndex);
    pack[resource.$gpu === 'module' ? 'modules' : 'layouts'].push({...reference, descriptor});
    return reference;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transfer(child, sourceIndex)]));
}
for (const {record, sourceIndex} of selected) pack.descriptors.push({...record, id: pack.descriptors.length + 1,
  deviceId: pack.devices[0].id, descriptor: transfer(record.descriptor, sourceIndex)});
assert.deepEqual(pack.descriptors.slice(0, original.descriptors.length), original.descriptors);
assert.deepEqual(pack.descriptors.filter(item => item.kind === 'compute'), original.descriptors.filter(item => item.kind === 'compute'));
fs.mkdirSync(output);
for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
  if (!entry.isFile() || ['index.html', 'asset-versions.json', 'pipeline-prewarm.json'].includes(entry.name)) continue;
  fs.linkSync(path.join(source, entry.name), assertProjectOutput(path.join(output, entry.name)));
}
fs.copyFileSync(path.join(source, 'index.html'), assertProjectOutput(path.join(output, 'index.html')));
replaceFile(path.join(output, 'pipeline-prewarm.json'), JSON.stringify(pack));
const page = readPage(output);
page.assets.diagnosticOnly = true;
page.assets.diagnosticPrewarm = {kind: 'manual-turn-coverage', addedRenderPipelines: labels.length,
  donors: donors.map(donor => audit(donor.file)),
  previous: page.assets.diagnosticPrewarm,
  originalPrewarm: audit(path.join(source, 'pipeline-prewarm.json')).sha256,
  boundary: 'Supplemented recorded graphics descriptors with WGSL verified against the target Cook. Not a same-runtime capture or an approved ordinary release.'};
page.assets.pipelinePrewarm.sha256 = audit(path.join(output, 'pipeline-prewarm.json')).sha256;
writePage(output, page);
const core = coreFiles.map(name => {
  const expected = audit(path.join(source, name)), actual = audit(path.join(output, name));
  assert.equal(actual.sha256, expected.sha256); return actual;
});
const products = fs.readdirSync(output).map(name => audit(path.join(output, name)));
writeVersions(output, products);
const report = {date: new Date().toISOString(), pass: true, diagnosticOnly: true,
  source, donors: donors.map(donor => audit(donor.file)), output, core, originalPipelines: original.descriptors.length,
  supplementedPipelines: pack.descriptors.length, added: labels, shaderProof,
  unchangedComputePipelines: true, unchangedSourcePack: audit(path.join(source, 'pipeline-prewarm.json')),
  pack: audit(path.join(output, 'pipeline-prewarm.json')),
  boundary: page.assets.diagnosticPrewarm.boundary};
fs.writeFileSync(assertProjectOutput(path.join(base, 'results/villa-tsr-turn-' + tag + '-package.json')), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, added: labels.length, verifiedShaders: selectedModules.size, pipelines: pack.descriptors.length}));
