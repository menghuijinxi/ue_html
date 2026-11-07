'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const directory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'results/nanite-asset');
const channels = process.argv[3] ? process.argv[3].split(',') : ['chrome', 'msedge'];
assert(channels.length > 0 && new Set(channels).size === channels.length &&
  channels.every(channel => ['chrome', 'msedge'].includes(channel)), 'Expected chrome and/or msedge');
const read = name => fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, '');
const asset = JSON.parse(read('asset.json'));
const stages = Object.fromEntries(['independent', 'dependent', 'decode'].map(name => [name, {
  code: read(`${name}.wgsl`), metadata: JSON.parse(read(`${name}.json`)),
}]));
const binaries = Object.fromEntries(['pages', 'install', 'source-triangles'].map(name =>
  [name, [...fs.readFileSync(path.join(directory, `${name}.bin`))]]));
assert(['fully-resident-editor-export', 'fully-resident-cooked-resource-roundtrip'].includes(asset.scope));
assert.equal(asset.webCookEnabled, asset.scope === 'fully-resident-cooked-resource-roundtrip');
if (asset.webCookEnabled) {
  const cooked = JSON.parse(read('cook-roundtrip.json'));
  assert(cooked.pass && cooked.retained && !cooked.runtimeNaniteEnabled);
  assert.equal(cooked.clusters, asset.numClusters);
}
assert(asset.pages.every(page => page.dependencyCount === 0));
assert(asset.pages.some(page => page.vertexReferences > 0), 'Fixture must exercise referenced vertices');
for (const [name, stage] of Object.entries(stages)) {
  assert.equal(stage.metadata.bindingContractVerified, true);
  if (name !== 'decode') {
    assert.match(stage.code, /enable subgroups;/);
    assert.match(stage.code, /diagnostic\(off, subgroup_uniformity\)/);
    assert.equal(stage.metadata.subgroupUniformityPolicy, 'nanite-active-lanes');
  }
}
const report = {date: new Date().toISOString(), pass: false, asset, requestedChannels: channels, browsers: [],
  boundary: `Real UE Nanite root pages transcoded and decoded in WebGPU. Source: ${asset.scope}; no packaged level, streaming, hierarchy traversal or material pass.`,
  sources: [__filename, ...Object.keys(stages).flatMap(name => ['wgsl', 'json', 'webshader']
    .map(ext => path.join(directory, `${name}.${ext}`))), ...['asset.json', 'pages.bin', 'install.bin', 'source-triangles.bin']
    .map(file => path.join(directory, file)),
  ...(asset.webCookEnabled ? ['cook-roundtrip.json', 'resources.cooked.bin'].map(file => path.join(directory, file)) : []),
  path.join(__dirname, '../../reference-engine/Engine/Shaders/Private/Nanite/NaniteTranscode.usf'),
  path.join(__dirname, '../../reference-engine/Engine/Shaders/Private/Nanite/NaniteDataDecode.ush'),
  path.join(__dirname, '../ue-shader-host/Shaders/Private/WebNaniteDecodeProbe.usf')].map(audit)};

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Nanite asset verification</title><style>body{margin:0;background:#eee}canvas{display:block;width:100%;height:auto;aspect-ratio:1;max-width:512px}</style><canvas width="512" height="512"></canvas>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const channel of channels) {
      let browser;
      try {
        browser = await chromium.launch({channel, headless: true});
        const page = await browser.newPage({viewport: {width: 800, height: 600}});
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const result = await page.evaluate(async ({stages, asset, binaries}) => {
          const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
          if (!adapter?.features.has('subgroups')) throw Error('subgroups unavailable');
          const minimum = adapter.info.subgroupMinSize;
          if (!(minimum >= asset.transcodeGroupSize))
            throw Error(`Transcode group ${asset.transcodeGroupSize} exceeds minimum subgroup size ${minimum}`);
          const device = await adapter.requestDevice({requiredFeatures: ['subgroups']});
          const errors = [];
          device.addEventListener('uncapturederror', event => errors.push(event.error.message));
          const check = (value, message) => { if (!value) throw Error(message); };
          let completed = false;
          try {
            const pipelines = {};
            for (const [name, stage] of Object.entries(stages)) {
              const module = device.createShaderModule({code: stage.code});
              const messages = (await module.getCompilationInfo()).messages;
              check(!messages.some(m => m.type === 'error'), `${name}: ${messages.map(m => m.message).join('\n')}`);
              try {
                pipelines[name] = await device.createComputePipelineAsync({layout: 'auto',
                  compute: {module, entryPoint: stage.metadata.webEntry}});
              } catch (error) {
                throw Error(`${name} pipeline: ${error.message}`);
              }
            }
            const source = new Float32Array(new Uint8Array(binaries['source-triangles']).buffer);
            const scale = 2 ** asset.positionPrecision;
            const vertexKey = v => [...v].map(x => Math.round(x * scale)).join(',');
            const triangleKey = vertices => {
              const keys = vertices.map(vertexKey);
              return [0, 1, 2].map(i => [keys[i], keys[(i + 1) % 3], keys[(i + 2) % 3]].join(';')).sort()[0];
            };
            const expected = new Map();
            for (let i = 0; i < source.length; i += 9) {
              const key = triangleKey([source.slice(i, i + 3), source.slice(i + 3, i + 6), source.slice(i + 6, i + 9)]);
              expected.set(key, (expected.get(key) || 0) + 1);
            }
            const canvas = document.querySelector('canvas');
            const context = canvas.getContext('webgpu');
            const format = navigator.gpu.getPreferredCanvasFormat();
            context.configure({device, format, alphaMode: 'opaque'});
            // Display only the full-detail leaf triangles decoded by the UE shader.
            const renderModule = device.createShaderModule({code: `
              @group(0) @binding(0) var<storage, read> clusters: array<vec4u>;
              @group(0) @binding(1) var<storage, read> triangles: array<vec4f>;
              struct Vertex { @builtin(position) position: vec4f, @location(0) world: vec3f };
              @vertex fn vs(@builtin(vertex_index) index: u32) -> Vertex {
                let cluster = clusters[index / 384u];
                var o: Vertex;
                if ((cluster.z & 4u) == 0u || (index / 3u) % 128u >= cluster.y) {
                  o.position = vec4f(2, 2, 2, 1); o.world = vec3f(0); return o;
                }
                let p = triangles[index].xyz;
                o.world = p;
                o.position = vec4f(p.x / 70.0, p.z / 70.0, 0.5 - p.y / 140.0, 1);
                return o;
              }
              @fragment fn fs(v: Vertex) -> @location(0) vec4f {
                let n = normalize(cross(dpdx(v.world), dpdy(v.world)));
                let light = 0.25 + 0.75 * abs(dot(n, normalize(vec3f(0.4, 0.8, 0.6))));
                return vec4f(vec3f(0.08, 0.60, 0.48) * light, 1);
              }`});
            const renderPipeline = await device.createRenderPipelineAsync({layout: 'auto',
              vertex: {module: renderModule, entryPoint: 'vs'},
              fragment: {module: renderModule, entryPoint: 'fs', targets: [{format}]},
              primitive: {topology: 'triangle-list'},
              depthStencil: {format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less'}});
            const cases = [];
            let firstPageBytes, firstTriangleBytes;
            for (const prefix of [0, 256]) {
              const owned = [];
              const buffer = (data, usage) => {
                const result = device.createBuffer({size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST});
                device.queue.writeBuffer(result, 0, data); owned.push(result); return result;
              };
              const guarded = (bytes, data) => {
                const initial = new Uint8Array(prefix + bytes + 256).fill(0xa5);
                initial.fill(0, prefix, prefix + bytes);
                if (data) initial.set(data, prefix);
                const gpu = buffer(initial, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
                return {initial, gpu, bytes, binding: {buffer: gpu, offset: prefix, size: bytes}};
              };
              const disk = guarded(binaries.pages.length, binaries.pages);
              const install = guarded(binaries.install.length, binaries.install);
              const output = guarded(asset.gpuPageBytes * asset.numRootPages);
              const independentOutput = guarded(output.bytes);
              const clusters = guarded(asset.numClusters * 16);
              const triangles = guarded(asset.numClusters * 128 * 3 * 16);
              const dependencies = buffer(new Uint32Array([0]), GPUBufferUsage.STORAGE);
              const resources = {SrcPageBuffer: disk.binding, ClusterInstallInfoBuffer: install.binding,
                DstPageBuffer: output.binding, PageDependenciesBuffer: {buffer: dependencies},
                ClusterPageData: output.binding, InstallInfo: install.binding,
                DecodedClusters: clusters.binding, DecodedTriangles: triangles.binding};
              const encode = (encoder, name, start, count) => {
                const metadata = stages[name].metadata;
                const globals = metadata.spirvBindings.find(b => b.name === '$Globals');
                const values = new Uint32Array(Math.ceil(globals.size / 16) * 4);
                const parameters = {PageConstants: [0, 0, 0, 0], StartClusterIndex: [start],
                  NumClusters: [count], ZeroUniform: [0], ClusterCount: [asset.numClusters]};
                for (const member of globals.members) {
                  check(parameters[member.name], `Unknown uniform ${member.name}`);
                  values.set(parameters[member.name], member.offset / 4);
                }
                const bindings = {...resources, '$Globals': {buffer: buffer(values, GPUBufferUsage.UNIFORM)}};
                const pass = encoder.beginComputePass(), pipeline = pipelines[name];
                pass.setPipeline(pipeline);
                for (let group = 0; group <= Math.max(...metadata.spirvBindings.map(b => b.group)); ++group) {
                  const entries = metadata.spirvBindings.filter(b => b.group === group).map(b => {
                    check(bindings[b.name], `Unknown binding ${b.name}`);
                    return {binding: b.binding, resource: bindings[b.name]};
                  });
                  pass.setBindGroup(group, device.createBindGroup({layout: pipeline.getBindGroupLayout(group), entries}));
                }
                pass.dispatchWorkgroups(count + 2); pass.end();
              };
              const encoder = device.createCommandEncoder();
              // Split batches exercise StartClusterIndex and out-of-range workgroups.
              const split = prefix ? Math.floor(asset.numClusters / 2) : asset.numClusters;
              encode(encoder, 'independent', 0, split);
              if (split < asset.numClusters) encode(encoder, 'independent', split, asset.numClusters - split);
              encoder.copyBufferToBuffer(output.gpu, prefix, independentOutput.gpu, prefix, output.bytes);
              encode(encoder, 'dependent', 0, asset.numClusters);
              encode(encoder, 'decode', 0, asset.numClusters);
              const color = device.createTexture({size: [512, 512], format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
              const depth = device.createTexture({size: [512, 512], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT});
              const render = target => {
                const pass = encoder.beginRenderPass({colorAttachments: [{view: target.createView(),
                  loadOp: 'clear', storeOp: 'store', clearValue: [0.93, 0.93, 0.93, 1]}],
                depthStencilAttachment: {view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1}});
                pass.setPipeline(renderPipeline);
                pass.setBindGroup(0, device.createBindGroup({layout: renderPipeline.getBindGroupLayout(0),
                  entries: [{binding: 0, resource: clusters.binding}, {binding: 1, resource: triangles.binding}]}));
                pass.draw(asset.numClusters * 384); pass.end();
              };
              render(color); render(context.getCurrentTexture());
              const buffers = [disk, install, output, clusters, triangles, independentOutput];
              const dataBytes = buffers.reduce((sum, item) => sum + item.initial.byteLength, 0);
              const readback = device.createBuffer({size: dataBytes + 512 * 512 * 4,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
              let offset = 0;
              for (const item of buffers) {
                item.offset = offset; encoder.copyBufferToBuffer(item.gpu, 0, readback, offset, item.initial.byteLength);
                offset += item.initial.byteLength;
              }
              encoder.copyTextureToBuffer({texture: color}, {buffer: readback, offset, bytesPerRow: 2048}, [512, 512]);
              device.queue.submit([encoder.finish()]);
              await readback.mapAsync(GPUMapMode.READ);
              const bytes = new Uint8Array(readback.getMappedRange());
              for (const item of buffers) {
                const data = bytes.slice(item.offset, item.offset + item.initial.length);
                for (let i = 0; i < data.length; ++i)
                  if (i < prefix || i >= prefix + item.bytes || item === disk || item === install)
                    check(data[i] === item.initial[i], `Buffer guard/source mismatch at ${i}`);
                item.data = data.slice(prefix, prefix + item.bytes);
              }
              const decoded = new Float32Array(triangles.data.buffer), stats = new Uint32Array(clusters.data.buffer);
              const remaining = new Map(expected);
              let leafClusters = 0, leafTriangles = 0, totalTriangles = 0;
              for (let c = 0; c < asset.numClusters; ++c) {
                const [vertices, count, flags, precision] = stats.slice(c * 4, c * 4 + 4);
                check(vertices > 0 && vertices <= 256 && count > 0 && count <= 128, `Invalid cluster ${c}: ${vertices}/${count}`);
                check(precision === asset.positionPrecision, `Position precision differs in cluster ${c}`);
                totalTriangles += count;
                if (flags & 4) ++leafClusters;
                for (let t = 0; t < count; ++t) {
                  const positions = [];
                  for (let corner = 0; corner < 3; ++corner) {
                    const index = ((c * 128 + t) * 3 + corner) * 4;
                    const position = decoded.slice(index, index + 3), vertex = decoded[index + 3];
                    check(Number.isInteger(vertex) && vertex >= 0 && vertex < vertices, `Cluster ${c} triangle ${t}: invalid index ${vertex}`);
                    check([...position].every(Number.isFinite), 'Nonfinite decoded position');
                    positions.push(position);
                  }
                  if (flags & 4) {
                    const key = triangleKey(positions), left = remaining.get(key) || 0;
                    check(left > 0, `Leaf triangle mismatch: cluster ${c}, triangle ${t}, ${key}`);
                    remaining.set(key, left - 1); ++leafTriangles;
                  }
                }
              }
              check(leafTriangles === asset.sourceTriangles && [...remaining.values()].every(n => n === 0),
                `Missing leaf triangles: ${leafTriangles}/${asset.sourceTriangles}`);
              const referencedBytes = output.data.reduce((sum, byte, i) =>
                sum + (byte !== independentOutput.data[i] ? 1 : 0), 0);
              check(referencedBytes > 0, 'Dependent pass must restore referenced vertex bytes');
              if (firstPageBytes) {
                check(output.data.every((b, i) => b === firstPageBytes[i]), 'Split transcode differs');
                check(triangles.data.every((b, i) => b === firstTriangleBytes[i]), 'Split decode differs');
              } else {
                firstPageBytes = output.data; firstTriangleBytes = triangles.data;
              }
              const pixels = bytes.subarray(dataBytes);
              let covered = 0;
              for (let i = 0; i < pixels.length; i += 4)
                if (pixels[i + 1] < 220) ++covered;
              check(covered > 90000 && covered < 120000, `Unexpected sphere coverage ${covered}`);
              cases.push({prefix, split, leafClusters, leafTriangles, totalTriangles, coveredPixels: covered,
                referencedBytes, windingPreserved: true, guardsPreserved: true, pass: true});
              readback.unmap(); readback.destroy(); color.destroy(); depth.destroy();
              owned.forEach(b => b.destroy());
            }
            await device.queue.onSubmittedWorkDone();
            check(errors.length === 0, errors.join('\n'));
            window.finishNaniteProbe = () => device.destroy();
            completed = true;
            return {pass: true, adapter: {vendor: adapter.info.vendor, architecture: adapter.info.architecture,
              subgroupMinSize: minimum, subgroupMaxSize: adapter.info.subgroupMaxSize,
              isFallbackAdapter: adapter.info.isFallbackAdapter},
            cases, pageBytes: [...firstPageBytes], errors};
          } finally {
            if (!completed) device.destroy();
          }
        }, {stages, asset, binaries});
        result.gpuPageSha256 = crypto.createHash('sha256').update(Buffer.from(result.pageBytes)).digest('hex');
        delete result.pageBytes;
        await page.screenshot({path: path.join(directory, `${channel}-desktop.png`)});
        await page.setViewportSize({width: 390, height: 620});
        await page.screenshot({path: path.join(directory, `${channel}-mobile.png`)});
        await page.evaluate(() => window.finishNaniteProbe());
        report.browsers.push({channel, version: browser.version(), ...result});
        console.log(JSON.stringify({channel, ...result}));
      } catch (error) {
        report.browsers.push({channel, pass: false, error: String(error.stack)});
        throw error;
      } finally {
        await browser?.close();
      }
    }
    for (const browser of report.browsers)
      assert.equal(report.browsers[0].gpuPageSha256, browser.gpuPageSha256);
    report.pass = true;
  } finally {
    server.close();
    fs.writeFileSync(path.join(directory, 'browser-results.json'), JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
