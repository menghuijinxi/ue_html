const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const stock = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const host = path.join(root, '.tools/ue58-web-platform-host/Engine');
const project = path.join(root, 'tests/ue-shader-host/UEShaderHost.uproject');
const ddpi = path.join(host, 'Platforms/WebGPU/Config/DataDrivenPlatformInfo.ini');
const disabled = `${ddpi}.negative-test-disabled`;
const reports = [];
function check(name, engine) {
  const log = path.join(__dirname, `results/ue-platform-negative-${name}.log`);
  const result = cp.spawnSync(path.join(engine, 'Binaries/Win64/UnrealEditor-Cmd.exe'),
    [project, '-run=WebShaderProbe', '-WebShaderPlatform',
      `-Output=${path.join(__dirname, 'build/ue-platform-negative', name)}`,
      '-unattended', '-nosplash', '-nop4', '-NoSound', '-nullrhi', `-abslog=${log}`],
    {encoding: 'utf8', timeout: 60000, windowsHide: true});
  const text = result.stdout + result.stderr;
  const pass = result.status === 1 && !result.error &&
    /Web static map\/DDPI missing: SP_WEBGPU_SM5/.test(text) &&
    !/Assertion failed|Critical error|Fatal error/.test(text);
  reports.push({name, pass, exitCode: result.status,
    expectedDiagnostic: 'Web static map/DDPI missing: SP_WEBGPU_SM5', log});
  assert(pass, `${name}: missing registration did not fail cleanly`);
}
check('missing-static-map', stock);
assert(!fs.existsSync(disabled));
assert(ddpi.startsWith(host + path.sep) && !fs.lstatSync(path.dirname(ddpi)).isSymbolicLink());
fs.renameSync(ddpi, disabled);
try { check('missing-ddpi', host); }
finally { fs.renameSync(disabled, ddpi); }
fs.writeFileSync(path.join(__dirname, 'results/ue-platform-negative-results.json'),
  JSON.stringify({pass: reports.every(item => item.pass), reports}, null, 2));
console.log(JSON.stringify(reports, null, 2));
