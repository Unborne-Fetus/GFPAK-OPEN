/** Synthetic rigged GFBMDL fixture for automated tests (not game assets). */
import { makeGfbmdlTriangle } from './native-gfbmdl-sample.mjs';

export function makeGfbmdlWithBone() {
  const result = new Uint8Array(1024);
  result.set(new Uint8Array(makeGfbmdlTriangle()));
  const v = new DataView(result.buffer);
  const u16 = (o,n) => v.setUint16(o,n,true);
  const u32 = (o,n) => v.setUint32(o,n,true);
  const i32 = (o,n) => v.setInt32(o,n,true);
  u16(32,24); // root vtable length including slot 9 bone vector
  u16(34,20); // root object adds fourth field
  u16(54,12); // bone vector slot 9 is at object offset 12
  u32(76,500-76); // relative pointer to bone vector
  u32(500,1);
  u32(504,540-504); // bone table pointer
  u16(520,10); u16(522,16);
  u16(524,4); // name
  u16(526,8); // BoneType
  u16(528,12); // parent
  i32(540,20); // vtable at 520
  u32(544,600-544); // name pointer
  u32(548,1); // deform bone
  i32(552,-1); // root parent
  u32(600,4);
  new TextEncoder().encode('root').forEach((byte,i) => result[604+i]=byte);
  return result.buffer;
}
