import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingLinkedDiffuseTexture } from '../src/texture-loader.js';

test('model with separate body and eyes materials receives the right linked textures',()=>{
  const items=[
    {path:'texture/pm0025_body.bntx',linkedKind:'texture'},
    {path:'texture/pm0025_eyes.dds',linkedKind:'texture'},
    {path:'texture/pm0025_body_normal.dds',linkedKind:'texture'},
    {path:'texture/pm0026_body.bntx'}
  ];
  assert.equal(matchingLinkedDiffuseTexture(items,'BodyMaterial',2),items[0]);
  assert.equal(matchingLinkedDiffuseTexture(items,'EyesMaterial',2),items[1]);
  assert.equal(matchingLinkedDiffuseTexture(items,'OtherMaterial',2),null);
});

test('no arbitrary skin selection when multiple linked color variants compete',()=>{
  const items=[
    {path:'textures/pm0025_body_color.dds',linkedKind:'texture'},
    {path:'textures/pm0025_body_diffuse.bntx',linkedKind:'texture'},
    {path:'textures/pm0025_body_normal.dds',linkedKind:'texture'}
  ];
  assert.equal(matchingLinkedDiffuseTexture(items,'BodyMaterial',2),null);
  assert.equal(matchingLinkedDiffuseTexture(items,'UnspecifiedMaterial',1),null);
});

test('single matched diffuse image can be applied without shader metadata',()=>{
  const files=[
    {path:'textures/pm0025_body.dds',linkedKind:'texture'},
    {path:'textures/pm0025_body_normal.dds',linkedKind:'texture'},
    {path:'textures/pm0026_eyes.dds'}
  ];
  assert.equal(matchingLinkedDiffuseTexture(files,'MeshStandardMaterial',1),files[0]);
});
