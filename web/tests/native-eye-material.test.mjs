import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterials,applyDecodedTextures} from '../src/trinity-model.js';

function highlightBntx(){
 const bytes=new Uint8Array(0x400),v=new DataView(bytes.buffer);
 const text=(at,s)=>bytes.set(new TextEncoder().encode(s),at);
 const u16=(at,n)=>v.setUint16(at,n,true),u32=(at,n)=>v.setUint32(at,n,true);
 const ptr=(at,n)=>v.setBigUint64(at,BigInt(n),true);
 text(0,'BNTX');u16(12,0xfeff);text(0x20,'NX  ');
 u32(0x24,1);ptr(0x28,0x80);ptr(0x80,0x100);text(0x100,'BRTI');
 bytes[0x110]=9;bytes[0x111]=2;u16(0x112,1);u16(0x116,1);
 u32(0x11c,0x0b01);u32(0x124,2);u32(0x128,2);u32(0x130,1);u32(0x150,64);
 ptr(0x160,0x1a0);ptr(0x170,0x1b0);ptr(0x1b0,0x200);
 u16(0x1a0,4);text(0x1a2,'mask');
 bytes.set([255,255,255,255,0,0,0,255],0x200);
 bytes.set([0,0,0,255,0,0,0,255],0x220);
 return bytes;
}

test('authored eye highlight mask and brightness load even when material name is generic',async()=>{
 const lookup=createMaterials([{materials:[{
  name:'face',textures:[{name:'HighlightMaskMap',file:'highlight.bntx'}],
  colors:{EmissionColorLayer5:[1,1,1,1]},
  scalars:{EmissionIntensityLayer5:.8,Roughness:.2}
 }]}]);
 const created=[];
 await applyDecodedTextures({items:[{path:'highlight.bntx',getBytes:async()=>highlightBntx()}]},
  lookup,'model.trmdl',()=>{},created);
 const mat=lookup.get('face').material;
 assert.ok(mat.isMeshPhysicalMaterial);
 assert.equal(mat.clearcoat,1);
 assert.equal(mat.emissiveIntensity,.8);
 assert.deepEqual(mat.emissive.toArray(),[1,1,1]);
 assert.deepEqual(Array.from(mat.emissiveMap.image.data.slice(0,4)),[255,255,255,255]);
 assert.deepEqual(Array.from(mat.emissiveMap.image.data.slice(4,8)),[0,0,0,255]);
 assert.equal(mat.map,null);
 created.forEach(t=>t.dispose());mat.dispose();
});

test('ordinary eye-named materials without a highlight mask keep standard shading',()=>{
 const lookup=createMaterials([{materials:[{name:'eye',textures:[]}]}]);
 assert.ok(lookup.get('eye').material.isMeshStandardMaterial);
 assert.equal(lookup.get('eye').material.isMeshPhysicalMaterial,undefined);
});
