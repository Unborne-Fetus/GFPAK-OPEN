import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {exportPokemonZip} from '../src/pokemon-export.js';
test('Pokémon ZIP retains original skeleton, textures, all animation companions and unknown files',async()=>{
  const paths=['pm0094.trmdl','pm0094.trskl','pm0094_idle.tranm','pm0094_idle.tracm','pm0094_body.bntx','unresolved.bin','pm0092.trmdl'];
  const project={items:paths.map(path=>({path,getBytes:async()=>new TextEncoder().encode(path)}))};
  const blob=await exportPokemonZip(project,'pm0094.trmdl');
  const zip=await JSZip.loadAsync(await blob.arrayBuffer());
  assert.equal(Object.keys(zip.files).length,7);
  assert.equal(await zip.file('pm0094_idle.tracm').async('string'),'pm0094_idle.tracm');
  assert.equal(zip.file('pm0092.trmdl'),null);
});
test('ZIP export rejects path traversal and fails on an unreadable asset',async()=>{
  await assert.rejects(exportPokemonZip({items:[{path:'../bad',getBytes:async()=>new Uint8Array()}]},'model.trmdl'),/Unsafe/);
  await assert.rejects(exportPokemonZip({items:[{path:'model.trmdl',getBytes:async()=>{throw new Error('decode failed')}}]},'model.trmdl'),/decode failed/);
});

test('Pokédex-ready ZIP embeds the converted GLB, source game and identity metadata',async()=>{
  const raw=new ArrayBuffer(20);
  const view=new DataView(raw);
  view.setUint32(0,0x46546c67,true);
  view.setUint32(4,2,true);
  view.setUint32(8,20,true);
  const project={items:[{path:'pm0094_00_00.trmdl',getBytes:async()=>new Uint8Array([1,2,3])}]};
  const blob=await exportPokemonZip(project,'pm0094_00_00.trmdl',{sourceGame:'sv',glb:raw});
  const zip=await JSZip.loadAsync(await blob.arrayBuffer());
  const manifest=JSON.parse(await zip.file('gfpak-pokemon-export.json').async('string'));
  assert.equal(manifest.format,'gfpak-pokemon-export');
  assert.equal(manifest.version,1);
  assert.equal(manifest.sourceGame,'sv');
  assert.equal(manifest.selectedModel,'pm0094_00_00.trmdl');
  assert.equal(manifest.convertedModel,'pokedex3d/regular.glb');
  assert.equal((await zip.file(manifest.convertedModel).async('arraybuffer')).byteLength,20);
});
test('Raw-only export honestly declares no converted GLB',async()=>{
  const project={items:[{path:'pm0092.trmdl',getBytes:async()=>new Uint8Array([1])}]};
  const zip=await JSZip.loadAsync(await (await exportPokemonZip(project,'pm0092.trmdl')).arrayBuffer());
  const manifest=JSON.parse(await zip.file('gfpak-pokemon-export.json').async('string'));
  assert.equal(manifest.convertedModel,null);
  assert.equal(manifest.conversion,'original-assets-only');
  assert.equal(zip.file('pokedex3d/regular.glb'),null);
});
