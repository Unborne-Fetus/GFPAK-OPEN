/**
 * Original synthetic FlatBuffers animation and skeleton fixtures.
 * These contain generated triangles/keyframes, no game asset data.
 */
import { Builder } from 'flatbuffers';
import { makeTrinityTriangle } from './trinity-fixture.mjs';

function offsets(builder, offsetsList) {
  builder.startVector(4, offsetsList.length, 4);
  for (let i = offsetsList.length - 1; i >= 0; i--) builder.addOffset(offsetsList[i]);
  return builder.endVector();
}

function vector3StructList(builder, points) {
  builder.startVector(12, points.length, 4);
  for (let i = points.length - 1; i >= 0; i--) {
    builder.prep(4, 12);
    builder.writeFloat32(points[i][2]);
    builder.writeFloat32(points[i][1]);
    builder.writeFloat32(points[i][0]);
  }
  return builder.endVector();
}

function table(builder, fields, size) {
  builder.startObject(size);
  for (const [slot, kind, value] of fields) {
    if (kind === 'offset') builder.addFieldOffset(slot, value, 0);
    else if (kind === 'int') builder.addFieldInt32(slot, value, 0);
    else if (kind === 'byte') builder.addFieldInt8(slot, value, 0);
  }
  return builder.endObject();
}

function array(b) { return b.asUint8Array().slice(); }

function makeSkeleton() {
  const b = new Builder(512);
  const name = b.createString('root');
  const node = table(b, [[0, 'offset', name], [4, 'int', -1]], 10);
  const nodes = offsets(b, [node]);
  const root = table(b, [[0, 'int', 2], [1, 'offset', nodes]], 6);
  b.finish(root);
  return array(b);
}

function makeTrmdlWithRig() {
  const b = new Builder(512);
  const skeletonName = b.createString('test.trskl');
  const skeleton = table(b, [[0, 'offset', skeletonName]], 1);
  const meshName = b.createString('test.trmsh');
  const mesh = table(b, [[0, 'offset', meshName]], 1);
  const meshes = offsets(b, [mesh]);
  const root = table(b, [[1, 'offset', meshes], [2, 'offset', skeleton]], 7);
  b.finish(root);
  return array(b);
}

function makeTranslationAnimation() {
  const b = new Builder(768);
  const name = b.createString('root');
  const values = vector3StructList(b, [[0, 0, 0], [0, 0.5, 0]]);
  const framed = table(b, [[0, 'offset', values]], 1);
  const track = table(b, [
    [0, 'offset', name],
    [5, 'byte', 2], // FramedVectorTrack union variant
    [6, 'offset', framed]
  ], 7);
  const tracks = offsets(b, [track]);
  const skeletal = table(b, [[0, 'offset', tracks]], 2);
  const info = table(b, [[0, 'int', 1], [1, 'int', 2], [2, 'int', 30]], 3);
  const root = table(b, [[0, 'offset', info], [1, 'offset', skeletal]], 2);
  b.finish(root);
  return array(b);
}

export function makeAnimatedTrinityTriangle() {
  return {
    ...makeTrinityTriangle(),
    'models/test.trmdl': makeTrmdlWithRig(),
    'models/test.trskl': makeSkeleton(),
    'models/test.tranm': makeTranslationAnimation(),
  };
}
