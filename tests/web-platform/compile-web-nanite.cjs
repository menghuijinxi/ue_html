'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const sourceRoot = path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite');
const host = path.join(root, '.tools/ue58-web-build-host/Engine');
const output = path.join(__dirname, 'results/nanite-wasm');
const intermediate = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngineThreads/Development/Renderer');
const unix = value => value.replaceAll('\\', '/');
fs.mkdirSync(output, {recursive: true});
const unity = fs.readdirSync(intermediate).filter(name => /^Module\.Renderer\.\d+\.cpp$/.test(name))
  .filter(name => fs.readFileSync(path.join(intermediate, name), 'utf8').includes('Nanite/NaniteCullRaster.cpp'));
assert.equal(unity.length, 1, 'Prepare the threaded Web engine build before this compile check');
const originalResponse = path.join(intermediate, `${unity[0]}.o.rsp`);
const sources = ['NaniteCullRaster.cpp', 'NaniteCullRaster.h', 'NaniteWebVisibility.h'];
const installed = sources.slice(0, 2).map(name => audit(path.join(
  process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine', 'Source/Runtime/Renderer/Private/Nanite', name)));
const destinationRoot = path.join(host, 'Source/Runtime/Renderer/Private/Nanite');
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
  ['-c', path.join(destinationRoot, 'NaniteCullRaster.cpp')],
  ['-o', path.join(output, 'NaniteCullRaster.o')],
  ['-MF', path.join(output, 'NaniteCullRaster.d')],
]) {
  assert.equal(lines.filter(line => line === flag).length, 1);
  lines[lines.indexOf(flag) + 1] = `"${unix(value)}"`;
}
const response = path.join(output, 'compile.rsp'), log = path.join(output, 'compile.log');
fs.writeFileSync(response, lines.join('\n'));
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
const report = {date: new Date().toISOString(), pass: result.status === 0 && unmodified,
  compileOnly: true, linked: false, target: 'UEWebEngineThreads wasm64', milliseconds: Date.now() - started,
  exitCode: result.status, error: result.error?.message, installedInputsUnmodified: unmodified, installed,
  inputs: [__filename, originalResponse, response, ...sources.map(n => path.join(sourceRoot, n))].map(audit),
  log: audit(log), object: result.status === 0 ? audit(path.join(output, 'NaniteCullRaster.o')) : null};
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.pass) {
  console.error(fs.readFileSync(log, 'utf8').slice(-12000));
  process.exitCode = 1;
}
