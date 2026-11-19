'use strict';

// Same-package format experiment at the device boundary. Keep PSO interning above these
// hooks so the startup replay and runtime requests use the same adapted native objects.
module.exports = function overrideVillaDistanceFieldAtlas(format) {
  const stats = globalThis.__villaAtlasFormat = {format, textures: [], shaders: 0, storageGroups: 0};
  const device = GPUDevice.prototype;
  const atlasViews = new WeakSet(), shaders = new WeakMap(), layouts = new WeakMap(), groups = new WeakMap();
  const alternatives = new WeakMap();
  const originalTexture = device.createTexture;
  device.createTexture = function(descriptor) {
    if (descriptor.label !== 'GlobalDistanceField.PageAtlas') return originalTexture.call(this, descriptor);
    if (descriptor.format !== 'r32float') throw Error('Expected the merged R32F atlas');
    const texture = originalTexture.call(this, {...descriptor, format});
    stats.textures.push({format: texture.format, width: texture.width, height: texture.height, depth: texture.depthOrArrayLayers});
    return texture;
  };
  const originalView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(descriptor) {
    if (this.label !== 'GlobalDistanceField.PageAtlas') return originalView.call(this, descriptor);
    const view = originalView.call(this, {...descriptor, format});
    atlasViews.add(view);
    return view;
  };
  const originalGroupLayout = device.createBindGroupLayout;
  device.createBindGroupLayout = function(descriptor) {
    const layout = originalGroupLayout.call(this, descriptor);
    groups.set(layout, descriptor);
    return layout;
  };
  const originalLayout = device.createPipelineLayout;
  device.createPipelineLayout = function(descriptor) {
    const layout = originalLayout.call(this, descriptor);
    layouts.set(layout, descriptor);
    return layout;
  };
  function atlasGroupLayout(device, layout, binding) {
    if (format === 'r32float') return layout;
    let cache = alternatives.get(layout);
    if (!cache) alternatives.set(layout, cache = new Map());
    if (!cache.has(binding)) {
      const descriptor = groups.get(layout);
      const target = descriptor.entries.find(entry => entry.binding === binding);
      if (target?.storageTexture?.format !== 'r32float') throw Error('Unexpected atlas storage layout');
      const entries = descriptor.entries.map(entry => entry === target ?
        {...entry, storageTexture: {...entry.storageTexture, format}} : entry);
      cache.set(binding, originalGroupLayout.call(device, {...descriptor, entries}));
    }
    return cache.get(binding);
  }
  const shader = device.createShaderModule;
  device.createShaderModule = function(descriptor) {
    const declaration = /@group\((\d+)u?\)\s+@binding\((\d+)u?\)\s+var RWPageAtlasTexture\s*:\s*texture_storage_3d<r32float,/g;
    const matches = [...descriptor.code.matchAll(declaration)];
    if (!matches.length) return shader.call(this, descriptor);
    if (matches.length !== 1) throw Error('Ambiguous atlas storage declaration');
    const [match, group, binding] = matches[0];
    const code = descriptor.code.replace(match, match.replace('r32float', format));
    const module = shader.call(this, {...descriptor, code});
    shaders.set(module, {group: Number(group), binding: Number(binding)});
    ++stats.shaders;
    return module;
  };
  for (const name of ['createComputePipeline', 'createComputePipelineAsync']) {
    const create = device[name];
    device[name] = function(descriptor) {
      const target = shaders.get(descriptor.compute.module);
      if (!target || format === 'r32float') return create.call(this, descriptor);
      const base = layouts.get(descriptor.layout);
      const bindGroupLayouts = base.bindGroupLayouts.map((layout, index) => index === target.group ?
        atlasGroupLayout(this, layout, target.binding) : layout);
      return create.call(this, {...descriptor, layout: originalLayout.call(this, {...base, bindGroupLayouts})});
    };
  }
  const createGroup = device.createBindGroup;
  device.createBindGroup = function(descriptor) {
    const view = descriptor.entries.find(entry => atlasViews.has(entry.resource) &&
      groups.get(descriptor.layout)?.entries.some(item => item.binding === entry.binding && item.storageTexture));
    if (!view) return createGroup.call(this, descriptor);
    ++stats.storageGroups;
    return createGroup.call(this, {...descriptor, layout: atlasGroupLayout(this, descriptor.layout, view.binding)});
  };
};
