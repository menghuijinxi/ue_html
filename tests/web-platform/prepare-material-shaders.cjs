const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const workspace = path.resolve(__dirname, '../..');
const revision = '396c9f059903aed5fec78ecd3d437a40c6415368';
const engine = process.env.P1_ENGINE || 'H:/UE_5.8';
const output = path.join(workspace, '.tools/ue58-material-shaders');
const tree = cp.execFileSync('git', ['-C', path.join(workspace, 'reference-engine'),
  'ls-tree', '-r', revision, '--', 'Engine/Shaders'], {encoding: 'utf8'});
const files = [], unavailable = [];
fs.mkdirSync(output, {recursive: true});
for (const line of tree.trim().split('\n')) {
  const [metadata, source] = line.split('\t');
  if (!/\.(usf|ush|h)$/.test(source)) continue;
  const expected = metadata.split(' ')[2];
  const installed = path.join(engine, source);
  let bytes = fs.existsSync(installed) ?
    Buffer.from(fs.readFileSync(installed, 'utf8').replace(/\r\n/g, '\n')) : null;
  const blobHash = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  let origin = 'installed-normalized';
  if (!bytes || blobHash(bytes) !== expected) {
    const extraction = cp.spawnSync('git', ['-C', path.join(workspace, 'reference-engine'),
      'show', `${revision}:${source}`], {env: {...process.env, GIT_NO_LAZY_FETCH: '1'}, maxBuffer: 4 * 1024 * 1024});
    if (extraction.status !== 0) { unavailable.push({source, expected, reason: 'blob-not-cached'}); continue; }
    bytes = extraction.stdout;
    origin = 'target-git-blob';
  }
  if (blobHash(bytes) !== expected) throw Error(`Source hash mismatch: ${source}`);
  const destination = path.join(output, source.slice('Engine/Shaders/'.length));
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.writeFileSync(destination, bytes);
  files.push({source, origin, gitBlob: expected,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
}
const report = {revision, installedEngine: engine, snapshotDirectory: output,
  verifiedCount: files.length, unavailableCount: unavailable.length, files, unavailable};
fs.writeFileSync(path.join(__dirname, 'results/material-source-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({snapshotDirectory: output, verifiedCount: files.length,
  extractedCount: files.filter(file => file.origin === 'target-git-blob').length, unavailable}, null, 2));
const required = ['Engine/Shaders/Private/LocalVertexFactory.ush', 'Engine/Shaders/Private/GpuSkinCommon.ush',
  'Engine/Shaders/Private/MaterialTemplate.ush', 'Engine/Shaders/Private/MobileBasePassVertexShader.usf',
  'Engine/Shaders/Private/MobileBasePassPixelShader.usf'];
process.exitCode = required.every(source => files.some(file => file.source === source)) ? 0 : 1;
