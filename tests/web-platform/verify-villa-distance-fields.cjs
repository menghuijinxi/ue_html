const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {PNG} = require('pngjs');
const sharp = require('sharp');
const directory = path.join(__dirname, 'results');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = argument('report') || 'final-1080p';
assert(/^[a-z0-9-]+$/.test(id));
const prefix = path.join(directory, `villa-distance-fields-${id}`);
const read = file => {
  const bytes = fs.readFileSync(file);
  return JSON.parse(bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8')
    .replace(/^\uFEFF/, ''));
};
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, comparisons: [], inputs: []};

function compare(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let sum = 0, changed = 0, pixels = 0, aLuma = 0, bLuma = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; ++c) delta += Math.abs(a.data[i + c] - b.data[i + c]);
    sum += delta;
    changed += delta / 3 > 8 ? 1 : 0;
    aLuma += 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
    bLuma += 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
    ++pixels;
  }
  return {meanAbsoluteRGB: sum / (pixels * 3), changedFraction: changed / pixels,
    aDisplayLuma: aLuma / pixels, bDisplayLuma: bLuma / pixels, scale: 255};
}

(async () => {
  try {
    const capture = read(`${prefix}-capture.json`);
    const fixture = read(`${prefix}-input.json`);
    const csv = read(`${prefix}-csv.json`);
    const noResourcesFile = path.join(directory, 'villa-distance-fields-no-resources-1080p-capture.json');
    const noResources = read(noResourcesFile);
    assert(capture.completed && noResources.completed);
    assert.equal(capture.featureLevel, 3);
    assert.equal(capture.variables['r.RayTracing'], 0);
    assert.equal(capture.variables['r.GenerateMeshDistanceFields'], 1);
    assert.equal(noResources.variables['r.GenerateMeshDistanceFields'], 0);
    assert.equal(noResources.componentsWithDistanceFields, 0);
    assert.equal(capture.componentsWithDistanceFields, capture.meshComponents);
    assert(capture.meshComponents > 2000 && capture.meshes.filter(mesh => mesh.valid).length > 500);
    assert.equal(capture.lights.filter(light => light.distanceFieldShadows).length, 0);
    assert(capture.lights.some(light => light.class === 'SkyLightComponent' &&
      light.mobility === 2 && light.castShadows && light.intensity === 7));
    assert.equal(csv.capture.sha256, audit(`${prefix}-capture.json`).sha256);
    assert(csv.runs.every(run => audit(run.csv.file).sha256 === run.csv.sha256));
    const resourcePrefix = path.join(directory, 'villa-distance-fields-living-resource-1080p');
    const resourceCapture = read(`${resourcePrefix}-capture.json`);
    const resourceCSV = read(`${resourcePrefix}-csv.json`);
    const resourceLog = fs.readFileSync(`${resourcePrefix}.log`, 'utf8');
    assert(resourceCapture.completed);
    assert.equal(resourceCSV.capture.sha256, audit(`${resourcePrefix}-capture.json`).sha256);
    assert(resourceCSV.runs.every(run => audit(run.csv.file).sha256 === run.csv.sha256));
    assert(resourceCSV.runs.every(run => run.stats['DistanceField/AtlasMB'].median === 32),
      'Disabling the effect at runtime must not be mistaken for releasing the mesh atlas');
    const resources = [...resourceLog.matchAll(
      /RHIResources: Name: (.+?) - Type: (\w+) - Size: ([\d.]+) MB/g)]
      .map(match => ({name: match[1], type: match[2], allocatedMiB: Number(match[3])}));
    assert(resources.some(resource => resource.name === 'GlobalDistanceField.PageAtlas' &&
      resource.allocatedMiB === 16));
    assert(resources.some(resource => resource.name === 'DistanceFields.DistanceFieldBrickTexture' &&
      resource.allocatedMiB === 32));
    report.resourceSnapshot = {resources,
      note: 'Includes older pooled brick atlases and a font texture; not the total incremental DF memory cost.'};
    report.inputs = [`${prefix}-capture.json`, `${prefix}-input.json`, `${prefix}-csv.json`,
      `${prefix}.log`, noResourcesFile, `${resourcePrefix}-capture.json`,
      `${resourcePrefix}-csv.json`, `${resourcePrefix}.log`].map(audit);
    const names = [...new Set(capture.runs.map(run => run.case.name.split('-')[0]))];
    const gallery = {};
    for (const view of names) {
      gallery[view] = {};
      for (const exposure of ['fixed', 'auto']) {
        const runs = capture.runs.filter(run => run.case.name.startsWith(`${view}-${exposure}-`));
        assert.equal(runs.length, 5);
        const pixels = {};
        const byMode = {};
        gallery[view][exposure] = {};
        for (const run of runs) {
          const mode = run.case.name.split('-').at(-1);
          assert.equal(run.giMethod, 0);
          assert.equal(run.reflectionMethod, 0);
          assert.equal(run.screenPercentage, 100);
          assert.equal(run.viewWidth, fixture.width);
          assert.equal(run.viewHeight, fixture.height);
          assert(run.gpuMs.length > 30 && run.frameMs.length >= fixture.samples);
          for (const key of ['x', 'y', 'z', 'pitch', 'yaw', 'fov'])
            assert.equal(run.case[key], runs[0].case[key]);
          pixels[mode] = PNG.sync.read(fs.readFileSync(run.image));
          assert.equal(pixels[mode].width, fixture.width);
          assert.equal(pixels[mode].height, fixture.height);
          byMode[mode] = run;
          gallery[view][exposure][mode] = path.basename(run.image);
          report.inputs.push(audit(run.image));
        }
        const ao = compare(pixels.off, pixels.ao);
        const shadows = compare(pixels.off, pixels.shadows);
        const restored = compare(pixels.both, pixels.restore);
        const aoVersusBoth = compare(pixels.both, pixels.ao);
        assert(ao.meanAbsoluteRGB > 5, `${view}/${exposure}: DFAO must produce a visible change`);
        assert(shadows.meanAbsoluteRGB < 2, `${view}/${exposure}: DFS unexpectedly affects this scene`);
        assert(restored.meanAbsoluteRGB < 2, `${view}/${exposure}: restoration did not converge`);
        assert(aoVersusBoth.meanAbsoluteRGB < 2, `${view}/${exposure}: AO does not explain both`);
        if (exposure === 'fixed')
          for (const run of runs) assert(Math.abs(run.lastExposure - runs[0].lastExposure) < 0.0001);
        const stat = mode => csv.runs.find(run => run.name === byMode[mode].case.name).stats;
        assert(stat('ao')['GPU/SkyLightDiffuse']?.median > 0);
        assert(!stat('off')['GPU/SkyLightDiffuse']);
        report.comparisons.push({view, exposure, ao, shadows, restored, aoVersusBoth,
          exposureOn: byMode.both.lastExposure, exposureOff: byMode.off.lastExposure,
          gpuOnMs: stat('both').GPUTime, gpuOffMs: stat('off').GPUTime,
          skyLightPassMs: stat('ao')['GPU/SkyLightDiffuse'],
          meshDistanceFieldAtlasMiB: stat('ao')['DistanceField/AtlasMB']?.median});
      }
    }
    report.meshData = {
      components: capture.meshComponents,
      uniqueMeshes: capture.meshes.filter(mesh => mesh.valid).length,
      cpuResidentBytes: capture.meshes.reduce((sum, mesh) => sum + (mesh.cpuResidentBytes || 0), 0),
      alwaysLoadedBytes: capture.meshes.reduce((sum, mesh) => sum + (mesh.alwaysLoadedBytes || 0), 0),
      streamableBytes: capture.meshes.reduce((sum, mesh) => sum + (mesh.streamableBytes || 0), 0),
    };
    const panelWidth = 960, panelHeight = 540, labelHeight = 36;
    const panels = [];
    for (const [column, mode] of ['off', 'ao'].entries()) {
      const file = path.join(directory, gallery.living.auto[mode]);
      panels.push({input: await sharp(file).resize(panelWidth, panelHeight).toBuffer(),
        left: column * panelWidth, top: labelHeight});
      panels.push({input: Buffer.from(`<svg width="${panelWidth}" height="${labelHeight}">
        <rect width="100%" height="100%" fill="#202020"/>
        <text x="16" y="25" font-family="Arial" font-size="20" fill="white">
        ${mode === 'off' ? 'DFAO OFF' : 'DFAO ON'} / UE desktop / same camera / automatic exposure</text></svg>`),
        left: column * panelWidth, top: 0});
    }
    const sheet = path.join(directory, 'villa-distance-fields-comparison.png');
    await sharp({create: {width: panelWidth * 2, height: panelHeight + labelHeight,
      channels: 4, background: '#202020'}}).composite(panels).png().toFile(sheet);
    report.contactSheet = audit(sheet);
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UE 距离场对照</title><style>
*{box-sizing:border-box}body{margin:0;background:#171717;color:#eee;font:14px system-ui}
header{display:flex;flex-wrap:wrap;align-items:center;gap:16px;padding:12px 20px}
label{display:flex;align-items:center;gap:8px}select{background:#303030;color:#fff;padding:6px;border:1px solid #666}
main{position:relative;width:100%;aspect-ratio:16/9}img{position:absolute;width:100%;height:100%;object-fit:contain}
#on{clip-path:inset(0 0 0 50%)}#line{position:absolute;left:50%;top:0;bottom:0;width:2px;background:#fff}
footer{display:flex;gap:20px;align-items:center;padding:12px 20px}input[type=range]{flex:1;min-width:100px}
</style><header><strong>UE 桌面距离场对照</strong>
<label>机位 <select id="view">${names.map(view => `<option value="${view}" ${view === 'living' ? 'selected' : ''}>${({living:'客厅',interior:'室内',kitchen:'厨房'})[view]}</option>`).join('')}</select></label>
<label>曝光 <select id="exposure"><option value="auto">原自动曝光</option><option value="fixed">固定 EV100 ${fixture.cases[0].ev100}</option></select></label>
<label>对照 <select id="mode"><option value="ao">仅 DFAO</option><option value="shadows">仅距离场阴影</option><option value="both">全部开启</option><option value="restore">恢复全部开启</option></select></label>
</header><main><img id="off" alt="距离场效果关闭"><img id="on" alt="距离场对照"><div id="line"></div></main>
<footer><span>关闭</span><input id="split" aria-label="画面对比位置" type="range" min="0" max="100" value="50"><span id="modeName">仅 DFAO</span></footer>
<script>const gallery=${JSON.stringify(gallery)};
const view=document.querySelector('#view'),exposure=document.querySelector('#exposure'),mode=document.querySelector('#mode');
const off=document.querySelector('#off'),on=document.querySelector('#on'),split=document.querySelector('#split');
function update(){const images=gallery[view.value][exposure.value];off.src=images.off;on.src=images[mode.value];document.querySelector('#modeName').textContent=mode.selectedOptions[0].textContent}
[view,exposure,mode].forEach(element=>element.addEventListener('change',update));
split.addEventListener('input',()=>{on.style.clipPath='inset(0 0 0 '+split.value+'%)';document.querySelector('#line').style.left=split.value+'%'});update();
</script></html>`;
    const page = path.join(directory, 'villa-distance-fields-comparison.html');
    fs.writeFileSync(page, html);
    report.viewer = audit(page);
    report.boundary = 'Native D3D12 SM5; GI/reflection methods, hardware RT and VSM disabled. ' +
      'Original map materials, lights and PP assets unchanged. ' +
      'Display-referred image deltas are not physical luminance. SkyLightDiffuse includes DFAO work; ' +
      'total GPU time is noisy and native timings do not predict WebGPU. The 32 MiB mesh atlas is not total DF GPU memory. ' +
      'Runtime effect toggles retain distance-field allocations; the separate startup-off capture checks resource removal. ' +
      'Static cameras do not measure movement, streaming churn or long-term performance. No refrigerator color investigation.';
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(`${prefix}-verified.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, comparisons: report.comparisons,
      contactSheet: report.contactSheet, viewer: report.viewer, failure: report.failure}, null, 2));
  }
})();
