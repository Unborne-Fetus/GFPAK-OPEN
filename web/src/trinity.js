/**
 * Browser-native Trinity FlatBuffers readers for model resources from
 * Pokémon Legends: Arceus / Scarlet-Violet / compatible Legends: Z-A.
 *
 * Based on published TRMDL/TRMSH/TRMBF/TRSKL/TRMTR layouts in GFTool.Core.
 * Strictly decodes supplied original geometry; it never fabricates meshes.
 * Proprietary shaders, switch BNTX transcoding and animation tracks require
 * separate game-specific work.
 */
import { FlatModelReader } from './gfbmdl.js';

export class TrinityError extends Error {
  constructor(message) { super(message); this.name = 'TrinityError'; }
}

const MAX_VERTICES = 5_000_000;
const MAX_INDEX_COUNT = 30_000_000;
const MAX_BUFFER = 450 * 1024 * 1024;

const FORMAT_BYTES = Object.freeze({
  20: 4, 22: 4, 39: 8, 43: 8, 48: 8, 51: 12, 52: 16, 54: 16
});
const USAGE = Object.freeze({
  1: 'position', 2: 'normal', 3: 'tangent', 4: 'binormal',
  5: 'color', 6: 'uv', 7: 'joints', 8: 'weights'
});

function createReader(bytes) {
  try { return new FlatModelReader(bytes); }
  catch (error) { throw new TrinityError('Invalid Trinity resource: ' + error.message); }
}

function list(reader, table, index, max = 100_000) {
  try { return reader.objects(table, index, max); }
  catch (error) { throw new TrinityError(error.message); }
}

