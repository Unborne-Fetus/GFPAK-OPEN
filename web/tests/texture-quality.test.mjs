import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {configureTextureSampling} from '../src/texture-quality.js';

test('native decoded texels retain source pixels with smooth magnification and mip filtering', () => {
  const pixels = new Uint8Array(4 * 4 * 4);
  const texture = new THREE.DataTexture(pixels, 4, 4);
  configureTextureSampling(texture, 8);
  assert.equal(texture.image.data, pixels);
  assert.equal(texture.magFilter, THREE.LinearFilter);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.generateMipmaps, true);
  assert.equal(texture.anisotropy, 8);
  assert.equal(texture.flipY, false);
  texture.dispose();
});

test('GPU compressed surfaces do not request an unavailable generated mip chain', () => {
  const levels = [{data:new Uint8Array(8),width:4,height:4}];
  const texture = new THREE.CompressedTexture(levels, 4, 4, THREE.RGB_S3TC_DXT1_Format);
  configureTextureSampling(texture);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.minFilter, THREE.LinearFilter);
  texture.mipmaps.push({data:new Uint8Array(8),width:2,height:2});
  configureTextureSampling(texture);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.mipmaps, levels);
  texture.dispose();
});
