import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  buildPokedexZip,validatePokedexGlb,normalizeExportGame,
  modelIdentityFromPath,compatibleProjectItems
} from '../src/pokedex3d-export.js';

function compatibleGlb({idle=true,embedded=true,textured=true,mixedMaterials=false}={}){
  // Match the structural fixture used in Pokédex 3D Max's Python importer.
  const doc={
    asset:{version:'2.0'}, scenes:[{nodes:[0]}],scene:0,
    nodes:[{name:'pm0942_body',mesh:0}],
    meshes:[{name:'pm0942_body',primitives:[{attributes:{POSITION:0},material:0}]}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'}],
    bufferViews:[{buffer:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:1280}],
    buffers:[{byteLength:1316}],
    materials:textured?[
      {pbrMetallicRoughness:{baseColorTexture:{index:0}}},
      ...(mixedMaterials?[{}]:[])
    ]:[{}],
    textures:[{source:0}],
    images:[embedded?{bufferView:1,mimeType:'image/png'}:{uri:'https://example.com/texture.png'}],
    animations:idle?[{
      name:'battle_idle',channels:[{sampler:0,target:{node:0,path:'rotation'}}],
      samplers:[{input:0,output:0}]
    }]:[]
  };
  const json=new TextEncoder().encode(JSON.stringify(doc));
  const padded=Math.ceil(json.length/4)*4;
  const out=new Uint8Array(12+8+padded+8+1316);
  out.fill(32,20,20+padded);
  out.set(json,20);
  const v=new DataView(out.buffer);
  v.setUint32(0,0x46546c67,true);
  v.setUint32(4,2,true);
  v.setUint32(8,out.byteLength,true);
  v.setUint32(12,padded,true);
  v.setUint32(16,0x4e4f534a,true);
  v.setUint32(20+padded,1316,true);
  v.setUint32(24+padded,0x004e4942,true);
  return out.buffer;
}
function item(path,bytes=Uint8Array.of(1,2,3)){
  return {path,size:bytes.byteLength,getBytes:async()=>bytes};
}
test('validated GLB uses the same scene/texture/idle contract as Pokédex 3D Max',()=>{
  const report=validatePokedexGlb(compatibleGlb());
  assert.equal(report.idle,'battle_idle');
  assert.equal(report.meshCount,1);
  assert.equal(report.textureCount,1);
  assert.equal(report.animations.length,1);
});
test('exporter rejects GLBs with missing idle, embedded textures, or base-color material',()=>{
  assert.throws(()=>validatePokedexGlb(compatibleGlb({idle:false})),/idle animation/i);
  assert.throws(()=>validatePokedexGlb(compatibleGlb({embedded:false})),/external|embedded/i);
  assert.throws(()=>validatePokedexGlb(compatibleGlb({textured:false})),/base-color/i);
  assert.throws(()=>validatePokedexGlb(compatibleGlb({mixedMaterials:true})),/every GLB material/i);
});
test('Pokédex ZIP includes original textures/skeleton/animations + import-ready GLB + exact desktop manifest',async()=>{
  const selected='pm0942_00_00/body.trmdl';
  const paths=[
    selected,
    'pm0942_00_00/body.trmsh',
    'pm0942_00_00/body.trmbf',
    'pm0942_00_00/body.trskl',
    'pm0942_00_00/body.bntx',
    'pm0942_00_00/pm0942_idle.tranm',
    'pm0942_00_00/unknown_hash.bin'
  ];
  const project={items:paths.map(path=>item(path))};
  const progress=[];
  const result=await buildPokedexZip(project,selected,'za',message=>progress.push(message),{
    glb:compatibleGlb()
  });
  const zip=await JSZip.loadAsync(result.blob);
  const names=Object.keys(zip.files).filter(n=>!n.endsWith('/'));
  assert.ok(names.includes('pokedex3d/regular.glb'));
  assert.ok(names.includes('gfpak-pokemon-export.json'));
  for(const p of paths)assert.ok(names.includes(p),p+' missing from export');
  const meta=JSON.parse(await zip.file('gfpak-pokemon-export.json').async('string'));
  assert.deepEqual(meta,{
    format:'gfpak-pokemon-export',
    version:1,
    selectedModel:selected,
    sourceGame:'za',
    convertedModel:'pokedex3d/regular.glb',
    animations:['battle_idle']
  });
  assert.deepEqual(await zip.file('pokedex3d/regular.glb').async('arraybuffer'),
    compatibleGlb());
  assert.equal(result.report.idle,'battle_idle');
  assert.ok(progress.some(message=>/Packaging/.test(message)));
});
test('PLA aliases to la and source Pokémon model identities remain game-internal',()=>{
  assert.equal(normalizeExportGame('pla'),'la');
  assert.equal(modelIdentityFromPath('pm0942_00_00/body.trmdl').modelId,942);
  assert.throws(()=>modelIdentityFromPath('pm0942/pm0025.trmdl'),/unambiguous/);
});
test('ZIP export blocks unsafe/duplicate original entries and unknown game',async()=>{
  assert.throws(()=>compatibleProjectItems('pm0942.trmdl',[
    item('pm0942.trmdl'),item('pm0942.trmdl')
  ]),/Conflicting original asset/);
  assert.throws(()=>compatibleProjectItems('pm0942.trmdl',[
    item('pm0942.trmdl'),item('../secret')
  ]),/Unsafe/);
  await assert.rejects(buildPokedexZip({items:[item('pm0942.trmdl')]},'pm0942.trmdl','auto',
    ()=>{},{glb:compatibleGlb()}),/Select the Pokémon source game/);
});
test('raw-only files cannot silently masquerade as a finished Pokédex 3D Max model',async()=>{
  const project={items:[item('pm0942_00_00.trmdl',new Uint8Array(8))]};
  await assert.rejects(buildPokedexZip(project,'pm0942_00_00.trmdl','za'),
    /Invalid size|Unable|Trinity|Missing|Failed|model|resource|FlatBuffer|data/i);
});
