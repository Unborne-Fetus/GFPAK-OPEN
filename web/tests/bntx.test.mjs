import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBntx, decodeBntxTexture, BntxError } from '../src/bntx.js';
function sampleBntx({format=0x0b01, tileMode=0, width=2, height=2}={}) {
  const bytes=new Uint8Array(0x500),v=new DataView(bytes.buffer);
  const set16=(at,n)=>v.setUint16(at,n,true),set32=(at,n)=>v.setUint32(at,n,true);
  const set64=(at,n)=>v.setBigUint64(at,BigInt(n),true);
  bytes.set(new TextEncoder().encode('BNTX'),0);
  bytes.set([0xff,0xfe],12);
  bytes.set(new TextEncoder().encode('NX  '),0x20);
  set32(0x24,1);set64(0x28,0x80);set64(0x80,0x100);
  bytes.set(new TextEncoder().encode('BRTI'),0x100);
  bytes[0x110]=tileMode;set16(0x116,1);
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
test('rejects unknown formats and corrupted pointers',()=>{
 const {bytes,v}=sampleBntx({format:0x9901});
 assert.throws(()=>decodeBntxTexture(parseBntx(bytes)),/Unsupported BNTX texture format/);
 v.setBigUint64(0x170,9999999n,true);
 assert.throws(()=>parseBntx(bytes),BntxError);
});
