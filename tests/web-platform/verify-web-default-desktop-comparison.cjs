const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, sourceFiles: [audit(__filename)], comparisons: []};
try {
  const nativeFile = path.join(directory, 'default-shadow-native-desktop-results.json');
  const native = read(nativeFile);
  assert(native.pass && native.featureLevel === 3 && native.mode === 'desktop');
  assert(native.images.every(valid));
  const fixture = read(native.input);
  const expectedCamera = fixture.views[0];
  const baseline = PNG.sync.read(fs.readFileSync(native.images[0].file));
  assert.equal(baseline.width, 1600);
  assert.equal(baseline.height, 900);
  report.nativeReport = audit(nativeFile);
  report.nativeInput = audit(native.input);
  report.nativeLog = audit(native.log);
  for (const suffix of ['', '-edge']) {
    const file = path.join(directory, `web-default-desktop${suffix}-results.json`);
    const browser = read(file);
    assert(browser.pass && browser.completeUEScene && browser.runs.length === 1);
    const run = browser.runs[0];
    assert(run.samples.sceneUnchanged && run.ready.featureLevel === 3 && !run.materialPolicy.mobile);
    for (const key of ['x', 'y', 'z', 'pitch', 'yaw', 'fov'])
      assert(Math.abs(run.comparisonCamera[key] - expectedCamera[key]) < 0.001);
    assert.equal(run.samples.samples.length, fixture.samples.length);
    run.samples.samples.forEach((sample, i) => {
      for (const key of ['material', 'metallic', 'roughness', 'specular', 'x', 'y', 'z', 'radius'])
        assert.equal(sample[key], fixture.samples[i][key]);
    });
    const image = run.images['native-camera'];
    assert(valid(image));
    const pixels = PNG.sync.read(fs.readFileSync(image.file));
    assert.equal(pixels.width, baseline.width);
    assert.equal(pixels.height, baseline.height);
    const comparison = {browser: run.browser, report: audit(file), image, regions: []};
    report.comparisons.push(comparison);
    for (const [name, x0, y0, x1, y1] of [
      ['frame', 0, 0, 1600, 900], ['materials', 200, 280, 1060, 790],
      ['floor', 1060, 450, 1600, 900], ['sky', 0, 0, 1600, 280]
    ]) {
      let sum = 0, count = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * pixels.width + x) * 4 + c;
            sum += Math.abs(pixels.data[i] - baseline.data[i]);
            count++;
          }
      const meanAbsoluteError = sum / count;
      comparison.regions.push({name, meanAbsoluteError, scale: 255});
      assert(meanAbsoluteError < 8, `${run.browser}/${name} differs from the native SM5 baseline`);
    }
  }
  report.pass = true;
  report.boundary = 'Same default map, profile, material samples and camera against native D3D12 SM5. Regional image differences allow rasterization/filtering variation; this does not establish Lumen or complete SM6 equivalence.';
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(directory, 'web-default-desktop-comparison-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, comparisons: report.comparisons, failure: report.failure}, null, 2));
}
