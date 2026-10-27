const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const plugin = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader');
const report = {date: new Date().toISOString(), pass: false, sourceFiles: [audit(__filename)], runs: []};
try {
  const source = path.join(plugin, 'Source/WebGPURHI/Private');
  const inputs = [path.join(plugin, 'Binaries/Win64/UnrealEditor-WebGPURHI.dll'),
    path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll'),
    ...['WebGPUDynamicRHI.cpp', 'WebGPUDynamicRHI.h', 'WebGPUTextureSRVProbe.cpp',
      'WebGPUBufferSRVProbe.cpp'].map(name => path.join(source, name)),
    path.join(root, '.tools/ue58-web-platform-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),
    path.join(root, '.tools/ue58-dawn-host/WebGPUHost.dll')];
  report.inputs = inputs.map(audit);
  const buildLog = path.join(results, 'web-desktop-native-rhi-build.log');
  assert(fs.readFileSync(buildLog, 'utf8').includes('Result: Succeeded'));
  report.nativeBuildLog = audit(buildLog);
  for (const [kind, flag, shader, folder] of [
    ['texture', '-WebTextureSRVProbe -WebDesktopTextureProbe', 'ue-platform-full-worker', 'ue-rhi-desktop-texture'],
    ['buffer', '-WebBufferSRVProbe', 'ue-buffer-worker', 'ue-rhi-buffer-srv']
  ]) {
    const output = path.join(__dirname, 'build', folder);
    const log = path.join(results, `ue-rhi-desktop-${kind}-host.log`);
    const shaderDirectory = path.join(__dirname, 'build', shader);
    const packets = fs.readdirSync(shaderDirectory).filter(name => name.endsWith('.webshader'))
      .map(name => audit(path.join(shaderDirectory, name)));
    const child = spawnSync(inputs[6], [path.join(root, 'tests/ue-shader-host/UEShaderHost.uproject'),
      '-run=WebShaderProbe', ...flag.split(' '), `-WebShaderDirectory=${shaderDirectory}`,
      `-Output=${output}`, '-nullrhi', '-norhithread', '-unattended', '-nop4', '-nosplash', '-nosound',
      `-abslog=${log}`], {encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
      env: {...process.env, PATH: path.join(root, '.tools/ue58-dawn-host') + ';' + process.env.PATH}});
    assert.equal(child.status, 0, child.error?.message || child.stdout.slice(-2000));
    const runtimeFile = path.join(output, kind === 'texture' ? 'texture-srv-results.json' : 'buffer-srv-results.json');
    const runtime = read(runtimeFile);
    assert(runtime.pass && runtime.hostRHI === 'Null');
    assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
    const run = {kind, runtime: audit(runtimeFile), shaderPackets: packets, log: audit(log), readbacks: []};
    report.runs.push(run);
    for (const mode of runtime.modes) {
      assert(mode.pass && mode.errors.length === 0 && mode.checks.every(check => check.pass));
      assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
      assert.equal(mode.checkedValues, kind === 'texture' ? 6492 : 1792);
      if (kind === 'texture') {
        for (const cleared of [false, true]) {
          const name = cleared ? 'desktop-array-clear-range-isolation' : 'desktop-array-initializer-all-mips-and-layers';
          assert(mode.checks.some(check => check.name === name && check.pass));
          const file = path.join(output, `${mode.mode}-${name}.bin`);
          const bytes = fs.readFileSync(file);
          assert.equal(bytes.length, 42 * 4);
          let index = 0;
          for (let mip = 0; mip < 3; mip++)
            for (let layer = 0; layer < 2; layer++)
              for (let pixel = 0; pixel < (4 >> mip) ** 2; pixel++)
                assert.equal(bytes.readUInt32LE(index++ * 4), cleared && mip === 1 && layer === 1 ?
                  0xa1b2c3d4 : 0x11223344 + layer * 0x10000 + mip);
          run.readbacks.push(audit(file));
        }
        assert(mode.checks.some(check => check.name === 'desktop-cube-array-lock-face-mip-isolation' && check.pass));
        const file = path.join(output, `${mode.mode}-desktop-cube-array-lock-face-mip-isolation.bin`);
        const bytes = fs.readFileSync(file);
        assert.equal(bytes.length, 252 * 4);
        let index = 0;
        for (let mip = 0; mip < 3; ++mip)
          for (let layer = 0; layer < 12; ++layer)
            for (let pixel = 0; pixel < (4 >> mip) ** 2; ++pixel)
              assert.equal(bytes.readUInt32LE(index++ * 4), 0x55660000 + layer * 0x100 + mip);
        run.readbacks.push(audit(file));
        assert(mode.checks.some(check => check.name === 'desktop-rg32uint-clear-preserves-channels' && check.pass));
        const velocityFile = path.join(output, `${mode.mode}-desktop-rg32uint-clear-preserves-channels.bin`);
        const velocityBytes = fs.readFileSync(velocityFile);
        assert.equal(velocityBytes.length, 12 * 4);
        for (let word = 0; word < 12; ++word)
          assert.equal(velocityBytes.readUInt32LE(word * 4), word % 2 ? 0xfedcba98 : 0x12345678);
        run.readbacks.push(audit(velocityFile));
      } else {
        assert.equal(mode.dispatches, 5);
        assert(mode.checks.some(check => check.name === 'raw-view-copy-and-guards' && check.pass));
        const original = Array.from({length: 256}, (_, i) => i === 0 ? 0 : i === 1 ? 0xffffffff :
          (Math.imul(i, 2654435761) ^ 0x80000000) >>> 0);
        const updated = original.map((_, i) => (Math.imul(i, 65537) ^ 0xfedcba98) >>> 0);
        const expected = Array(256).fill(0xa5a5a5a5);
        const check = (name, values) => {
          const file = path.join(output, `${mode.mode}-${name}.bin`), bytes = fs.readFileSync(file);
          assert.equal(bytes.length, 1024);
          values.forEach((value, i) => assert.equal(bytes.readUInt32LE(i * 4), value));
          run.readbacks.push(audit(file));
        };
        for (let i = 0; i < 129; i++) expected[11 + i] = original[7 + i];
        check('whole-view-copy-and-guards', expected);
        check('read-only-source-preserved', original);
        for (let i = 0; i < 67; i++) expected[97 + i] = original[67 + i];
        check('subrange-copy-and-guards', expected);
        expected.splice(0, expected.length, ...original);
        check('raw-view-copy-and-guards', expected);
        for (let i = 0; i < 35; i++) expected[199 + i] = updated[74 + i];
        check('view-observes-copy-update', expected);
        for (let i = 0; i < 200; i++) expected[3 + i] = updated[5 + i];
        check('srv-survives-caller-release', expected);
        check('updated-read-only-source-preserved', updated);
      }
    }
    const text = fs.readFileSync(log, 'utf8');
    assert(!/Assertion failed:|Fatal error:|P2_(TEXTURE|BUFFER)_SRV[^\r\n]*pass=0/.test(text));
    assert(text.includes('Object subsystem successfully closed.'));
  }
  for (const item of report.inputs) assert.equal(audit(item.file).sha256, item.sha256);
  report.pass = true;
  report.boundary = 'Native Dawn/D3D12 resource regression with unchanged binaries and sources during the run. Full browser rendering is verified separately.';
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(results, 'web-desktop-resources-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, runs: report.runs.map(run => run.kind), failure: report.failure}));
}
