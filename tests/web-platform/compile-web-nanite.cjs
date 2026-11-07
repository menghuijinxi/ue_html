'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const uploader = process.argv.includes('--uploader');
const moduleName = uploader ? 'Engine' : 'Renderer';
const mainSource = uploader ? 'NaniteStreamingPageUploader.cpp' : 'NaniteCullRaster.cpp';
const objectName = mainSource.replace(/\.cpp$/, '');
const sourceRoot = path.join(root, `reference-engine/Engine/Source/Runtime/${moduleName}/Private/Nanite`);
const host = path.join(root, '.tools/ue58-web-build-host/Engine');
const output = path.join(__dirname, uploader ? 'results/nanite-uploader-wasm' : 'results/nanite-wasm');
const intermediate = path.join(root, `tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngineThreads/Development/${moduleName}`);
const unix = value => value.replaceAll('\\', '/');
fs.mkdirSync(output, {recursive: true});
const unity = fs.readdirSync(intermediate).filter(name => new RegExp(`^Module\\.${moduleName}\\.\\d+\\.cpp$`).test(name))
  .filter(name => fs.readFileSync(path.join(intermediate, name), 'utf8').includes(`Nanite/${mainSource}`));
assert.equal(unity.length, 1, 'Prepare the threaded Web engine build before this compile check');
const originalResponse = path.join(intermediate, `${unity[0]}.o.rsp`);
const sources = uploader ? ['NaniteStreamingPageUploader.cpp', 'NaniteStreamingPageUploader.h'] :
  ['NaniteCullRaster.cpp', 'NaniteCullRaster.h', 'NaniteWebVisibility.h'];
const installed = sources.slice(0, 2).map(name => audit(path.join(
  process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine', `Source/Runtime/${moduleName}/Private/Nanite`, name)));
const destinationRoot = path.join(host, `Source/Runtime/${moduleName}/Private/Nanite`);
assert.equal(fs.realpathSync(destinationRoot).toLowerCase(), destinationRoot.toLowerCase());
for (const name of sources) {
  const destination = path.join(destinationRoot, name);
  if (fs.existsSync(destination)) {
    assert.equal(fs.statSync(destination).nlink, 1, `Linked overlay: ${destination}`);
    fs.chmodSync(destination, 0o666);
  }
  fs.copyFileSync(path.join(sourceRoot, name), destination);
}
// Derive arguments from UBT; keep this check's object/dependency outputs separate
// from the executable's incremental build and do not perform a link.
const lines = fs.readFileSync(originalResponse, 'utf8').split(/\r?\n/);
for (const [flag, value] of [
  ['-c', path.join(destinationRoot, mainSource)],
  ['-o', path.join(output, objectName + '.o')],
  ['-MF', path.join(output, objectName + '.d')],
]) {
  assert.equal(lines.filter(line => line === flag).length, 1);
  lines[lines.indexOf(flag) + 1] = `"${unix(value)}"`;
}
const response = path.join(output, 'compile.rsp'), log = path.join(output, 'compile.log');
fs.writeFileSync(response, lines.join('\n'));
const inputs = [__filename, originalResponse, response, ...sources.map(n => path.join(sourceRoot, n))].map(audit);
const sdk = unix(path.join(root, '.tools/emsdk'));
const descriptor = fs.openSync(log, 'w');
const started = Date.now();
const result = cp.spawnSync(path.join(sdk, 'python/3.13.3_64bit/python.exe'),
  [path.join(sdk, 'upstream/emscripten/em++.py'), '@' + response], {
    cwd: path.join(host, 'Source'), env: {...process.env, EM_CONFIG: sdk + '/.emscripten'},
    windowsHide: true, stdio: ['ignore', descriptor, descriptor],
  });
fs.closeSync(descriptor);
const unmodified = installed.every(item => audit(item.file).sha256 === item.sha256);
const sourcesUnmodified = inputs.every(item => audit(item.file).sha256 === item.sha256);
const report = {date: new Date().toISOString(), pass: result.status === 0 && unmodified && sourcesUnmodified,
  compileOnly: true, linked: false, target: 'UEWebEngineThreads wasm64', milliseconds: Date.now() - started,
  exitCode: result.status, error: result.error?.message, installedInputsUnmodified: unmodified, installed,
  inputs, sourcesUnmodified,
  log: audit(log), object: result.status === 0 ? audit(path.join(output, objectName + '.o')) : null};
if (uploader && report.pass) {
  const rhiResponse = path.join(intermediate, '../WebGPURHI/BrowserDynamicRHI.cpp.o.rsp');
  const rhiLines = fs.readFileSync(rhiResponse, 'utf8').split(/\r?\n/);
  for (const [flag, suffix] of [['-o', '.o'], ['-MF', '.d']]) {
    assert.equal(rhiLines.filter(line => line === flag).length, 1);
    rhiLines[rhiLines.indexOf(flag) + 1] = `"${unix(path.join(output, 'BrowserDynamicRHI' + suffix))}"`;
  }
  const rhiCompile = path.join(output, 'rhi.rsp'), rhiLog = path.join(output, 'rhi.log');
  fs.writeFileSync(rhiCompile, rhiLines.join('\n'));
  const rhiSources = [rhiResponse, rhiCompile, ...['WebGPUDynamicRHI.cpp', 'WebGPUDynamicRHI.h'].map(name => path.join(root,
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private', name))].map(audit);
  const rhiFd = fs.openSync(rhiLog, 'w');
  const rhiResult = cp.spawnSync(path.join(sdk, 'python/3.13.3_64bit/python.exe'),
    [path.join(sdk, 'upstream/emscripten/em++.py'), '@' + rhiCompile], {
      cwd: path.join(host, 'Source'), env: {...process.env, EM_CONFIG: sdk + '/.emscripten'},
      windowsHide: true, stdio: ['ignore', rhiFd, rhiFd],
    });
  fs.closeSync(rhiFd);
  report.rhi = {pass: rhiResult.status === 0 && rhiSources.every(s => audit(s.file).sha256 === s.sha256),
    inputs: rhiSources, exitCode: rhiResult.status, error: rhiResult.error?.message, log: audit(rhiLog),
    object: rhiResult.status === 0 ? audit(path.join(output, 'BrowserDynamicRHI.o')) : null};
  report.pass &&= report.rhi.pass;
  if (!report.rhi.pass) console.error(fs.readFileSync(rhiLog, 'utf8').slice(-8000));
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.pass) {
  console.error(fs.readFileSync(log, 'utf8').slice(-12000));
  process.exitCode = 1;
}
