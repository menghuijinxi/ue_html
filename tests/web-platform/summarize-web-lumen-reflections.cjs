'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const regions = [
  {name: 'mirror', x: 605, y: 225, width: 420, height: 235},
  {name: 'wall', x: 270, y: 250, width: 260, height: 160},
  {name: 'sink', x: 650, y: 555, width: 440, height: 140},
];
const limit = {meanAbsoluteError: 3, changedPixelFraction: 0.05, pixelErrorThreshold: 16};
function compare(first, second, region) {
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
  assert(region.x >= 0 && region.y >= 0 &&
    region.x + region.width <= first.width && region.y + region.height <= first.height);
  let sum = 0, changed = 0;
  for (let y = region.y; y < region.y + region.height; ++y)
    for (let x = region.x; x < region.x + region.width; ++x) {
      const offset = (y * first.width + x) * 4;
      let error = 0;
      for (let channel = 0; channel < 3; ++channel)
        error += Math.abs(first.data[offset + channel] - second.data[offset + channel]);
      sum += error;
      changed += error / 3 > limit.pixelErrorThreshold ? 1 : 0;
    }
  const count = region.width * region.height;
  const meanAbsoluteError = sum / (count * 3), changedPixelFraction = changed / count;
  return {...region, meanAbsoluteError, changedPixelFraction,
    pass: meanAbsoluteError <= limit.meanAbsoluteError && changedPixelFraction <= limit.changedPixelFraction};
}
function image(item) {
  assert.equal(audit(item.file).sha256, item.sha256, `Image changed: ${item.file}`);
  const png = PNG.sync.read(fs.readFileSync(item.file));
  assert.equal(png.width, 1280);
  assert.equal(png.height, 720);
  return png;
}
function web(file, names, camera) {
  const data = read(file);
  assert(data.pass);
  assert.deepEqual(data.settings, {});
  assert.deepEqual(data.errors, []);
  assert.deepEqual(data.cases.map(item => item.entry.name), names);
  assert.deepEqual(data.camera, camera);
  for (const item of data.cases) {
    assert.deepEqual(item.state.camera, Object.fromEntries(
      ['x', 'y', 'z', 'pitch', 'yaw'].map((key, index) => [key, camera[index]])));
    assert.deepEqual(item.state.errors, []);
    assert.deepEqual(item.state.losses, []);
    assert.equal(item.state.lighting.giMethod, 1);
    assert.equal(item.state.lighting.antiAliasing, 4);
    assert.equal(item.state.lighting.reflectionMethod, item.entry.name === 'no-reflections' ? 0 : 1);
    image(item.image);
  }
  return {file, data, audit: audit(file)};
}
function native(prefix, tracing, camera) {
  const capture = prefix + '-capture.json', launch = prefix + '-system.json', input = prefix + '-input.json';
  const data = read(capture), system = read(launch), settings = read(input);
  assert(data.completed && settings.preserveProjectSettings);
  assert.equal(system.exitCode, 0);
  assert.equal(system.lumenTracing, tracing);
  assert.equal(settings.width, 1280);
  assert.equal(settings.height, 720);
  assert.equal(data.runs.length, 1);
  const run = data.runs[0];
  assert.deepEqual(['x', 'y', 'z', 'pitch', 'yaw'].map(key => run.case[key]), camera);
  assert.equal(run.case.fov, 90);
  assert.equal(run.giMethod, 1);
  assert.equal(run.reflectionMethod, 1);
  assert.equal(run.antiAliasingMethod, 4);
  assert.equal(run.viewWidth, 1280);
  assert.equal(run.viewHeight, 720);
  assert.equal(data.variables['r.RayTracing'], 1);
  const overrides = system.arguments.filter(value => value.startsWith('-ini:'));
  const expected = tracing === 'Software' ? ['-ini:Engine:[SystemSettings]:r.Lumen.HardwareRayTracing=0'] :
    tracing === 'SoftwareReflections' ? ['-ini:Engine:[SystemSettings]:r.Lumen.Reflections.HardwareRayTracing=0'] : [];
  assert.deepEqual(overrides, expected);
  const log = fs.readFileSync(prefix + '.log', 'utf8');
  assert.match(log, /Using Highest Feature Level of D3D12: SM6/);
  assert.match(log, /r.Lumen.HardwareRayTracing.LightingMode:2/);
  if (tracing === 'Software') assert.match(log, /Set CVar \[\[r.Lumen.HardwareRayTracing:0\]\]/);
  if (tracing === 'SoftwareReflections')
    assert.match(log, /Set CVar \[\[r.Lumen.Reflections.HardwareRayTracing:0\]\]/);
  const sourceImage = audit(run.image);
  return {tracing, data, system, png: image(sourceImage), image: sourceImage,
    reports: [capture, launch, input, prefix + '.log'].map(audit)};
}

