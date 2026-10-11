import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {decodeDDSTexture, loadDecodedTexture} from '../src/texture-loader.js';

function syntheticBC1DDS() {
  const bytes = new Uint8Array(128 + 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x20534444, true);  // DDS magic
  view.setUint32(4, 124, true);         // DDS_HEADER size
  view.setUint32(8, 0xA1007, true);     // flags
  view.setUint32(12, 4, true);          // height
  view.setUint32(16, 4, true);          // width
  view.setUint32(20, 8, true);          // linear size
  view.setUint32(28, 1, true);          // mip maps
  view.setUint32(76, 32, true);         // DDS_PIXELFORMAT size
  view.setUint32(80, 0x4, true);        // FOURCC
  view.setUint32(84, 0x31545844, true);// DXT1
  view.setUint32(108, 0x1000, true);   // DDSCAPS_TEXTURE
  bytes[128] = 0x00; bytes[129] = 0xF8; // red endpoint RGB565
  bytes[130] = 0x1F; bytes[131] = 0x00; // blue endpoint RGB565
  return bytes;
}

test('read real DDS BC1 texture metadata without guessing materials', () => {
  const texture = decodeDDSTexture(syntheticBC1DDS());
  assert.ok(texture.isCompressedTexture);
  assert.equal(texture.image.width, 4);
  assert.equal(texture.image.height, 4);
  assert.equal(texture.mipmaps.length, 1);
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  texture.dispose();
});

test('decoded DDS textures can be created from project file bytes', async () => {
  const image = syntheticBC1DDS();
  const loaded = await loadDecodedTexture({path: 'pm0025_body.dds', getBytes: async () => image});
  assert.ok(loaded.isCompressedTexture);
  loaded.dispose();
  assert.throws(() => decodeDDSTexture(new Uint8Array(12)), /truncated/);
});

test('malformed BNTX never masquerades as a decoded Pokémon skin', async () => {
  await assert.rejects(() => loadDecodedTexture({
    path:'pm0025_body.bntx',getBytes: async()=>new Uint8Array(32)
  }), /Not a BNTX container/);
});
