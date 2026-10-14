/**
 * Browser-native GFBMDL geometry reader for Pokémon Let's Go and Sword/Shield.
 *
 * Independent implementation of the published FlatBuffers Model layout used by
 * the Pokémon Switch Blender add-on. Decodes actual meshes; does NOT decode
 * proprietary shader programs, BNTX textures, or GFBANM animation clips.
 *
 * The FlatBuffers vtable format is self-describing: fields are accessed by
 * index and offset, with strict bounds checks on every read.
 */
export class GFBMDLError extends Error {
  constructor(message) { super(message); this.name = 'GFBMDLError'; }
}

const MAX_BYTES = 450 * 1024 * 1024;
const MAX_VECTOR = 5_000_000;
const MAX_MESHES = 10_000;
const MAX_VERTICES = 5_000_000;
const MAX_TRIANGLES = 10_000_000;

export class FlatModelReader {
  constructor(bytes) {
    if (!(bytes instanceof ArrayBuffer)) throw new GFBMDLError('Model data must be an ArrayBuffer');
    if (bytes.byteLength < 8 || bytes.byteLength > MAX_BYTES)
      throw new GFBMDLError('GFBMDL size is invalid or exceeds the browser safety limit');
    this.bytes = bytes;
    this.view = new DataView(bytes);
    this.decoder = new TextDecoder('utf-8', { fatal: false });
  }

  ensure(offset, size) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) ||
        offset < 0 || size < 0 || offset + size > this.bytes.byteLength)
      throw new GFBMDLError('Invalid FlatBuffers pointer or truncated model data');
  }

  u8(pos) { this.ensure(pos, 1); return this.view.getUint8(pos); }
  u16(pos) { this.ensure(pos, 2); return this.view.getUint16(pos, true); }
  u32(pos) { this.ensure(pos, 4); return this.view.getUint32(pos, true); }
  i32(pos) { this.ensure(pos, 4); return this.view.getInt32(pos, true); }
  f32(pos) { this.ensure(pos, 4); return this.view.getFloat32(pos, true); }
  root() {
    const pointer = this.u32(0);
    this.table(pointer);
    return pointer;
  }

  table(pos) {
    this.ensure(pos, 4);
    const vtable = pos - this.i32(pos);
    this.ensure(vtable, 4);
    const tableSize = this.u16(vtable);
    const objectSize = this.u16(vtable + 2);
    if (tableSize < 4 || tableSize > 8192 || (tableSize & 1) ||
        objectSize < 4 || objectSize > 65535)
      throw new GFBMDLError('Invalid GFBMDL FlatBuffers table layout');
    this.ensure(vtable, tableSize);
    this.ensure(pos, objectSize);
    return { pos, vtable, tableSize, objectSize };
  }

  field(table, slot) {
    const at = table.vtable + 4 + 2 * slot;
    if (at + 2 > table.vtable + table.tableSize) return 0;
    const offset = this.u16(at);
    if (!offset) return 0;
    if (offset >= table.objectSize) throw new GFBMDLError('FlatBuffers field points outside its table');
    return table.pos + offset;
  }

  uint(table, slot, fallback = 0) {
    const pos = this.field(table, slot);
    return pos ? this.u32(pos) : fallback;
  }

  integer(table, slot, fallback = 0) {
    const pos = this.field(table, slot);
    return pos ? this.i32(pos) : fallback;
  }

  pointer(at) {
    this.ensure(at, 4);
    const target = at + this.u32(at);
    this.ensure(target, 4);
    return target;
  }

  vector(table, slot, width = 4) {
    const field = this.field(table, slot);
    if (!field) return null;
    const base = this.pointer(field);
    const count = this.u32(base);
    if (count > MAX_VECTOR) throw new GFBMDLError('Unreasonable FlatBuffers vector size');
    const start = base + 4;
    this.ensure(start, count * width);
    return { start, count };
  }

  objects(table, slot, limit = MAX_MESHES) {
    const info = this.vector(table, slot, 4);
    if (!info) return [];
    if (info.count > limit) throw new GFBMDLError('Too many GFBMDL table entries');
    const result = [];
    for (let i = 0; i < info.count; i++) {
      const at = info.start + i * 4;
      result.push(this.table(this.pointer(at)));
    }
    return result;
  }

  stringAt(at) {
    const ptr = this.pointer(at);
    const length = this.u32(ptr);
    if (length > 1024 * 1024) throw new GFBMDLError('Oversized FlatBuffers string');
    this.ensure(ptr + 4, length);
    return this.decoder.decode(new Uint8Array(this.bytes, ptr + 4, length));
  }

  string(table, slot) {
    const at = this.field(table, slot);
    return at ? this.stringAt(at) : '';
  }

  strings(table, slot) {
    const arr = this.vector(table, slot, 4);
    if (!arr) return [];
    if (arr.count > 10000) throw new GFBMDLError('Too many texture or material names');
    return Array.from({ length: arr.count }, (_, i) => this.stringAt(arr.start + 4 * i));
  }

  vector3(table, slot, defaultValues) {
    const at = this.field(table, slot);
    return at ? [this.f32(at), this.f32(at + 4), this.f32(at + 8)] : defaultValues;
  }
}

function halfToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  if (exp === 0) return sign * fraction * 2 ** -24;
  if (exp === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exp - 15);
}

const FORMAT = Object.freeze({
  0: { width: 4, decode: (r, p) => r.f32(p) },
  1: { width: 2, decode: (r, p) => halfToFloat(r.u16(p)) },
  3: { width: 1, decode: (r, p) => r.u8(p) },
  5: { width: 2, decode: (r, p) => r.u16(p) },
  8: { width: 1, decode: (r, p) => r.u8(p) / 255 },
});

const TYPE = Object.freeze({
  0: 'position', 1: 'normal', 2: 'tangent',
  3: 'uv', 4: 'uv2', 5: 'uv3', 6: 'uv4',
  7: 'color', 8: 'color2', 11: 'joints', 12: 'weights', 13: 'bitangent'
});

function decodeMesh(reader, meshTable, meshIndex) {
  const attrs = reader.objects(meshTable, 1, 64).map(table => {
    const type = reader.uint(table, 0);
    const format = reader.uint(table, 1);
    const components = reader.uint(table, 2);
    if (!(format in FORMAT)) throw new GFBMDLError('Unsupported vertex format ' + format);
    if (components < 1 || components > 16) throw new GFBMDLError('Unsupported vertex component count');
    return { type, format, components, size: FORMAT[format].width * components };
  });

  if (!attrs.length) throw new GFBMDLError('GFBMDL mesh has no vertex attributes');
  const stride = attrs.reduce((sum, attr) => sum + attr.size, 0);
  if (stride < 12 || stride > 1024) throw new GFBMDLError('GFBMDL has implausible vertex stride');

  const dataVector = reader.vector(meshTable, 2, 1);
  if (!dataVector || !dataVector.count || dataVector.count % stride)
    throw new GFBMDLError('GFBMDL vertex data is empty or not aligned');
  const vertices = dataVector.count / stride;
  if (vertices > MAX_VERTICES) throw new GFBMDLError('Too many vertices');
  const properties = {};
  for (const attr of attrs) {
    const semantic = TYPE[attr.type];
    if (semantic && !properties[semantic]) properties[semantic] = new Float32Array(vertices * attr.components);
  }
  if (!properties.position) throw new GFBMDLError('Missing POSITION attribute');

  for (let i = 0; i < vertices; i++) {
    let ptr = dataVector.start + i * stride;
    for (const attr of attrs) {
      const semantic = TYPE[attr.type];
      const dest = semantic ? properties[semantic] : null;
      const decode = FORMAT[attr.format].decode;
      const width = FORMAT[attr.format].width;
      for (let n = 0; n < attr.components; n++) {
        const number = decode(reader, ptr);
        if (dest) dest[i * attr.components + n] = Number.isFinite(number) ? number : 0;
        ptr += width;
      }
    }
  }
  const polygons = reader.objects(meshTable, 0, 4096);
  const indices = [];
  const groups = [];
  let lastGroup = null;
  for (const p of polygons) {
    const materialIndex = reader.uint(p, 0);
    const faces = reader.vector(p, 1, 2);
    if (!faces || faces.count % 3) throw new GFBMDLError('A GFBMDL triangle index buffer is malformed');
    if (indices.length + faces.count > MAX_TRIANGLES * 3)
      throw new GFBMDLError('Too many polygons');
    const start = indices.length;
    for (let i = 0; i < faces.count; i++) {
      const index = reader.u16(faces.start + i * 2);
      if (index >= vertices) throw new GFBMDLError('GFBMDL triangle refers to a missing vertex');
      indices.push(index);
    }
    if (lastGroup && lastGroup.materialIndex === materialIndex &&
        lastGroup.start + lastGroup.count === start) lastGroup.count += faces.count;
    else {
      lastGroup = { start, count: faces.count, materialIndex };
      groups.push(lastGroup);
    }
  }
  if (!indices.length) throw new GFBMDLError('GFBMDL mesh contains no triangles');
  return { index: meshIndex, vertexCount: vertices, properties, indices, groups };
}

