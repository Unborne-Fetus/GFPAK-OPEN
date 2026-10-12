import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {makeMesh} from '../src/trinity-model.js';

test('vertex joint IDs bind through skeleton joint IDs, independent of influence summary order',()=>{
  const scene=new THREE.Group();
  const root=new THREE.Bone(),helper=new THREE.Bone(),head=new THREE.Bone();
  root.name='root';helper.name='helper';head.name='head';
  root.add(helper);helper.add(head);scene.add(root);scene.updateMatrixWorld(true);
  const rig=new THREE.Skeleton([root,helper,head]);rig.calculateInverses();
  const mesh=makeMesh({name:'eye',material:'eye',indices:new Uint32Array([0,1,2]),
    // This summary is intentionally in a different order from the vertex IDs.
    boneWeights:[{rigIndex:1,weight:3},{rigIndex:0,weight:2}],
    vertices:{count:3,position:new Float32Array([1,0,0,0,1,0,0,0,1]),
      joints:new Float32Array(12),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0])}
  },new THREE.MeshStandardMaterial(),{rig,bones:[root,helper,head],jointNodes:new Map([[0,2]])});
  scene.add(mesh);scene.updateMatrixWorld(true);
  assert.equal(mesh.geometry.getAttribute('skinIndex').getX(0),2);
  head.position.set(2,3,0);scene.updateMatrixWorld(true);rig.update();
  const point=new THREE.Vector3(1,0,0);mesh.applyBoneTransform(0,point);
  assert.deepEqual(point.toArray(),[3,3,0]);
});
