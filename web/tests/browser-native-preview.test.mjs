import test from 'node:test';
import assert from 'node:assert/strict';
import {fnv1a64} from '../src/gfpak.js';
import {inferGfpakModelNames,discoverGfpakReferenceNames} from '../src/gfpak-model-inference.js';
import {categoryOf,openGfpak} from '../src/browser-package-reader.js';
import {browserModelAssetMatches,browserNativeProject} from '../src/browser-native-project.js';

function resource(index,name) {
  return {index,pathHash:fnv1a64(name),fileHash:fnv1a64(name)};
}
test('browser infers exact TRMDL/TRMSH/TRMBF family like desktop',()=>{
  const resources=[
    resource(0,'pm0212_00_00.trmdl'),
    resource(1,'pm0212_00_00.trmsh'),
    resource(2,'pm0212_00_00.trmbf'),
    resource(3,'unrelated.bntx')
  ];
  const names=inferGfpakModelNames(resources,'pm0212_00_00.gfpak');
  assert.equal(names.get(0),'pm0212_00_00.trmdl');
  assert.equal(names.get(1),'pm0212_00_00.trmsh');
  assert.equal(names.get(2),'pm0212_00_00.trmbf');
  assert.equal(names.has(3),false);
});
test('exact hash-validated referenced textures recover actual names, not guesses',async()=>{
  const resources=[
    resource(0,'pm0212_00_00.trmdl'),
    resource(1,'pm0212_00_00.trmsh'),
    resource(2,'pm0212_00_00.trmbf'),
    resource(3,'body_diffuse.bntx')
  ].map(res=>({...res,size:150}));
  const names=inferGfpakModelNames(resources,'pm0212_00_00.gfpak');
  const looked=[];
  const result=await discoverGfpakReferenceNames(
    {resources},names,async res=>{
      looked.push(res.index);
      return new TextEncoder().encode(res.index===0?
        'object\\x00body_diffuse.bntx\\x00': 'other');
    });
  assert.equal(result.get(3),'body_diffuse.bntx');
  assert.ok(looked.length>=1);
  assert.ok(!looked.includes(3));
});
test('unknown descriptor references never assign unrelated resource names',async()=>{
  const resources=[
    resource(0,'pm0212_00_00.trmdl'),
    resource(1,'pm0212_00_00.trmsh'),
    resource(2,'pm0212_00_00.trmbf'),
    resource(3,'unrelated.bin')
  ].map(res=>({...res,size:100}));
  const result=await discoverGfpakReferenceNames(
    {resources},inferGfpakModelNames(resources,'pm0212.gfpak'),
    async()=>new TextEncoder().encode('unmatched_diffuse.bntx')
  );
  assert.equal(result.has(3),false);
});
test('TRMSH counts as mesh, TRANM/TRACM as animation',()=>{
  assert.equal(categoryOf('body.trmdl'),'model');
  assert.equal(categoryOf('body.trmsh'),'mesh');
  assert.equal(categoryOf('idle.tranm'),'animation');
  assert.equal(categoryOf('idle.tracm'),'animation');
});
test('preview companions include one-model GFPAK members and reject a foreign Pokémon',()=>{
  const root={name:'game.nsp',path:'game.nsp',parent:null,kind:'package'};
  const archive={name:'pm0212.gfpak',path:'game.nsp/pm0212.gfpak',parent:root,kind:'gfpak'};
  const node=(name,category)=>{
    const path=archive.path+'/'+name;
    const bytes=new TextEncoder().encode(name);
    const source={size:bytes.length,read:async(at,len)=>bytes.subarray(at,at+len)};
    return {name,path,parent:archive,kind:'file',category,size:bytes.length,children:null,source};
  };
  const model=node('pm0212.trmdl','model');
  const mesh=node('pm0212.trmsh','mesh');
  const skeleton=node('rig.trskl','skeleton');
  const unknown=node('unresolved/abcdef.bin','unknown');
  const unrelated=node('pm0094.tranm','animation');
  const matches=browserModelAssetMatches(model,[model,mesh,skeleton,unknown,unrelated]);
  assert.ok(matches.includes(mesh));
  assert.ok(matches.includes(skeleton));
  assert.ok(matches.includes(unknown));
  assert.ok(!matches.includes(unrelated));
});
test('model loader receives lazy original companion buffers without a temporary ZIP',async()=>{
  const root={name:'game.zip',path:'game.zip',parent:null};
  const getNode=name=>{
    const bytes=new Uint8Array([1,2,3,4]);
    return {name,path:'game.zip/'+name,parent:root,category:name.endsWith('trmdl')?'model':'mesh',
      kind:'file',children:null,size:bytes.length,
      source:{size:bytes.length,read:async(a,b)=>bytes.subarray(a,a+b)}};
  };
  const model=getNode('pm0212.trmdl'),mesh=getNode('pm0212.trmsh');
  const {project,selected}=browserNativeProject(model,[model,mesh],root,async item=>item.source);
  assert.equal(selected,'pm0212.trmdl');
  assert.equal(project.items.length,2);
  assert.equal(project.items[1].linkedKind,'mesh');
  assert.deepEqual(new Uint8Array(await project.items[0].getBytes()),new Uint8Array([1,2,3,4]));
});
