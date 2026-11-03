'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const inspect = require('./inspect-project-settings.cjs');
const cases = require('./lumen-tests/policy-cases.json');
const root = path.resolve(__dirname, '../..');
const host = path.join(root, 'tests/ue-shader-host');
const output = path.join(__dirname, 'build/lumen-project-settings');
fs.mkdirSync(output, {recursive: true});
assert.equal(fs.realpathSync(output), path.resolve(output));
const projects = cases.map(test => {
  const directory = path.join(output, test.name);
  fs.mkdirSync(path.join(directory, 'Config'), {recursive: true});
  assert.equal(fs.realpathSync(directory), path.resolve(directory));
  const project = path.join(directory, 'UEShaderHost.uproject');
  const descriptor = JSON.parse(fs.readFileSync(path.join(host, 'UEShaderHost.uproject'), 'utf8'));
  descriptor.AdditionalPluginDirectories = [path.join(host, 'Plugins')];
  fs.writeFileSync(project, JSON.stringify(descriptor, null, 2));
  for (const name of ['DefaultEditor.ini', 'DefaultDeviceProfiles.ini'])
    fs.copyFileSync(path.join(host, 'Config', name), path.join(directory, 'Config', name));
  const binaries = path.join(directory, 'Binaries');
  if (!fs.existsSync(binaries)) fs.symlinkSync(path.join(host, 'Binaries'), binaries, 'junction');
  assert.equal(fs.realpathSync(binaries), fs.realpathSync(path.join(host, 'Binaries')));
  const settings = {
    'r.DynamicGlobalIlluminationMethod': test.gi, 'r.ReflectionMethod': test.reflections,
    'r.Lumen.Supported': test.supported, 'r.GenerateMeshDistanceFields': test.distanceFields,
    'r.ForwardShading': test.forward, 'r.Shadow.Virtual.Enable': 0, 'r.RayTracing': 0,
  };
  fs.writeFileSync(path.join(directory, 'Config/DefaultEngine.ini'),
    '[/Script/Engine.RendererSettings]\n' + Object.entries(settings).map(([name, value]) =>
      `${name}=${value}`).join('\n') + '\n\n[SystemSettings]\nr.ShaderDevelopmentMode=0\n');
  if (test.web) {
    fs.mkdirSync(path.join(directory, 'Config/Web'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'Config/Web/WebEngine.ini'),
      '[SystemSettings]\n' + Object.entries(test.web).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
  }
  const report = inspect(project);
  assert.equal(report.lumen.enabled, test.expected);
  assert.deepEqual(report.rendererOverrides, []);
  return {...test, project};
});
fs.writeFileSync(path.join(output, 'projects.json'), JSON.stringify(projects, null, 2));
console.log(JSON.stringify({output, projects: projects.length}));
