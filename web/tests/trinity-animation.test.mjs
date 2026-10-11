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
