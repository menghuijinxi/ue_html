'use strict';
const memoryLimit = 16 * 1024 * 1024;
const diskLimit = 1024 * 1024 * 1024;
const stats = {memoryLimit, memoryBytes: 0, peakMemoryBytes: 0, memoryHits: 0,
  diskReads: 0, diskReadBytes: 0, downloadedBytes: 0, downloads: 0,
  persistentHits: 0, evictions: 0, diskEvictions: 0, activeReads: 0, peakActiveReads: 0};
const assets = new Map(), blocks = new Map(), pendingBlocks = new Map();
const queue = [];
let directory, baseUrl, active = 0;
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  value => value.toString(16).padStart(2, '0')).join('');
const markerName = value => value + '.json';
const lockName = value => 'ue-web-local-' + value;

async function exists(info) {
  try {
    const marker = JSON.parse(await (await directory.getFileHandle(markerName(info.sha256))).getFile()
      .then(file => file.text()));
    const file = await (await directory.getFileHandle(info.sha256 + '.bin')).getFile();
    return marker.sha256 === info.sha256 && marker.size === info.size && file.size === info.size;
  } catch { return false; }
}

async function download(info) {
  const response = await fetch(new URL(info.url + '?v=' + info.sha256, baseUrl));
  if (!response.ok) throw new Error(`Local content download: HTTP ${response.status} (${info.url})`);
  const handle = await directory.getFileHandle(info.sha256 + '.bin', {create: true});
  const writer = await handle.createWritable();
  const reader = response.body.getReader();
  let offset = 0, index = 0, used = 0, received = 0;
  let buffer = new Uint8Array(Math.min(info.blockSize, info.size));
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      stats.downloadedBytes += value.byteLength;
      received += value.byteLength;
      for (let position = 0; position < value.byteLength;) {
        const length = Math.min(buffer.length - used, value.byteLength - position);
        if (!length) throw new Error('Content exceeds the manifest size');
        buffer.set(value.subarray(position, position + length), used);
        used += length;
        position += length;
        if (used === buffer.length) {
          if (await hash(buffer) !== info.blocks[index++]) throw new Error(`Content hash mismatch: ${info.url}`);
          await writer.write(buffer);
          offset += buffer.length;
          used = 0;
          buffer = new Uint8Array(Math.min(info.blockSize, info.size - offset));
        }
      }
      postMessage({progress: {url: info.url, receivedBytes: received, fileBytes: offset,
        totalBytes: info.size}, stats});
    }
    if (used || offset !== info.size || index !== info.blocks.length) throw new Error('Incomplete local content');
    await writer.close();
    const marker = await (await directory.getFileHandle(markerName(info.sha256), {create: true})).createWritable();
    await marker.write(JSON.stringify({sha256: info.sha256, size: info.size, used: Date.now()}));
    await marker.close();
    ++stats.downloads;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function trimDisk(current) {
  const items = [];
  for await (const [name, handle] of directory.entries()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try { items.push(JSON.parse(await (await handle.getFile()).text())); } catch {}
  }
  let bytes = items.reduce((sum, item) => sum + item.size, 0);
  for (const item of items.sort((a, b) => a.used - b.used)) {
    if (bytes <= diskLimit) break;
    if (item.sha256 === current) continue;
    await navigator.locks.request(lockName(item.sha256), {ifAvailable: true}, async lock => {
      if (!lock) return;
      await directory.removeEntry(markerName(item.sha256));
      await directory.removeEntry(item.sha256 + '.bin');
      bytes -= item.size;
      ++stats.diskEvictions;
    });
  }
}

async function asset(info) {
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.blockSize !== 256 * 1024 ||
      !/^[a-f0-9]{64}$/.test(info.sha256) ||
      info.blocks.length !== Math.ceil(info.size / info.blockSize) ||
      !info.blocks.every(value => /^[a-f0-9]{64}$/.test(value)))
    throw new Error('Invalid local content manifest');
  if (!assets.has(info.sha256)) assets.set(info.sha256, (async () => {
    await navigator.locks.request(lockName(info.sha256), async () => {
      if (await exists(info)) ++stats.persistentHits;
      else await download(info);
    });
    // Hold a shared lease while this worker uses the immutable file; old-version cleanup cannot delete it.
    let ready, failed;
    const opened = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    navigator.locks.request(lockName(info.sha256), {mode: 'shared'}, async () => {
      try { ready(await (await directory.getFileHandle(info.sha256 + '.bin')).getFile()); }
      catch (error) { failed(error); return; }
      await new Promise(() => {});
    }).catch(failed);
    const file = await opened;
    await trimDisk(info.sha256);
    return {info, file};
  })());
  return assets.get(info.sha256);
}

async function block(value, index) {
  const {info, file} = value, key = info.sha256 + ':' + index;
  if (blocks.has(key)) {
    const bytes = blocks.get(key);
    blocks.delete(key);
    blocks.set(key, bytes);
    ++stats.memoryHits;
    return bytes;
  }
  if (!pendingBlocks.has(key)) pendingBlocks.set(key, (async () => {
    const offset = index * info.blockSize;
    const bytes = new Uint8Array(await file.slice(offset, Math.min(info.size, offset + info.blockSize)).arrayBuffer());
    if (await hash(bytes) !== info.blocks[index]) {
      await directory.removeEntry(markerName(info.sha256)).catch(() => {});
      throw new Error('Local content is corrupt; reload to rebuild the disk cache');
    }
    ++stats.diskReads;
    stats.diskReadBytes += bytes.length;
    while (stats.memoryBytes + bytes.length > memoryLimit && blocks.size) {
      const oldest = blocks.keys().next().value;
      stats.memoryBytes -= blocks.get(oldest).length;
      blocks.delete(oldest);
      ++stats.evictions;
    }
    blocks.set(key, bytes);
    stats.memoryBytes += bytes.length;
    stats.peakMemoryBytes = Math.max(stats.peakMemoryBytes, stats.memoryBytes);
    return bytes;
  })().finally(() => pendingBlocks.delete(key)));
  return pendingBlocks.get(key);
}

async function execute(message) {
  if (message.type === 'init') {
    baseUrl = message.baseUrl;
    directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('ue-web-local-v1', {create: true});
    return null;
  }
  if (message.type === 'asset') return (await asset(message.info)).file;
  if (message.type === 'clear-memory') {
    blocks.clear();
    stats.memoryBytes = 0;
    return null;
  }
  if (message.type === 'stats') return null;
  if (message.type !== 'read') throw new Error('Unknown local IO request');
  const value = await asset(message.info), {offset, size} = message;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 ||
      offset + size > value.info.size || size > 32 * 1024 * 1024) throw new Error('Invalid local IO range');
  const result = new Uint8Array(size);
  for (let copied = 0; copied < size;) {
    const position = offset + copied, index = Math.floor(position / value.info.blockSize);
    const bytes = await block(value, index), start = position % value.info.blockSize;
    const length = Math.min(size - copied, bytes.length - start);
    result.set(bytes.subarray(start, start + length), copied);
    copied += length;
  }
  return result.buffer;
}

function pump() {
  while (active < 4 && queue.length) {
    const message = queue.shift();
    ++active;
    stats.activeReads = active;
    stats.peakActiveReads = Math.max(stats.peakActiveReads, active);
    execute(message).then(result => {
      postMessage({id: message.id, result, stats}, result instanceof ArrayBuffer ? [result] : []);
    }, error => postMessage({id: message.id, error: error.message, stats})).finally(() => {
      --active;
      stats.activeReads = active;
      pump();
    });
  }
}
onmessage = event => { queue.push(event.data); pump(); };
