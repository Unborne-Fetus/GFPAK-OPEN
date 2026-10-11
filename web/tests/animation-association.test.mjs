import test from 'node:test';
import assert from 'node:assert/strict';
import {speciesToken, selectNativeAnimations} from '../src/animation-association.js';

test('Pokémon identifiers are detected only from meaningful path components', () => {
  assert.equal(speciesToken('bin/archive/pokemon/pm0025_00_00.trmdl'), 'pm0025');
  assert.equal(speciesToken('PLA/pm0025/animations/idle.tranm'), 'pm0025');
  assert.equal(speciesToken('random/pm00250/other.tranm'), '');
  assert.equal(speciesToken('generic/anim.tranm'), '');
});

test('animation companion selection prefers matching species from very large game dumps', () => {
  const model = 'bin/archive/pokemon/pm0025_00_00.trmdl';
  const files = Array.from({length:240}, (_, i) => ({
    path:'bin/animation/pokemon/pm' + String(i+1).padStart(4,'0') + '_idle.tranm',
    size:128
  }));
  files.push({path:'bin/archive/pokemon/pm0025_motion.tranm',size:256});
  files.push({path:'bin/animation/pokemon/pm0025_attack.tranm',size:256});
  const selected = selectNativeAnimations(files, model);
  assert.equal(selected.length, 3);
  assert.ok(selected.every(row => row.path.includes('pm0025')));
});

test('shared animations are selected only when located near the model', () => {
  const assets = [
    {path:'pokemon/pm0025/anim/idle.tranm'},
    {path:'pokemon/pm0025/anim/walk.tranm'},
    {path:'other_game/global/idle.tranm'},
    {path:'pokemon/pm0026/anim/run.tranm'},
    {path:'pokemon/pm0025/anim/idle.gif'},
  ];
  const result = selectNativeAnimations(assets,'pokemon/pm0025/model.trmdl');
  assert.deepEqual(result.map(x=>x.path), [
    'pokemon/pm0025/anim/idle.tranm','pokemon/pm0025/anim/walk.tranm'
  ]);
});

test('selection has a strict decoding cap', () => {
  const files = Array.from({length:300}, (_, i) => ({
    path:'pokemon/pm0025/animation/' + i + '.tranm',
    size:20
  }));
  assert.equal(selectNativeAnimations(files,'pokemon/pm0025/model.trmdl').length,64);
  assert.throws(()=>selectNativeAnimations(files,'x.trmdl',900), RangeError);
});
