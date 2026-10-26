import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NativeBone } from '../src/trinity-model.js';
import { prepareRiggedGlbExport } from '../src/segment-scale-export.js';

function near(a, b, tolerance = 1e-4) {
  assert.ok(Math.abs(a-b) < tolerance, a + ' was not approximately ' + b);
}

test('GLB rest and animated poses bake native segment-scale compensation', () => {
  const root = new THREE.Group();
  const parent = new NativeBone();
  parent.name = 'parent';
  parent.scale.set(0.5, 0.5, 0.5);
  const tongue = new NativeBone();
  tongue.name = 'tongue';
  tongue.segmentScaleCompensate = true;
  tongue.position.set(2, 0, 0);
  tongue.scale.set(0.8, 0.8, 0.8);
  parent.add(tongue);
  root.add(parent);
  root.updateMatrixWorld(true);

  const worldBefore = tongue.getWorldPosition(new THREE.Vector3()).x;
  near(worldBefore, 2);
  const clip = new THREE.AnimationClip('idle', 1, [
    new THREE.VectorKeyframeTrack('parent.scale', [0, 1],
      [0.5,0.5,0.5, 0.25,0.25,0.25])
  ]);
  const prepared = prepareRiggedGlbExport(root, [clip]);
  try {
    assert.equal(prepared.compensatedBones, 1);
    assert.equal(tongue.segmentScaleCompensate, false);
    near(tongue.getWorldPosition(new THREE.Vector3()).x, worldBefore);
    const baked = prepared.animations[0];
    assert.ok(baked.tracks.some(track => track.name === 'tongue.position'));
    assert.ok(baked.tracks.some(track => track.name === 'tongue.scale'));
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(baked);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(0.5);
    root.updateMatrixWorld(true);
    near(tongue.getWorldPosition(new THREE.Vector3()).x, 2);
    near(tongue.getWorldScale(new THREE.Vector3()).x, 0.8);
  } finally {
    prepared.restore();
  }
  assert.equal(tongue.segmentScaleCompensate, true);
  near(tongue.position.x, 2);
  near(tongue.scale.x, 0.8);
});

test('non-representable native shears reject export instead of publishing broken limbs', () => {
  const root = new THREE.Group();
  const parent = new NativeBone();
  parent.scale.set(0.4, 1, 1);
  const child = new NativeBone();
  child.name = 'arm';
  child.segmentScaleCompensate = true;
  child.rotation.z = Math.PI / 4;
  parent.add(child);
  root.add(parent);
  assert.throws(() => prepareRiggedGlbExport(root, []),
    /non-TRS shear/);
  assert.equal(child.segmentScaleCompensate, true);
});
