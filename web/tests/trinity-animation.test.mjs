import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeAnimation, NativeAnimationError, unpackQuaternion } from '../src/trinity-animation.js';
import { parseTrskl } from '../src/trinity.js';
import { makeAnimatedTrinityTriangle } from './trinity-animation-fixture.mjs';

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('Trinity skeleton and FramedVector translation animation parse into valid keyframes', () => {
  const source = makeAnimatedTrinityTriangle();
  const skeleton = parseTrskl(arrayBuffer(source['models/test.trskl']));
  assert.equal(skeleton.bones.length, 1);
  assert.equal(skeleton.bones[0].name, 'root');
  assert.equal(skeleton.bones[0].parent, -1);
  const animation = parseNativeAnimation(arrayBuffer(source['models/test.tranm']), 'test.tranm');
  assert.equal(animation.name, 'test');
  assert.equal(animation.frameCount, 2);
  assert.equal(animation.frameRate, 30);
  assert.equal(animation.tracks.length, 1);
  assert.deepEqual(animation.tracks[0].translation.map(k => k.frame), [0, 1]);
  assert.deepEqual(animation.tracks[0].translation[1].value, [0, 0.5, 0]);
});

test('packed native quaternion decoder produces normalized XYZW orientation', () => {
  const quat = unpackQuaternion(0, 0, 0);
  assert.equal(quat.length, 4);
  assert.ok(Math.abs(Math.hypot(...quat) - 1) < 1e-5);
});

test('malformed animation refuses fake playback', () => {
  assert.throws(() => parseNativeAnimation(new ArrayBuffer(5)), NativeAnimationError);
});
