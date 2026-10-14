import test from 'node:test';
import assert from 'node:assert/strict';
import {Builder} from 'flatbuffers';
import * as THREE from 'three';
import {decodeGfbmdl} from '../src/gfbmdl.js';
import {loadGfbmdl} from '../src/gfbmdl-model.js';
import {parseGfbmdlVisibility,applyGfbmdlRestVisibility} from '../src/gfbmdl-visibility.js';
import {makeGfbmdlTriangle} from './native-gfbmdl-sample.mjs';

export function visibilityFixture(name='pm0519_00_LWingSkin', type=1, enabled=false) {
  const b = new Builder(512);
  const target = b.createString(name);
  let keys=0, bits=0;
  if (type === 2) bits=b.createByteVector([0b00000101,0b00000011]);
  if (type === 4) {
    keys=b.createByteVector([0,4,9]);
    bits=b.createByteVector([0b00000101]);
  }
  b.startObject(type===1?1:2);
  if (type===1) b.addFieldInt8(0,enabled?1:0,0);
  else if (type===2) b.addFieldOffset(0,bits,0);
  else { b.addFieldOffset(0,keys,0);b.addFieldOffset(1,bits,0); }
  const data=b.endObject();
  b.startObject(3);
  b.addFieldOffset(0,target,0);
  b.addFieldInt8(1,type,0);
  b.addFieldOffset(2,data,0);
  const track=b.endObject();
  b.startVector(4,1,4);b.addOffset(track);const entries=b.endVector();
  b.startObject(1);b.addFieldOffset(0,entries,0);const skin=b.endObject();
  b.startObject(3);b.addFieldInt32(1,10,0);b.addFieldInt32(2,30,0);
  const info=b.endObject();
  b.startObject(4);b.addFieldOffset(0,info,0);b.addFieldOffset(3,skin,0);
  b.finish(b.endObject());
  const bytes=b.asUint8Array().slice();
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}

// Synthetic geometry plus the real GFBMDL slot-7 mesh/skin-node binding
// layout. This is not game geometry or a copied Nintendo asset.
export function boundTriangle(name='pm0519_00_LWingSkin') {
  const src=makeGfbmdlTriangle(), bytes=new ArrayBuffer(1024);
  new Uint8Array(bytes).set(new Uint8Array(src));
  const d=new DataView(bytes);
  const u16=(at,val)=>d.setUint16(at,val,true);
  const u32=(at,val)=>d.setUint32(at,val,true);
  const i32=(at,val)=>d.setInt32(at,val,true);
  u16(32,24); u16(34,24); // extend model vtable/object for slots 7 and 9
  u16(50,12); u16(54,16);
  u32(76,512-76);u32(80,536-80);
  u32(512,1);u32(516,560-516); // mesh-binding vector
  u32(536,1);u32(540,608-540); // skin-bone vector
  u16(544,8);u16(546,12);u16(548,4);u16(550,8);
  i32(560,16);i32(564,0);i32(568,0); // bone 0 -> mesh 0
  u16(592,6);u16(594,8);u16(596,4);
  i32(608,16);u32(612,640-612);
  const encoded=new TextEncoder().encode(name);
  u32(640,encoded.length);new Uint8Array(bytes,644,encoded.length).set(encoded);
  return bytes;
}

test('GFBANM fixed and bit-packed shape visibility are decoded correctly',()=>{
  const fixed=parseGfbmdlVisibility(visibilityFixture());
  assert.equal(fixed.frameRate,30);
  assert.deepEqual(fixed.channels,[{
    name:'pm0519_00_LWingSkin',frames:[0],values:[false],
  }]);
  const dense=parseGfbmdlVisibility(visibilityFixture('TailSkin',2));
  assert.deepEqual(dense.channels[0].frames,[0,1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(dense.channels[0].values,
    [true,false,true,false,false,false,false,false,true,true]);
  const keyed=parseGfbmdlVisibility(visibilityFixture('TailSkin',4));
  assert.deepEqual(keyed.channels[0],
    {name:'TailSkin',frames:[0,4,9],values:[true,false,true]});
});

test('GFBMDL skin bindings recover authored names for wing/tail visibility',()=>{
  const mdl=decodeGfbmdl(boundTriangle('pm0519_00_LWingSkin'));
  assert.equal(mdl.meshes[0].name,'pm0519_00_LWingSkin');
  assert.equal(mdl.stats.meshCount,1);
});

test('idle visibility works for alternate tails without discarding their mesh',()=>{
  const root=new THREE.Group();
  const primary=new THREE.Mesh(), alternate=new THREE.Mesh();
  primary.name='TailSkin';alternate.name='AlternateTailSkin';
  root.add(primary,alternate);
  assert.equal(applyGfbmdlRestVisibility(root,[
    {name:'TailSkin',frames:[0],values:[true]},
    {name:'AlternateTailSkin',frames:[0],values:[false]},
  ]),2);
  assert.equal(root.children.length,2);
  assert.equal(primary.scale.x,1);
  assert.equal(alternate.scale.x,0);
});

test('native idle Pidove wing state survives preview and becomes an exportable scale track',async()=>{
  const model=boundTriangle();
  const idle=visibilityFixture();
  const files=[
    {path:'pm0519_resource_0000.gfbmdl',bytes:model},
    {path:'pm0519_00_ba10_waitA01.gfbanm',bytes:idle}
  ];
  const project={items:files.map(row=>({
    path:row.path,size:row.bytes.byteLength,
    getBytes:async()=>row.bytes,
  }))};
  const result=await loadGfbmdl(project,files[0].path,()=>{}, {fastPreview:true});
  const mesh=result.root.children.find(child=>child.isMesh);
  assert.equal(mesh.name,'pm0519_00_LWingSkin');
  assert.equal(mesh.scale.x,0);
  await result.postLoad();
  assert.equal(result.animations.length,1);
  const scale=result.animations[0].tracks.find(t=>t.name===mesh.uuid+'.scale');
  assert.ok(scale);
  assert.deepEqual([...scale.values],[0,0,0]);
  assert.equal(scale.getInterpolation(),THREE.InterpolateDiscrete);
  result.disposeAssets();
});
