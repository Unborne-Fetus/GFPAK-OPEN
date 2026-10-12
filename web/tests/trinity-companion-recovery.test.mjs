import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Builder} from 'flatbuffers';
import {loadTrinityModel,chooseRigByAnimationTracks,
  chooseRigByMeshInfluences,trinityMaterialVariant,
  chooseTrinityMaterialSources,preferredTrinityMeshes} from '../src/trinity-model.js';
import {makeTrinityTriangle} from './trinity-fixture.mjs';
import {makeAnimatedTrinityTriangle} from './trinity-animation-fixture.mjs';

const item=(path,bytes)=>({
  path,size:bytes.byteLength,
  getBytes:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)
});
const from=(files)=>({label:'Test PLA GFPAK',items:Object.entries(files).map(([path,data])=>item(path,data))});

function minimalTrmtr(name='body'){
  const b=new Builder(512),label=b.createString(name);
  b.startObject(8);b.addFieldOffset(0,label,0);
  const record=b.endObject();
  b.startVector(4,1,4);b.addOffset(record);
  const list=b.endVector();
  b.startObject(2);b.addFieldOffset(1,list,0);b.finish(b.endObject());
  return b.asUint8Array().slice();
}

test('real TRSKL rig and animation load when TRMDL omits the skeleton pointer',async()=>{
  const files=makeTrinityTriangle();
  const animated=makeAnimatedTrinityTriangle();
  files['models/unnamed-actual-rig.trskl']=animated['models/test.trskl'];
  files['models/real-idle.tranm']=animated['models/test.tranm'];
  const log=[];
  const model=await loadTrinityModel(from(files),'models/test.trmdl',s=>log.push(s),{fastPreview:true});
  assert.equal(model.sourceStats.bones,1,log.join('\n'));
  assert.ok(model.root.children.some(object=>object.isBone));
  await model.postLoad();
  assert.equal(model.animations.length,1,log.join('\n'));
  assert.ok(model.animations[0].tracks.length);
  assert.match(log.join(' '),/Recovered unambiguous 1-bone skeleton/);
  model.disposeAssets();
});

test('actual matching material definition loads when TRMDL omits material pointers',async()=>{
  const files={
    ...makeTrinityTriangle(),
    'models/hashed-material.trmtr':minimalTrmtr()
  };
  const log=[];
  const model=await loadTrinityModel(from(files),'models/test.trmdl',s=>log.push(s),{fastPreview:true});
  const mesh=model.root.children.find(child=>child.isMesh);
  assert.ok(mesh);
  assert.equal(mesh.material.name,'body');
  assert.equal(mesh.material.side,THREE.FrontSide,'matching original TRMTR selected, not generic gray fallback');
  assert.match(log.join(' '),/Matched 1 material definition/);
  model.disposeAssets();
});

test('two unreferenced rigs must not be assigned randomly to unrelated model',async()=>{
  const files=makeTrinityTriangle();
  const rig=makeAnimatedTrinityTriangle()['models/test.trskl'];
  files['models/skeletonA.trskl']=rig;
  files['models/skeletonB.trskl']=rig;
  const log=[];
  const result=await loadTrinityModel(from(files),'models/test.trmdl',s=>log.push(s),{fastPreview:true});
  assert.equal(result.sourceStats.bones,0);
  assert.match(log.join(' '),/skipping unsafe rig substitution/);
  result.disposeAssets();
});

