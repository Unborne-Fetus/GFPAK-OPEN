import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Builder} from 'flatbuffers';
import {loadTrinityModel,chooseRigByAnimationTracks} from '../src/trinity-model.js';
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
