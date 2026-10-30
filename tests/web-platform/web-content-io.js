'use strict';
class WebLocalContentIO {
  constructor(workerUrl, {verification = 'sampled'} = {}) {
    this.worker = new Worker(workerUrl);
    this.pending = new Map();
    this.requests = new Map();
    this.files = new Map();
    this.sequence = 0;
    this.stats = {};
    this.worker.onmessage = event => {
      const message = event.data;
      this.stats = message.stats;
      if (message.progress) { this.onprogress?.(message.progress); return; }
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      if (message.error) job.reject(new Error(message.error));
      else job.resolve(message.result);
    };
    this.worker.onerror = event => {
      for (const job of this.pending.values()) job.reject(new Error(event.message));
      this.pending.clear();
    };
    this.ready = this.call('init', {baseUrl: location.href, verification});
  }
  call(type, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, {resolve, reject});
      this.worker.postMessage({id, type, ...args});
    });
  }
  async asset(info) { await this.ready; return this.call('asset', {info}); }
  async read(offset, size) {
    await this.ready;
    return new Uint8Array(await this.call('read', {sha256: this.manifest.pack.sha256, offset, size}));
  }
  findFile(path) {
    try { return this.files.get(this.filesystem.lookupPath(path).path); }
    catch { return undefined; }
  }
  async mount(manifest, filesystem) {
    if (!['SP_WEBGPU_ES31', 'SP_WEBGPU_SM5'].includes(manifest.shaderPlatform))
      throw new Error(`Invalid content shader platform: ${manifest.shaderPlatform}`);
    const shaderCachePath = `/Engine/GlobalShaderCache-${manifest.shaderPlatform}.bin`;
    this.manifest = manifest;
    await this.asset(manifest.pack);
    this.filesystem = filesystem;
    const files = manifest.files;
    for (const file of files) {
      if ((!/^\/Engine\/(?:Content\/|Programs\/UEWebEngine\/Content\/)/.test(file.path) &&
          file.path !== shaderCachePath) ||
          /(?:^|\/)\.\.(?:\/|$)/.test(file.path) || !Number.isSafeInteger(file.offset) ||
          !Number.isSafeInteger(file.size) || file.offset < 0 || file.size < 0 ||
          file.offset + file.size > manifest.pack.size) throw new Error(`Invalid content entry: ${file.path}`);
      filesystem.mkdirTree(file.path.slice(0, file.path.lastIndexOf('/')));
      if (file.path.endsWith('.ubulk')) {
        this.files.set(file.path, file);
        filesystem.writeFile(file.path, new Uint8Array());
        const node = filesystem.lookupPath(file.path).node;
        node.usedBytes = file.size;
        node.stream_ops = {...node.stream_ops, read: () => {
          throw new Error(`Synchronous read of streamed bulk data: ${file.path}`);
        }};
      }
    }
    const startup = files.filter(file => !this.files.has(file.path));
    let next = 0, completed = this.files.size;
    await Promise.all(Array.from({length: 4}, async () => {
      while (next < startup.length) {
        const file = startup[next++];
        const stream = filesystem.open(file.path, 'w');
        try {
          const chunkSize = 4 * 1024 * 1024;
          for (let offset = 0; offset < file.size; offset += chunkSize) {
            const bytes = await this.read(file.offset + offset, Math.min(chunkSize, file.size - offset));
            filesystem.write(stream, bytes, 0, bytes.length, offset);
          }
        } finally { filesystem.close(stream); }
        this.onmount?.(++completed, files.length);
      }
    }));
    await this.call('clear-memory');
  }
  readRequest(id, path, offset, size, destination) {
    const token = {};
    this.requests.set(id, token);
    const file = this.findFile(path);
    const task = async () => {
      if (!file || offset < 0 || size < 0 || offset + size > file.size) throw new Error('Invalid bulk IO range');
      const bytes = await this.read(file.offset + offset, size);
      if (this.requests.get(id) !== token) return;
      this.copy(destination, bytes);
      this.requests.delete(id);
      this.complete(id, true);
    };
    task().catch(error => {
      if (this.requests.get(id) !== token) return;
      this.requests.delete(id);
      console.error('Local bulk IO failed:', error);
      this.complete(id, false);
    });
  }
  cancelRequest(id) { this.requests.delete(id); }
}
globalThis.WebLocalContentIO = WebLocalContentIO;
