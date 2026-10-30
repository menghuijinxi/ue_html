const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');

const directory = path.join(__dirname, 'results');
const prefix = 'distance-field-triplex-house-villa-df-distance-fields-threads-msedge-';
const inputs = [
  ['桌面参考', 'villa-distance-fields-cube-shadow-audit-baseline.png'],
  ['Web：关闭局部灯阴影', `${prefix}cube-shadow-off-foyer.png`],
  ['Web：开启局部灯阴影', `${prefix}cube-shadow-shipped-foyer.png`],
];
const regions = {
  'handle-shadow': [918, 145, 34, 124],
  'door-wall': [550, 180, 51, 360],
  'wall-floor': [550, 634, 128, 50],
};

(async () => {
  const images = inputs.map(([, name]) => PNG.sync.read(fs.readFileSync(path.join(directory, name))));
  assert(images.every(image => image.width === 1280 && image.height === 720));
  const meanDifference = (a, b, [x, y, width, height]) => {
    let sum = 0;
    for (let row = y; row < y + height; ++row)
      for (let col = x; col < x + width; ++col) {
        const offset = (row * a.width + col) * 4;
        for (let channel = 0; channel < 3; ++channel)
          sum += Math.abs(a.data[offset + channel] - b.data[offset + channel]);
      }
    return sum / (width * height * 3);
  };
  const contribution = Object.fromEntries(Object.entries(regions).map(([name, rect]) =>
    [name, meanDifference(images[1], images[2], rect)]));
  assert(contribution['handle-shadow'] > 5, 'The actual handle shadow must change when cubemap shadows are disabled');
  const layers = [];
  for (let index = 0; index < inputs.length; ++index) {
    const [title, name] = inputs[index];
    const file = path.join(directory, name);
    const header = Buffer.from(`<svg width="640" height="40"><rect width="640" height="40" fill="#202020"/>
      <text x="16" y="27" fill="white" font-size="20" font-family="Microsoft YaHei">${title}</text></svg>`);
    layers.push({input: header, left: index * 640, top: 0});
    layers.push({input: await sharp(file).resize(640, 360).toBuffer(), left: index * 640, top: 40});
    layers.push({input: await sharp(file).extract({left: 890, top: 125, width: 120, height: 180})
      .resize(140, 210).toBuffer(), left: index * 640 + 20, top: 420});
    layers.push({input: await sharp(file).extract({left: 500, top: 540, width: 300, height: 180})
      .resize(350, 210).toBuffer(), left: index * 640 + 210, top: 420});
  }
  const output = path.join(directory, 'villa-cube-shadow-comparison.png');
  await sharp({create: {width: 1920, height: 650, channels: 4, background: '#202020'}})
    .composite(layers).png().toFile(output);
  const report = {pass: true, source: audit(__filename), inputs: inputs.map(([label, file]) =>
    ({label, ...audit(path.join(directory, file))})), output: audit(output), regions, contribution,
    boundary: 'Pixel differences measure the controlled Web on/off contribution, not desktop parity. The native reference has different texture residency.'};
  fs.writeFileSync(path.join(directory, 'villa-cube-shadow-comparison.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1;});
