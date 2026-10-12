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

test('native multi-axis rest rotations agree with the authored inverse bind pose',async()=>{
  const {buildBones}=await import('../src/trinity-model.js');
  const rotation=[.45,-.7,1.1];
  const qx=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),rotation[0]);
  const qy=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),rotation[1]);
  const qz=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),rotation[2]);
  const authored=new THREE.Matrix4().compose(new THREE.Vector3(2,-1,3),
    qz.multiply(qy).multiply(qx),new THREE.Vector3(1,1,1));
  const inverse=authored.clone().invert(),e=inverse.elements;
  const scene=new THREE.Group();
  const result=buildBones({bones:[{index:0,name:'joint',parent:-1,jointInfoIndex:0,
    translation:[2,-1,3],rotation,scale:[1,1,1]}],joints:[{
      inverseBind:[e.slice(0,3),e.slice(4,7),e.slice(8,11),e.slice(12,15)]
    }]},scene);
  const skin=result.bones[0].matrixWorld.clone().multiply(result.rig.boneInverses[0]);
  skin.elements.forEach((value,i)=>assert.ok(Math.abs(value-(i%5===0?1:0))<1e-6));
  const part={name:'hand',indices:new Uint32Array([0,1,2]),vertices:{count:3,
    position:new Float32Array([1,2,3,2,3,4,3,4,5]),joints:new Float32Array(12),
    weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0])}};
  makeMesh(part,new THREE.MeshStandardMaterial(),result);
  result.rig.boneInverses[0].elements.forEach((value,i)=>
    assert.ok(Math.abs(value-inverse.elements[i])<1e-6));
});