(async () => {
  const fixtureFile = path.join(__dirname, 'lumen-reflection-cases.json');
  const fixture = read(fixtureFile)[0];
  assert.equal(fixture.name, 'bathroom-mirror');
  const camera = ['x', 'y', 'z', 'pitch', 'yaw'].map(key => fixture[key]);
  const cycle = web(option('web'), ['baseline', 'no-reflections', 'restored-reflections'], camera);
  const repeated = web(option('repeat'), ['baseline'], camera);
  const software = native(option('native-software'), 'Software', camera);
  const project = native(option('native-project'), 'Project', camera);
  const reflections = native(option('native-reflections'), 'SoftwareReflections', camera);
  assert.equal(cycle.data.folder, repeated.data.folder);
  assert.deepEqual(software.data.variables, project.data.variables);
  assert.deepEqual(reflections.data.variables, project.data.variables);
  for (const item of [software, reflections]) {
    const normalize = args => args.filter(value => !value.startsWith('-ini:') &&
      !value.startsWith('-WebDistanceFieldComparison=') && !value.startsWith('-abslog='));
    assert.deepEqual(normalize(item.system.arguments), normalize(project.system.arguments));
  }
  const baseline = image(cycle.data.cases[0].image);
  const comparisons = {
    webToNativeSoftware: regions.map(region => compare(baseline, software.png, region)),
    webToNativeProject: regions.map(region => compare(baseline, project.png, region)),
    softwareReflectionsToNativeProject: regions.map(region => compare(reflections.png, project.png, region)),
    nativeSoftwareToSoftwareReflections: regions.map(region => compare(software.png, reflections.png, region)),
    webIndependentRepeat: compare(baseline, image(repeated.data.cases[0].image), regions[0]),
    webReflectionsDisabled: compare(baseline, image(cycle.data.cases[1].image), regions[0]),
    webReflectionsRestored: compare(baseline, image(cycle.data.cases[2].image), regions[0]),
  };
  const sameModeMatched = comparisons.webToNativeSoftware.every(region => region.pass);
  assert(comparisons.webIndependentRepeat.pass && comparisons.webReflectionsRestored.pass,
    'Mirror result must repeat and restore');
  assert(comparisons.webReflectionsDisabled.meanAbsoluteError > 10,
    'Reflection toggle must visibly affect the mirror');
  const desktopMirrorMatched = comparisons.webToNativeProject[0].pass;
  const output = path.resolve(option('output'));
  const comparisonFile = path.join(__dirname, 'results', path.basename(output, '.json') + '-comparison.png');
  const tiles = [
    {label: 'UE desktop - project / hardware', file: project.image.file},
    {label: 'UE desktop - software Lumen', file: software.image.file},
    {label: 'WebGPU - software Lumen', file: cycle.data.cases[0].image.file},
  ];
  const layers = [];
  for (const [index, tile] of tiles.entries()) {
    layers.push({input: await sharp(tile.file).extract({left: 576, top: 145, width: 480, height: 330})
      .resize(640, 440).toBuffer(), left: index * 640, top: 34});
    layers.push({input: Buffer.from(`<svg width="640" height="34"><text x="14" y="23" fill="white" font-family="Arial" font-size="18">${tile.label}</text></svg>`),
      left: index * 640, top: 0});
  }
  await sharp({create: {width: 1920, height: 474, channels: 4, background: '#202124'}})
    .composite(layers).png().toFile(comparisonFile);
  const report = {
    date: new Date().toISOString(), diagnosisPassed: sameModeMatched,
    desktopReflectionParityAccepted: desktopMirrorMatched, rendererFixApplied: false,
    scope: 'One fixed bathroom mirror, 1280x720, warmed TSR and automatic exposure. No general feature or visual-parity certification.',
    cause: sameModeMatched && !desktopMirrorMatched ?
      'The native software distance-field / Surface Cache path reproduces the blurred and incomplete mirror. The project hardware path retains reflected detail. This view demonstrates a tracing capability gap, not an accepted desktop-quality reflection implementation.' :
      'Inspect the regional comparisons before assigning a cause.',
    fixture: audit(fixtureFile), camera, limit, comparisons,
    web: {report: cycle.audit, cases: cycle.data.cases.map(item => ({
      name: item.entry.name, image: item.image, camera: item.state.camera,
      lighting: item.state.lighting, errors: item.state.errors, losses: item.state.losses,
    })), repeat: repeated.audit, package: cycle.data.folder,
    products: cycle.data.products, settingsOverrides: cycle.data.settings},
    native: [project, software, reflections].map(item => ({
      tracing: item.tracing, image: item.image, reports: item.reports,
      featureLevel: item.data.featureLevel, variables: item.data.variables,
      arguments: item.system.arguments,
    })),
    hybridObservation: 'Disabling hardware reflections while retaining hardware GI produced a near-black mirror. This hybrid is not a valid native software reference; its missing trace data or lighting is not diagnosed here.',
    comparisonImage: audit(comparisonFile),
    sources: [__filename, path.join(__dirname, 'capture-villa-distance-fields.ps1'),
      path.join(__dirname, 'probe-web-lumen-shadow-artifacts.cjs')].map(audit),
    remaining: [
      'The user-reported desktop mirror quality is still unmet; this diagnostic does not fix it.',
      'The global software switch changes both GI and reflections. SoftwareReflections changes only reflection tracing.',
      'The near-black hybrid result must not be interpreted as matching the Web software path.',
      'Native software agreement in this view does not exclude Web rendering defects elsewhere.',
      'The numeric limits are local comparison tolerances, not a substitute for reflected-object correctness.',
    ],
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({diagnosisPassed: report.diagnosisPassed,
    desktopReflectionParityAccepted: desktopMirrorMatched, output, comparisonFile, comparisons}));
  assert(sameModeMatched, 'Web software Lumen differs from the native software reference');
  if (process.argv.includes('--require-desktop-parity'))
    assert(desktopMirrorMatched, 'Desktop mirror parity is not met');
})().catch(error => {console.error(error); process.exitCode = 1;});
