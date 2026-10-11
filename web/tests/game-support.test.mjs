import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, detectGameFromNames, identifyFormat, describeSource, gameById, gameCapabilities } from '../src/game-support.js';

test('major games from Lets Go through Z-A and DLC all have independent profiles', () => {
 for(const id of ['lgpe','swsh','bdsp','pla','sv','za'])assert.ok(gameById(id).engine);
 assert.match(gameById('za').name,/Mega Dimension/);
 assert.match(gameById('swsh').name,/DLC/);
});
test('detect profile from directory or archive labels but not extension alone', () => {
 assert.equal(detectGameFromNames(['game/legends_za/model.trmdl']).id,'za');
 assert.equal(detectGameFromNames(['mega_dimension/model.trmdl']).id,'za');
 assert.equal(detectGameFromNames(['SwordShield/model.gfbmdl']).id,'swsh');
 assert.equal(detectGameFromNames(['Scarlet_Violet/model.trmdl']).id,'sv');
 assert.equal(detectGameFromNames(['model.trmdl']).id,'auto');
});
test('separate native files from browser-renderable meshes', () => {
 const x=identifyFormat(['x.trmdl','x.glb','z.gfbmdl','a.unity3d','b.nusrcmdlb','c.gfpak']);
 assert.equal(x.converted.length,1);
 assert.equal(x.native.length,5);
 assert.equal(x.hasUnity,true);
 assert.equal(x.hasSnap,true);
});
test('unknown native formats never falsely claim a complete rendering', () => {
 assert.equal(describeSource('za',['pokemon.trmdl']).kind,'native');
 assert.equal(describeSource('bdsp',['a.unity3d']).kind,'native');
 assert.equal(describeSource('lgpe',['pokemon.glb']).kind,'renderable');
});

test('format support is reported separately from successful NSP/XCI browsing', () => {
 for (const id of ['lgpe','swsh','pla','sv','za','bdsp','snap','other']) {
   const capabilities = gameCapabilities(id);
   assert.ok(capabilities.archives);
   assert.ok(capabilities.models);
   assert.ok(capabilities.textures);
   assert.ok(capabilities.animations);
 }
 assert.match(gameCapabilities('bdsp').models, /not yet decoded/);
 assert.match(gameCapabilities('snap').models, /not yet supported/);
 assert.match(gameCapabilities('pla').textures, /BNTX incomplete/);
 assert.match(gameCapabilities('za').models, /experimental/);
 assert.deepEqual(gameCapabilities('made-up'),gameCapabilities('other'));
});
