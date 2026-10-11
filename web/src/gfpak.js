/**
 * Portable, read-only GFLXPACK parser for browsers and Node.
 * Does not decrypt NSP/NCA data and does not include copyrighted assets.
 * Type 3 (Oodle) blocks remain compressed: a browser cannot load Windows DLLs.
 */
const MAX_FILES = 250000;
const MAX_UNPACKED = 512 * 1024 * 1024;
const decoder = new TextDecoder();

function requireBytes(view, offset, count, field = 'archive') {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) ||
      offset < 0 || count < 0 || offset + count > view.byteLength) {
    throw new Error('Invalid ' + field + ': offset or length outside archive');
  }
}

function u16(view, offset) { requireBytes(view, offset, 2); return view.getUint16(offset, true); }
function u32(view, offset) { requireBytes(view, offset, 4); return view.getUint32(offset, true); }
function u64(view, offset) {
  requireBytes(view, offset, 8);
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Archive offset exceeds JavaScript safe integer range');
  return Number(value);
}
function hash(view, offset) {
  requireBytes(view, offset, 8);
  return view.getBigUint64(offset, true).toString(16).padStart(16, '0');
}

export function parseGfpak(buffer, filename = 'archive.gfpak') {
  if (!(buffer instanceof ArrayBuffer)) throw new TypeError('Expected an ArrayBuffer');
  const view = new DataView(buffer);
  requireBytes(view, 0, 40, 'GFLXPACK header');
  if (decoder.decode(new Uint8Array(buffer, 0, 8)) !== 'GFLXPACK') {
    throw new Error('Not a GFLXPACK archive (.gfpak)');
  }
  const version = u32(view, 8);
  const relocated = u32(view, 12);
  const count = u32(view, 16);
  const folderCount = u32(view, 20);
  if (count > MAX_FILES || folderCount > MAX_FILES) throw new Error('Archive declares too many resources');
  const tableOffset = u64(view, 24);
  const pathsOffset = u64(view, 32);
  requireBytes(view, tableOffset, count * 24, 'resource table');
  requireBytes(view, pathsOffset, count * 8, 'path hashes');
  requireBytes(view, 40, folderCount * 8, 'folder pointers');

  const mapping = new Map();
  for (let i = 0; i < folderCount; i++) {
    const at = u64(view, 40 + i * 8);
    requireBytes(view, at, 16, 'folder header');
    const folderHash = hash(view, at);
    const folderEntries = u32(view, at + 8);
    if (folderEntries > count) throw new Error('Invalid folder resource count');
    requireBytes(view, at + 16, folderEntries * 16, 'folder index');
    for (let j = 0; j < folderEntries; j++) {
      const base = at + 16 + j * 16;
      const fileHash = hash(view, base);
      const index = u32(view, base + 8);
      if (index >= count || mapping.has(index)) throw new Error('Duplicate or invalid resource index');
      mapping.set(index, { folder: i, folderHash, fileHash });
    }
  }
  const resources = [];
  let packedBytes = 0;
  let unpackedBytes = 0;
  const compressionTypes = {};
  for (let i = 0; i < count; i++) {
    const at = tableOffset + i * 24;
    const level = u16(view, at);
    const compression = u16(view, at + 2);
    const size = u32(view, at + 4);
    const packedSize = u32(view, at + 8);
    const offset = u32(view, at + 16);
    // Index huge resources without allocating their decoded payloads.
    requireBytes(view, offset, packedSize, 'resource ' + i);
    const assoc = mapping.get(i) ?? { folder: null, folderHash: null, fileHash: null };
    resources.push({
      index: i, level, compression, size, packedSize, offset,
      pathHash: hash(view, pathsOffset + i * 8),
      ...assoc
    });
    packedBytes += packedSize;
    unpackedBytes += size;
    compressionTypes[compression] = (compressionTypes[compression] ?? 0) + 1;
  }
  return { filename, version, relocated, count, folderCount,
    packedBytes, unpackedBytes, compressionTypes, resources, buffer };
}

/**
 * Open a local File or Blob by reading only index metadata. Even multi-gigabyte
 * GFPAKs stay file-backed; their resources are fetched only when requested.
 * No server, conversion program, or source-file rewrite is involved.
 */
