import test from 'node:test';
import assert from 'node:assert/strict';
import {Builder} from 'flatbuffers';
import {parseMeshVisibility} from '../src/trinity-visibility.js';
import {createMaterials,makeMesh,applyRestVisibility,loadTrinityModel} from '../src/trinity-model.js';
import {makeTrinityTriangle} from './trinity-fixture.mjs';
import * as THREE from 'three';
function fixture(type,visible,shapeName='alternate_mesh') {
  const b=new Builder(256),name=b.createString(shapeName);
  let keys,values;
  if(type===4) {keys=b.createByteVector([0,38,74]);values=b.createByteVector([2]);}
  b.startObject(2);
  if(type===1)b.addFieldInt8(0,visible?1:0,0);
  else {b.addFieldOffset(0,keys,0);b.addFieldOffset(1,values,0);}
  const data=b.endObject();
  b.startObject(2);b.addFieldInt8(0,type,0);b.addFieldOffset(1,data,0);const union=b.endObject();
  b.startObject(3);b.addFieldOffset(2,union,0);const visibility=b.endObject();
  b.startObject(6);b.addFieldOffset(0,name,0);b.addFieldOffset(5,visibility,0);const shape=b.endObject();
  b.startVector(4,1,4);b.addOffset(shape);const shapes=b.endVector();
  b.startObject(2);b.addFieldOffset(1,shapes,0);b.finish(b.endObject());
  return b.asUint8Array().slice().buffer;
}
test('native visibility retains fixed false and unpacked keyed tongue states',()=>{
  assert.deepEqual(parseMeshVisibility(fixture(1,false))[0].values,[false]);
  assert.deepEqual(parseMeshVisibility(fixture(1,true))[0].values,[true]);
  assert.deepEqual(parseMeshVisibility(fixture(4))[0],{name:'alternate_mesh',frames:[0,38,74],values:[false,true,false]});
});
test('native inverted shells honor culling and vertex data is not automatically diffuse color',()=>{
  const {material}=createMaterials([{materials:[{name:'shell',faceCulling:1,shaders:[{name:'NonDirectional',flags:{EnableVertexBaseColor:'False'}}]}]}]).get('shell');
  assert.equal(material.side,1);
  assert.equal(material.isMeshBasicMaterial,true);
  const mesh=makeMesh({name:'shell',vertices:{count:3,position:new Float32Array(9),color:new Float32Array(12)},indices:new Uint32Array([0,1,2])},material);
  assert.equal(mesh.material.vertexColors,false);
});

test('authored idle visibility hides alternate shape parts without deleting mesh geometry',()=>{
  const scene = new THREE.Group();
  const hidden = new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());
  const normal = new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());
  hidden.name='Alternate_Wing:feather'; normal.name='Normal_Wing:feather';
  scene.add(hidden,normal);
  assert.equal(applyRestVisibility(scene,[
    {name:'alternate_wing',frames:[0],values:[false]},
    {name:'Normal_Wing',frames:[0],values:[true]},
  ]),2);
  assert.equal(hidden.visible,false);
  assert.equal(normal.visible,true);
  assert.equal(hidden.userData.nativeIdleVisibility,true);
  assert.equal(applyRestVisibility(scene,[{name:'Normal_Wing',frames:[9],values:[false]}]),0);
  assert.equal(normal.visible,true);
});

test('Trinity preview honors standalone idle TRACM even with no skeleton/TRANM',async()=>{
  const files={...makeTrinityTriangle(),
    'models/defaultwait.tracm': new Uint8Array(fixture(1,false,'Test Pokemon'))};
  const items=Object.entries(files).map(([path,bytes])=>({
    path,size:bytes.byteLength,getBytes:async()=>bytes,
  }));
  const {root,sourceStats}=await loadTrinityModel({items},
    'models/test.trmdl',()=>{},{fastPreview:true});
  const shapes=[];
  root.traverse(mesh=>{if(mesh.isMesh)shapes.push(mesh);});
  assert.equal(sourceStats.meshParts,1);
  assert.equal(shapes.length,1);
  assert.equal(shapes[0].visible,false);
});
