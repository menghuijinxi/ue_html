const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const cookFile = path.resolve(option('cook-report'));
const output = path.resolve(option('output'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const blocks = {
  PF_B8G8R8A8: [1, 4], PF_R8G8B8A8: [1, 4], PF_FloatRGBA: [1, 8],
  PF_G8: [1, 1], PF_R8: [1, 1], PF_R8G8: [1, 2], PF_R16F: [1, 2], PF_G16R16F: [1, 4],
  PF_DXT1: [4, 8], PF_DXT3: [4, 16], PF_DXT5: [4, 16],
  PF_BC4: [4, 8], PF_BC5: [4, 16], PF_BC6H: [4, 16], PF_BC7: [4, 16]
};
const report = {date: new Date().toISOString(), pass: false, cookReport: audit(cookFile),
  source: audit(__filename), textures: [], formats: {}, boundary:
  'UE cooked platform headers and block-size estimates, including mip chains and cube faces. Not GPU residency or total VRAM.'};
try {
  const cook = read(cookFile);
  assert(cook.pass);
  report.textureCompression = cook.textureCompression || 'Uncompressed';
  const projectOnly = option('scope') !== 'all';
  report.scope = projectOnly ? 'project-content' : 'all';
  for (const item of cook.products.filter(item => item.file.endsWith('.uexp') &&
    (!projectOnly || path.relative(cook.output, item.file).replaceAll('\\', '/').startsWith(cook.projectName + '/Content/')))) {
    const buffer = Buffer.alloc(Math.min(65536, fs.statSync(item.file).size));
    const fd = fs.openSync(item.file, 'r');
    try { fs.readSync(fd, buffer); } finally { fs.closeSync(fd); }
    const matches = Array.from(buffer.toString('latin1').matchAll(/PF_[a-zA-Z0-9_]+\x00/g));
    for (const match of matches) {
      const index = match.index;
      if (index < 16 || buffer.readInt32LE(index - 4) !== match[0].length) continue;
      const x = buffer.readInt32LE(index - 16), y = buffer.readInt32LE(index - 12);
      if (x <= 0 || y <= 0 || x > 32768 || y > 32768) continue;
      const packed = buffer.readUInt32LE(index - 8);
      assert.equal(packed & 0x60000000, 0, 'Optional/CPU texture headers need explicit parsing: ' + item.file);
      const cursor = index + match[0].length;
      const firstMip = buffer.readInt32LE(cursor), mips = buffer.readInt32LE(cursor + 4);
      assert(firstMip >= 0 && firstMip <= 15 && mips > 0 && mips <= 16, item.file);
      const format = match[0].slice(0, -1), layout = blocks[format];
      assert(layout, 'Unknown block size: ' + format);
      const cube = !!(packed & 0x80000000), slices = packed & 0x1fffffff;
      // This inventory covers 2D/cube assets; volume size needs the per-mip depth fields.
      if (!cube && slices > 1) continue;
      const width = Math.max(1, x >> firstMip), height = Math.max(1, y >> firstMip), faces = cube ? 6 : 1;
      let bytes = 0;
      for (let mip = 0; mip < mips; ++mip)
        bytes += Math.ceil(Math.max(1, width >> mip) / layout[0]) *
          Math.ceil(Math.max(1, height >> mip) / layout[0]) * layout[1] * faces;
      const texture = {file: path.relative(cook.output, item.file).replaceAll('\\', '/'),
        format, width, height, firstMip, mips, faces, estimatedBytes: bytes};
      report.textures.push(texture);
      const group = report.formats[format] ||= {count: 0, estimatedBytes: 0};
      ++group.count;
      group.estimatedBytes += bytes;
    }
  }
  assert(report.textures.length > 0);
  report.count = report.textures.length;
  report.multiMip = report.textures.filter(item => item.mips > 1).length;
  report.singleMip = report.count - report.multiMip;
  report.estimatedBytes = report.textures.reduce((sum, item) => sum + item.estimatedBytes, 0);
  report.largest = [...report.textures].sort((a, b) => b.estimatedBytes - a.estimatedBytes).slice(0, 20);
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
}
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, count: report.count, multiMip: report.multiMip,
  estimatedBytes: report.estimatedBytes, formats: report.formats, failure: report.failure}, null, 2));
