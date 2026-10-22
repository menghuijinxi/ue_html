const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const directory = path.resolve(__dirname, '../results');
const input = path.resolve(option('log') || path.join(directory, 'web-default-fog-dawn-shader-dump.log'));
const output = path.resolve(option('output') || path.join(directory, 'dawn-dxc-inputs'));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const text = fs.readFileSync(input, 'utf8').replace(
  /^\d{4}-\d{2}-\d{2}T\S+ pw:browser \[pid=\d+\]\[err\] /gm, '');
const blocks = text.split('/* Dumped generated HLSL */').slice(1);
assert(blocks.length, 'No Dawn HLSL dumps found');
fs.mkdirSync(output, {recursive: true});
const records = blocks.map((block, index) => {
  const flagsAt = block.indexOf('/* DXC compile flags */');
  const dxilAt = block.indexOf('/* Dumped disassembled DXIL */');
  assert(flagsAt >= 0 && dxilAt > flagsAt, `Incomplete shader dump ${index}`);
  const hlsl = block.slice(0, flagsAt).trim() + '\n';
  const flags = block.slice(flagsAt + '/* DXC compile flags */'.length, dxilAt).trim().split(/\s+/);
  assert.deepEqual([...flags].sort(), ['D3DCOMPILE_PACK_MATRIX_ROW_MAJOR',
    'D3DCOMPILE_IEEE_STRICTNESS', 'D3DCOMPILE_OPTIMIZATION_LEVEL3'].sort(),
  `Update the native harness before testing different compiler flags in shader ${index}`);
  const model = block.slice(dxilAt).match(/!\{!"(vs|ps|cs)", i32 (\d+), i32 (\d+)\}/);
  assert(model, `Missing DXIL shader model ${index}`);
  const entry = hlsl.match(/\b(dawn_entry_point_[0-9a-f]+)\s*\(/)?.[1];
  assert(entry, `Missing Dawn entry point ${index}`);
  const profile = `${model[1]}_${model[2]}_${model[3]}`;
  const file = path.join(output, `${index}-${profile}.hlsl`);
  fs.writeFileSync(file, hlsl);
  return {index, profile, entry, flags, ...audit(file)};
});
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
  date: new Date().toISOString(), source: audit(__filename), dump: audit(input), records
}, null, 2));
console.log(JSON.stringify({shaders: records.length, profiles: [...new Set(records.map(record => record.profile))],
  manifest: path.join(output, 'manifest.json')}));
