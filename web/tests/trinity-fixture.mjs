/**
 * Original synthetic FlatBuffers Trinity fixtures. Nothing from game files.
 * Corresponds to TRMDL, TRMSH and TRMBF schemas published in GFTool.Core.
 */
import { Builder } from 'flatbuffers';

function tbl(b, count, fields) {
  b.startObject(count);
  for (const [slot, type, value, fallback = 0] of fields) {
    if (type === 'offset') b.addFieldOffset(slot, value, 0);
    else if (type === 'int') b.addFieldInt32(slot, value, fallback);
    else if (type === 'uint') b.addFieldInt32(slot, value, fallback);
    else throw new Error('Unknown field type');
  }
  return b.endObject();
}

function offsets(b, values) {
  b.startVector(4, values.length, 4);
  for (let i = values.length - 1; i >= 0; i--) b.addOffset(values[i]);
  return b.endVector();
}

function bytesOf(b) {
  return b.asUint8Array().slice();
}

function mkTRMDL() {
  const b = new Builder(512);
  const file = b.createString('test.trmsh');
  const mesh = tbl(b, 1, [[0, 'offset', file]]);
  const meshes = offsets(b, [mesh]);
  const root = tbl(b, 7, [[1, 'offset', meshes]]);
  b.finish(root);
  return bytesOf(b);
}

function mkTRMSH() {
  const b = new Builder(1024);
  const buff = b.createString('test.trmbf');
  const shapeName = b.createString('Test Pokemon');
  const matName = b.createString('body');
  // Vertex declaration: X/Y/Z float32 position at stride 12, buffer layer 0.
  const element = tbl(b, 5, [
    [1, 'int', 1], // TRVertexUsage.POSITION
    [3, 'int', 51] // TRVertexFormat.X32_Y32_Z32_FLOAT
  ]);
  const size = tbl(b, 1, [[0, 'int', 12]]);
  const decl = tbl(b, 2, [
    [0, 'offset', offsets(b, [element])],
    [1, 'offset', offsets(b, [size])]
  ]);
  const part = tbl(b, 5, [
    [0, 'int', 3], // 3 vertex indices
    [3, 'offset', matName]
  ]);
  const mesh = tbl(b, 13, [
    [0, 'offset', shapeName],
    [2, 'int', 1], // TRIndexFormat.SHORT
    [3, 'offset', offsets(b, [decl])],
    [4, 'offset', offsets(b, [part])]
  ]);
  const root = tbl(b, 3, [
    [1, 'offset', offsets(b, [mesh])],
    [2, 'offset', buff]
  ]);
  b.finish(root);
  return bytesOf(b);
}

function mkTRMBF() {
  const b = new Builder(1024);
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const input = new Uint8Array(positions.byteLength);
  new Float32Array(input.buffer).set(positions);
  const indexBytes = new Uint8Array([0, 0, 1, 0, 2, 0]);
  const indexBuffer = tbl(b, 1, [[0, 'offset', b.createByteVector(indexBytes)]]);
  const vertexBuffer = tbl(b, 1, [[0, 'offset', b.createByteVector(input)]]);
  const modelBuffer = tbl(b, 3, [
    [0, 'offset', offsets(b, [indexBuffer])],
    [1, 'offset', offsets(b, [vertexBuffer])]
  ]);
  const root = tbl(b, 2, [[1, 'offset', offsets(b, [modelBuffer])]]);
  b.finish(root);
  return bytesOf(b);
}

export function makeTrinityTriangle() {
  return {
    'models/test.trmdl': mkTRMDL(),
    'models/test.trmsh': mkTRMSH(),
    'models/test.trmbf': mkTRMBF(),
  };
}
