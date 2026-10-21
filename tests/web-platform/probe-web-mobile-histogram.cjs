const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const results = path.join(__dirname, 'results');
const report = {date: new Date().toISOString(), pass: false, browserRuns: [], source: audit(__filename)};

(async () => {
  let browser;
  try {
    const cookFile = path.join(results, 'web-engine-webgpu-es31-default-cook-results.json');
    const cook = read(cookFile);
    assert(cook.pass);
    report.cook = audit(cookFile);
    const explicit = process.argv.find(arg => arg.startsWith('--job='))?.slice(6);
    let job = explicit;
    if (!job) {
      const cooks = path.dirname(cook.output);
      for (const directory of fs.readdirSync(cooks).sort().reverse()) {
        const conversions = path.join(cooks, directory, 'ShaderConversion');
        if (!fs.existsSync(conversions)) continue;
        for (const name of fs.readdirSync(conversions)) {
          const input = path.join(conversions, name, 'input.json');
          if (!fs.existsSync(input) || !fs.existsSync(path.join(conversions, name, 'output.wgsl'))) continue;
          if (read(input).shaderName === 'TMobileHistogramCS< true >') {
            job = path.dirname(input);
            break;
          }
        }
        if (job) break;
      }
    }
    assert(job, 'A cooked UE mobile histogram shader is required');
    const input = path.join(job, 'input.json'), wgsl = path.join(job, 'output.wgsl');
    const shader = read(input);
    assert.equal(shader.shaderName, 'TMobileHistogramCS< true >');
    report.shader = {input: audit(input), wgsl: audit(wgsl)};
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:8765/histogram-validation', route =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Histogram validation</title>'}));
      await page.goto('http://127.0.0.1:8765/histogram-validation');
      const result = await page.evaluate(async ({metadata, code}) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw Error('WebGPU adapter unavailable');
        const device = await adapter.requestDevice();
        const errors = [], checks = [];
        device.addEventListener('uncapturederror', event => errors.push(event.error.message));
        const module = device.createShaderModule({code});
        const pipeline = await device.createComputePipelineAsync({
          layout: 'auto', compute: {module, entryPoint: metadata.webEntry}
        });
        for (const [level, half] of [[0, 0], [0.25, 0x3400], [0.5, 0x3800], [0.75, 0x3a00], [1, 0x3c00]]) {
          const resources = [];
          const histogram = device.createBuffer({size: 256,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          const readback = device.createBuffer({size: 256,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          resources.push(histogram, readback);
          const groups = new Map();
          for (const binding of metadata.spirvBindings) {
            let resource;
            if (binding.descriptorType === 6) {
              const values = new Float32Array(binding.size / 4);
              for (const member of binding.members) {
                const fixture = {
                  EyeAdaptation_BlackHistogramBucketInfluence: [1],
                  InputTextureSizeInv: [1 / 32, 1 / 32],
                  SourceSizeAndInvSize: [32, 32, 1 / 32, 1 / 32]
                }[member.name];
                if (!fixture) throw Error(`Uncovered uniform ${member.name}`);
                values.set(fixture, member.offset / 4);
              }
              const buffer = device.createBuffer({size: values.byteLength,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
              device.queue.writeBuffer(buffer, 0, values);
              resources.push(buffer);
              resource = {buffer};
            } else if (binding.name === 'RWHistogramBuffer') {
              resource = {buffer: histogram};
            } else if (binding.descriptorType === 2) {
              if (!['InputTexture', 'EyeAdaptation_MeterMaskTexture'].includes(binding.name))
                throw Error(`Uncovered texture ${binding.name}`);
              const size = binding.name === 'InputTexture' ? 32 : 1;
              const data = new Uint16Array(size * size * 4).fill(size === 32 ? half : 0x3c00);
              const texture = device.createTexture({size: [size, size], format: 'rgba16float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
              device.queue.writeTexture({texture}, data, {bytesPerRow: size * 8}, [size, size]);
              resources.push(texture);
              resource = texture.createView();
            } else if (binding.descriptorType === 0) {
              resource = device.createSampler({minFilter: 'linear', magFilter: 'linear'});
            } else throw Error(`Uncovered binding ${binding.name}`);
            if (!groups.has(binding.group)) groups.set(binding.group, []);
            groups.get(binding.group).push({binding: binding.binding, resource});
          }
          const encoder = device.createCommandEncoder();
          encoder.clearBuffer(histogram);
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          for (const [group, entries] of groups)
            pass.setBindGroup(group, device.createBindGroup({layout: pipeline.getBindGroupLayout(group), entries}));
          pass.dispatchWorkgroups(1);
          pass.end();
          encoder.copyBufferToBuffer(histogram, 0, readback, 0, 256);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const actual = Array.from(new Uint32Array(readback.getMappedRange()));
          const expected = Array(64).fill(0);
          const bucket = level * 63, lower = Math.floor(bucket), fraction = bucket - lower;
          expected[lower] += Math.floor((1 - fraction) * 100000);
          expected[Math.min(lower + 1, 63)] += Math.floor(fraction * 100000);
          const mismatches = actual.flatMap((value, bin) =>
            Math.abs(value - expected[bin]) > 2 ? [{bin, expected: expected[bin], actual: value}] : []);
          checks.push({level, pass: !mismatches.length, totalWeight: actual.reduce((a, b) => a + b, 0), mismatches});
          readback.unmap();
          for (const resource of resources) resource.destroy();
        }
        await device.queue.onSubmittedWorkDone();
        device.destroy();
        return {pass: !errors.length && checks.every(check => check.pass), errors, checks};
      }, {metadata: shader.metadata, code: fs.readFileSync(wgsl, 'utf8')});
      report.browserRuns.push({browser: name, ...result});
      await browser.close();
      browser = null;
    }
    report.pass = report.browserRuns.length === 2 && report.browserRuns.every(run => run.pass);
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-mobile-histogram-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
