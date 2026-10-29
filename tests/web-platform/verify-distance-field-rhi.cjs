const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');

const directory = path.join(__dirname, 'build/ue-rhi-distance-field');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const resultFile = path.join(directory, 'distance-field-rhi-results.json');
const preparationFile = path.join(directory, 'CookShaders/preparation.json');
const result = read(resultFile), preparation = read(preparationFile);
assert(result.pass && result.modes.length === 2);
assert(preparation.pass && preparation.shaders.length === 3);
for (const item of [preparation.cook, preparation.tint])
  assert.equal(audit(item.file).sha256, item.sha256);
const cook = read(preparation.cook.file);
assert(cook.pass && cook.distanceFields && cook.shaderFailures.length === 0);
for (const shader of preparation.shaders)
  for (const item of [shader.input, shader.wgsl, shader.packet])
    assert.equal(audit(item.file).sha256, item.sha256);
let verifiedValues = 0;
const files = [];
for (const [index, name] of ['recorded', 'bypass'].entries()) {
  const mode = result.modes[index];
  assert.equal(mode.bypass, index === 1);
  assert(mode.pass && mode.checks.length === 15 && mode.checks.every(check => check.pass));
  assert.deepEqual(mode.errors, []);
  const largeFile = path.join(directory, `${name}-large-clear.bin`);
  const large = fs.readFileSync(largeFile);
  assert.equal(large.length, (65535 * 256 + 17) * 4);
  for (let offset = 0; offset < large.length; offset += 4) {
    assert.equal(large.readUInt32LE(offset), 0x9e3779b9);
    ++verifiedValues;
  }
  files.push(audit(largeFile));
  for (const [format, count, expected, skip] of [
    [3, 18, [64, 0, 0, 255], 0], [13, 18, [64, 0, 0, 255], 0],
    [71, 18, [64, 0, 0, 255], 0], [28, 19, [0xffffffff, 0, 0, 1], 4],
  ]) {
    const file = path.join(directory, `${name}-format${format}.bin`);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, count * 16);
    for (let i = skip; i < count * 4; ++i) {
      assert.equal(bytes.readUInt32LE(i * 4), expected[i % 4], `${name}: format ${format}, value ${i}`);
      ++verifiedValues;
    }
    files.push(audit(file));
  }
  const file = path.join(directory, `${name}-packed.bin`);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, 4096 * 16);
  for (let z = 0; z < 16; ++z) for (let y = 0; y < 16; ++y) for (let x = 0; x < 16; ++x) {
    const brick = x >= 8 && y < 8 && z < 8 ? 1 : x < 8 && y >= 8 && z >= 8 ? 2 : 0;
    const source = brick * 512 + ((z % 8) * 8 + y % 8) * 8 + x % 8;
    const expected = [brick ? (source * 37 + Math.floor(source / 7) + 13) % 256 : 255, 0, 0, 255];
    for (let c = 0; c < 4; ++c) {
      assert.equal(bytes.readUInt32LE((((z * 16 + y) * 16 + x) * 4 + c) * 4), expected[c],
        `${name}: packed voxel (${x},${y},${z}), channel ${c}`);
      ++verifiedValues;
    }
  }
  files.push(audit(file));
}
const report = {pass: true, checks: 30, verifiedValues, result: audit(resultFile),
  preparation: audit(preparationFile), files, source: audit(__filename),
  boundary: 'Native WebGPURHI GPU readback; browser DFAO output and performance require separate verification.'};
fs.writeFileSync(path.join(__dirname, 'results/distance-field-rhi-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, checks: report.checks, verifiedValues}));
