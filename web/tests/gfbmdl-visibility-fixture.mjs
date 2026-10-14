import {Builder} from 'flatbuffers';
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

