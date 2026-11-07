'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');

function compareGlass(actual, reference) {
  assert.equal(actual.width, 1280);
  assert.equal(actual.height, 720);
  assert.equal(reference.width, actual.width);
  assert.equal(reference.height, actual.height);
  // Fixed interior camera (-175,-80,160), pitch -5, yaw 50, horizontal FOV 90.
  const regions = [
    {name: 'cabinet-glass', x: 465, y: 350, width: 25, height: 105},
    {name: 'window-glass', x: 844, y: 480, width: 26, height: 35},
  ];
  const measure = (image, region) => {
    const sum = [0, 0, 0];
    for (let y = region.y; y < region.y + region.height; ++y)
      for (let x = region.x; x < region.x + region.width; ++x) {
        const offset = (y * image.width + x) * 4;
        for (let channel = 0; channel < 3; ++channel) sum[channel] += image.data[offset + channel];
      }
    const total = sum.reduce((a, b) => a + b, 0);
    assert(total > 0, 'Glass region must not be black');
    return {mean: sum.map(value => value / (region.width * region.height)),
      chromaticity: sum.map(value => value / total)};
  };
  const cases = regions.map(region => {
    const web = measure(actual, region), native = measure(reference, region);
    const difference = Math.max(...web.chromaticity.map((value, i) => Math.abs(value - native.chromaticity[i])));
    return {region, web, native, difference, pass: difference < 0.02};
  });
  return {pass: cases.every(item => item.pass), maximumChromaticityDifference: 0.02, cases};
}
module.exports = compareGlass;
if (require.main === module) {
  const [actual, reference, output] = process.argv.slice(2);
  assert(actual && reference && output, 'Usage: node verify-web-glass-color.cjs actual.png reference.png report.json');
  const result = {date: new Date().toISOString(), source: audit(__filename),
    actual: audit(path.resolve(actual)), reference: audit(path.resolve(reference)),
    ...compareGlass(PNG.sync.read(fs.readFileSync(actual)), PNG.sync.read(fs.readFileSync(reference)))};
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
}
