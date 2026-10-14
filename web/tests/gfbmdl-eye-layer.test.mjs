import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {applyLegacyEyeLayer} from '../src/gfbmdl-eye-layer.js';

test('eye shader reveals the iris through transparent eyelids using separate UV transforms', () => {
  const material=new THREE.MeshStandardMaterial();
  material.map=new THREE.Texture();material.map.repeat.set(2,1);material.map.offset.set(-1,0);
  const iris=new THREE.Texture();iris.repeat.set(-4,4);iris.offset.set(0,-3);
  applyLegacyEyeLayer(material,iris,[]);
  const shader={uniforms:{},vertexShader:'#include <uv_vertex>',fragmentShader:'#include <map_fragment>'};
  material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.gfEyeBase.value,material.map);
  assert.equal(shader.uniforms.gfEyeIris.value,iris);
  assert.notDeepEqual(shader.uniforms.gfEyeBaseTransform.value.elements,
    shader.uniforms.gfEyeIrisTransform.value.elements);
  assert.match(shader.fragmentShader,/mix\(pupil.rgb,eyelid.rgb,eyelid.a\)/);
  assert.match(shader.vertexShader,/gfEyeUV=uv/);
});

test('materials without an iris keep their existing texture shader', () => {
  const material=new THREE.MeshStandardMaterial();const original=material.onBeforeCompile;
  applyLegacyEyeLayer(material,null,[]);
  assert.equal(material.onBeforeCompile,original);
});

test('iris centers on the nearest transparent eyelid opening without changing scale', async () => {
  const {nearestEyeOpening,centerEyeIris}=await import('../src/gfbmdl-eye-layer.js');
  const pixels=new Uint8Array(12*12*4);pixels.fill(255);
  for(let y=2;y<5;y++)for(let x=2;x<5;x++)pixels[(y*12+x)*4+3]=0;
  for(let y=7;y<10;y++)for(let x=8;x<11;x++)pixels[(y*12+x)*4+3]=0;
  const opening=nearestEyeOpening(pixels,12,12,[.25,.25]);
  assert.deepEqual(opening,[3.5/12,3.5/12]);
  const iris=new THREE.Texture();iris.repeat.set(-4,4);iris.offset.set(0,-3);iris.updateMatrix();
  centerEyeIris(iris,opening);
  const uv=new THREE.Vector2(...opening).applyMatrix3(iris.matrix);
  assert.ok(Math.abs((uv.x-Math.floor(uv.x))-.5)<1e-6);
  assert.ok(Math.abs((uv.y-Math.floor(uv.y))-.5)<1e-6);
  assert.deepEqual(iris.repeat.toArray(),[-4,4]);
  pixels.fill(255);assert.equal(nearestEyeOpening(pixels,12,12,[.25,.25]),null);
});

test('painted iris is located off-center and aligned through mirrored texture periods', async () => {
  const {irisContentCenter,centerEyeIris}=await import('../src/gfbmdl-eye-layer.js');
  const pixels=new Uint8Array(20*20*4);pixels.fill(240);
  for(let i=0;i<400;i++)pixels[i*4+3]=255;
  for(let y=11;y<17;y++)for(let x=10;x<16;x++){
    const i=(y*20+x)*4;pixels[i]=140;pixels[i+1]=30;pixels[i+2]=45;
  }
  const painted=irisContentCenter(pixels,20,20);
  assert.deepEqual(painted,[.65,.7]);
  const iris=new THREE.Texture();iris.repeat.set(-4,4);iris.offset.set(0,-3);
  iris.wrapS=iris.wrapT=THREE.MirroredRepeatWrapping;iris.updateMatrix();
  centerEyeIris(iris,[.36,.17],painted);
  const uv=new THREE.Vector2(.36,.17).applyMatrix3(iris.matrix);
  const wrap=value=>{const p=((value%2)+2)%2;return p>1?2-p:p;};
  assert.ok(Math.abs(wrap(uv.x)-painted[0])<1e-6);
  assert.ok(Math.abs(wrap(uv.y)-painted[1])<1e-6);
});

test('slanted eye openings receive a small horizontal gaze correction', async () => {
  const {nearestEyeOpening}=await import('../src/gfbmdl-eye-layer.js');
  const pixels=new Uint8Array(10*10*4);pixels.fill(255);
  for(const [x,y] of [[2,2],[3,2],[4,2],[2,3],[3,3],[2,4]])pixels[(y*10+x)*4+3]=0;
  const center=nearestEyeOpening(pixels,10,10,[.3,.3]);
  assert.ok(Math.abs(center[0]-1/3)<1e-6);
  assert.ok(Math.abs(center[1]-19/60)<1e-6);
});

test('tear-duct gaze nudges move paired eyes in opposite UV directions', async () => {
  const {nearestEyeOpening}=await import('../src/gfbmdl-eye-layer.js');
  const pixels=new Uint8Array(20*20*4);pixels.fill(255);
  for(let y=6;y<14;y++)for(let x=6;x<14;x++)pixels[(y*20+x)*4+3]=0;
  const neutral=nearestEyeOpening(pixels,20,20,[.5,.5]);
  const left=nearestEyeOpening(pixels,20,20,[.5,.5],1);
  const right=nearestEyeOpening(pixels,20,20,[.5,.5],-1);
  assert.ok(left[0]>neutral[0]);assert.ok(right[0]<neutral[0]);
  assert.equal(left[1],neutral[1]);assert.equal(right[1],neutral[1]);
  assert.ok(Math.abs(left[0]-neutral[0]-(neutral[0]-right[0]))<1e-6);
});