test('animation bone evidence uniquely associates the correct rig without guessing',()=>{
  const roots=[
    {item:{path:'related-a.trskl'},value:{bones:[
      {name:'root'}, {name:'neck'}, {name:'wing_right'}]}},
    {item:{path:'related-b.trskl'},value:{bones:[
      {name:'root'}, {name:'tail'}, {name:'claw_left'}]}}
  ];
  const animations=[{tracks:[{bone:'root'},{bone:'neck'},{bone:'wing_right'}]}];
  assert.equal(chooseRigByAnimationTracks(roots,animations),roots[0]);
  assert.equal(chooseRigByAnimationTracks(roots,[{tracks:[{bone:'root'}]}]),null);
  assert.equal(chooseRigByAnimationTracks(roots,[{tracks:[
    {bone:'root'},{bone:'wing_right'},{bone:'tail'}]}]),null);
  assert.equal(chooseRigByAnimationTracks([roots[0],{
    ...roots[0],item:{path:'duplicate.trskl'}
  }],animations),null);
});

test('joint index evidence resolves only one structurally compatible skeleton',()=>{
  const candidates=[
    {value:{bones:[{jointInfoIndex:0},{jointInfoIndex:1}]}},
    {value:{bones:[{jointInfoIndex:0},{jointInfoIndex:2},{jointInfoIndex:4}]}}
  ];
  const mesh={vertices:{count:1,
    joints:new Float32Array([0,2,0,0]),
    weights:new Float32Array([0.5,0.5,0,0])}};
  assert.equal(chooseRigByMeshInfluences(candidates,[mesh]),candidates[1]);
  assert.equal(chooseRigByMeshInfluences(candidates,[{
    vertices:{count:1,joints:new Float32Array([0,0,0,0]),
      weights:new Float32Array([1,0,0,0])}}]),null);
  assert.equal(chooseRigByMeshInfluences([candidates[1],{
    value:{bones:[{jointInfoIndex:0},{jointInfoIndex:2}]}
  }],[mesh]),null);
});

test('regular material palette does not get replaced by a rare/shiny TRMTR',async()=>{
  const files={...makeTrinityTriangle(),
    'models/pm0212_00_00.trmtr':minimalTrmtr(),
    'models/pm0212_00_00_rare.trmtr':minimalTrmtr()};
  const project=from(files);
  const normalLog=[],shinyLog=[];
  const normal=await loadTrinityModel(project,'models/test.trmdl',
    line=>normalLog.push(line),{fastPreview:true,textureVariant:'regular'});
  const rare=await loadTrinityModel(project,'models/test.trmdl',
    line=>shinyLog.push(line),{fastPreview:true,textureVariant:'shiny'});
  assert.equal(normalLog.filter(line=>/Matched 1 material definition/.test(line)).length,1,
    normalLog.join('\\n'));
  assert.equal(shinyLog.filter(line=>/Matched 1 material definition/.test(line)).length,2,
    shinyLog.join('\\n'));
  normal.disposeAssets();rare.disposeAssets();
});

test('hashed material aliases mark rare palettes even without filename dictionary',()=>{
  const rows=[
    {item:{path:'recovered/material_001.trmtr',
      nativeAliases:['pm0212_00_00.trmtr']},data:{materials:[{name:'body'}]}},
    {item:{path:'recovered/material_002.trmtr',
      nativeAliases:['pm0212_00_00_rare.trmtr']},data:{materials:[{name:'body'}]}}
  ];
  assert.equal(trinityMaterialVariant(rows[0].item),'regular');
  assert.equal(trinityMaterialVariant(rows[1].item),'shiny');
  assert.deepEqual(chooseTrinityMaterialSources(rows,'regular'),[rows[0]]);
  assert.deepEqual(chooseTrinityMaterialSources(rows,'shiny'),rows);
});

test('native high-detail LOD wins without discarding head, body or accessory meshes',()=>{
  const refs=['head_lod2.trmsh','body.trmsh','head_lod0.trmsh',
    'head_lod1.trmsh','tail_lod1.trmsh','tail_lod0.trmsh','eye_left.trmsh'];
  assert.deepEqual(preferredTrinityMeshes(refs),[
    'body.trmsh','head_lod0.trmsh','tail_lod0.trmsh','eye_left.trmsh']);
  assert.deepEqual(preferredTrinityMeshes(['head','body','tail']),['head','body','tail']);
});
