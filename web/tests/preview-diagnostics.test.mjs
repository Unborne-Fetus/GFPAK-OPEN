import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {previewDiagnostics} from '../src/preview-diagnostics.js';

test('preview report flags guessed GFPAK mesh/texture links without exposing bytes',()=>{
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([
    0,0,0,1,0,0,0,1,0],3));
  geometry.setIndex([0,1,2]);
  const material=new THREE.MeshStandardMaterial({name:'body'});
  material.map=new THREE.DataTexture(new Uint8Array(16*8*4),16,8);
  const root=new THREE.Group();
  root.add(new THREE.Mesh(geometry,material));
  const project={label:'pm0025_00_00.gfpak',items:[{
    path:'recovered/pm0025_00_00/head.trmsh',size:2048,
    sourceArchive:'pm0025_00_00.gfpak',sourceResourceIndex:24,
    pathHash:'abc',fileHash:'def',
    resourceMatches:[{kind:'trmsh',reference:'head',evidence:'UNVERIFIED-RESOURCE-ORDER'}],
    getBytes:async()=>{throw Error('diagnostics must never read any file data');}
  },{
    path:'recovered/pm0025_00_00/resource_0030.bntx',
    linkedKind:'texture',textureNames:['body_color','body_color_rare'],
    size:3072
  }]};
  const loaded={root,animations:[],selected:'recovered/head.trmdl',
    sourceFormat:'TRMDL',sourceStats:{bones:0}};
  const result=previewDiagnostics(project,loaded,{textureVariant:'regular',
    activity:['first attempt']});
  assert.equal(result.resources[0].resourceIndex,24);
  assert.equal(result.rendered.materials[0].albedo.width,16);
  assert.equal(result.rendered.materials[0].albedo.height,8);
  assert.equal(result.rendered.meshes[0].triangles,1);
  assert.equal(result.rendered.animationNames.length,0);
  assert.ok(result.warnings.some(x=>x.includes('UNVERIFIED')));
  assert.ok(result.warnings.some(x=>x.includes('skeleton')));
  assert.doesNotMatch(JSON.stringify(result),/getBytes|Uint8Array/);
  geometry.dispose();material.map.dispose();material.dispose();
});

test('preview report has a safe empty state when no model has rendered',()=>{
  const result=previewDiagnostics(null,null);
  assert.deepEqual(result.resources,[]);
  assert.deepEqual(result.rendered.meshes,[]);
  assert.equal(result.selectedModel,null);
});
