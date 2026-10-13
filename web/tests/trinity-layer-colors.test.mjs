import test from 'node:test';
import assert from 'node:assert/strict';
import {Builder} from 'flatbuffers';
import * as THREE from 'three';
import {parseTrmtr} from '../src/trinity.js';
import {applyLayerColors} from '../src/trinity-layer-colors.js';

function vector(builder, offsets) {
  builder.startVector(4,offsets.length,4);
  for(let i=offsets.length-1;i>=0;i--)builder.addOffset(offsets[i]);
  return builder.endVector();
}
function color(builder,name,rgba) {
  const text=builder.createString(name);
  builder.startObject(2);
  builder.prep(4,16);
  for(let i=3;i>=0;i--)builder.writeFloat32(rgba[i]);
  builder.addFieldStruct(1,builder.offset(),0);
  builder.addFieldOffset(0,text,0);
  return builder.endObject();
}

test('native material color parameters reach masked base-color shader',()=>{
  const b=new Builder(512),name=b.createString('body');
  const parameters=vector(b,[
    color(b,'BaseColorLayer1',[.48,.35,.01,1]),
    color(b,'BaseColorLayer2',[.1,.03,.015,1]),
    color(b,'BaseColorLayer3',[.015,.015,.015,1]),
    color(b,'BaseColorLayer4',[0,0,0,1])]);
  b.startObject(8);b.addFieldOffset(0,name,0);b.addFieldOffset(7,parameters,0);
  const material=b.endObject(),materials=vector(b,[material]);
  b.startObject(2);b.addFieldOffset(1,materials,0);b.finish(b.endObject());
  const bytes=b.asUint8Array();
  const info=parseTrmtr(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)).materials[0];
  assert.ok(Math.abs(info.colors.BaseColorLayer1[0]-.48)<1e-6);
  const mat=new THREE.MeshStandardMaterial({map:new THREE.Texture()});
  const mask=new THREE.Texture();
  applyLayerColors({...info,material:mat,layerMaskMap:mask},[]);
  const shader={uniforms:{},fragmentShader:'#include <map_fragment>',vertexShader:'#include <uv_vertex>'};
  mat.onBeforeCompile(shader);
  assert.equal(shader.uniforms.gfLayerMask.value,mask);
  assert.ok(shader.uniforms.gfLayerColors.value[0].x>.47);
  assert.match(shader.fragmentShader,/diffuseColor.rgb = gfBlendLayers/);
});

test('ordinary material without native layer palette retains normal shading',()=>{
  const material=new THREE.MeshStandardMaterial(),original=material.onBeforeCompile;
  applyLayerColors({material,colors:{}},[]);
  assert.equal(material.onBeforeCompile,original);
});