/**
 * Decode a GFBMDL file into geometry, texture/material metadata and bones.
 * Does not invent rigging or textures absent from the supplied source.
 */
export function decodeGfbmdl(bytes) {
  const reader = new FlatModelReader(bytes);
  const model = reader.table(reader.root());
  const version = reader.uint(model, 0);
  const textureNames = reader.strings(model, 2);
  const materialNames = reader.strings(model, 5);
  const materials = reader.objects(model, 6).map((table, i) => {
    const maps = reader.objects(table, 11, 128).map(mapTable => ({
      // FlatBuffers omits the schema default (0). The first texture is
      // therefore a valid reference even when the field is absent.
      sampler: reader.string(mapTable, 0), textureIndex: reader.integer(mapTable, 1, 0)
    }));
    return {
      name: reader.string(table, 0) || materialNames[i] || 'Material ' + i,
      renderLayer: reader.integer(table, 2),
      flags: Object.fromEntries(reader.objects(table, 12, 512).map(value => {
        const at = reader.field(value, 1);
        return [reader.string(value, 0), at ? reader.u8(at) !== 0 : false];
      })),
      scalars: Object.fromEntries(reader.objects(table, 13, 512).map(value => {
        const at = reader.field(value, 1);
        return [reader.string(value, 0), at ? reader.f32(at) : 0];
      })),
      maps
    };
  });
  const meshes = reader.objects(model, 8).map((table, i) => decodeMesh(reader, table, i));
  if (!meshes.length) throw new GFBMDLError('GFBMDL contains no model meshes');
  const bones = reader.objects(model, 9, 65536).map((table, i) => ({
    index: i,
    name: reader.string(table, 0) || 'bone_' + i,
    type: reader.uint(table, 1),
    parent: reader.integer(table, 2, -1),
    rigid: !!reader.field(table, 10),
    scale: reader.vector3(table, 5, [1, 1, 1]),
    rotation: reader.vector3(table, 6, [0, 0, 0]),
    translation: reader.vector3(table, 7, [0, 0, 0])
  }));
  const meshCount = meshes.length;
  const vertexCount = meshes.reduce((n, mesh) => n + mesh.vertexCount, 0);
  const triangleCount = meshes.reduce((n, mesh) => n + mesh.indices.length / 3, 0);
  return { version, meshes, bones, materials, textureNames, stats: {
    meshCount, vertexCount, triangleCount, boneCount: bones.length, materialCount: materials.length
  }};
}
