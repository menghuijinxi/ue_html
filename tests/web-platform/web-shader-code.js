(function (target) {
  const headerBytes = 28;
  // Diagnostic JS consumers of Cook packets. The game uses UE's native Compact
  // Binary implementation; this reads only its JSON-compatible metadata subset.
  function decodeMetadataBinary(bytes) {
    const utf8 = new TextDecoder('utf-8', {fatal: true});
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let position = 0;
    const take = (size, end) => {
      if (!Number.isSafeInteger(size) || size < 0 || size > end - position) throw Error('Binary metadata truncated');
      const start = position; position += size; return start;
    };
    const byte = end => bytes[take(1, end)];
    const uint = end => {
      const first = byte(end);
      let count = 1;
      for (let mask = 0x80; mask && (first & mask); mask >>= 1) ++count;
      let value = first & (0xff >>> count);
      for (let index = 1; index < count; ++index) value = value * 256 + byte(end);
      if (!Number.isSafeInteger(value)) throw Error('Binary metadata integer exceeds safe range');
      return value;
    };
    const string = end => {
      const size = uint(end), start = take(size, end);
      return utf8.decode(bytes.subarray(start, start + size));
    };
    function field(end, depth, inheritedType) {
      if (depth > 128) throw Error('Binary metadata nesting exceeds limit');
      const type = inheritedType ?? byte(end);
      if (type & 0x60) throw Error('Binary metadata field flags invalid');
      const name = type & 0x80 ? string(end) : undefined;
      let value;
      switch (type & 0x1f) {
      case 1: value = null; break;
      case 12: value = false; break;
      case 13: value = true; break;
      case 7: value = string(end); break;
      case 8: value = uint(end); break;
      case 9: value = -1 - uint(end); break;
      case 10: value = view.getFloat32(take(4, end), false); break;
      case 11: value = view.getFloat64(take(8, end), false); break;
      case 2: case 3: case 4: case 5: {
        const size = uint(end), containerEnd = position + size;
        if (containerEnd > end) throw Error('Binary metadata container truncated');
        const array = (type & 0x1f) >= 4;
        const count = array ? uint(containerEnd) : null;
        if (count > 1000000) throw Error('Binary metadata array exceeds limit');
        const uniform = type & 1 ? byte(containerEnd) : undefined;
        value = array ? [] : {};
        for (let index = 0; array ? index < count : position < containerEnd; ++index) {
          const child = field(containerEnd, depth + 1, uniform);
          if (array) {
            if (child.name !== undefined) throw Error('Binary metadata array field has a name');
            value.push(child.value);
          } else {
            if (!child.name || Object.hasOwn(value, child.name)) throw Error('Binary metadata object field name invalid');
            Object.defineProperty(value, child.name, {value: child.value, enumerable: true, writable: true, configurable: true});
          }
        }
        if (position !== containerEnd) throw Error('Binary metadata container length mismatch');
        break;
      }
      default: throw Error('Unsupported binary metadata field type');
      }
      return {name, value};
    }
    const root = field(bytes.length, 0);
    if (root.name !== undefined || !root.value || Array.isArray(root.value) || typeof root.value !== 'object' || position !== bytes.length)
      throw Error('Binary metadata root or trailing data invalid');
    return root.value;
  }
  function decode(buffer, expectedPlatform) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength < headerBytes) throw Error('Web shader header truncated');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fields = Array.from({length: 7}, (_, index) => view.getUint32(index * 4, true));
    if (fields[0] !== 0x53475057 || ![1, 2].includes(fields[1]) || fields[2] !== headerBytes ||
        headerBytes + fields[5] + fields[6] !== bytes.byteLength) {
      throw Error('Web shader magic, schema or lengths invalid');
    }
    const utf8 = new TextDecoder('utf-8', {fatal: true});
    const metadataBytes = bytes.subarray(headerBytes, headerBytes + fields[5]);
    const metadata = fields[1] === 2 ? decodeMetadataBinary(metadataBytes) : JSON.parse(utf8.decode(metadataBytes));
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
  if (typeof module !== 'undefined') module.exports = {decode, decodeMetadataBinary};
  else target.WebShaderCode = {decode, decodeMetadataBinary};
})(globalThis);
