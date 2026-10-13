import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {exportPokemonZip} from '../src/pokemon-export.js';
test('Pokémon ZIP retains original skeleton, textures, all animation companions and unknown files',async()=>{
  const paths=['pm0094.trmdl','pm0094.trskl','pm0094_idle.tranm','pm0094_idle.tracm','pm0094_body.bntx','unresolved.bin','pm0092.trmdl'];
  const project={items:paths.map(path=>({path,getBytes:async()=>new TextEncoder().encode(path)}))};
  const blob=await exportPokemonZip(project,'pm0094.trmdl');
  const zip=await JSZip.loadAsync(await blob.arrayBuffer());
  assert.equal(Object.keys(zip.files).length,6);
  assert.equal(await zip.file('pm0094_idle.tracm').async('string'),'pm0094_idle.tracm');
  assert.equal(zip.file('pm0092.trmdl'),null);
});
test('ZIP export rejects path traversal and fails on an unreadable asset',async()=>{
  await assert.rejects(exportPokemonZip({items:[{path:'../bad',getBytes:async()=>new Uint8Array()}]},'model.trmdl'),/Unsafe/);
  await assert.rejects(exportPokemonZip({items:[{path:'model.trmdl',getBytes:async()=>{throw new Error('decode failed')}}]},'model.trmdl'),/decode failed/);
});
