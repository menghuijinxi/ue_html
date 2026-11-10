'use strict';
const memoryLimit = 16 * 1024 * 1024;
const diskLimit = 1024 * 1024 * 1024;
const stats = {memoryLimit, memoryBytes: 0, peakMemoryBytes: 0, memoryHits: 0,
  diskReads: 0, diskReadBytes: 0, downloadedBytes: 0, downloads: 0,
  persistentHits: 0, evictions: 0, diskEvictions: 0, activeReads: 0, peakActiveReads: 0,
  verification: 'sampled', hashedBytes: 0, hashMs: 0, downloadMs: 0, diskReadMs: 0,
  quotaRetries: 0, quotaFailures: 0, reclaimedBytes: 0, missingFileRetries: 0};
const assets = new Map(), blocks = new Map(), pendingBlocks = new Map();
const queue = [];
let directory, baseUrl, active = 0, fullVerification = false;
const hash = async bytes => {
  const started = performance.now();
  const value = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0')).join('');
  stats.hashedBytes += bytes.byteLength;
  stats.hashMs += performance.now() - started;
  return value;
};
const markerName = value => value + '.json';
const lockName = value => 'ue-web-local-' + value;
const cacheDirectory = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('ue-web-local-v1', {create: true});

async function removeEntry(name) {
  try { await directory.removeEntry(name); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

// Call only while holding this asset's exclusive lock.
async function discard(value) {
  await removeEntry(markerName(value));
  await removeEntry(value + '.bin');
}

async function exists(info) {
  try {
    const marker = JSON.parse(await (await directory.getFileHandle(markerName(info.sha256))).getFile()
      .then(file => file.text()));
    const file = await (await directory.getFileHandle(info.sha256 + '.bin')).getFile();
    return marker.sha256 === info.sha256 && marker.size === info.size && file.size === info.size &&
      (!fullVerification || marker.verification === 'full');
  } catch { return false; }
}

async function download(info) {
  const started = performance.now();
  const response = await fetch(new URL(info.url + '?v=' + info.sha256, baseUrl));
  if (!response.ok) throw new Error(`Local content download: HTTP ${response.status} (${info.url})`);
  const reader = response.body.getReader();
  let writer, marker;
  let offset = 0, used = 0, received = 0, previousProgress = 0;
  let buffer = new Uint8Array(Math.min(4 * 1024 * 1024, info.size));
  try {
    const handle = await directory.getFileHandle(info.sha256 + '.bin', {create: true});
    writer = await handle.createWritable();
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
          for (let start = 0; start < buffer.length; start += info.blockSize) {
            const index = (offset + start) / info.blockSize;
            // First/last and one block per 16 MiB catch common failures without hashing gigabytes.
            if (fullVerification || index === 0 || index === info.blocks.length - 1 || index % 64 === 0)
              if (await hash(buffer.subarray(start, Math.min(start + info.blockSize, buffer.length))) !== info.blocks[index])
                throw new Error(`Content hash mismatch: ${info.url}`);
          }
          await writer.write(buffer);
          offset += buffer.length;
          used = 0;
          buffer = new Uint8Array(Math.min(4 * 1024 * 1024, info.size - offset));
        }
      }
      if (performance.now() - previousProgress >= 100 || received === info.size) {
        previousProgress = performance.now();
        postMessage({progress: {url: info.url, receivedBytes: received, fileBytes: offset,
          totalBytes: info.size}, stats});
      }
    }
    if (used || offset !== info.size) throw new Error('Incomplete local content');
    await writer.close();
    marker = await (await directory.getFileHandle(markerName(info.sha256), {create: true})).createWritable();
    await marker.write(JSON.stringify({sha256: info.sha256, size: info.size, used: Date.now(),
      verification: stats.verification}));
    await marker.close();
    ++stats.downloads;
    stats.downloadMs += performance.now() - started;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (writer) await writer.abort().catch(() => {});
    if (marker) await marker.abort().catch(() => {});
    await discard(info.sha256);
    throw error;
  } finally { reader.releaseLock(); }
}

