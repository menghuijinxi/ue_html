const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const stock = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const host = path.join(root, '.tools/ue58-web-native-build-host/Engine');
const reportFile = path.join(__dirname, 'results/native-rendercore-host-results.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const report = {date: new Date().toISOString(), pass: false, host, installedEngine: stock};
function local(directory) {
  fs.mkdirSync(directory, {recursive: true});
  assert.equal(fs.realpathSync(directory), path.resolve(directory), `Expected local directory: ${directory}`);
}
function link(source, destination) {
  if (!fs.existsSync(destination)) fs.symlinkSync(source, destination, 'junction');
  assert.equal(fs.realpathSync(destination), fs.realpathSync(source));
}
function copyTree(relative) {
  const destination = path.join(host, relative);
  local(destination);
  const marker = path.join(host, '.prepared-' + relative.replaceAll('/', '-') + '.json');
  if (!fs.existsSync(marker)) {
    fs.cpSync(path.join(stock, relative), destination, {recursive: true, dereference: false});
    fs.writeFileSync(marker, JSON.stringify({source: path.join(stock, relative), destination}));
  }
}
try {
  local(host);
  local(path.join(host, 'Programs/UnrealHeaderTool'));
  const uhtConfig = path.join(host, 'Programs/UnrealHeaderTool/Config');
  if (!fs.existsSync(uhtConfig)) fs.cpSync(path.join(stock, 'Programs/UnrealHeaderTool/Config'), uhtConfig, {recursive: true});
  for (const name of ['Build', 'Intermediate/Build/Win64', 'Intermediate/Build/BuildRules']) copyTree(name);
  local(path.join(host, 'Source'));
  for (const entry of fs.readdirSync(path.join(stock, 'Source'), {withFileTypes: true})) {
    const destination = path.join(host, 'Source', entry.name);
    if (entry.name === 'Runtime') continue;
    if (entry.isDirectory()) link(path.join(stock, 'Source', entry.name), destination);
    else if (!fs.existsSync(destination)) fs.copyFileSync(path.join(stock, 'Source', entry.name), destination);
  }
  local(path.join(host, 'Source/Runtime'));
  for (const entry of fs.readdirSync(path.join(stock, 'Source/Runtime'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'RenderCore') copyTree('Source/Runtime/RenderCore');
    else link(path.join(stock, 'Source/Runtime', entry.name), path.join(host, 'Source/Runtime', entry.name));
  }
  const overlays = ['Private/Shader.cpp', 'Private/RenderUtils.cpp',
    'Private/GPUDebugCrashUtils.cpp', 'Private/ResolveShader.cpp', 'Private/VertexFactory.cpp', 'Public/WebShaderPlatform.h'];
  for (const name of overlays) {
    const source = path.join(root, 'reference-engine/Engine/Source/Runtime/RenderCore', name);
    const destination = path.join(host, 'Source/Runtime/RenderCore', name);
    if (fs.existsSync(destination)) {
      assert.equal(fs.statSync(destination).nlink, 1);
      if (sha(source) === sha(destination)) continue;
      fs.chmodSync(destination, 0o666);
    }
    fs.copyFileSync(source, destination);
  }
  for (const name of ['Config', 'Content', 'Shaders', 'Plugins', 'Platforms']) link(path.join(stock, name), path.join(host, name));
  local(path.join(host, 'Binaries'));
  link(path.join(stock, 'Binaries/ThirdParty'), path.join(host, 'Binaries/ThirdParty'));
  local(path.join(host, 'Binaries/DotNET'));
  for (const entry of fs.readdirSync(path.join(stock, 'Binaries/DotNET'), {withFileTypes: true})) {
    if (entry.name === 'UnrealBuildTool') continue;
    const source = path.join(stock, 'Binaries/DotNET', entry.name);
    const destination = path.join(host, 'Binaries/DotNET', entry.name);
    if (entry.isDirectory()) link(source, destination);
    else if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
  }
  local(path.join(host, 'Binaries/Win64'));
  for (const entry of fs.readdirSync(path.join(stock, 'Binaries/Win64'), {withFileTypes: true})) {
    const destination = path.join(host, 'Binaries/Win64', entry.name);
    const source = path.join(stock, 'Binaries/Win64', entry.name);
    if (entry.isDirectory()) {
      link(source, destination);
    } else if (!fs.existsSync(destination)) {
      if (/^UnrealEditor-RenderCore\./i.test(entry.name) || !/\.(dll|exe)$/i.test(entry.name)) fs.copyFileSync(source, destination);
      else fs.linkSync(source, destination);
    }
  }
  assert.equal(fs.statSync(path.join(host, 'Binaries/Win64/UnrealEditor-RenderCore.dll')).nlink, 1);
  report.installedInputs = [
    'Binaries/Win64/UnrealEditor-RenderCore.dll',
    'Source/Runtime/RenderCore/Private/Shader.cpp',
    'Source/Runtime/RenderCore/Private/RenderUtils.cpp',
    'Source/Runtime/RenderCore/Private/GPUDebugCrashUtils.cpp',
    'Source/Runtime/RenderCore/Private/ResolveShader.cpp',
    'Source/Runtime/RenderCore/Private/VertexFactory.cpp',
    'Build/Build.version',
  ].map(name => audit(path.join(stock, name)));
  report.sourceFiles = [audit(__filename),
    ...overlays.map(name => audit(path.join(root, 'reference-engine/Engine/Source/Runtime/RenderCore', name))),
    ...overlays.map(name => audit(path.join(host, 'Source/Runtime/RenderCore', name)))];
  report.boundary = 'Isolated native RenderCore build host using installed source, generated headers and copied import libraries. All writable Intermediate/Build/Win64, BuildRules and RenderCore outputs are independent copies. Other native DLL hardlinks are read-only dependencies; no other module may be rebuilt.';
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, host, failure: report.failure}, null, 2));
}
