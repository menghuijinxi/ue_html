'use strict';
const {initializeProjectOutput, assertProjectOutput} = require('./project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const files = [
  'Source/Runtime/Engine/Private/ShaderCompiler/ShaderCompiler.cpp',
  'Source/Runtime/Renderer/Private/AnisotropyRendering.h',
  'Source/Runtime/Renderer/Private/FogRendering.cpp',
  'Source/Runtime/Renderer/Private/InstanceCulling/InstanceCullingContext.cpp',
  'Source/Runtime/Renderer/Private/Lumen/LumenSceneCardCapture.h',
  'Source/Runtime/Renderer/Private/Lumen/LumenSceneRendering.cpp',
  'Source/Runtime/Renderer/Private/PostProcess/PostProcessUpscale.cpp',
  'Source/Runtime/Renderer/Private/PostProcess/TemporalAA.cpp',
];
for (const relative of files) {
  const target = assertProjectOutput(path.join(root, '.tools/ue58-web-build-host/Engine', relative));
  assert.equal(fs.statSync(target).nlink, 1, 'PSO overlay must be an independent build-host copy');
  fs.chmodSync(target, 0o666);
  const source = path.join(root, 'reference-engine/Engine', relative);
  if (!fs.readFileSync(source).equals(fs.readFileSync(target))) fs.copyFileSync(source, target);
}
console.log('Web automatic global PSO collector overlay prepared');
