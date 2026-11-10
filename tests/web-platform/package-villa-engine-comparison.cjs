'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {audit, metadata} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {applyAcceptedDefaults} = require('./web-accepted-defaults.cjs');
const {releaseOptions, finalizeDesktopRelease} = require('./web-release-defaults.cjs');
const profile = require('./villa-engine-comparison.json');
const source = path.join(__dirname, 'build', profile.baseline);
const dest = path.join(__dirname, 'build', profile.ours);
const runtime = path.join(__dirname, 'build', profile.runtime);
const runtimeManifest = path.join(runtime, 'asset-versions.json');
const runtimeVersions = JSON.parse(fs.readFileSync(runtimeManifest));
const products = ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'].map(name => ({
  file: path.join(runtime, name), sha256: runtimeVersions[name].sha256
}));
const versions = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json')));
assert(!fs.existsSync(dest), 'Keep published comparison packages immutable');
for (const [name, entry] of Object.entries(versions)) {
  assert.equal(path.basename(name), name);
  assert.equal(audit(path.join(source, name)).sha256, entry.sha256, name);
}
// Reuse the archived, verified executable. Current engine sources have newer
// experiments; this is deliberately not evidence of a new source build.
for (const product of products)
  assert.equal(audit(product.file).sha256, product.sha256, product.file);
fs.mkdirSync(dest);
const replaced = new Set(['index.html', 'config-files.json', 'asset-versions.json',
  'UEWebEngineThreads.js', 'UEWebEngineThreads.wasm', 'web-engine-host.js', 'web-engine-worker.js']);
for (const name of Object.keys(versions))
  if (!replaced.has(name)) fs.linkSync(path.join(source, name), path.join(dest, name));
for (const name of ['index.html', 'config-files.json'])
  fs.copyFileSync(path.join(source, name), path.join(dest, name));
for (const name of ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'])
  fs.copyFileSync(products.find(p => path.basename(p.file) === name).file, path.join(dest, name));
for (const name of ['web-engine-host.js', 'web-engine-worker.js'])
  fs.copyFileSync(path.join(__dirname, name), path.join(dest, name));
const performanceProfile = applyAcceptedDefaults(dest);
const configPath = path.join(dest, 'config-files.json');
const configs = JSON.parse(fs.readFileSync(configPath));
const ini = configs.find(f => f.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
const text = Buffer.from(ini.data, 'base64').toString() + '\n[SystemSettings]\n' +
  Object.entries(profile.settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
ini.data = Buffer.from(text).toString('base64');
ini.sha256 = crypto.createHash('sha256').update(text).digest('hex');
fs.writeFileSync(configPath, JSON.stringify(configs));
const htmlPath = path.join(dest, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
assert(match);
const assets = JSON.parse(match[1]);
assets.fixedRenderSize = {width: profile.width, height: profile.height};
for (const name of Object.keys(assets.versions))
  assets.versions[name] = audit(path.join(dest, name)).sha256;
assets.wasm = metadata(path.join(dest, 'UEWebEngineThreads.wasm'), 'UEWebEngineThreads.wasm');
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
assert(html.includes('width="1280" height="720"'));
html = html.replace('width="1280" height="720"', `width="${profile.width}" height="${profile.height}"`);
const argsMatch = html.match(/arguments: (\[[^\n]+\]),/);
const args = JSON.parse(argsMatch[1]);
args.push(`-ResX=${profile.width}`, `-ResY=${profile.height}`, '-ForceRes');
html = html.replace(argsMatch[0], 'arguments: ' + JSON.stringify(args) + ',');
fs.writeFileSync(htmlPath, html);
const releaseDefaults = finalizeDesktopRelease(dest, releaseOptions());
writeVersions(dest, fs.readdirSync(dest).map(name => audit(path.join(dest, name))));
const report = {
  date: new Date().toISOString(), profile, performanceProfile, runtimePackage: profile.runtime,
  releaseDefaults, startupPrewarm: releaseDefaults.prewarm,
  runtimeManifest: audit(runtimeManifest), products,
  baselineManifest: audit(path.join(source, 'asset-versions.json')),
  candidateManifest: audit(path.join(dest, 'asset-versions.json')),
  content: audit(path.join(dest, 'content.bin')),
  source: audit(__filename),
  boundary: 'Repackaged verified v71 runtime with archived Lumen Cook and accepted performance settings. The accepted Nov 7 executable is absent locally. No new engine build or Cook; rendering equivalence requires browser verification.'
};
fs.writeFileSync(path.join(__dirname, 'results', profile.ours + '-package.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({directory: dest, runtimePackage: profile.runtime, performanceProfile}));
