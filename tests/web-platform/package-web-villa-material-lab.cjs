const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const prepared = read(path.join(directory, 'web-project-villa-material-lab-prepare-results.json'));
const layout = read(prepared.lab.layout.file);
assert(prepared.lab.sourceTemplateUnmodified && prepared.lab.sourceFiles.every(valid) && valid(prepared.lab.layout));
assert(layout.templateLightingUnmodified && layout.sourceMaterialsUnmodified && layout.samples.length === 6);
execFileSync(process.execPath, [path.join(__dirname, 'package-web-project.cjs'),
  '--project=villa-material-lab', '--desktop', '--threads'], {stdio: 'inherit'});
const reportFile = path.join(directory, 'web-project-villa-material-lab-threads-package-results.json');
const report = read(reportFile);
const output = report.output;
const htmlFile = path.join(output, 'index.html');
const uiFile = path.join(__dirname, 'villa-material-lab-ui.js');
fs.copyFileSync(prepared.lab.layout.file, path.join(output, 'layout.json'));
fs.copyFileSync(uiFile, path.join(output, 'villa-material-lab-ui.js'));
const html = fs.readFileSync(htmlFile, 'utf8')
  .replaceAll('TriplexHouseVilla', 'UE 别墅材质对照')
  + '\n<script src="villa-material-lab-ui.js?v=' + audit(uiFile).sha256 + '"></script>\n';
fs.writeFileSync(htmlFile, html);
report.layout = layout;
report.sourceFiles.push(audit(__filename), audit(uiFile), prepared.lab.layout, ...prepared.lab.sourceFiles);
report.products = [...report.products.filter(item => path.basename(item.file) !== 'index.html'),
  ...['index.html', 'layout.json', 'villa-material-lab-ui.js'].map(name => audit(path.join(output, name)))];
report.totalBytes = report.products.reduce((sum, item) => sum + fs.statSync(item.file).size, 0);
report.boundary = 'Original villa meshes and material slots in a copy of Template_Default. ' +
  'Lighting, sky, floor and postprocess actors are retained. Only sample placement and PlayerStart change. ' +
  'This isolates the material comparison; it does not certify material parity or fix the villa lighting.';
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, samples: layout.samples.length, bytes: report.totalBytes}));
