import test from 'node:test';
import assert from 'node:assert/strict';
import {Builder} from 'flatbuffers';
import {parseMeshVisibility} from '../src/trinity-visibility.js';
import {createMaterials,makeMesh} from '../src/trinity-model.js';
function fixture(type,visible) {
  const b=new Builder(256),name=b.createString('alternate_mesh');
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
