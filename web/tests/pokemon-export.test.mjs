import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {exportPokemonZip,pokemonExportMetadata} from '../src/pokemon-export.js';

function fixtureGlb() {
  const json=new TextEncoder().encode(JSON.stringify({asset:{version:'2.0'},meshes:[{}],animations:[{name:'idle'}]}));
  const length=Math.ceil(json.length/4)*4, bytes=new Uint8Array(20+length), view=new DataView(bytes.buffer);
  view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,bytes.length,true);
  view.setUint32(12,length,true);view.setUint32(16,0x4e4f534a,true);
  bytes.fill(32,20);bytes.set(json,20);return bytes.buffer;
}
test('Pokédex bridge embeds the actual GLB and versioned game metadata, replacing old exports',async()=>{
  const project={items:['pm0212.trmdl','pokedex3d/regular.glb','gfpak-pokemon-export.json']
    .map(path=>({path,getBytes:async()=>new TextEncoder().encode('original')}))};
  const glb=fixtureGlb();
  const zip=await JSZip.loadAsync(await (await exportPokemonZip(project,'pm0212.trmdl',{glb,sourceGame:'pla'})).arrayBuffer());
  assert.deepEqual(await zip.file('pokedex3d/regular.glb').async('uint8array'),new Uint8Array(glb));
  assert.deepEqual(JSON.parse(await zip.file('gfpak-pokemon-export.json').async('string')),
    {format:'gfpak-pokemon-export',version:1,selectedModel:'pm0212.trmdl',sourceGame:'la',
      convertedModel:'pokedex3d/regular.glb',animations:['idle']});
});
test('Pokédex bridge refuses unknown games and malformed GLBs',()=>{
  assert.throws(()=>pokemonExportMetadata('pm0212.trmdl','auto',fixtureGlb()),/Choose the source game/);
  assert.throws(()=>pokemonExportMetadata('pm0212.trmdl','la',new ArrayBuffer(24)),/valid GLB/);
});
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
