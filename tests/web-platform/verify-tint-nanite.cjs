'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(__dirname, 'results/nanite-converter');
const tools = path.join(root, '.tools/dawn-v20261009.190412/bin');
const converter = path.join(tools, 'tint_nanite.exe');
const dxc = path.join(root, '.tools/dxc-v1.9.2609/bin/x64/dxc.exe');
const fixture = path.join(__dirname, 'shader-fixtures/nanite-transcode-policy.hlsl');
fs.mkdirSync(output, {recursive: true});
const cases = [];
for (const entry of ['ValidBarrier', 'InvalidBarrier', 'ActiveLanes']) {
  const spv = path.join(output, `${entry}.spv`), wgsl = path.join(output, `${entry}.wgsl`);
  cp.execFileSync(dxc, [fixture, '-E', entry, '-T', 'cs_6_0', '-HV', '2021', '-spirv',
    '-fspv-target-env=vulkan1.1', '-Fo', spv], {stdio: 'pipe'});
  const converted = cp.spawnSync(converter, [spv, wgsl], {encoding: 'utf8'});
  assert.ifError(converted.error);
  const error = converted.stderr + converted.stdout;
  if (entry === 'InvalidBarrier') {
    assert.notEqual(converted.status, 0);
    assert.match(error, /workgroupBarrier.*uniform control flow/);
  } else {
    assert.equal(converted.status, 0, error);
    const code = fs.readFileSync(wgsl, 'utf8');
    assert.match(code, /diagnostic\(off, subgroup_uniformity\)/);
    if (entry === 'ValidBarrier') assert.match(code, /workgroupBarrier\(/);
    cp.execFileSync(path.join(tools, 'tint_info.exe'), ['--json', wgsl]);
  }
  if (entry === 'ActiveLanes') {
    const stock = cp.spawnSync(path.join(tools, 'tint.exe'),
      [spv, '--format', 'wgsl', '-o', path.join(output, 'stock.wgsl')], {encoding: 'utf8'});
    assert.ifError(stock.error);
    assert.notEqual(stock.status, 0);
    assert.match(stock.stderr + stock.stdout, /subgroup.*uniform control flow/);
  }
  cases.push({entry, pass: true, rejected: entry === 'InvalidBarrier'});
}
const malformed = path.join(output, 'truncated.spv');
fs.writeFileSync(malformed, Buffer.from([3, 2, 35]));
assert.equal(cp.spawnSync(converter, [malformed, path.join(output, 'invalid.wgsl')]).status, 3);
assert.equal(cp.spawnSync(converter, []).status, 2);
cases.push({entry: 'truncated-input', pass: true, rejected: true},
  {entry: 'missing-arguments', pass: true, rejected: true});
const report = {date: new Date().toISOString(), pass: true, cases, sources: [__filename, fixture, converter, dxc,
  path.join(__dirname, 'tint-nanite/main.cpp'), path.join(__dirname, 'tint-nanite/CMakeLists.txt'),
  path.join(root, '.tools/dawn-v20261009.190412/lib/webgpu_dawn.lib')].map(audit)};
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, cases}));
