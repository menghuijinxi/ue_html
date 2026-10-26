const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/material-lab');
const layoutFile = path.join(results, 'material-lab-layout.json');
const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8').replace(/^\uFEFF/, ''));
const prepareFile = path.join(results, 'web-material-lab-prepare-results.json');
const prepared = JSON.parse(fs.readFileSync(prepareFile, 'utf8').replace(/^\uFEFF/, ''));
assert(prepared.pass && prepared.sourceTemplateUnmodified &&
  [...prepared.sourceFiles, ...prepared.generatedAssets, prepared.layout, prepared.log].every(valid));
assert.equal(prepared.generatedAssets.length, 20);
assert.equal(layout.map, '/Game/WebMaterialLab');
assert.equal(layout.samples.length, 16);
execFileSync(process.execPath, [path.join(__dirname, 'package-web-project.cjs'), '--project=material-lab'],
  {stdio: 'inherit'});
const reportFile = path.join(results, 'web-project-material-lab-package-results.json');
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert(report.pass && report.map === layout.map);
report.pass = false;
try {
  const htmlFile = path.join(output, 'index.html');
  const uiFile = path.join(__dirname, 'material-lab-ui.js');
  fs.copyFileSync(uiFile, path.join(output, 'material-lab-ui.js'));
  fs.writeFileSync(path.join(output, 'layout.json'), JSON.stringify(layout, null, 2));
  let html = fs.readFileSync(htmlFile, 'utf8')
    .replace('<title>MaterialLab</title>', '<title>UE 材质测试场</title>')
    .replace('<h1>MaterialLab</h1>', '<h1>UE 材质测试场</h1>')
    .replace('aria-label="MaterialLab"', 'aria-label="UE 材质测试场"');
  assert(html.includes("'-WebProjectMap=/Game/WebMaterialLab'"));
  html += '\n<script src="material-lab-ui.js?v=' + audit(uiFile).sha256 + '"></script>\n';
  fs.writeFileSync(htmlFile, html);
  report.sourceFiles.push(...[__filename, uiFile, layoutFile,
    path.join(__dirname, 'build-web-material-lab.ps1'),
    path.resolve(__dirname, '../ue-shader-host/Source/UEShaderHost/Private/WebMaterialLabCommandlet.cpp'),
    path.resolve(__dirname, '../ue-shader-host/Source/UEShaderHost/Public/WebMaterialLabCommandlet.h')].map(audit));
  report.products = [...report.products.filter(item => path.basename(item.file) !== 'index.html'),
    ...['index.html', 'material-lab-ui.js', 'layout.json'].map(name => audit(path.join(output, name)))];
  report.totalBytes = report.products.reduce((total, item) => total + fs.statSync(item.file).size, 0);
  report.layout = layout;
  report.materialLabPreparation = audit(prepareFile);
  report.pass = true;
} finally {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({pass: report.pass, map: report.map, samples: layout.samples.length,
  output, bytes: report.totalBytes}, null, 2));
