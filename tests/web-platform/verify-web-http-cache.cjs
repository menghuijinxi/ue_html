const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {once} = require('node:events');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'serve.cjs')],
    {env: {...process.env, HOST: '127.0.0.1', PORT: '0'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  try {
    let output = '';
    const origin = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      });
      child.once('exit', code => reject(new Error(`Server exited ${code}: ${output}`)));
    });
    const url = origin + '/web-default-template.html';
    const initial = await fetch(url);
    const body = await initial.arrayBuffer();
    assert.equal(initial.status, 200);
    assert(initial.headers.get('etag'), 'Missing validator; unchanged files will be downloaded again');
    assert(!initial.headers.get('cache-control').includes('no-store'));
    const unchanged = await fetch(url, {headers: {'If-None-Match': initial.headers.get('etag')}});
    assert.equal(unchanged.status, 304);
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    const changed = await fetch(url, {headers: {'If-None-Match': '"old-version"'}});
    assert.equal(changed.status, 200);
    assert.equal((await changed.arrayBuffer()).byteLength, body.byteLength);
    const version = initial.headers.get('etag').replaceAll('"', '');
    const immutable = await fetch(url + '?v=' + version);
    assert(immutable.headers.get('cache-control').includes('immutable'));
    await immutable.body.cancel();
    const stale = await fetch(url + '?v=' + '0'.repeat(64));
    assert.equal(stale.status, 409, 'An obsolete version URL must never serve newer bytes');
    const fixture = path.join(__dirname, 'results/http-cache-fixture.bin');
    fs.writeFileSync(fixture, 'first');
    const first = await fetch(origin + '/results/http-cache-fixture.bin');
    await first.arrayBuffer();
    fs.writeFileSync(fixture, 'changed-version');
    const updated = await fetch(origin + '/results/http-cache-fixture.bin',
      {headers: {'If-None-Match': first.headers.get('etag')}});
    assert.equal(updated.status, 200);
    assert.notEqual(updated.headers.get('etag'), first.headers.get('etag'));
    assert.equal(await updated.text(), 'changed-version');
    const report = {pass: true, date: new Date().toISOString(),
      sourceFiles: [__filename, path.join(__dirname, 'serve.cjs')].map(audit),
      etag: initial.headers.get('etag'), bytes: body.byteLength,
      cacheControl: initial.headers.get('cache-control'), immutable: true, unchangedStatus: unchanged.status,
      staleVersionStatus: stale.status, changedFileStatus: updated.status};
    fs.writeFileSync(path.join(__dirname, 'results/web-http-cache-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
