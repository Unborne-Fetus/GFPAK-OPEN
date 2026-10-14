import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {decodeGfbmdl} from '../src/gfbmdl.js';
import {loadGfbmdl} from '../src/gfbmdl-model.js';
import {parseGfbmdlVisibility,applyGfbmdlRestVisibility} from '../src/gfbmdl-visibility.js';
import {boundTriangle,visibilityFixture} from './gfbmdl-visibility-fixture.mjs';

test('GFBANM fixed and bit-packed shape visibility are decoded correctly',()=>{
  const fixed=parseGfbmdlVisibility(visibilityFixture());
  assert.equal(fixed.frameRate,30);
  assert.deepEqual(fixed.channels,[{
    name:'pm0519_00_LWingSkin',frames:[0],values:[false],
  }]);
  const dense=parseGfbmdlVisibility(visibilityFixture('TailSkin',2));
  assert.deepEqual(dense.channels[0].frames,[0,1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(dense.channels[0].values,
    [true,false,true,false,false,false,false,false,true,true]);
  const keyed=parseGfbmdlVisibility(visibilityFixture('TailSkin',4));
  assert.deepEqual(keyed.channels[0],
    {name:'TailSkin',frames:[0,4,9],values:[true,false,true]});
});

test('GFBMDL skin bindings recover authored names for wing/tail visibility',()=>{
  const mdl=decodeGfbmdl(boundTriangle('pm0519_00_LWingSkin'));
  assert.equal(mdl.meshes[0].name,'pm0519_00_LWingSkin');
  assert.equal(mdl.stats.meshCount,1);
});

test('idle visibility works for alternate tails without discarding their mesh',()=>{
  const root=new THREE.Group();
  const primary=new THREE.Mesh(), alternate=new THREE.Mesh();
  primary.name='TailSkin';alternate.name='AlternateTailSkin';
  root.add(primary,alternate);
  assert.equal(applyGfbmdlRestVisibility(root,[
    {name:'TailSkin',frames:[0],values:[true]},
    {name:'AlternateTailSkin',frames:[0],values:[false]},
  ]),2);
  assert.equal(root.children.length,2);
  assert.equal(primary.scale.x,1);
  assert.equal(alternate.scale.x,0);
});

test('native idle Pidove wing state survives preview and becomes an exportable scale track',async()=>{
  const model=boundTriangle();
  const idle=visibilityFixture();
  const files=[
    {path:'pm0519_resource_0000.gfbmdl',bytes:model},
    {path:'pm0519_00_ba10_waitA01.gfbanm',bytes:idle}
  ];
  const project={items:files.map(row=>({
    path:row.path,size:row.bytes.byteLength,
    getBytes:async()=>row.bytes,
  }))};
  const result=await loadGfbmdl(project,files[0].path,()=>{}, {fastPreview:true});
  const mesh=result.root.children.find(child=>child.isMesh);
  assert.equal(mesh.name,'pm0519_00_LWingSkin');
  assert.equal(mesh.scale.x,0);
  await result.postLoad();
  assert.equal(result.animations.length,1);
  const scale=result.animations[0].tracks.find(t=>t.name===mesh.uuid+'.scale');
  assert.ok(scale);
  assert.deepEqual([...scale.values],[0,0,0]);
  assert.equal(scale.getInterpolation(),THREE.InterpolateDiscrete);
  result.disposeAssets();
});
