'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
const limit = 32 * 1024 * 1024;
module.exports = async function exportTurn(request, response) {
  const reply = (status, value) => response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'}).end(JSON.stringify(value));
  if (request.method !== 'POST') return reply(405, {error: 'Only POST is supported'});
  // Only the same-origin diagnostic page can ask this local preview server to save.
  if (request.headers.origin !== 'http://' + request.headers.host ||
      !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''))
    return reply(403, {error: 'Require a same-origin JSON request'});
  if (Number(request.headers['content-length']) > limit) return reply(413, {error: 'Recording exceeds 32 MB'});
  try {
    let length = 0; const chunks = [];
    for await (const chunk of request) {
      length += chunk.length;
      if (length > limit) return reply(413, {error: 'Recording exceeds 32 MB'});
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.version !== 1 || data.kind !== 'villa-manual-turn' || !Array.isArray(data.records) ||
        !data.records.length || data.records.length > 100 ||
        data.records.some(record => !record.metadata || !Array.isArray(record.frames) ||
          !Array.isArray(record.contexts) || !Array.isArray(record.events)) ||
        !data.records.some(record => record.frames.length > 1))
      return reply(400, {error: 'Invalid or empty recording'});
    const directory = assertProjectOutputTree(path.join(__dirname, 'results/villa-turn-manual'));
    fs.mkdirSync(directory, {recursive: true});
    const name = 'villa-turn-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8) + '.json';
    const file = assertProjectOutput(path.join(directory, name));
    await fs.promises.writeFile(file, JSON.stringify(data), {flag: 'wx'});
    reply(201, {file: name, path: file, url: '/results/villa-turn-manual/' + name});
  } catch (error) {
    reply(error instanceof SyntaxError ? 400 : 500, {error: error instanceof SyntaxError ? 'Invalid JSON' : error.message});
  }
};
