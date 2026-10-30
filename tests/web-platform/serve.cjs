const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const root = __dirname;
const host = process.env.HOST || '0.0.0.0';
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json'};
const validators = new Map();
async function digest(file, stat) {
  const version = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = validators.get(file);
  if (previous?.version === version) return previous.hash;
  if (stat.size > 1024 * 1024 && process.env.VERIFY_ASSETS !== '1') {
    try {
      const versions = JSON.parse(await fs.promises.readFile(path.join(path.dirname(file), 'asset-versions.json'), 'utf8'));
      const published = versions[path.basename(file)];
      if (published?.size === stat.size && published.mtimeMs === stat.mtimeMs && /^[a-f0-9]{64}$/.test(published.sha256)) {
        validators.set(file, {version, hash: published.sha256});
        return published.sha256;
      }
    } catch {}
  }
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  const value = hash.digest('hex');
  validators.set(file, {version, hash: value});
  return value;
}
const server = http.createServer(async (request, response) => {
  let url, pathname;
  try {
    url = new URL(request.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch { response.writeHead(400).end(); return; }
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-cache');
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) { response.writeHead(404).end(); return; }
    const hash = await digest(file, stat), etag = `"${hash}"`;
    const version = url.searchParams.get('v');
    if (version && version !== hash) { response.writeHead(409).end('Asset version changed; reload the page.'); return; }
    response.setHeader('ETag', etag);
    response.setHeader('Last-Modified', stat.mtime.toUTCString());
    response.setHeader('Cache-Control', version ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (request.headers['if-none-match']?.split(',').some(value =>
      value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
      response.writeHead(304).end();
      return;
    }
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    response.setHeader('Content-Length', stat.size);
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch { if (!response.headersSent) response.writeHead(404).end(); else response.destroy(); }
});
server.listen(Number(process.env.PORT || 8765), host, () => {
  const port = server.address().port;
  console.log(`P0 server listening on ${host}:${port}`);
  if (host === '0.0.0.0') {
    console.log(`Local http://127.0.0.1:${port}/build/ue-default-template/index.html`);
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal)
          console.log(`LAN http://${address.address}:${port}/build/ue-default-template/index.html`);
      }
    }
    console.log('LAN HTTP WebGPU requires a trusted origin in the test browser, or HTTPS.');
  } else {
    const address = host.includes(':') ? `[${host}]` : host;
    console.log(`P0 server http://${address}:${port}`);
  }
});
