'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const inspect = require('./inspect-project-settings.cjs');
const output = path.join(__dirname, 'build/lumen-settings-validation');
fs.mkdirSync(output, {recursive: true});
const directory = fs.mkdtempSync(path.join(output, 'case-'));
fs.mkdirSync(path.join(directory, 'Config/Web'), {recursive: true});
fs.mkdirSync(path.join(directory, 'Config/Windows'), {recursive: true});
const project = path.join(directory, 'Settings.uproject');
fs.writeFileSync(project, '{}');
const base = path.join(directory, 'Config/DefaultEngine.ini');
const web = path.join(directory, 'Config/Web/WebEngine.ini');
const set = (file, values, section = '/Script/Engine.RendererSettings') => fs.writeFileSync(file,
  `[${section}]\n` + Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
set(base, {'r.DynamicGlobalIlluminationMethod': 1, 'r.ReflectionMethod': 0,
  'r.GenerateMeshDistanceFields': 1});
assert.equal(inspect(project).lumen.enabled, true);
set(web, {'r.DynamicGlobalIlluminationMethod': 0});
assert.equal(inspect(project).lumen.enabled, false);
set(path.join(directory, 'Config/Windows/WebEngine.ini'), {'r.DynamicGlobalIlluminationMethod': 1});
assert.equal(inspect(project).lumen.enabled, false, 'Other platforms cannot enable Web Lumen');
set(web, {'r.DynamicGlobalIlluminationMethod': 1, 'r.GenerateMeshDistanceFields': 0});
assert.throws(() => inspect(project), /Generate Mesh Distance Fields/);
set(web, {'r.DynamicGlobalIlluminationMethod': 1, 'r.ForwardShading': 1});
assert.throws(() => inspect(project), /deferred rendering/);
set(web, {'r.DynamicGlobalIlluminationMethod': 1, 'r.Lumen.Supported': 0});
assert.equal(inspect(project).lumen.enabled, false);
set(web, {'r.Shadow.Virtual.Enable': 1});
assert.equal(inspect(project).virtualShadows.enabled, true);
set(web, {'r.Shadow.Virtual.Enable': 1, 'r.ForwardShading': 1,
  'r.DynamicGlobalIlluminationMethod': 0});
assert.throws(() => inspect(project), /virtual shadow maps require deferred rendering/);
fs.writeFileSync(base, '[SystemSettings]\nr.DynamicGlobalIlluminationMethod=0\nr.GenerateMeshDistanceFields=1\n');
set(web, {'r.DynamicGlobalIlluminationMethod': 1});
assert.equal(inspect(project).lumen.enabled, false, 'SystemSettings CVar priority wins across INI layers');
assert.deepEqual(inspect(project).rendererOverrides, []);
console.log(JSON.stringify({pass: true, cases: 10, directory}));
