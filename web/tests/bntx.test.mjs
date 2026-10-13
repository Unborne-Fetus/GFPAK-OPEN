import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBntx, decodeBntxTexture, BntxError } from '../src/bntx.js';
import { loadDecodedTexture } from '../src/texture-loader.js';
import * as THREE from 'three';
function sampleBntx({format=0x0b01, tileMode=0, width=2, height=2}={}) {
  const bytes=new Uint8Array(0x500),v=new DataView(bytes.buffer);
  const set16=(at,n)=>v.setUint16(at,n,true),set32=(at,n)=>v.setUint32(at,n,true);
  const set64=(at,n)=>v.setBigUint64(at,BigInt(n),true);
  bytes.set(new TextEncoder().encode('BNTX'),0);
  bytes.set([0xff,0xfe],12);
  bytes.set(new TextEncoder().encode('NX  '),0x20);
  set32(0x24,1);set64(0x28,0x80);set64(0x80,0x100);
  bytes.set(new TextEncoder().encode('BRTI'),0x100);
  bytes[0x110]=9;bytes[0x111]=2;set16(0x112,tileMode === 1 ? 0 : 1);set16(0x116,1);
  set32(0x11c,format);set32(0x124,width);set32(0x128,height);
  set32(0x130,1);set32(0x134,0);set32(0x150,256);
  set64(0x160,0x1a0);set64(0x170,0x1b0);set64(0x1b0,0x200);
  set16(0x1a0,4);bytes.set(new TextEncoder().encode('body'),0x1a2);
  return {bytes,v};
}
test('decodes pitch-linear RGBA8 and respects row pitch',()=>{
 const {bytes}=sampleBntx();
 bytes.set([255,0,0,255,0,255,0,255],0x200);
 bytes.set([0,0,255,255,255,255,255,255],0x220);
 const archive=parseBntx(bytes),image=decodeBntxTexture(archive);
 assert.equal(archive.textures[0].name,'body');
 assert.deepEqual([image.width,image.height],[2,2]);
 assert.deepEqual(Array.from(image.data),[255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
});
test('decodes Tegra block-linear BC1 texture',()=>{
 const {bytes}=sampleBntx({format:0x1a01,tileMode:1,width:4,height:4});
 bytes.set([0,0xf8,0x1f,0,0,0,0,0],0x200);
 const image=decodeBntxTexture(parseBntx(bytes));
 assert.deepEqual(Array.from(image.data.slice(0,4)),[255,0,0,255]);
 assert.equal(image.data.length,64);
});
test('decoded Nintendo textures use smooth filtering at their original resolution',async()=>{
 const {bytes}=sampleBntx();
 const texture=await loadDecodedTexture({path:'body.bntx',getBytes:async()=>bytes});
 assert.deepEqual([texture.image.width,texture.image.height],[2,2]);
 assert.equal(texture.magFilter,THREE.LinearFilter);
 assert.equal(texture.minFilter,THREE.LinearMipmapLinearFilter);
 assert.equal(texture.generateMipmaps,true);
 texture.dispose();
});
test('rejects unknown formats and corrupted pointers',()=>{
 const {bytes,v}=sampleBntx({format:0x9901});
 assert.throws(()=>decodeBntxTexture(parseBntx(bytes)),/Unsupported BNTX texture format/);
 v.setBigUint64(0x170,9999999n,true);
 assert.throws(()=>parseBntx(bytes),BntxError);
});

test('BC7 is deswizzled and passed to GPU without fake pixel conversion', async()=>{
 const {bytes}=sampleBntx({format:0x2006,tileMode:1,width:4,height:4});
 bytes.set(new Uint8Array(16).fill(0xab),0x200);
 const decoded=decodeBntxTexture(parseBntx(bytes));
 assert.equal(decoded.compressed,'bc7');
 assert.deepEqual(Array.from(decoded.data),Array(16).fill(0xab));
 const texture=await loadDecodedTexture({path:'body.bntx',getBytes:async()=>bytes});
 assert.ok(texture.isCompressedTexture);
 assert.equal(texture.format,THREE.RGBA_BPTC_Format);
 texture.dispose();
});

test('ASTC 6x6 Nintendo BNTX surfaces use hardware ASTC format',async()=>{
 const {bytes}=sampleBntx({format:0x3101,tileMode:1,width:6,height:6});
 bytes.set(new Uint8Array(16).fill(0x72),0x200);
 const decoded=decodeBntxTexture(parseBntx(bytes));
 assert.equal(decoded.compressed,'astc');
 assert.deepEqual([decoded.blockWidth,decoded.blockHeight],[6,6]);
 const texture=await loadDecodedTexture({path:'body.bntx',getBytes:async()=>bytes});
 assert.equal(texture.format,THREE.RGBA_ASTC_6x6_Format);
 texture.dispose();
});

test('BNTX BC2 explicit alpha keeps per-pixel transparency',()=>{
 const {bytes}=sampleBntx({format:0x1b01,tileMode:1,width:4,height:4});
 bytes.set([0x0f,0,0,0,0,0,0,0,0,0xf8,0x1f,0,0,0,0,0],0x200);
 const image=decodeBntxTexture(parseBntx(bytes));
 assert.deepEqual(Array.from(image.data.slice(0,8)),[255,0,0,255,255,0,0,0]);
});
test('BNTX BC4 and BC5 normal channels decode without external tools',()=>{
 const b4=sampleBntx({format:0x1d01,tileMode:1,width:4,height:4});
 b4.bytes.set([0x7f,0,0,0,0,0,0,0],0x200);
 assert.deepEqual(Array.from(decodeBntxTexture(parseBntx(b4.bytes)).data.slice(0,4)),[127,127,127,255]);
 const b5=sampleBntx({format:0x1e01,tileMode:1,width:4,height:4});
 b5.bytes.set([255,0,0,0,0,0,0,0, 0,255,0,0,0,0,0,0],0x200);
 const decoded=decodeBntxTexture(parseBntx(b5.bytes));
 assert.equal(decoded.data[0],255);
 assert.equal(decoded.data[1],0);
 assert.equal(decoded.data[3],255);
});
test('BNTX R8, RG8, RGB565 and BGRA8 retain channel values',()=>{
 const formats=[
   {format:0x0201,pixel:[99],expected:[99,99,99,255]},
   {format:0x0901,pixel:[21,113],expected:[21,113,0,255]},
   {format:0x0701,pixel:[0,0xf8],expected:[255,0,0,255]},
   {format:0x0c01,pixel:[4,17,250,255],expected:[250,17,4,255]}
 ];
 for(const row of formats){
   const {bytes}=sampleBntx({format:row.format,width:1,height:1});
   bytes.set(row.pixel,0x200);
   const decoded=decodeBntxTexture(parseBntx(bytes));
   assert.deepEqual(Array.from(decoded.data.slice(0,4)),row.expected);
 }
});

test('multiple BNTX textures require an exact surface name',async()=>{
 const {bytes,v}=sampleBntx({width:2,height:2});
 bytes.copyWithin(0x280,0x100,0x178);
 v.setUint32(0x24,2,true);
 v.setBigUint64(0x88,0x280n,true);
 v.setBigUint64(0x2e0,0x1c0n,true);
 v.setBigUint64(0x2f0,0x1d0n,true);
 v.setUint16(0x1c0,4,true);
 bytes.set(new TextEncoder().encode('eyes'),0x1c2);
 v.setBigUint64(0x1d0,0x400n,true);
 bytes.set([255,0,0,255],0x200);
 bytes.set([0,255,0,255],0x400);
 const parsed=parseBntx(bytes);
 assert.equal(parsed.textures.length,2);
 await assert.rejects(() => loadDecodedTexture({
   path:'packed.bntx',getBytes:async()=>bytes
 }),/select a matching internal texture name/);
 const texture=await loadDecodedTexture({
   path:'packed.bntx',getBytes:async()=>bytes
 },true,['eyes']);
 assert.deepEqual(Array.from(texture.image.data.slice(0,4)),[0,255,0,255]);
 texture.dispose();
});

test('BRTI flags and dimension bytes are independent of native tile mode',()=>{
 const {bytes,v}=sampleBntx({format:0x1a01,tileMode:1,width:4,height:4});
 v.setUint16(0x110,0x0209,true);
 v.setUint16(0x112,0,true);
 bytes.set([0,0xf8,0x1f,0,0,0,0,0],0x200);
 const parsed=parseBntx(bytes);
 assert.equal(parsed.textures[0].tileMode,1);
 assert.deepEqual(Array.from(decodeBntxTexture(parsed).data.slice(0,4)),[255,0,0,255]);
});

test('BC5 normal texture reconstructs Z and uses the same UV orientation as BC7',async()=>{
 const {bytes}=sampleBntx({format:0x1e01,tileMode:1,width:4,height:4});
 bytes.set([128,128,0,0,0,0,0,0,128,128,0,0,0,0,0,0],0x200);
 const texture=await loadDecodedTexture({path:'body_nrm.bntx',getBytes:async()=>bytes},false,['NormalMap']);
 assert.ok(texture.image.data[2]>=254);
 assert.equal(texture.flipY,false);
 texture.dispose();
});
