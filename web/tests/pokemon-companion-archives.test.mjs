import test from 'node:test';
import assert from 'node:assert/strict';
import {pokemonArchiveIdentity,selectPokemonCompanionArchives} from '../src/pokemon-companion-archives.js';

const row=name=>({name,size:1024});

test('companion matching groups PLA packs by Pokémon and form, not exact variant filename',()=>{
  const selected=row('section-1/bin/archive/pokemon/pm0036_00_00.gfpak');
  const entries=[
    selected,
    row('section-1/bin/archive/pokemon/pm0036_00.gfpak'),
    row('section-1/bin/archive/pokemon/pm0036_00_00_motion.gfpak'),
    row('section-1/bin/archive/pokemon/pm0036_anim.gfpak'),
    row('section-1/bin/archive/pokemon/pm0036_01_00.gfpak'),
    row('section-1/bin/archive/pokemon/pm0035_00_00.gfpak')
  ];
  const results=selectPokemonCompanionArchives(entries,selected);
  assert.ok(results.some(x=>x.name.endsWith('pm0036_00.gfpak')));
  assert.ok(results.some(x=>x.name.endsWith('pm0036_anim.gfpak')));
  assert.ok(results.some(x=>x.name.endsWith('pm0036_00_00_motion.gfpak')));
  assert.ok(!results.some(x=>x.name.endsWith('pm0035_00_00.gfpak')));
  assert.ok(!results.some(x=>x.name.endsWith('pm0036_01_00.gfpak')));
});

test('companion reader honors total-byte and count budgets',()=>{
  const model=row('pm0025_00_00.gfpak');
  const names=Array.from({length:50},(_,i)=>row('pm0025_00_'+String(i).padStart(2,'0')+'_anim.gfpak'));
  const selected=selectPokemonCompanionArchives([model,...names],model,{maxArchives:3,maxBytes:2048});
  assert.equal(selected.length,2);
  assert.ok(selected.every(x=>x.name.includes('pm0025')));
});

test('only actual pm#### Pokémon identity matches count as valid',()=>{
  assert.equal(pokemonArchiveIdentity('pm0092_00_00.gfpak')?.species,'pm0092');
  assert.equal(pokemonArchiveIdentity('pm0092_00_00.gfpak')?.form,'00');
  assert.equal(pokemonArchiveIdentity('spam0092_anim.gfpak'),null);
});
