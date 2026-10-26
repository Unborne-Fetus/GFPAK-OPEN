import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeAnimation, NativeAnimationError, unpackQuaternion } from '../src/trinity-animation.js';
import { parseTrskl } from '../src/trinity.js';
import { animationTracks } from '../src/trinity-model.js';
import * as THREE from 'three';
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

test('packed quaternion uses smallest-three unit component range, not radians', () => {
  // On-disk word: omitted W (3), positive sign, X at maximum, Y/Z at center.
  const packed = 3n | (32767n << 3n) | (16384n << 18n) | (16384n << 33n);
  const a = Number(packed & 0xffffn);
  const b = Number((packed >> 16n) & 0xffffn);
  const c = Number((packed >> 32n) & 0xffffn);
  const q = unpackQuaternion(a, b, c);
  assert.ok(Math.abs(q[0] - Math.SQRT1_2) < 1e-4);
  assert.ok(Math.abs(q[1]) < 1e-4);
  assert.ok(Math.abs(q[2]) < 1e-4);
  assert.ok(Math.abs(q[3] - Math.SQRT1_2) < 1e-4);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6);
});

test('malformed animation refuses fake playback', () => {
  assert.throws(() => parseNativeAnimation(new ArrayBuffer(5)), NativeAnimationError);
});

test('skeletal clips normalize opposite quaternion signs for smooth interpolation', () => {
  const bone = new THREE.Bone();
  bone.name = 'root';
  const clip = animationTracks({
    name:'Test',frameCount:11,frameRate:30,
    tracks:[{bone:'root',rotation:[
      {frame:0,value:[0,0,0,1]},
      {frame:10,value:[0,0,0,-1]}
    ]}]
  },[bone]);
  assert.ok(clip?.validate());
  assert.deepEqual(Array.from(clip.tracks[0].values.slice(4,8)),[0,0,0,1]);
});

test('ambiguous bone names do not produce incorrectly bound animations', () => {
  const a = new THREE.Bone(), b = new THREE.Bone();
  a.name = 'root'; b.name = 'root';
  assert.equal(animationTracks({
    name:'Test',frameRate:30,frameCount:1,
    tracks:[{bone:'root',translation:[{frame:0,value:[1,2,3]}]}]
  },[a,b]),null);
});
