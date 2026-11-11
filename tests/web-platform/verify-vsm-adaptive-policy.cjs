'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process'), {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..'), directory = path.join(__dirname, 'results/vsm-adaptive-policy-20261111');
fs.mkdirSync(directory, {recursive: true});
const dxc = path.join(root, '.tools/dxc-v1.9.2609/bin/x64/dxc.exe');
const converter = path.join(root, '.tools/dawn-v20261009.190412/bin/tint_nanite.exe');
const input = path.join(__dirname, 'shader-fixtures/vsm-adaptive-policy.hlsl');
const spv = path.join(directory, 'policy.spv'), wgsl = path.join(directory, 'policy.wgsl');
function run(tool, args) {
  const result = spawnSync(tool, args, {encoding: 'utf8', windowsHide: true});
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
}
const report = {date: new Date().toISOString(), pass: false,
  boundary: 'Subgroup active-lane semantic fixture, not full scene visual or performance validation.'};
let browser;
(async () => {
  try {
    run(dxc, [input, '-E', 'MainCS', '-T', 'cs_6_0', '-HV', '2021', '-spirv',
      '-fspv-target-env=vulkan1.1', '-Fo', spv]);
    run(converter, [spv, wgsl, '--vsm-adaptive-probe']);
    const code = fs.readFileSync(wgsl, 'utf8');
    assert.match(code, /subgroupAll/); assert.match(code, /enable subgroups/);
    const invalid = path.join(directory, 'invalid.spv');
    run(dxc, [path.join(__dirname, 'shader-fixtures/nanite-transcode-policy.hlsl'),
      '-E', 'InvalidBarrier', '-T', 'cs_6_0', '-spirv', '-Fo', invalid]);
    const rejected = spawnSync(converter, [invalid, path.join(directory, 'invalid.wgsl'),
      '--vsm-adaptive-probe'], {encoding: 'utf8', windowsHide: true});
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /workgroupBarrier.*uniform control flow/);
    report.invalidWorkgroupBarrierRejected = true;
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage(); await page.goto('http://127.0.0.1:8765');
    report.gpu = await page.evaluate(async code => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice({requiredFeatures: ['subgroups']});
      const errors = []; device.addEventListener('uncapturederror', e => errors.push(e.error.message));
      const module = device.createShaderModule({code});
      const messages = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error').map(m => m.message);
      const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'MainCS'}});
      const buffer = device.createBuffer({size: 6 * 64 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
      const read = device.createBuffer({size: buffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer}}]});
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(6); pass.end();
      encoder.copyBufferToBuffer(buffer, 0, read, 0, buffer.size); device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = [...new Uint32Array(read.getMappedRange())]; read.unmap(); device.destroy();
      return {values, errors, messages};
    }, code);
    assert.deepEqual(report.gpu.errors, []); assert.deepEqual(report.gpu.messages, []);
    let checked = 0;
    for (let group = 0; group < 6; group++) for (let index = 0; index < 64; index++) {
      const [rays, misses, , lane] = report.gpu.values.slice((group * 64 + index) * 4, (group * 64 + index + 1) * 4);
      const inactive = group === 4 && index >= 49 || group === 3 && lane % 2 === 0;
      const expected = inactive ? [0, 0] : group === 0 || group === 3 || group === 4 ? [1, 1] :
        group === 1 ? [2, 0] : group === 5 ? [8, 8] : [8, lane % 2 ? 8 : 0];
      assert.deepEqual([rays, misses], expected, `group=${group} index=${index} lane=${lane}`);
      checked++;
    }
    report.checkedLanes = checked;
    report.sources = [__filename, input, dxc, converter, spv, wgsl].map(audit);
    report.pass = true;
  } catch (error) {report.error = error.stack; process.exitCode = 1; console.error(error);}
  finally {
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    await browser?.close(); console.log(JSON.stringify({pass: report.pass, checkedLanes: report.checkedLanes}));
  }
})();
