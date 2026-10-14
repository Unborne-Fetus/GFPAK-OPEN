import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {exportGlb} from '../src/model.js';

// GLTFExporter's browser Blob reader, without needing a GPU for geometry.
globalThis.FileReader=class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();});
  }
};
const inspect=buffer=>JSON.parse(new TextDecoder().decode(
  new Uint8Array(buffer,20,new DataView(buffer).getUint32(12,true))));

test('export excludes disabled native shader masks and preserves the preview geometry',async()=>{
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute([255,255,255,255,255,255,255,255,255],3));
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:false}));
  const first=inspect(await exportGlb(mesh));
  assert.equal(first.meshes[0].primitives[0].attributes.COLOR_0,undefined);
  assert.equal(mesh.geometry,geometry);
  assert.equal(geometry.getAttribute('color').getX(0),255);
  geometry.getAttribute('color').array.fill(1);
  mesh.material.vertexColors=true;
  const second=inspect(await exportGlb(mesh));
  assert.notEqual(second.meshes[0].primitives[0].attributes.COLOR_0,undefined);
  assert.equal(mesh.geometry,geometry);
});