export async function parseGfpakFile(file, filename = file?.name || 'archive.gfpak') {
  if (!file || !Number.isSafeInteger(file.size) || typeof file.slice !== 'function') {
    throw new TypeError('Expected a local File or Blob');
  }
  const read = async (offset, length, label) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || offset > file.size || length > file.size - offset) {
      throw new Error('Invalid ' + label + ': offset or length outside archive');
    }
    return new DataView(await file.slice(offset, offset + length).arrayBuffer());
  };
  const header = await read(0, 40, 'GFLXPACK header');
  if (decoder.decode(new Uint8Array(header.buffer, 0, 8)) !== 'GFLXPACK') {
    throw new Error('Not a GFLXPACK archive (.gfpak)');
  }
  const version = u32(header, 8);
  const relocated = u32(header, 12);
  const count = u32(header, 16);
  const folderCount = u32(header, 20);
  if (count > MAX_FILES || folderCount > MAX_FILES) {
    throw new Error('Archive declares too many resources');
  }
  const tableOffset = u64(header, 24);
  const pathsOffset = u64(header, 32);
  const pointers = await read(40, folderCount * 8, 'folder pointers');
  const table = await read(tableOffset, count * 24, 'resource table');
  const hashes = await read(pathsOffset, count * 8, 'path hashes');
  const mapping = new Map();
  for (let i = 0; i < folderCount; i++) {
    const at = u64(pointers, i * 8);
    const folderHeader = await read(at, 16, 'folder header');
    const folderHash = hash(folderHeader, 0);
    const folderEntries = u32(folderHeader, 8);
    if (folderEntries > count) throw new Error('Invalid folder resource count');
    const entries = await read(at + 16, folderEntries * 16, 'folder index');
    for (let j = 0; j < folderEntries; j++) {
      const base = j * 16;
      const fileHash = hash(entries, base);
      const index = u32(entries, base + 8);
      if (index >= count || mapping.has(index)) throw new Error('Duplicate or invalid resource index');
      mapping.set(index, { folder: i, folderHash, fileHash });
    }
  }
  const resources = [];
  const compressionTypes = {};
  let packedBytes = 0;
  let unpackedBytes = 0;
  for (let i = 0; i < count; i++) {
    const at = i * 24;
    const level = u16(table, at);
    const compression = u16(table, at + 2);
    const size = u32(table, at + 4);
    const packedSize = u32(table, at + 8);
    const offset = u32(table, at + 16);
    if (offset > file.size || packedSize > file.size - offset) {
      throw new Error('Invalid resource ' + i + ': outside archive');
    }
    const assoc = mapping.get(i) ?? { folder: null, folderHash: null, fileHash: null };
    resources.push({
      index: i, level, compression, size, packedSize, offset,
      pathHash: hash(hashes, i * 8), ...assoc
    });
    packedBytes += packedSize;
    unpackedBytes += size;
    compressionTypes[compression] = (compressionTypes[compression] ?? 0) + 1;
  }
  return { filename, version, relocated, count, folderCount,
    packedBytes, unpackedBytes, compressionTypes, resources, file };
}

/** Resolve a single file-backed resource without reading its parent archive. */
export async function extractResourceAsync(archive, resource, { packed = false } = {}) {
  if (archive.resources[resource.index] !== resource) throw new Error('Resource not found');
  if (!archive.file) return extractResource(archive, resource, { packed });
  const block = archive.file.slice(resource.offset, resource.offset + resource.packedSize);
  // Blob slices are zero-copy file references, even for enormous stored files.
  if (packed) return block;
  if (resource.compression === 0) {
    if (resource.size !== resource.packedSize) throw new Error('Invalid stored file size');
    return block;
  }
  if (resource.compression === 3) {
    throw new Error('Oodle compression is not available in the browser. Use Windows GFPAK-OPEN.');
  }
  if (resource.compression !== 2) throw new Error('Unknown GFPAK compression code ' + resource.compression);
  if (resource.size > MAX_UNPACKED || resource.packedSize > MAX_UNPACKED) {
    throw new Error('Compressed resource exceeds the 512 MiB in-memory decoding limit');
  }
  return decompressLz4(new Uint8Array(await block.arrayBuffer()), resource.size);
}

export function summary(archive) {
  const { buffer: _privateBuffer, file: _privateFile, resources, ...meta } = archive;
  return { ...meta, resources: resources.map(({ ...r }) => r) };
}