async function trimDisk(quotaRecovery = false) {
  const entries = new Map();
  for await (const [name, handle] of directory.entries()) {
    const match = /^([a-f0-9]{64})\.(json|bin)$/.exec(name);
    if (!match || handle.kind !== 'file') continue;
    const item = entries.get(match[1]) || {sha256: match[1], size: 0, used: 0};
    entries.set(match[1], item);
    try {
      const file = await handle.getFile();
      if (match[2] === 'bin') item.size = file.size;
      else {
        const marker = JSON.parse(await file.text());
        if (Number.isFinite(marker.used)) item.used = marker.used;
      }
    } catch (error) { if (error.name !== 'NotFoundError' && !(error instanceof SyntaxError)) throw error; }
  }
  const items = [...entries.values()];
  let bytes = items.reduce((sum, item) => sum + item.size, 0);
  for (const item of items.sort((a, b) => a.used - b.used)) {
    if (!quotaRecovery && bytes <= diskLimit) break;
    if (assets.has(item.sha256)) continue;
    await navigator.locks.request(lockName(item.sha256), {ifAvailable: true}, async lock => {
      if (!lock) return;
      await discard(item.sha256);
      bytes -= item.size;
      ++stats.diskEvictions;
      stats.reclaimedBytes += item.size;
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
    for (let attempt = 0; ; ++attempt) {
      try { return await openAsset(info); }
      catch (error) {
        if (error.name !== 'NotFoundError' || attempt !== 0) throw error;
        // OPFS can invalidate a cached directory/file handle independently of
        // our Web Locks (for example when browser storage is reclaimed).
        // Reopen from the storage root and revalidate under the exclusive lock.
        // A second disappearance remains an error; never return partial data.
        ++stats.missingFileRetries;
        directory = await cacheDirectory();
      }
    }
  })().catch(error => { assets.delete(info.sha256); throw error; }));
  return assets.get(info.sha256);
}

async function openAsset(info) {
    let opened;
    await navigator.locks.request(lockName(info.sha256), async () => {
      if (await exists(info)) ++stats.persistentHits;
      else {
        try { await download(info); }
        catch (error) {
          if (error.name !== 'QuotaExceededError') throw error;
          ++stats.quotaRetries;
          // Large packs may exceed the normal idle-cache budget. On quota
          // failure reclaim all unused versions, including interrupted files.
          // Active assets in this worker and shared leases in other tabs survive.
          await trimDisk(true);
          try { await download(info); }
          catch (retryError) {
            if (retryError.name === 'QuotaExceededError') {
              ++stats.quotaFailures;
              throw new Error(`Insufficient browser storage for ${info.url} (${info.size} bytes) after reclaiming unused content`);
            }
            throw retryError;
          }
        }
      }
      // Queue the shared lease before releasing the exclusive lock so another
      // worker's quota cleanup cannot delete the file between download and use.
      let ready, failed;
      opened = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
      navigator.locks.request(lockName(info.sha256), {mode: 'shared'}, async () => {
        try { ready(await (await directory.getFileHandle(info.sha256 + '.bin')).getFile()); }
        catch (error) { failed(error); return; }
        await new Promise(() => {});
      }).catch(failed);
    });
    const file = await opened;
    return {info, file};
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
    const started = performance.now(), length = Math.min(info.blockSize, info.size - offset);
    const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    stats.diskReadMs += performance.now() - started;
    if (bytes.length !== length || fullVerification && await hash(bytes) !== info.blocks[index]) {
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
    fullVerification = message.verification === 'full';
    stats.verification = fullVerification ? 'full' : 'sampled';
    directory = await cacheDirectory();
    return null;
  }
  if (message.type === 'asset') return (await asset(message.info)).file;
  if (message.type === 'clear-memory') {
    blocks.clear();
    stats.memoryBytes = 0;
    // Mount has opened the whole bundle; trimming earlier can evict its large content pack during WASM startup.
    await trimDisk();
    return null;
  }
  if (message.type === 'stats') return null;
  if (message.type !== 'read') throw new Error('Unknown local IO request');
  const registered = assets.get(message.sha256);
  if (!registered) throw new Error('Local IO asset is not registered');
  const value = await registered, {offset, size} = message;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 ||
      offset + size > value.info.size || size > 32 * 1024 * 1024) throw new Error('Invalid local IO range');
  if (!fullVerification && size >= value.info.blockSize) {
    const started = performance.now();
    const result = await value.file.slice(offset, offset + size).arrayBuffer();
    stats.diskReadMs += performance.now() - started;
    if (result.byteLength !== size) throw new Error('Incomplete local IO read');
    ++stats.diskReads;
    stats.diskReadBytes += size;
    return result;
  }
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
    }, error => postMessage({id: message.id,
      error: `${message.type}${message.info?.url ? ' ' + message.info.url : ''}: ${error.name}: ${error.message}`, stats})).finally(() => {
      --active;
      stats.activeReads = active;
      pump();
    });
  }
}
onmessage = event => { queue.push(event.data); pump(); };
