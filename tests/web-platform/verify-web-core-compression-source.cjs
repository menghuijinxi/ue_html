const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const repo = path.join(root, 'reference-engine');
const engine = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const out = path.join(__dirname, 'build/web-core-compression-source');
const base = '396c9f059903aed5fec78ecd3d437a40c6415368';
const msvc = 'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64';
const sharedRoot = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Intermediate/Build/Win64/x64/UnrealEditor/Development/WebGPURHI');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {pass: false, date: '2026-10-15', baseCommit: base, files: [],
  wasmCompilationVerified: false, patchedCoreRuntimeTested: false};
function run(exe, args, log) {
  const result = cp.spawnSync(exe, args, {cwd: path.join(engine, 'Source'), encoding: 'utf8',
    timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true});
  fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''));
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${log}\n${((result.stdout || '') + (result.stderr || '')).slice(-4000)}`);
  return result.stdout;
}
try {
  fs.mkdirSync(out, {recursive: true});
  const definitionsSource = path.join(sharedRoot, 'Definitions.h');
  const definitions = path.join(out, 'Definitions.CoreSourceCheck.h');
  const definitionsText = fs.readFileSync(definitionsSource, 'utf8');
  assert(definitionsText.includes('#define CORE_API DLLIMPORT'));
  fs.writeFileSync(definitions, definitionsText.replace('#define CORE_API DLLIMPORT', '#define CORE_API DLLEXPORT'));
  const shared = path.join(sharedRoot, 'WebGPURHI.Shared.rsp');
  const args = fs.readFileSync(shared, 'utf8').trim().split(/\r?\n/);
  for (const include of ['Runtime/Core/Private', 'Runtime/OodleDataCompression/Sdks/2.9.16/include',
    'ThirdParty/zlib/1.3/include', 'ThirdParty/BLAKE3/1.3.1/c'])
    args.push(`/I"${include}"`);
  args.push(`/FI"${definitions}"`, '/TP', '/GR-', '/std:c++20', '/wd5054');
  report.compiler = path.join(msvc, 'cl.exe');
  report.sharedDefinitionsSha256 = sha(definitionsSource);
  report.sharedResponseSha256 = sha(shared);
  for (const relative of ['Private/Misc/Compression.cpp', 'Private/Compression/CompressedBuffer.cpp',
    'Private/Compression/OodleDataCompression.cpp', 'Private/Compression/OodleDataCompressionFormat.cpp',
    'Private/Compression/OodleDataCompressionUtil.cpp']) {
    const source = path.join(repo, 'Engine/Source/Runtime/Core', relative);
    const name = path.basename(source, '.cpp');
    const baseline = path.join(out, `${name}-baseline.cpp`);
    fs.writeFileSync(baseline, cp.execFileSync('git', ['-C', repo, 'show',
      `${base}:Engine/Source/Runtime/Core/${relative}`]));
    const variants = [{name: 'baseline', source: baseline, flags: []},
      {name: 'desktop', source, flags: []}, {name: 'web', source, flags: ['/DPLATFORM_WEB=1']}];
    const entry = {source, sha256: sha(source), variants: []};
    for (const variant of variants) {
      const prefix = path.join(out, `${name}-${variant.name}`);
      const response = `${prefix}.rsp`;
      const preprocessed = `${prefix}.i`;
      fs.writeFileSync(response, [...args, ...variant.flags, `"${variant.source}"`,
        '/P', '/EP', `/Fi"${preprocessed}"`].join('\n'));
      run(report.compiler, [`@${response}`], `${prefix}-preprocess.log`);
      variant.text = fs.readFileSync(preprocessed, 'utf8');
      if (variant.name !== 'baseline') {
        const object = `${prefix}.obj`;
        fs.writeFileSync(response, [...args, ...variant.flags, `"${source}"`, `/Fo"${object}"`].join('\n'));
        run(report.compiler, [`@${response}`], `${prefix}-compile.log`);
        const symbols = run(path.join(msvc, 'dumpbin.exe'), ['/symbols', object], `${prefix}-symbols.log`);
        const oodleSymbols = /\?[A-Za-z0-9_]+@FOodleDataCompression@@|FOodleEncoder|FOodleDecoder|CreateOodleDataCompressionFormat/.test(symbols);
        assert.equal(oodleSymbols, variant.name === 'desktop');
        entry.variants.push({name: variant.name, object, objectSha256: sha(object), oodleSymbols});
      }
    }
    const normalize = text => {
      for (const file of [source, baseline]) text = text.replaceAll(JSON.stringify(file), '"<source>"');
      return text.replace(/"<source>"\s*,\s*\d+/g, '"<source>", 0')
        .replace(/(__CpuProfilerEvent(?:SpecId|Scope))\d+/g, '$1<Location>')
        .replace(/\b((?:LLM|Mem)Scope)\d+\b/g, '$1<Location>')
        .replace(/\s+/g, ' ').trim();
    };
    const normalizedHash = text => crypto.createHash('sha256').update(normalize(text)).digest('hex');
    assert.equal(normalizedHash(variants[0].text), normalizedHash(variants[1].text),
      `${name}: desktop code changed beyond source locations / instrumentation local names derived from __LINE__`);
    entry.desktopPreprocessedCodeUnchanged = true;
    report.files.push(entry);
    console.log(`P3_CORE_SOURCE ${name}: desktop preserved, Web Oodle symbols excluded`);
  }
  report.pass = true;
  report.webOodleImplementationAndConsumersExcluded = true;
  report.boundary = 'Five complete target-branch Core translation units compile as Win64 objects using installed 5.8.0 headers and the existing MSVC/UBT environment. Their desktop preprocessed code matches the pinned baseline after diagnostic locations are normalized. Web conditional objects contain no Oodle implementation or binding symbols. This is conditional source validation, not a linked Core runtime, compression round trip, or WASM compilation of these files.';
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(__dirname, 'results/web-core-compression-source-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