/** Decode an LZ4 raw block. Bounds checked and output size capped. */
export function decompressLz4(block, expected) {
  if (!(block instanceof Uint8Array)) block = new Uint8Array(block);
  if (!Number.isInteger(expected) || expected < 0 || expected > MAX_UNPACKED) {
    throw new Error('Invalid LZ4 output length');
  }
  const output = new Uint8Array(expected);
  let src = 0;
  let dst = 0;
  while (src < block.length) {
    const token = block[src++];
    let literal = token >>> 4;
    if (literal === 15) {
      let extra;
      do {
        if (src >= block.length) throw new Error('Truncated LZ4 literal length');
        extra = block[src++];
        literal += extra;
      } while (extra === 255);
    }
    if (src + literal > block.length || dst + literal > output.length) {
      throw new Error('Invalid LZ4 literal run');
    }
    output.set(block.subarray(src, src + literal), dst);
    src += literal;
    dst += literal;
    if (src === block.length) break;
    if (src + 2 > block.length) throw new Error('Truncated LZ4 match offset');
    const back = block[src] | (block[src + 1] << 8);
    src += 2;
    if (!back || back > dst) throw new Error('Invalid LZ4 backreference');
    let match = (token & 15) + 4;
    if ((token & 15) === 15) {
      let extra;
      do {
        if (src >= block.length) throw new Error('Truncated LZ4 match length');
        extra = block[src++];
        match += extra;
      } while (extra === 255);
    }
    if (dst + match > output.length) throw new Error('LZ4 output overflow');
    for (let i = 0; i < match; i++) output[dst + i] = output[dst + i - back];
    dst += match;
  }
  if (dst !== expected) throw new Error('LZ4 decoded ' + dst + ' bytes; expected ' + expected);
  return output;
}

export function extractResource(archive, resource, { packed = false } = {}) {
  if (archive.resources[resource.index] !== resource) throw new Error('Resource not found');
  if (!(archive.buffer instanceof ArrayBuffer)) {
    throw new Error('File-backed GFPAK requires extractResourceAsync');
  }
  if (resource.size > MAX_UNPACKED || resource.packedSize > MAX_UNPACKED) {
    throw new Error('Resource exceeds the 512 MiB in-memory decoding limit');
  }
  const data = new Uint8Array(archive.buffer, resource.offset, resource.packedSize);
  if (packed) return new Uint8Array(data);
  if (resource.compression === 0) {
    if (resource.size !== data.byteLength) throw new Error('Invalid stored file size');
    return new Uint8Array(data);
  }
  if (resource.compression === 2) return decompressLz4(data, resource.size);
  if (resource.compression === 3) throw new Error('Oodle compression is not available in the browser. Use Windows GFPAK-OPEN for this resource.');
  throw new Error('Unknown GFPAK compression code ' + resource.compression);
}

export function fnv1a64(name) {
  let hashValue = 0xCBF29CE484222325n;
  for (const byte of new TextEncoder().encode(name)) {
    hashValue = ((hashValue ^ BigInt(byte)) * 0x100000001B3n) & 0xFFFFFFFFFFFFFFFFn;
  }
  return hashValue.toString(16).padStart(16, '0');
}

/** Support name-per-line lists and the folder-per-line convention. */
export function parseHashDictionary(text, isJson = false) {
  const map = new Map();
  if (isJson) {
    const parsed = JSON.parse(text);
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^(?:0x)?[a-f0-9]{16}$/i.test(key) || typeof value !== 'string') throw new Error('Invalid hash dictionary');
      map.set(key.replace(/^0x/i, '').toLowerCase(), value);
    }
  } else {
    let folder = '';
    for (const raw of text.split(/\r?\n/)) {
      const name = raw.trim().replace(/\\/g, '/');
      if (!name || name.startsWith('#') || name.startsWith('//')) continue;
      if (name.endsWith('/')) { folder = name; continue; }
      const full = name.includes('/') ? name : folder + name;
      for (const candidate of [full, name, full.toLowerCase()]) {
        map.set(fnv1a64(candidate), full);
      }
    }
  }
  return map;
}

export function resolvedName(resource, hashMap) {
  return hashMap?.get(resource.pathHash) ?? hashMap?.get(resource.fileHash) ?? null;
}
