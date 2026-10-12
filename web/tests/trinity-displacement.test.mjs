import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Builder} from 'flatbuffers';
import {decodeTrinityMeshes} from '../src/trinity.js';
import {makeMesh,NativeBone} from '../src/trinity-model.js';
import {bakeNativeDisplacement,animateNativeDisplacement} from '../src/trinity-displacement.js';
import {parseMaterialUVAnimation} from '../src/trinity-material-animation.js';

function uvAnimation(){
  const b=new Builder(1024);
  const list=values=>{b.startVector(4,values.length,4);for(const v of values.slice().reverse())b.addOffset(v);return b.endVector();};
  const curve=(first,last)=>{
    const keys=[0,120].map((frame,index)=>{b.startObject(5);b.addFieldFloat32(0,frame,0);b.addFieldFloat32(1,index?last:first,0);b.addFieldInt8(4,1,0);return b.endObject();});
    const v=list(keys);b.startObject(1);b.addFieldOffset(0,v,0);return b.endObject();
  };
  const components=[curve(1,1),curve(1,1),curve(0,1),curve(0,1)];
  b.startObject(4);components.forEach((value,index)=>b.addFieldOffset(index,value,0));const vector=b.endObject();
  const parameterName=b.createString('UVScaleOffset3');b.startObject(2);b.addFieldOffset(0,parameterName,0);b.addFieldOffset(1,vector,0);const parameter=b.endObject();
  const parameters=list([parameter]),materialName=b.createString('effect');b.startObject(3);b.addFieldOffset(0,materialName,0);b.addFieldOffset(2,parameters,0);const material=b.endObject();
  const materials=list([material]);b.startObject(5);b.addFieldOffset(2,materials,0);const track=b.endObject();
  const shapeName=b.createString('effect_shape');b.startObject(6);b.addFieldOffset(0,shapeName,0);b.addFieldOffset(4,track,0);const shape=b.endObject();
  const shapes=list([shape]);b.startObject(2);b.addFieldOffset(1,shapes,0);b.finish(b.endObject());return b.asUint8Array().slice().buffer;
}
function effect(){
  const vertices={count:3,position:new Float32Array([0,0,0,1,0,0,0,1,0]),normal:new Float32Array([0,0,1,0,0,1,0,0,1]),uv:new Float32Array([.25,.5,.25,.5,.25,.5]),uv1:new Float32Array([.75,.5,.75,.5,.75,.5]),color:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0])};
  const root=new THREE.Group(),mesh=makeMesh({name:'effect_shape',material:'effect',vertices,indices:new Uint32Array([0,1,2])},new THREE.MeshBasicMaterial({name:'effect'}));root.add(mesh);
  const texture=new THREE.DataTexture(new Uint8Array([0,0,0,255,255,255,255,255]),2,1);texture.updateMatrix();
  const lookup=new Map([['effect',{shader:{flags:{EnableDisplacementMap:'True'}},displacementMap:texture,scalars:{DisplacementHeight:2}}]]);
  return {root,mesh,lookup};
}
test('secondary UV semantic reads the declared buffer rather than treating UV1 as a second buffer',()=>{
  const values=new Float32Array([0,0,0,.1,.2,.7,.8, 1,0,0,.1,.2,.7,.8, 0,1,0,.1,.2,.7,.8]);
  const descriptor={strides:[28],elements:[{usage:1,layer:0,strideIndex:0,format:51,offset:0},{usage:6,layer:0,strideIndex:0,format:48,offset:12},{usage:6,layer:1,strideIndex:0,format:48,offset:20}]};
  const parts=decodeTrinityMeshes({meshes:[{index:0,name:'effect_shape',indexFormat:1,declarations:[descriptor],parts:[{count:3,offset:0,declaration:0}]}]}, {buffers:[{vertexBuffers:[new Uint8Array(values.buffer)],indexBuffers:[new Uint8Array([0,0,1,0,2,0])]}]});
  assert.ok(Math.abs(parts[0].vertices.uv1[0]-.7)<1e-6);
});
test('native displacement uses UV1 and authored vertex strength and survives ordinary geometry export',()=>{
  const {root,mesh,lookup}=effect();bakeNativeDisplacement(root,lookup);
  assert.equal(mesh.geometry.attributes.position.getZ(0),1);
  assert.equal(mesh.material.isMeshBasicMaterial,true);
  bakeNativeDisplacement(root,lookup);assert.equal(mesh.geometry.attributes.position.getZ(0),1);
});
test('original material UV loop becomes animated morph targets in every exported clip',async()=>{
  const bytes=uvAnimation(),channel=parseMaterialUVAnimation(bytes)[0];
  assert.deepEqual(channel.components[2],[{frame:0,value:0},{frame:120,value:1}]);
  const {root,mesh,lookup}=effect();bakeNativeDisplacement(root,lookup);
  const clip=new THREE.AnimationClip('idle',4,[]);
  await animateNativeDisplacement(root,lookup,{items:[{path:'effect_loop.tracm',getBytes:async()=>bytes}]},[clip]);
  assert.equal(mesh.geometry.morphAttributes.position.length,17);assert.equal(clip.tracks.length,17);
  const mixer=new THREE.AnimationMixer(root);mixer.clipAction(clip).play();mixer.update(.5);
  assert.ok(mesh.morphTargetInfluences[2]>.99);assert.ok(clip.validate());
});
test('compensated tongue segments retract with animated parent scale without accumulating scale',()=>{
  const root=new THREE.Group(),a=new NativeBone(),b=new NativeBone(),c=new NativeBone();
  b.segmentScaleCompensate=c.segmentScaleCompensate=true;b.position.x=c.position.x=1;root.add(a);a.add(b);b.add(c);
  a.scale.x=b.scale.x=c.scale.x=.05;root.updateMatrixWorld(true);
  assert.ok(Math.abs(c.getWorldPosition(new THREE.Vector3()).x-.1)<1e-6);
  assert.ok(Math.abs(c.getWorldScale(new THREE.Vector3()).x-.05)<1e-6);
});

test('GLB retains native smoke morph animations',async()=>{
  const {exportGlb}=await import('../src/model.js');
  const original=globalThis.FileReader;
  globalThis.FileReader=class {
    readAsArrayBuffer(blob){blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();});}
    readAsDataURL(blob){blob.arrayBuffer().then(result=>{this.result='data:'+blob.type+';base64,'+Buffer.from(result).toString('base64');this.onloadend?.();});}
  };
  try{
    const {root,mesh,lookup}=effect();bakeNativeDisplacement(root,lookup);
    const clip=new THREE.AnimationClip('idle',4,[]);
    await animateNativeDisplacement(root,lookup,{items:[{path:'effect_loop.tracm',getBytes:async()=>uvAnimation()}]},[clip]);
    const output=await exportGlb(root,[clip]),view=new DataView(output);
    const json=JSON.parse(new TextDecoder().decode(new Uint8Array(output,20,view.getUint32(12,true))));
    assert.equal(json.meshes[0].primitives[0].targets.length,17);
    assert.ok(json.animations[0].channels.some(channel=>channel.target.path==='weights'));
  }finally{globalThis.FileReader=original;}
});
