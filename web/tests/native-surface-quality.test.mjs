import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {decodeTrinityMeshes} from '../src/trinity.js';
import {makeMesh,createMaterials,hasOpenBoundary,textureUvChannel,applyDecodedTextures} from '../src/trinity-model.js';
import {applyLayerColors} from '../src/trinity-layer-colors.js';

function part() {
  return {name:'thin surface',indices:new Uint32Array([0,1,2]),vertices:{count:3,
    position:new Float32Array([0,0,0,1,0,0,0,1,0]),
    normal:new Float32Array([0,0,1,0,0,1,0,0,1]),
    tangent:new Float32Array([1,0,0,1,1,0,0,1,1,0,0,1]),
    uv:new Float32Array([0,0,1,0,0,1]),uv1:new Float32Array([.2,.3,.4,.5,.6,.7])}};
}

test('secondary UV semantic uses the same vertex binding, not a nonexistent second buffer',()=>{
  const data=new Float32Array([0,0,0,0,0,.25,.5, 1,0,0,1,0,.75,.5, 0,1,0,0,1,.25,1]);
  const descriptor={strides:[28],elements:[
    {usage:1,layer:0,strideIndex:0,offset:0,format:51},
    {usage:6,layer:0,strideIndex:0,offset:12,format:48},
    {usage:6,layer:1,strideIndex:0,offset:20,format:48}]};
  const meshes=decodeTrinityMeshes({meshes:[{index:0,name:'quad',indexFormat:1,
    declarations:[descriptor],parts:[{count:3,offset:0,declaration:0}]}]},
    {buffers:[{vertexBuffers:[new Uint8Array(data.buffer)],indexBuffers:[new Uint8Array(new Uint16Array([0,1,2]).buffer)]}]});
  assert.deepEqual(Array.from(meshes[0].vertices.uv1),[.25,.5,.75,.5,.25,1]);
  const mesh=makeMesh(meshes[0],new THREE.MeshStandardMaterial());
  assert.deepEqual(Array.from(mesh.geometry.getAttribute('uv1').array),[.25,.5,.75,.5,.25,0]);
});

test('authored tangent handedness follows the UV reflection without changing source data',()=>{
  const source=part();const mesh=makeMesh(source,new THREE.MeshStandardMaterial());
  assert.equal(mesh.geometry.getAttribute('tangent').getW(0),-1);
  assert.equal(source.vertices.tangent[3],1);
});

test('open sheets render both faces, while intentional inverted shells retain backface rendering',()=>{
  const wing=makeMesh(part(),new THREE.MeshStandardMaterial({side:THREE.FrontSide}));
  assert.equal(wing.material.side,THREE.DoubleSide);
  const shell=makeMesh(part(),new THREE.MeshBasicMaterial({side:THREE.BackSide}));
  assert.equal(shell.material.side,THREE.BackSide);
});

test('closed surface with duplicated UV seam positions is not mistaken for an open wing',()=>{
  const p=new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]);
  assert.equal(hasOpenBoundary(p,new Uint32Array([4,2,1,0,1,3,1,2,3,2,0,3])),false);
});

test('native material routes masks and individual maps to their authored secondary UV set',()=>{
  const textures=[{name:'NormalMap'},{name:'BaseColorMap'}];
  const definition={textures,integers:{UVIndexLayer1:0,UVIndexLayerMask:0}};
  assert.equal(textureUvChannel(definition,'normalMap',textures[0]),1);
  assert.equal(textureUvChannel(definition,'map',textures[1]),0);
  assert.equal(textureUvChannel(definition,'layerMaskMap'),1);
});

test('different mask UV sets stay in the shader rather than being flattened into the wrong atlas',()=>{
  const mask=new THREE.Texture();mask.channel=1;
  const material=new THREE.MeshStandardMaterial({map:new THREE.Texture()});
  applyLayerColors({material,layerMaskMap:mask,colors:Object.fromEntries([1,2,3,4].map(i=>['BaseColorLayer'+i,[1,0,0,1]]))},[]);
  const shader={uniforms:{},vertexShader:'#include <uv_vertex>',fragmentShader:'#include <map_fragment>'};
  material.onBeforeCompile(shader);
  assert.match(shader.vertexShader,/gfBaseUv = uv1/);
  assert.equal(material.map.channel,0);
});

test('disabled native normal channel is not applied even if its texture is present',async()=>{
  const lookup=createMaterials([{materials:[{name:'body',shaders:[{flags:{EnableNormalMap:'False'}}],textures:[{name:'NormalMap',file:'normal.bntx'}]}]}]);
  let reads=0;
  await applyDecodedTextures({items:[{path:'normal.bntx',getBytes:async()=>{reads++;return new Uint8Array(32);}}]},lookup,'body.trmdl',()=>{},[]);
  assert.equal(reads,0);
  assert.equal(lookup.get('body').material.normalMap,null);
});

test('vertex binding is selected by stride index independently of semantic layer',()=>{
  const data=new Float32Array([0,0,0,1,0,0,0,1,0]);
  const meshes=decodeTrinityMeshes({meshes:[{index:0,name:'split binding',indexFormat:1,
    declarations:[{strides:[4,12],elements:[{usage:1,layer:0,strideIndex:1,offset:0,format:51}]}],
    parts:[{count:3,offset:0,declaration:0}]}]},
    {buffers:[{vertexBuffers:[new Uint8Array(12),new Uint8Array(data.buffer)],indexBuffers:[new Uint8Array(new Uint16Array([0,1,2]).buffer)]}]});
  assert.deepEqual(Array.from(meshes[0].vertices.position),Array.from(data));
});
