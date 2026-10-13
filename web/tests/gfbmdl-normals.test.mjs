import test from 'node:test';
import assert from 'node:assert/strict';
import {loadGfbmdl} from '../src/gfbmdl-model.js';
import {makeGfbmdlTriangle} from './native-gfbmdl-sample.mjs';

test('GFBMDL XYZW normals preserve each vertex XYZ and discard W', async () => {
  const bytes=new ArrayBuffer(640);
  new Uint8Array(bytes).set(new Uint8Array(makeGfbmdlTriangle()));
  const v=new DataView(bytes);
  const u16=(o,n)=>v.setUint16(o,n,true), u32=(o,n)=>v.setUint32(o,n,true);
  u32(240,2); u32(248,600-248);
  u16(576,10); u16(578,16); u16(580,4); u16(582,8); u16(584,12);
  v.setInt32(600,24,true); u32(604,1); u32(608,0); u32(612,4);
  u32(320,84);
  const records=[0,0,0,0,0,1,17, 1,0,0,0,1,0,23, 0,1,0,1,0,0,31];
  records.forEach((value,i)=>v.setFloat32(324+i*4,value,true));
  const result=await loadGfbmdl({items:[{path:'sample.gfbmdl',getBytes:async()=>bytes}]},
    'sample.gfbmdl',()=>{}, {fastPreview:true});
  assert.deepEqual(result.root.rotation.toArray().slice(0,3),[0,0,0]);
  const mesh=result.root.children.find(x=>x.isMesh);
  assert.deepEqual([...mesh.geometry.getAttribute('normal').array],[0,0,1,0,1,0,1,0,0]);
  assert.deepEqual([...mesh.geometry.getAttribute('position').array],[0,0,0,1,0,0,0,1,0]);
  result.disposeAssets();
});
