'use strict';
const http = require('node:http');
const prefix = '/official/';
// Keep both frames on one isolated origin. Preserve official range responses,
// compression and cache validators without changing either published package.
http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405).end();
    return;
  }
  const url = new URL(request.url, 'http://127.0.0.1:8766');
  const official = url.pathname.startsWith(prefix);
  const port = official ? 8900 : 8765;
  const upstream = http.request({
    hostname: '127.0.0.1', port, method: request.method,
    path: (official ? '/' + url.pathname.slice(prefix.length) : url.pathname) + url.search,
    headers: {...request.headers, host: '127.0.0.1:' + port}
  }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, {'Content-Type': 'text/plain; charset=utf-8'});
    response.end('Local villa server unavailable on port ' + port);
  });
  response.on('close', () => upstream.destroy());
  upstream.end();
}).listen(8766, '127.0.0.1', () => {
  console.log('Villa comparison http://127.0.0.1:8766/villa-engine-comparison.html#ours');
});