function float16(bits) {
  const negative = bits & 0x8000 ? -1 : 1;
  const exponent = bits >>> 10 & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return negative * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? 0 : negative * Infinity;
  return negative * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function asVector(reader, table, slot, width = 3, fallback = []) {
  const field = reader.field(table, slot);
  if (!field) return fallback;
  reader.ensure(field, width * 4);
  return Array.from({ length: width }, (_, i) => reader.f32(field + i * 4));
}

export function parseTrmdl(bytes) {
  const reader = createReader(bytes);
  try {
    const model = reader.table(reader.root());
    const meshFiles = list(reader, model, 1, 512).map(item => reader.string(item, 0)).filter(Boolean);
    const skeletonRef = reader.field(model, 2);
    const skeleton = skeletonRef ? reader.string(reader.table(reader.pointer(skeletonRef)), 0) : '';
    const materials = reader.strings(model, 3);
    if (!meshFiles.length) throw new TrinityError('TRMDL contains no mesh references');
    return { version: reader.integer(model, 0), meshFiles, skeleton, materials };
  } catch (error) {
    if (error instanceof TrinityError) throw error;
    throw new TrinityError('Cannot parse TRMDL model descriptor: ' + error.message);
  }
}

export function parseTrmsh(bytes) {
  const reader = createReader(bytes);
  try {
    const model = reader.table(reader.root());
    const meshes = list(reader, model, 1, 4096).map((table, idx) => {
      const declarations = list(reader, table, 3, 32).map(decl => ({
        elements: list(reader, decl, 0, 64).map(item => ({
          strideIndex: reader.integer(item, 0),
          usage: reader.integer(item, 1),
          layer: reader.integer(item, 2),
          format: reader.integer(item, 3),
          offset: reader.integer(item, 4)
        })),
        strides: list(reader, decl, 1, 64).map(item => reader.integer(item, 0))
      }));
      const parts = list(reader, table, 4, 4096).map(item => ({
        count: reader.integer(item, 0),
        offset: reader.integer(item, 1),
        material: reader.string(item, 3),
        declaration: reader.integer(item, 4)
      }));
      const boneWeights = list(reader, table, 10, 20000).map(item => ({
        rigIndex: reader.integer(item, 0),
        weight: reader.field(item, 1) ? reader.f32(reader.field(item, 1)) : 0
      }));
      return {
        index: idx, name: reader.string(table, 0) || 'Shape ' + idx,
        indexFormat: reader.integer(table, 2),
        declarations, parts, boneWeights
      };
    });
    if (!meshes.length) throw new TrinityError('TRMSH contains no mesh shapes');
    const bufferFile = reader.string(model, 2);
    return { version: reader.integer(model, 0), bufferFile, meshes };
  } catch (error) {
    if (error instanceof TrinityError) throw error;
    throw new TrinityError('Cannot parse TRMSH mesh descriptor: ' + error.message);
  }
}

function vectorBytes(reader, table, slot) {
  const vector = reader.vector(table, slot, 1);
  if (!vector) return new Uint8Array();
  if (vector.count > MAX_BUFFER) throw new TrinityError('Trinity resource buffer is unreasonably large');
  return new Uint8Array(reader.bytes, vector.start, vector.count);
}

export function parseTrmbf(bytes) {
  const reader = createReader(bytes);
  try {
    const model = reader.table(reader.root());
    const buffers = list(reader, model, 1, 4096).map(table => {
      const indexBuffers = list(reader, table, 0, 24).map(item => vectorBytes(reader, item, 0));
      const vertexBuffers = list(reader, table, 1, 64).map(item => vectorBytes(reader, item, 0));
      return { indexBuffers, vertexBuffers };
    });
    if (!buffers.length) throw new TrinityError('TRMBF contains no mesh buffers');
    return { version: reader.integer(model, 0), buffers };
  } catch (error) {
    if (error instanceof TrinityError) throw error;
    throw new TrinityError('Cannot parse TRMBF vertex/index buffers: ' + error.message);
  }
}

export function parseTrmtr(bytes) {
  const reader = createReader(bytes);
  try {
    const root = reader.table(reader.root());
    return {
      materials: list(reader, root, 1, 3000).map(table => ({
        name: reader.string(table, 0),
        alphaType: reader.string(table, 15),
        faceCulling: (() => {
          const at = reader.field(table,14);
          return at ? reader.integer(reader.table(reader.pointer(at)),1,-1) : -1;
        })(),
        shaders: list(reader, table, 1, 64).map(t => ({
          name: reader.string(t,0),
          flags: Object.fromEntries(list(reader,t,1,128).map(v => [reader.string(v,0),reader.string(v,1)]))
        })),
        textures: list(reader, table, 2, 128).map(t => ({
          name: reader.string(t, 0),
          file: reader.string(t, 1),
          slot: reader.uint(t, 2)
        })),
        colors: Object.fromEntries(list(reader, table, 7, 128).map(t =>
          [reader.string(t, 0), asVector(reader, t, 1, 4, [])])),
        scalars: Object.fromEntries(list(reader, table, 4, 128).map(t => {
          const at = reader.field(t, 1);
          return [reader.string(t, 0), at ? reader.f32(at) : 0];
        }))
      }))
    };
  } catch (error) {
    throw new TrinityError('Cannot parse TRMTR materials: ' + error.message);
  }
}

export function parseTrskl(bytes) {
  const reader = createReader(bytes);
  try {
    const root = reader.table(reader.root());
    const bones = list(reader, root, 1, 3000).map((table, idx) => {
      const localRef = reader.field(table, 1);
      let scale = [1, 1, 1], rotation = [0, 0, 0], translation = [0, 0, 0];
      if (localRef) {
        const srt = reader.table(reader.pointer(localRef));
        scale = asVector(reader, srt, 0, 3, scale);
        rotation = asVector(reader, srt, 1, 3, rotation);
        translation = asVector(reader, srt, 2, 3, translation);
      }
      return {
        index: idx, name: reader.string(table, 0) || 'joint_' + idx,
        parent: reader.integer(table, 4, -1),
        jointInfoIndex: reader.integer(table, 5, -1),
        scale, rotation, translation
      };
    });
    const joints = list(reader, root, 2, 3000).map(table => {
      const at = reader.field(table, 2);
      const matrix = at ? reader.table(reader.pointer(at)) : null;
      return { segmentScaleCompensate: !!(reader.field(table,0) && reader.u8(reader.field(table,0))),
        inverseBind: matrix ? [0,1,2,3].map(slot =>
        asVector(reader, matrix, slot, 3, [])) : null };
    });
    return { version: reader.uint(root, 0), bones, joints };
  } catch (error) {
    throw new TrinityError('Cannot parse TRSKL skeleton: ' + error.message);
  }
}

function vec(reader, pos, format, usage) {
  switch (format) {
    case 51: return [reader.f32(pos), reader.f32(pos + 4), reader.f32(pos + 8)];
    case 48: return [reader.f32(pos), reader.f32(pos + 4)];
    case 54:
      return usage === 3 || usage === 1
        ? [reader.f32(pos + 4), reader.f32(pos + 8), reader.f32(pos + 12), reader.f32(pos)]
        : [reader.f32(pos), reader.f32(pos + 4), reader.f32(pos + 8), reader.f32(pos + 12)];
    case 43: return Array.from({ length: 4 }, (_, i) => float16(reader.u16(pos + i * 2)));
    case 39: {
      return Array.from({ length: 4 }, (_, i) => {
        const value = reader.u16(pos + i * 2);
        return (usage === 2 || usage === 3 || usage === 4)
          ? Math.max(-1, (value >= 0x8000 ? value - 0x10000 : value) / 32767)
          : value / 65535;
      });
    }
    case 20:
      return Array.from({ length: 4 }, (_, i) => {
        const n = reader.u8(pos + i);
        return usage === 2 || usage === 3 || usage === 4
          ? Math.max(-1, (n < 128 ? n : n - 256) / 127)
          : n / 255;
      });
    case 22: return Array.from({ length: 4 }, (_, i) => reader.u8(pos + i));
    case 52: return Array.from({ length: 4 }, (_, i) => reader.u32(pos + i * 4));
    default: throw new TrinityError('Unknown Trinity vertex attribute format ' + format);
  }
}

function normalizeWeights(weights) {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  return sum > 0 ? weights.map(v => Math.max(0, v) / sum) : weights;
}

function decodeVertices(descriptor, vertexStreams) {
  const position = descriptor.elements.find(e => e.usage === 1);
  if (!position) throw new TrinityError('Mesh declaration is missing POSITION data');
  const posStride = descriptor.strides[position.strideIndex];
  const posBuffer = vertexStreams[position.layer];
  if (!posBuffer || !posStride || posStride < 4 || posStride > 2048)
    throw new TrinityError('Mesh POSITION buffer or stride is missing');
  const count = Math.floor(posBuffer.byteLength / posStride);
  if (count <= 0 || count > MAX_VERTICES) throw new TrinityError('Invalid mesh vertex count');
  const output = {
    count, position: new Float32Array(count * 3),
    normal: null, tangent: null, uv: null, color: null, joints: null, weights: null
  };
  const channels = new Set();
  const readerCache = vertexStreams.map(stream => {
    if (!stream || stream.byteLength < 4) return null;
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    return { view,
      u8: pos => view.getUint8(pos),
      u16: pos => view.getUint16(pos, true),
      u32: pos => view.getUint32(pos, true),
      f32: pos => view.getFloat32(pos, true)
    };
  });
  // UV channels beyond layer 0 and additional skin streams need separate
  // mappings. Decode the primary channel without pretending to preserve others.
  for (const element of descriptor.elements) {
    const channel = USAGE[element.usage];
    if (!channel || channels.has(channel)) continue;
    const stride = descriptor.strides[element.strideIndex];
    const source = vertexStreams[element.layer];
    const bytes = FORMAT_BYTES[element.format];
    if (!source || !stride || !bytes || element.offset < 0 ||
        element.offset + bytes > stride || stride > 2048) {
      if (channel === 'position') throw new TrinityError('Unsupported POSITION vertex format or stride');
      continue;
    }
    const n = channel === 'uv' ? 2 : channel === 'position' || channel === 'normal' ? 3 : 4;
    if (!output[channel]) output[channel] = new Float32Array(count * n);
    const read = readerCache[element.layer];
    if (!read) continue;
    for (let i = 0; i < count; i++) {
      const offset = i * stride + element.offset;
      if (offset + bytes > source.byteLength)
        throw new TrinityError('Vertex stream ends before declared vertices');
      const values = vec(read, offset, element.format, element.usage);
      for (let j = 0; j < n; j++) {
        const value = values[j] ?? (channel === 'color' && j === 3 ? 1 : 0);
        output[channel][i * n + j] = Number.isFinite(value) ? value : 0;
      }
    }
    channels.add(channel);
  }
  if (!channels.has('position')) throw new TrinityError('No decodable position stream found');
  if (output.weights) {
    for (let i = 0; i < count; i++) {
      const start = i * 4;
      output.weights.set(normalizeWeights(Array.from(output.weights.subarray(start, start + 4))), start);
    }
  }
  return output;
}

/**
 * Convert decoded TRMSH + TRMBF into unmodified mesh geometry with part names.
 * Optional TRSKL used later for skinning. Return real geometry or throw.
 */
export function decodeTrinityMeshes(meshFile, bufferFile) {
  const result = [];
  for (const mesh of meshFile.meshes) {
    const buffers = bufferFile.buffers[mesh.index];
    if (!buffers) throw new TrinityError('TRMBF missing vertex data for ' + mesh.name);
    if (![0, 1, 2].includes(mesh.indexFormat)) throw new TrinityError('Unsupported index type');
    const width = 1 << mesh.indexFormat;
    const indexBytes = buffers.indexBuffers[0];
    if (!indexBytes) throw new TrinityError('TRMBF missing LOD0 index buffer');
    const view = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);
    const declarations = mesh.declarations.map(decl => decodeVertices(decl, buffers.vertexBuffers));
    for (const part of mesh.parts) {
      if (part.count <= 0) continue;
      if (part.count % 3 || part.offset < 0 || part.count > MAX_INDEX_COUNT)
        throw new TrinityError('Invalid mesh-part triangle index count');
      const start = part.offset * width;
      const end = start + part.count * width;
      if (!Number.isSafeInteger(end) || end > indexBytes.length)
        throw new TrinityError('TRMBF index buffer is truncated');
      const attrs = declarations[part.declaration] ?? declarations[0];
      if (!attrs) throw new TrinityError('No vertex declaration for mesh part');
      const indices = new Uint32Array(part.count);
      for (let i = 0; i < part.count; i++) {
        const at = start + i * width;
        const index = width === 1 ? view.getUint8(at)
          : width === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
        if (index >= attrs.count) throw new TrinityError('Triangle index outside vertex buffer');
        indices[i] = index;
      }
      result.push({
        name: mesh.name, material: part.material, vertices: attrs,
        indices, boneWeights: mesh.boneWeights
      });
    }
  }
  if (!result.length) throw new TrinityError('Trinity model has no renderable triangle parts');
  return result;
}
