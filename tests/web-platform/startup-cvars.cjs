'use strict';
// Shared test helper: append console variables to the packaged WebEngine.ini
// before engine startup. Usage: --cvars=r.Name=1,r.Other=0. The applied
// settings and resulting file hash are recorded in the caller's report.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
module.exports = async function applyStartupCvars(context, argv, report) {
  const text = argv.find(a => a.startsWith('--cvars='))?.slice(8);
  if (!text) return;
  const settings = text.split(',').filter(Boolean).map(v => v.split('='));
  assert(settings.length && settings.every(v => v.length === 2 && /^[A-Za-z0-9_.]+$/.test(v[0]) && /^-?[0-9.]+$/.test(v[1])), 'Invalid --cvars');
  await context.route('**/config-files.json*', async route => {
    const response = await route.fetch(), files = await response.json();
    const file = files.find(f => f.path === '/Engine/Platforms/Web/Config/WebEngine.ini'); assert(file);
    const data = Buffer.from(Buffer.from(file.data, 'base64').toString() + '\n[SystemSettings]\n' + settings.map(v => v.join('=')).join('\n') + '\n');
    file.data = data.toString('base64'); file.sha256 = crypto.createHash('sha256').update(data).digest('hex');
    report.startupConfig = {path: file.path, sha256: file.sha256, settings};
    await route.fulfill({response, body: JSON.stringify(files)});
  });
};
