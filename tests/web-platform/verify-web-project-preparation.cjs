'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');

const id = 'prepare-loading-phase-regression';
const input = path.join(__dirname, 'build', id + '-input');
fs.mkdirSync(path.join(input, 'Content'), {recursive: true});
fs.mkdirSync(path.join(input, 'Config'), {recursive: true});
const project = path.join(input, 'LoadingPhase.uproject');
fs.writeFileSync(project, JSON.stringify({FileVersion: 3, EngineAssociation: '5.8'}));
const config = path.join(input, 'Config/DefaultEngine.ini');
fs.writeFileSync(config, '[/Script/Engine.RendererSettings]\n' +
  'r.DynamicGlobalIlluminationMethod=1\nr.ReflectionMethod=1\n' +
  'r.GenerateMeshDistanceFields=True\nr.VirtualTextures=True\nr.Shadow.Virtual.Enable=1\n');
const before = [project, config].map(audit);
execFileSync(process.execPath, [path.join(__dirname, 'prepare-web-project.cjs'),
  '--project=' + project, '--id=' + id, '--project-settings'], {stdio: 'pipe'});
const prepared = path.join(__dirname, 'build/projects', id, 'LoadingPhase.uproject');
const descriptor = JSON.parse(fs.readFileSync(prepared));
const hostModule = descriptor.Modules.find(item => item.Name === 'UEShaderHost');
assert.equal(hostModule?.LoadingPhase, 'PostConfigInit',
  'Prepared projects must register host shader types before engine shader initialization');
const host = JSON.parse(fs.readFileSync(path.join(__dirname, '../ue-shader-host/UEShaderHost.uproject')));
assert.deepEqual(hostModule, host.Modules.find(item => item.Name === 'UEShaderHost'));
assert.deepEqual(before.map(item => audit(item.file)), before, 'Original project files changed');
assert.equal(fs.readFileSync(path.join(path.dirname(prepared), 'Config/DefaultEngine.ini'), 'utf8'),
  fs.readFileSync(config, 'utf8'), 'Project rendering settings changed');
console.log(JSON.stringify({pass: true, loadingPhase: hostModule.LoadingPhase,
  originalProjectUnmodified: true, renderingSettingsPreserved: true}));
