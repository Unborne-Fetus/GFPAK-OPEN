import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingLinkedDiffuseTexture, textureVariantForItem,
  textureVariantFromName, textureFamilyName } from '../src/texture-loader.js';

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

test('regular texture variant is preferred while shiny remains selectable',()=>{
  const files=[
    {path:'textures/pm0025_body_color.dds',linkedKind:'texture'},
    {path:'textures/pm0025_body_color_shiny.dds',linkedKind:'texture'},
    {path:'textures/pm0025_body_normal.dds',linkedKind:'texture'}
  ];
  assert.equal(textureVariantForItem(files[0]),'regular');
  assert.equal(textureVariantForItem(files[1]),'shiny');
  assert.equal(matchingLinkedDiffuseTexture(files,'BodyMaterial',2,'regular'),files[0]);
  assert.equal(matchingLinkedDiffuseTexture(files,'BodyMaterial',2,'shiny'),files[1]);
});

test('mixed BNTX containers can serve either regular or shiny surfaces',()=>{
  const mixed={path:'textures/pm0025_body.bntx',linkedKind:'texture',
    textureNames:['body_color','body_color_shiny']};
  assert.equal(textureVariantForItem(mixed),'mixed');
  assert.equal(matchingLinkedDiffuseTexture([mixed],'BodyMaterial',1,'regular'),mixed);
  assert.equal(matchingLinkedDiffuseTexture([mixed],'BodyMaterial',1,'shiny'),mixed);
});

test('numeric native color skins map to their own normal and shiny surfaces',()=>{
  assert.equal(textureVariantFromName('pm0025_body_col00.dds'),'regular');
  assert.equal(textureVariantFromName('pm0025_body_col01.dds'),'shiny');
  assert.equal(textureFamilyName('pm0025_body_col00.dds'),
    textureFamilyName('pm0025_body_col01.dds'));
  assert.equal(textureFamilyName('pm0025_body_color_shiny.dds'),
    textureFamilyName('pm0025_body_color.dds'));
});
