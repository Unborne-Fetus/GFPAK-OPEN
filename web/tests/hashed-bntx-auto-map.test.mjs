import test from 'node:test';
import assert from 'node:assert/strict';
import {matchingLinkedDiffuseTexture,matchingLinkedDiffuseSurface} from '../src/texture-loader.js';
import {loadTrinityModel} from '../src/trinity-model.js';
import {makeTrinityTriangle} from './trinity-fixture.mjs';

function bntxForSurface(surface){
  const bytes=new Uint8Array(0x500),v=new DataView(bytes.buffer);
  const text=(at,s)=>bytes.set(new TextEncoder().encode(s),at);
  const u16=(at,n)=>v.setUint16(at,n,true),u32=(at,n)=>v.setUint32(at,n,true);
  const ptr=(at,n)=>v.setBigUint64(at,BigInt(n),true);
  text(0,'BNTX');u16(12,0xfeff);text(0x20,'NX  ');
  u32(0x24,1);ptr(0x28,0x80);ptr(0x80,0x100);text(0x100,'BRTI');
  bytes[0x110]=9;bytes[0x111]=2;u16(0x112,1);u16(0x116,1);
  u32(0x11c,0x0b01);u32(0x124,2);u32(0x128,2);u32(0x130,1);u32(0x150,64);
  ptr(0x160,0x380);ptr(0x170,0x1b0);ptr(0x1b0,0x200);
  u16(0x380,surface.length);text(0x382,surface);
  bytes.set([255,0,0,255,255,0,0,255],0x200);
  bytes.set([255,0,0,255,255,0,0,255],0x220);
  return bytes;
}
const asset=(path,bytes,extras={})=>({
  path,size:bytes.length,getBytes:async()=>bytes,...extras
});

test('hashed BNTX identifies a diffuse surface rather than guessing filenames',()=>{
  const texture={path:'unknown/resource_0011.bntx',linkedKind:'texture',
    textureNames:['pm0025_00_00_body_col','pm0025_00_00_eyes_diffuse','body_nrm']};
  assert.equal(matchingLinkedDiffuseTexture([texture],'body',2),texture);
  assert.equal(matchingLinkedDiffuseSurface(texture,'body'),'pm0025_00_00_body_col');
  assert.equal(matchingLinkedDiffuseSurface(texture,'eyes'),'pm0025_00_00_eyes_diffuse');
  assert.equal(matchingLinkedDiffuseSurface(texture,'tail'),null);
});

test('no automatic association if two internal BNTX surfaces are plausible',()=>{
  const mixed={path:'unknown/resource_011.bntx',linkedKind:'texture',
    textureNames:['body_col','body_diffuse']};
  assert.equal(matchingLinkedDiffuseSurface(mixed,'body'),null);
  assert.equal(matchingLinkedDiffuseTexture([mixed],'body',4),null);
});

test('native TRMDL automatically receives a color texture from its hashed BNTX companion',async()=>{
  const source=makeTrinityTriangle();
  const items=Object.entries(source).map(([path,bytes])=>asset(path,bytes));
  const surface='pm0025_00_00_body_col';
  items.push(asset('unknown/resource_011.bntx',bntxForSurface(surface),
    {linkedKind:'texture',textureNames:[surface]}));
  const logs=[];
  const result=await loadTrinityModel({label:'PLA',items},'models/test.trmdl',
    message=>logs.push(message),{fastPreview:true});
  const mesh=result.root.children.find(o=>o.isMesh);
  assert.ok(mesh);
  assert.equal(mesh.material.map,null);
  await result.postLoad();
  assert.ok(mesh.material.map?.isTexture,logs.join('\n'));
  assert.deepEqual(Array.from(mesh.material.map.image.data.slice(0,4)),[255,0,0,255]);
  assert.match(logs.join(' '),/Automatically applied linked texture/);
  result.disposeAssets();
});
