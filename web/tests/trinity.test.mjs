import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TrinityError, parseTrmdl, parseTrmsh, parseTrmbf, decodeTrinityMeshes
} from '../src/trinity.js';
import { makeTrinityTriangle } from './trinity-fixture.mjs';

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('parse TRMDL companion references and decode TRMSH TRMBF into real geometry', () => {
  const files = makeTrinityTriangle();
  const mdl = parseTrmdl(arrayBuffer(files['models/test.trmdl']));
  assert.deepEqual(mdl.meshFiles, ['test.trmsh']);
  const shape = parseTrmsh(arrayBuffer(files['models/test.trmsh']));
  assert.equal(shape.meshes[0].name, 'Test Pokemon');
  assert.equal(shape.meshes[0].parts[0].count, 3);
  assert.equal(shape.bufferFile, 'test.trmbf');
  const trmbf = parseTrmbf(arrayBuffer(files['models/test.trmbf']));
  assert.equal(trmbf.buffers[0].vertexBuffers[0].byteLength, 36);
  const meshes = decodeTrinityMeshes(shape, trmbf);
  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].vertices.count, 3);
  assert.deepEqual(Array.from(meshes[0].indices), [0, 1, 2]);
  assert.deepEqual(Array.from(meshes[0].vertices.position), [0,0,0, 1,0,0, 0,1,0]);
});

test('reject malformed native Trinity meshes and truncated companion buffers', () => {
  assert.throws(() => parseTrmdl(new ArrayBuffer(4)), TrinityError);
  const files = makeTrinityTriangle();
  const parsed = parseTrmsh(arrayBuffer(files['models/test.trmsh']));
  const buffers = parseTrmbf(arrayBuffer(files['models/test.trmbf']));
  parsed.meshes[0].parts[0].count = 123456;
  assert.throws(() => decodeTrinityMeshes(parsed, buffers), TrinityError);
});
