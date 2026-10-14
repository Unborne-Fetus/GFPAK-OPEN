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
