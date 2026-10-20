(function (target) {
  const headerBytes = 28;
  function decode(buffer, expectedPlatform) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength < headerBytes) throw Error('Web shader header truncated');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fields = Array.from({length: 7}, (_, index) => view.getUint32(index * 4, true));
    if (fields[0] !== 0x53475057 || fields[1] !== 1 || fields[2] !== headerBytes ||
        headerBytes + fields[5] + fields[6] !== bytes.byteLength) {
      throw Error('Web shader magic, schema or lengths invalid');
    }
    const utf8 = new TextDecoder('utf-8', {fatal: true});
    const metadata = JSON.parse(utf8.decode(bytes.subarray(headerBytes, headerBytes + fields[5])));
    const wgsl = utf8.decode(bytes.subarray(headerBytes + fields[5]));
    if (metadata.schema !== fields[1] || metadata.frequency !== fields[3] ||
        metadata.formatVersion !== fields[4] || !metadata.bindingContractVerified ||
        !['SF_WEBGPU_ES31', 'SF_WEBGPU_SM5'].includes(metadata.format)) {
      throw Error('Web shader metadata/header mismatch');
    }
    if (expectedPlatform && (metadata.shaderPlatform !== expectedPlatform.name ||
        metadata.shaderPlatformEnum !== expectedPlatform.enum ||
        metadata.shaderPlatformPropertiesHash !== expectedPlatform.propertiesHash ||
        metadata.format !== expectedPlatform.format)) {
      throw Error('Web shader platform/configuration mismatch');
    }
    return {metadata, wgsl};
  }
  if (typeof module !== 'undefined') module.exports = {decode};
  else target.WebShaderCode = {decode};
})(globalThis);
