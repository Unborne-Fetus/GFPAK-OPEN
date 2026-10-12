import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTrinityTriangle} from './trinity-fixture.mjs';
import {Builder} from 'flatbuffers';
import {prepareGfpakModelPreview} from '../src/native-gfpak-preview.js';
import {loadTrinityModel} from '../src/trinity-model.js';
import {fnv1a64,parseHashDictionary} from '../src/gfpak.js';

function gfpak(contents,codec=0,validOodle=false) {
  const files=Object.entries(contents).map(([name,bytes])=>{
    if(codec!==3||!validOodle)return [name,bytes,bytes.byteLength];
    const n=bytes.byteLength;
    if(n<1||n>131071)throw Error('Unsupported fixture size');
    const length=n-1;
    const frame=Uint8Array.from([0x8c,0x06,(length>>16)&255,(length>>8)&255,length&255,...bytes]);
    return [name,frame,n];
  });
  const total=files.length;
  const tableAt=40,hashAt=tableAt+24*total,bodyAt=hashAt+8*total;
  const sizes=files.map(([,body])=>body.byteLength);
  const size=bodyAt+sizes.reduce((a,b)=>a+b,0);
  const array=new Uint8Array(size),view=new DataView(array.buffer);
  array.set(new TextEncoder().encode('GFLXPACK'));
  view.setUint32(8,0x1000,true);
  view.setUint32(16,total,true);
  view.setBigUint64(24,BigInt(tableAt),true);
  view.setBigUint64(32,BigInt(hashAt),true);
  let offset=bodyAt;
  for(let i=0;i<total;i++) {
    const [name,body,rawSize]=files[i];
    const at=tableAt+i*24;
    view.setUint16(at+2,codec,true);
    view.setUint32(at+4,rawSize,true);
    view.setUint32(at+8,body.byteLength,true);
    view.setUint32(at+16,offset,true);
    view.setBigUint64(hashAt+i*8,BigInt('0x'+fnv1a64(name)),true);
    array.set(body,offset);offset+=body.byteLength;
  }
  return new Blob([array]);
}

test('PLA GFPAK with unknown resource hashes still resolves real TRMDL/TRMSH/TRMBF and renders geometry',async()=>{
  const blob=gfpak(makeTrinityTriangle());
  const {project,selected}=await prepareGfpakModelPreview(blob,'pm0025_00_00.gfpak');
  assert.equal(project.items.length,3);
  assert.match(selected,/\.trmdl$/);
  const real=await loadTrinityModel(project,selected,()=>{},{fastPreview:true});
  let geometry=0;
  real.root.traverse(child=>{if(child.isMesh)geometry+=child.geometry.getAttribute('position')?.count||0;});
  assert.equal(geometry,3);
  real.disposeAssets();
});
test('PLA GFPAK with known hash dictionary preserves real original companion filenames',async()=>{
  const blob=gfpak(makeTrinityTriangle());
  const dictionary=parseHashDictionary('models/\ntest.trmdl\ntest.trmsh\ntest.trmbf\n');
  const {project,selected}=await prepareGfpakModelPreview(blob,'pla-pokemon.gfpak',()=>{},dictionary);
  assert.equal(selected,'models/test.trmdl');
  assert.deepEqual(project.items.map(item=>item.path).sort(),Object.keys(makeTrinityTriangle()).sort());
});
test('Invalid Oodle-compressed GFPAK never fabricates a fake model',async()=>{
  const blob=gfpak(makeTrinityTriangle(),3);
  await assert.rejects(prepareGfpakModelPreview(blob,'pla.gfpak'),/No supported TRMDL|Oodle|unsupported compression/);
});

test('Oodle-compressed PLA GFPAK decodes original Trinity mesh and renders in browser',async()=>{
  const archive=gfpak(makeTrinityTriangle(),3,true);
  const {project,selected}=await prepareGfpakModelPreview(archive,'pm0025_00_00.gfpak');
  assert.equal(project.items.length,3);
  const model=await loadTrinityModel(project,selected,()=>{},{fastPreview:true});
  let meshes=0,vertices=0;
  model.root.traverse(o=>{
    if(o.isMesh){meshes++;vertices+=o.geometry.getAttribute('position')?.count||0;}
  });
  assert.equal(meshes,1);
  assert.equal(vertices,3);
  model.disposeAssets();
});

function bareNameTrmdl(names) {
  const b=new Builder(1024);
  const members=names.map(name=>{
    const value=b.createString(name);
    b.startObject(1);b.addFieldOffset(0,value,0);return b.endObject();
  });
  b.startVector(4,members.length,4);
  for(let i=members.length-1;i>=0;i--)b.addOffset(members[i]);
  const list=b.endVector();
  b.startObject(7);b.addFieldOffset(1,list,0);
  b.finish(b.endObject());
  return b.asUint8Array().slice();
}
test('Extensionless head/body/tail resolve across three indistinguishable hashed PLA meshes',async()=>{
  const triangle=makeTrinityTriangle();
  const data={
    'models/pm0094.trmdl':bareNameTrmdl(['head','body','tail']),
    'hidden/mesh_1.trmsh':triangle['models/test.trmsh'],
    'hidden/mesh_2.trmsh':triangle['models/test.trmsh'],
    'hidden/mesh_3.trmsh':triangle['models/test.trmsh'],
    'hidden/buffers.trmbf':triangle['models/test.trmbf']
  };
  const notes=[];
  const result=await prepareGfpakModelPreview(gfpak(data),'pm0094.gfpak',line=>notes.push(line));
  assert.deepEqual(result.project.items.filter(item=>item.path.endsWith('.trmsh'))
    .map(item=>item.path.split('/').at(-1)).sort(),['body.trmsh','head.trmsh','tail.trmsh']);
  assert.match(notes.join(' '),/ambiguous trmsh reference/);
  const loaded=await loadTrinityModel(result.project,result.selected,()=>{},{fastPreview:true});
  let count=0;
  loaded.root.traverse(node=>{if(node.isMesh)count++;});
  assert.equal(count,3);
  loaded.disposeAssets();
});
