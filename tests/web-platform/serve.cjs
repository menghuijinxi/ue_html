const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = __dirname;
const host = process.env.HOST || '0.0.0.0';
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json'};
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    response.setHeader('Content-Length', stat.size);
    fs.createReadStream(file).pipe(response);
  });
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
