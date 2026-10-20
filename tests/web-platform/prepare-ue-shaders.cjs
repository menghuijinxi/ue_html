const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const workspace = path.resolve(__dirname, '../..');
const engine = process.env.P1_ENGINE || 'H:/UE_5.8';
const output = path.join(workspace, '.tools/ue58-verified-shaders');
const revision = '396c9f059903aed5fec78ecd3d437a40c6415368';
const tree = cp.execFileSync('git', ['-C', path.join(workspace, 'reference-engine'),
  'ls-tree', '-r', revision, '--', 'Engine/Shaders'], {encoding: 'utf8'});
const verified = [];
const unavailable = [];
for (const line of tree.trim().split('\n')) {
  const [metadata, source] = line.split('\t');
  if (!/\.(usf|ush|h)$/.test(source)) continue;
  const expected = metadata.split(' ')[2];
  const installed = path.join(engine, source);
  if (!fs.existsSync(installed)) { unavailable.push({source, expected, reason: 'missing'}); continue; }
  const original = fs.readFileSync(installed);
  const bytes = Buffer.from(original.toString('utf8').replace(/\r\n/g, '\n'));
  const actual = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== expected) {
    unavailable.push({source, expected, actual, reason: 'different-content'});
    continue;
  }
  const relative = source.substring('Engine/Shaders/'.length);
  const destination = path.join(output, relative);
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.writeFileSync(destination, bytes);
  verified.push({source, gitBlob: actual, sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
}
const report = {revision, installedEngine: engine, newlineNormalization: 'CRLF-to-LF',
  verifiedCount: verified.length, unavailableCount: unavailable.length, verified, unavailable};
fs.mkdirSync(path.join(__dirname, 'results'), {recursive: true});
fs.writeFileSync(path.join(__dirname, 'results/ue-shader-source-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({verifiedCount: verified.length, unavailableCount: unavailable.length, unavailable}, null, 2));
