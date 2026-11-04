'use strict';

// Read the scalar/vector/matrix layouts emitted by Tint for these two diagnostic
// uniforms. Reject unknown types rather than silently calculating wrong offsets.
module.exports = function uniformLayouts(code) {
  const align = (n, a) => Math.ceil(n / a) * a;
  const scalar = new Set(['f32', 'i32', 'u32', 'f16']);
  function typeLayout(type) {
    if (scalar.has(type)) return {align: type === 'f16' ? 2 : 4, size: type === 'f16' ? 2 : 4};
    let match = /^vec([234])<(.+)>$/.exec(type);
    if (match) {
      const element = typeLayout(match[2]), count = +match[1];
      return {align: (count === 2 ? 2 : 4) * element.align, size: count * element.size};
    }
    match = /^mat([234])x([234])<(.+)>$/.exec(type);
    if (match) {
      const column = typeLayout(`vec${match[2]}<${match[3]}>`);
      return {align: column.align, size: +match[1] * align(column.size, column.align)};
    }
    throw new Error('Unsupported diagnostic uniform type: ' + type);
  }
  const structs = new Map();
  for (const match of code.matchAll(/struct\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) structs.set(match[1], match[2]);
  const result = [];
  for (const match of code.matchAll(/@group\((\d+)u?\)\s*@binding\((\d+)u?\)\s*var<uniform>\s+(\w+)\s*:\s*(\w+)\s*;/g)) {
    const body = structs.get(match[4]);
    if (!body || !/\b(VelocityScale|View_ClipToPrevClip)\s*:/.test(body)) continue;
    let cursor = 0;
    const fields = [];
    const members = /((?:@\w+\([^)]*\)\s*)*)(\w+)\s*:\s*(\w+(?:<[^>]+>)?)\s*,/g;
    for (const member of body.matchAll(members)) {
      const layout = typeLayout(member[3]);
      const alignment = /@align\((\d+)u?\)/.exec(member[1]);
      const size = /@size\((\d+)u?\)/.exec(member[1]);
      cursor = align(cursor, alignment ? +alignment[1] : layout.align);
      fields.push({name: member[2], offset: cursor, size: layout.size});
      cursor += size ? +size[1] : layout.size;
    }
    result.push({name: match[3], group: +match[1], binding: +match[2], fields});
  }
  return result;
};
