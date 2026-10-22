const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const source = path.resolve(argument('project') || 'H:/TriplexHouseVilla/TriplexHouseVilla.uproject');
const id = argument('id') || 'triplex-house-villa';
const textureSize = Number(argument('texture-size') || 0);
const inputProfile = argument('input-profile');
assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
assert([0, 256, 512, 1024, 2048].includes(textureSize));
const root = path.resolve(__dirname, '../..');
const host = path.join(root, 'tests/ue-shader-host');
const directory = path.join(__dirname, 'build/projects', id);
const output = path.join(directory, path.basename(source));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, id, project: output, originalProject: source,
  sourceFiles: [], copiedFiles: [], originalProjectUnmodified: false};
function files(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), 'Project input must not contain links: ' + file);
      return entry.isDirectory() ? files(file) : [file];
    });
}
try {
  assert(fs.existsSync(source) && path.extname(source) === '.uproject');
  fs.mkdirSync(directory, {recursive: true});
  assert.equal(fs.realpathSync(directory), path.resolve(directory));
  const descriptor = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  assert(!descriptor.Modules?.some(module => module.Type !== 'Editor'),
    'This runner currently supports content projects; game C++ modules require their own Web target.');
  const inputs = [source, ...['Content', 'Config'].flatMap(name => files(path.join(path.dirname(source), name)))];
  for (const file of inputs) {
    report.sourceFiles.push(audit(file));
    if (file === source) continue;
    const destination = path.join(directory, path.relative(path.dirname(source), file));
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    if (!fs.existsSync(destination) || audit(destination).sha256 !== report.sourceFiles.at(-1).sha256)
      fs.copyFileSync(file, destination);
    report.copiedFiles.push(audit(destination));
    assert.equal(report.copiedFiles.at(-1).sha256, report.sourceFiles.at(-1).sha256);
  }
  descriptor.Modules = [...(descriptor.Modules || []).filter(module => module.Name !== 'UEShaderHost'),
    {Name: 'UEShaderHost', Type: 'Editor', LoadingPhase: 'Default'}];
  descriptor.Plugins = [...(descriptor.Plugins || []).filter(plugin => plugin.Name !== 'WebGPUShader'),
    {Name: 'WebGPUShader', Enabled: true}];
  descriptor.DisableEnginePluginsByDefault = true;
  descriptor.AdditionalPluginDirectories = [...(descriptor.AdditionalPluginDirectories || [])
    .map(value => path.resolve(path.dirname(source), value)), path.join(host, 'Plugins')];
  fs.writeFileSync(output, JSON.stringify(descriptor, null, 2) + '\n');
  report.hostConfigFiles = [];
  for (const name of ['DefaultEditor.ini', 'DefaultDeviceProfiles.ini']) {
    const file = path.join(host, 'Config', name);
    report.hostConfigFiles.push(audit(file));
    const destination = path.join(directory, 'Config', name);
    const original = path.join(path.dirname(source), 'Config', name);
    const text = (fs.existsSync(original) ? fs.readFileSync(original, 'utf8') : '') +
      '\n' + fs.readFileSync(file, 'utf8');
    fs.writeFileSync(destination, text);
  }
  if (inputProfile) {
    const file = path.resolve(inputProfile);
    report.hostConfigFiles.push(audit(file));
    fs.appendFileSync(path.join(directory, 'Config/DefaultInput.ini'),
      '\n' + fs.readFileSync(file, 'utf8'));
    report.inputProfile = audit(file);
  }
  if (textureSize) {
    const base = path.join(process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine', 'Config/BaseDeviceProfiles.ini');
    report.hostConfigFiles.push(audit(base));
    const groups = [...new Set(Array.from(fs.readFileSync(base, 'utf8')
      .matchAll(/Group=(TEXTUREGROUP_[a-zA-Z0-9_]+)/g), match => match[1]))];
    assert(groups.length >= 20);
    const target = path.join(directory, 'Config/DefaultDeviceProfiles.ini');
    fs.appendFileSync(target, '\n[Web DeviceProfile]\n' + groups.map(group =>
      `+TextureLODGroups=(Group=${group},MaxLODSize=${textureSize},MinLODSize=1,LODBias=0,MinMagFilter=aniso,MipFilter=point)`
    ).join('\n') + '\n');
  }
  report.copiedFiles = report.copiedFiles.map(item => audit(item.file));
  const binaries = path.join(directory, 'Binaries');
  if (!fs.existsSync(binaries)) fs.symlinkSync(path.join(host, 'Binaries'), binaries, 'junction');
  assert.equal(fs.realpathSync(binaries), fs.realpathSync(path.join(host, 'Binaries')));
  report.descriptor = audit(output);
  report.pluginPolicy = 'Engine plugins require explicit enablement, matching the current Web runner.';
  report.textureMaxLODSize = textureSize || null;
  report.originalProjectUnmodified = report.sourceFiles.every(item => audit(item.file).sha256 === item.sha256);
  assert(report.originalProjectUnmodified);
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.mkdirSync(path.join(__dirname, 'results'), {recursive: true});
  fs.writeFileSync(path.join(__dirname, `results/web-project-${id}-prepare-results.json`),
    JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, project: output, files: report.copiedFiles.length,
    sourceBytes: report.sourceFiles.reduce((total, item) => total + fs.statSync(item.file).size, 0),
    failure: report.failure}, null, 2));
}
