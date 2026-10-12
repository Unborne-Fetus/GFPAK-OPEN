import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTrinityTriangle} from './trinity-fixture.mjs';
import {prepareGfpakModelPreview} from '../src/native-gfpak-preview.js';
import {loadTrinityModel} from '../src/trinity-model.js';
import {fnv1a64,parseHashDictionary} from '../src/gfpak.js';

function gfpak(contents,codec=0) {
  const files=Object.entries(contents);
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
    const [name,body]=files[i];
    const at=tableAt+i*24;
    view.setUint16(at+2,codec,true);
    view.setUint32(at+4,body.byteLength,true);
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
