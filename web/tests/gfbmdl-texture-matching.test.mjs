import test from 'node:test';
import assert from 'node:assert/strict';
import { findLegacyTexture, chooseMap } from '../src/gfbmdl-model.js';
import { decodeGfbmdl } from '../src/gfbmdl.js';
import { makeGfbmdlTriangle } from './native-gfbmdl-sample.mjs';

test('hashed BNTX containers match exact internal regular and shiny surfaces', () => {
  const rows = [
    { item: {path:'resource_53.bntx'}, score:10, base:'resource_53', internalNames:['pm0001_body_col'] },
    { item: {path:'resource_54.bntx'}, score:10, base:'resource_54', internalNames:['pm0001_body_col_rare'] },
    { item: {path:'resource_56.bntx'}, score:10, base:'resource_56', internalNames:['pm0001_body_nor'] }
  ];
  assert.equal(findLegacyTexture('pm0001_body_col', rows), rows[0].item);
  assert.equal(findLegacyTexture('pm0001_body_col_rare', rows), rows[1].item);
  assert.equal(findLegacyTexture('missing_col', rows), null);
  assert.equal(findLegacyTexture('pm0001_body_col', [...rows, {...rows[0],item:{path:'duplicate.bntx'}}]), null);
});

test('base color sampler wins over a shader color layer', () => {
  const layer = {sampler:'LyCol0Tex',textureIndex:1};
  const base = {sampler:'Col0Tex',textureIndex:0};
  assert.equal(chooseMap(['body_col','dummy_col'],{maps:[layer,base]}), base);
});

test('omitted texture index uses FlatBuffers zero default', () => {
  const bytes = new ArrayBuffer(768);
  new Uint8Array(bytes).set(new Uint8Array(makeGfbmdlTriangle()));
  const v = new DataView(bytes);
  const u16=(o,n)=>v.setUint16(o,n,true), u32=(o,n)=>v.setUint32(o,n,true);
  u16(34,20); u16(48,12); u32(76,512-76); // root material vector
  u32(512,1); u32(516,600-516);
  u16(560,28); u16(562,8); u16(586,4); // material maps slot 11
  v.setInt32(600,40,true); u32(604,640-604);
  u32(640,1); u32(644,700-644);
  u16(680,8); u16(682,8); u16(684,4); // sampler present; index absent
  v.setInt32(700,20,true); u32(704,720-704); u32(720,7);
  new Uint8Array(bytes,724,7).set(new TextEncoder().encode('Col0Tex'));
  const result=decodeGfbmdl(bytes);
  assert.equal(result.materials[0].maps[0].textureIndex,0);
  assert.equal(result.materials[0].maps[0].sampler,'Col0Tex');
});
