import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGfbmdl, GFBMDLError } from '../src/gfbmdl.js';
import { makeGfbmdlTriangle } from './native-gfbmdl-sample.mjs';

test('decode genuine FlatBuffers-format vertex and triangle streams', () => {
  const result = decodeGfbmdl(makeGfbmdlTriangle());
  assert.equal(result.version, 2);
  assert.equal(result.stats.meshCount, 1);
  assert.equal(result.stats.vertexCount, 3);
  assert.equal(result.stats.triangleCount, 1);
  assert.deepEqual(result.meshes[0].indices, [0, 1, 2]);
  assert.deepEqual(Array.from(result.meshes[0].properties.position),
    [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(result.meshes[0].groups[0].count, 3);
});

test('reject truncated or corrupt native model offsets rather than inventing meshes', () => {
  assert.throws(() => decodeGfbmdl(new ArrayBuffer(4)), GFBMDLError);
  const bytes = makeGfbmdlTriangle();
  new DataView(bytes).setUint32(72, 0xFFFFFF00, true);
  assert.throws(() => decodeGfbmdl(bytes), GFBMDLError);
});

test('reject out-of-range face indices', () => {
  const bytes = makeGfbmdlTriangle();
  new DataView(bytes).setUint16(488, 99, true);
  assert.throws(() => decodeGfbmdl(bytes), /missing vertex/);
});
