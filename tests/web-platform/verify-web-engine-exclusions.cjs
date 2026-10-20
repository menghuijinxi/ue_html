const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const target = path.join(root, 'reference-engine/Engine');
const host = path.join(root, '.tools/ue58-web-build-host/Engine');
const intermediate = path.join(root, 'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngine/Development');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && item.sha256 === sha(item.file);
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64',
  fullLinkSucceeded: false, fontRuntimeVerified: false, browserNetworkingVerified: false,
  completeBrowserUERuntime: false};

try {
  const buildFile = path.join(__dirname, 'results/web-engine-full-build-results.json');
  const build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
  assert(build.fullBuildAttempted && build.fullLinkAttempted,
    'The full target must have completed its required compile actions and reached linking');
  assert(valid(build.log) && valid(build.ubtLog) && valid(build.ubt));
  assert(build.sourceFiles?.length && build.sourceFiles.every(valid));
  const nm = path.join(root, '.tools/emsdk/upstream/bin/llvm-nm.exe');
  function symbols(module, names, includeUndefined = false) {
    const objects = names.map(name => path.join(intermediate, module, `${name}.cpp.o`));
    for (const object of objects)
      assert(fs.readFileSync(object).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
    const result = cp.spawnSync(nm, [...(includeUndefined ? [] : ['--defined-only']), '-C', ...objects], {
      encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 * 1024});
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    report.objects.push(...objects.map(audit));
    const file = path.join(__dirname, 'results', `web-engine-${module}-exclusion-symbols.log`);
    fs.writeFileSync(file, result.stdout);
    report.symbols.push(audit(file));
    return result.stdout;
  }
  report.objects = [];
  report.symbols = [];
  const slate = symbols('SlateCore', [1, 2, 3, 4, 5].map(index => `Module.SlateCore.${index}`));
  assert(!/FSlateSdfGeneratorImpl::|SdfUtils::|SlateMsdfgen::msdfgen::/.test(slate),
    'Web must not define the MSDF geometry or SDF task implementation');
  for (const name of ['FSlateSdfGenerator::create', 'IsSlateSdfTextFeatureEnabled',
    'UE::Slate::FPreprocessedFontGeometry::GetAllocatedSize',
    'UE::Slate::FPreprocessedFontGeometry::ViewGlyph', 'UE::Slate::operator<<'])
    assert(slate.includes(name), `Retain the disabled-feature entry or font data interface: ${name}`);

  const sockets = symbols('Sockets', ['Module.Sockets']);
  assert(!/FSocketBSD::|FSocketSubsystemBSD::|FInternetAddrBSD::/.test(sockets));
  assert(sockets.includes('CreateSocketSubsystem(FSocketSubsystemModule&)'));
  assert(sockets.includes('DestroySocketSubsystem(FSocketSubsystemModule&)'));
  const definitions = path.join(intermediate, 'Sockets/Definitions.h');
  const text = fs.readFileSync(definitions, 'utf8');
  assert(text.includes('#define PLATFORM_HAS_BSD_SOCKETS 0'));
  assert(text.includes('#define PLATFORM_HAS_BSD_IPV6_SOCKETS 0'));

  const image = symbols('ImageWrapper', ['Module.ImageWrapper'], true);
  assert(image.includes('FPngImageWrapper::') && /\bU png_create_write_struct_2\b/.test(image));
  const imageDefinitions = path.join(intermediate, 'ImageWrapper/Definitions.h');
  assert(fs.readFileSync(imageDefinitions, 'utf8').includes('#define WITH_UNREALPNG 1'));
  report.pngDefinitions = audit(imageDefinitions);
  assert(valid(build.linkResponse), 'The actual full-link response must be preserved before compile probes run');
  const response = build.linkResponse.file;
  const linkArguments = fs.readFileSync(response, 'utf8').replace(/\\/g, '/');
  report.portableLibraries = ['BLAKE3/1.3.1/lib/wasm64/libBLAKE3.a',
    'libPNG/libPNG-1.6.44/lib/wasm64/libpng.a'].map(relative => {
    const original = path.join(target, 'Platforms/Web/Source/ThirdParty', relative);
    const copied = path.join(host, 'Platforms/Web/Source/ThirdParty', relative);
    assert.equal(sha(original), sha(copied));
    assert(linkArguments.toLowerCase().includes(copied.replace(/\\/g, '/').toLowerCase()));
    assert(build.sourceFiles.some(item =>
      path.resolve(item.file).toLowerCase() === original.toLowerCase() && valid(item)));
    return {source: audit(original), linked: audit(copied)};
  });
  report.linkResponse = audit(response);

  const icmp = symbols('Icmp', ['Module.Icmp'], true);
  assert(!/\b(?:HtoNS|HtoNL|NtoHS|NtoHL)\(/.test(icmp));
  assert(!/FUdpPingManyAsync::|FUDPPingAsyncResult::|\bUDPPing::/.test(icmp));
  for (const name of ['FUDPPing::UDPEcho(', 'FUDPPing::UDPEchoMany('])
    assert(icmp.includes(name), `Retain the unsupported-result interface ${name}`);
  const patch = symbols('BuildPatchServices', [1, 2, 3, 4].map(index => `Module.BuildPatchServices.${index}`), true);
  assert(!/\bsem_timedwait\b/.test(patch));
  assert(patch.includes('BuildPatchServices::FVerifier::ProcessVerifyJobs('),
    'Keep the existing synchronous file verification implementation');

  const relativeSources = [
    'Source/Runtime/SignalProcessing/Private/FloatArrayMath.cpp',
    ...['FontCache.cpp', 'PreprocessedFontGeometry.cpp', 'SlateSdfGenerator.cpp'].map(name =>
      `Source/Runtime/SlateCore/Private/Fonts/${name}`),
    'Source/Runtime/Slate/Private/Framework/Animation/AttributeInterpolator.cpp',
    'Source/Runtime/Slate/Private/Framework/Application/SlateApplication.cpp',
    'Source/Runtime/Slate/Private/Framework/Application/SlateUser.cpp',
    'Source/Runtime/Slate/Public/Framework/Text/Web/WebPlatformTextField.h',
    'Platforms/Web/Source/Runtime/Sockets/Sockets_Web.Build.cs',
    'Platforms/Web/Source/Runtime/Sockets/Private/Web/SocketSubsystemWeb.cpp',
    'Platforms/Web/Source/ThirdParty/BLAKE3/BLAKE3_Web.Build.cs',
    'Platforms/Web/Source/ThirdParty/libPNG/UElibPNG_Web.Build.cs',
    'Source/Runtime/Online/ICMP/Private/UDPPing.cpp',
    'Source/Runtime/Online/BuildPatchServices/Private/Installer/Verifier.cpp'
  ];
  report.sourceFiles = [audit(__filename), ...relativeSources.flatMap(relative => {
    const source = path.join(target, relative);
    const copied = path.join(host, relative);
    assert.equal(sha(source), sha(copied));
    assert(build.sourceFiles.some(item =>
      path.resolve(item.file).toLowerCase() === source.toLowerCase() && valid(item)));
    return [audit(source), audit(copied)];
  })];
  Object.assign(report, {pass: true, sdfImplementationExcluded: true,
    fontDataInterfacesRetained: true, bsdSocketImplementationExcluded: true,
    udpProbeImplementationExcluded: true, portableLibrariesLinked: true, runtimePngCodecRetained: true,
    patchTimedSemaphoreWaitExcluded: true,
    fullLinkSucceeded: build.buildSucceeded === true,
    definitions: audit(definitions), buildReport: audit(buildFile),
    boundary: 'Full-target wasm64 objects exclude MSDF/SDF tasks, native BSD sockets, UDP probe workers and timed patch-verification semaphore waits. Font data, socket/unsupported-ping interfaces, synchronous verification and UE PNG codec remain compiled. Actual link inputs contain byte-identical copies of the tested portable BLAKE3 and libPNG archives. These are object/link-input checks; no font, networking, PNG wrapper, patch runtime, Engine startup or scene is verified.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(__dirname, 'results/web-engine-exclusion-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, sdfImplementationExcluded: report.sdfImplementationExcluded,
  bsdSocketImplementationExcluded: report.bsdSocketImplementationExcluded, failure: report.failure}, null, 2));
process.exitCode = report.pass ? 0 : 1;
