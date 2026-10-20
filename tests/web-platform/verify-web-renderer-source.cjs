const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const repo = path.join(root, 'reference-engine');
const engine = path.join(process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine');
const output = path.join(__dirname, 'build/ue-web-renderer-source');
const resultFile = path.join(__dirname, 'results/ue-web-renderer-source-results.json');
const relativeSource = 'Engine/Source/Runtime/Renderer/Private/FXRenderingUtils.cpp';
const sourceFile = path.join(repo, relativeSource);
const baseCommit = '396c9f059903aed5fec78ecd3d437a40c6415368';
const shared = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Intermediate/Build/Win64/x64/UnrealEditor/Development/WebGPURHI/WebGPURHI.Shared.rsp');
const toolchain = 'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = {pass: false, date: '2026-10-15', baseCommit, sourceFile,
  fullSourceEngineBuildCompleted: false, modifiedRendererLinkedIntoHost: false,
  modifiedRendererStartupTested: false, wasmCompilationTested: false};
function run(executable, args, log) {
  const result = cp.spawnSync(executable, args, {cwd: path.join(engine, 'Source'),
    encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024});
  fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''));
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${path.basename(executable)} failed; see ${log}\n${((result.stdout || '') + (result.stderr || '')).slice(-5000)}`);
  return result.stdout;
}
try {
  fs.mkdirSync(output, {recursive: true});
  const original = cp.execFileSync('git', ['-C', repo, 'show', `${baseCommit}:${relativeSource}`]);
  const baseline = path.join(output, 'FXRenderingUtils-baseline.cpp');
  fs.writeFileSync(baseline, original);
  const source = fs.readFileSync(sourceFile);
  Object.assign(report, {sourceSha256: sha(source), baseSourceSha256: sha(original),
    installedHeaderEngine: engine, compiler: path.join(toolchain, 'cl.exe')});
  const args = fs.readFileSync(shared, 'utf8').trim().split(/\r?\n/);
  const includes = [
    'Runtime/Renderer/Private', 'Runtime/Renderer/Public', 'Runtime/Engine/Public', 'Runtime/Engine/Classes',
    path.join(engine, 'Shaders/Private'),
    path.join(engine, 'Shaders/Shared'),
    '../Intermediate/Build/Win64/x64/UnrealEditor/Development/UnrealEd',
  ];
  // Installed Renderer ships definitions and headers, but no compiler response file.
  // Module header roots supplement the existing UBT compiler environment.
  for (const entry of fs.readdirSync(path.join(engine, 'Source'), {recursive: true, withFileTypes: true})) {
    if (entry.isDirectory() && ['Public', 'Classes', 'Internal'].includes(entry.name) &&
        /[\\/]Source[\\/](?:Runtime|Developer|Editor)[\\/]/.test(entry.parentPath))
      includes.push(path.join(entry.parentPath, entry.name));
  }
  const generated = path.join(engine, 'Intermediate/Build/Win64/UnrealEditor/Inc');
  for (const module of fs.readdirSync(generated)) {
    for (const suffix of ['UHT', 'VerseVMBytecode']) {
      const dir = path.join(generated, module, suffix);
      if (fs.existsSync(dir)) includes.push(dir);
    }
  }
  for (const dir of new Set(includes)) args.push(`/I "${dir}"`);
  const definitions = path.join(engine, 'Intermediate/Build/Win64/x64/UnrealEditor/Development/Renderer/Definitions.Renderer.h');
  args.push(`/FI"${definitions}"`, '/TP', '/GR-', '/std:c++20', '/wd5054');
  report.rendererDefinitionsSha256 = sha(fs.readFileSync(definitions));
  report.ubtSharedResponseSha256 = sha(fs.readFileSync(shared));
  const variants = [
    {name: 'baseline-desktop', source: baseline, flags: []},
    {name: 'patched-desktop', source: sourceFile, flags: []},
    {name: 'patched-web', source: sourceFile, flags: ['/DPLATFORM_WEB=1']},
  ];
  for (const variant of variants) {
    const preprocessed = path.join(output, `${variant.name}.i`);
    const response = path.join(output, `${variant.name}-preprocess.rsp`);
    const command = [...args, ...variant.flags, `"${variant.source}"`, '/P', '/EP', `/Fi"${preprocessed}"`];
    fs.writeFileSync(response, command.join('\n'));
    run(report.compiler, [`@${response}`], path.join(output, `${variant.name}-preprocess.log`));
    variant.text = fs.readFileSync(preprocessed, 'utf8');
    variant.preprocessedFile = preprocessed;
  }
  const normalize = text => {
    for (const name of [baseline, sourceFile]) text = text.replaceAll(JSON.stringify(name), '"<translation-unit>"');
    return text.replace(/"<translation-unit>"\s*,\s*\d+/g, '"<translation-unit>", 0')
      .replace(/\s+/g, ' ').trim();
  };
  assert.equal(sha(normalize(variants[0].text)), sha(normalize(variants[1].text)),
    'Non-Web preprocessed code must match the original Renderer translation unit');
  const desktop = variants[1].text;
  const web = variants[2].text;
  assert(desktop.includes('class FDFDummyByteAddress') && desktop.includes('GDFDummyByteAddress.PooledBuffer'));
  assert(!web.includes('FDFDummyByteAddress') && !web.includes('GDFDummyByteAddress'));
  assert(web.includes('Web renderer does not support binding mesh distance-field object parameters.') &&
    web.includes('Web renderer does not support binding mesh distance-field atlas parameters.'));
  report.nonWebPreprocessedCodeUnchangedExceptDiagnosticLocations = true;
  report.webDistanceFieldInitializationAndConsumerExcluded = true;
  report.compiledVariants = [];
  for (const variant of variants.slice(1)) {
    const object = path.join(output, `${variant.name}.obj`);
    const response = path.join(output, `${variant.name}-compile.rsp`);
    fs.writeFileSync(response, [...args, ...variant.flags, `"${variant.source}"`, `/Fo"${object}"`].join('\n'));
    run(report.compiler, [`@${response}`], path.join(output, `${variant.name}-compile.log`));
    const symbolsFile = path.join(output, `${variant.name}-symbols.log`);
    const symbols = run(path.join(toolchain, 'dumpbin.exe'), ['/symbols', object], symbolsFile);
    const desktopVariant = variant.name === 'patched-desktop';
    for (const name of ['GDFDummyByteAddress', 'FDFDummyByteAddress',
      '?SetupObjectBufferParameters@DistanceField@@', '?SetupAtlasParameters@DistanceField@@'])
      assert.equal(symbols.includes(name), desktopVariant, `${variant.name}: unexpected symbol ${name}`);
    for (const name of ['HasDataToBind', 'SetupObjectBufferParameters', 'SetupAtlasParameters'])
      assert(symbols.includes(`?${name}@DistanceFields@FXRenderingUtils@UE@@`));
    report.compiledVariants.push({name: variant.name, object, objectSha256: sha(fs.readFileSync(object)),
      distanceFieldDummySymbolsPresent: desktopVariant,
      distanceFieldBindingDependenciesPresent: desktopVariant, publicDistanceFieldEntryPointsPreserved: true, symbolsFile});
  }
  report.pass = true;
  report.boundary = 'The complete modified FXRenderingUtils.cpp compiles to Win64 objects with installed UE 5.8.0 headers under normal and PLATFORM_WEB=1 preprocessing. Desktop preprocessed code matches the target 5.8.3 original after normalizing whitespace and diagnostic filename/line coordinates; the Web object excludes the dummy class/global and binding consumers. This is conditional-source validation, not a linked Renderer, an engine startup, or Emscripten/WASM compilation. Web UBT must define PLATFORM_WEB=1; active distance-field effects remain unsupported.';
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
