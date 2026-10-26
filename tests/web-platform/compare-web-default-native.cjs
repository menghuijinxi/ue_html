const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {pass: false, inputs: [], comparisons: []};
function measure(file, reference) {
  const a = PNG.sync.read(fs.readFileSync(file)), b = PNG.sync.read(fs.readFileSync(reference));
  assert(a.width === 1600 && a.height === 900 && b.width === a.width && b.height === a.height);
  const delta = (x, y) => {
    const i = (y * a.width + x) * 4;
    return (b.data[i] + b.data[i + 1] + b.data[i + 2] - a.data[i] - a.data[i + 1] - a.data[i + 2]) / 3;
  };
  const lit = [];
  for (let y = 340; y < 470; ++y)
    for (let x = 850; x < 970; ++x) lit.push(delta(x, y));
  lit.sort((a, b) => a - b);
  const exposure = lit[Math.floor(lit.length / 2)];
  let changed = 0, count = 0, sum = 0;
  for (let y = 300; y < 750; ++y)
    for (let x = 580; x < 1030; ++x) {
      if (Math.hypot(x - 800, y - 525) > 220) continue;
      const d = delta(x, y) - exposure;
      changed += d > 6 ? 1 : 0; sum += Math.max(0, d); ++count;
    }
  return {exposure, mean: sum / count, changedFraction: changed / count};
}
(async () => {
  let browser;
  try {
    const webFile = path.join(results, 'web-default-shadow-artifacts-results.json');
    const web = read(webFile);
    assert(web.pass);
    report.inputs.push(audit(webFile));
    assert.equal(web.camera.fov, 75);
    for (const [mode, feature] of [['desktop', 3], ['mobile', 1]]) {
      const file = path.join(results, `default-shadow-native-${mode}-results.json`);
      const native = read(file), fixture = read(native.input);
      assert(native.pass && native.featureLevel === feature);
      for (const image of native.images) assert.equal(audit(image.file).sha256, image.sha256);
      const log = fs.readFileSync(native.log, 'utf8');
      assert(log.includes('triangles=960') && log.includes('triangles=16128'));
      for (const view of fixture.views) {
        assert.equal(view.fov, web.camera.fov);
        for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
          assert(Math.abs(view[key] - web.camera[key]) < 0.0001);
        assert(log.includes(`feature=${feature} bias=${view.bias} slope=${view.slope} fov=75`));
      }
      report.inputs.push(audit(file), audit(native.input), audit(native.log));
      const prefix = path.join(results, `default-shadow-native-${mode}`);
      const coarse = measure(`${prefix}-coarse.png`, `${prefix}-shadows-off.png`);
      const dense = measure(`${prefix}-baseline.png`, `${prefix}-shadows-off.png`);
      report.comparisons.push({mode, coarse, dense});
      assert(coarse.changedFraction > 0.05, 'Stock native CSM must reproduce the reported coarse terminator');
      assert(dense.mean < coarse.mean, 'Dense geometry must improve the native terminator too');
    }
    const panels = [
      ['UE desktop SM5 / CSM / original 960 triangles', 'default-shadow-native-desktop-coarse.png'],
      ['UE desktop SM5 / CSM / dense 16128 triangles', 'default-shadow-native-desktop-baseline.png'],
      ['UE desktop ES3.1 preview / original 960 triangles', 'default-shadow-native-mobile-coarse.png'],
      ['WebGPU ES3.1 / dense mesh + receiver plane correction', 'default-shadow-web-baseline.png']
    ];
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page = await browser.newPage({viewport: {width: 1600, height: 988}});
    const html = `<style>
      *{box-sizing:border-box}body{margin:0;background:#fff;color:#171717;font:18px Arial}
      main{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px}
      figure{margin:0}figcaption{height:36px;display:flex;align-items:center}
      img{display:block;width:100%;aspect-ratio:16/9}
      </style><main>${panels.map(([title, file]) =>
      `<figure><figcaption>${title}</figcaption><img src="data:image/png;base64,${fs.readFileSync(path.join(results, file)).toString('base64')}"></figure>`).join('')}</main>`;
    await page.setContent(html);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    const output = path.join(results, 'default-shadow-native-web-comparison.png');
    await page.locator('main').screenshot({path: output});
    report.contactSheet = audit(output);
    report.boundary = 'Same source world, sample transforms/materials, light biases and camera. Stock native CSM, not VSM/Lumen. Reflection and atmosphere differences remain; no whole-image parity claim.';
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'default-shadow-native-web-comparison-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
