import test from 'node:test';
import assert from 'node:assert/strict';
import {fireGradientPixels,fireMaskPixels,isLegacyFireCore,isLegacyFireMask} from '../src/gfbmdl-fire.js';

test('native fire shader uses authored red and yellow palette with correct color encoding', () => {
  const source={shader:'PokeFireCoreShader1',colors:{BaseColor0:[1,0,0],
    BaseColor1:[1,0,0],LayerColor0:[1,1,0],LayerColor1:[1,1,0]},scalars:{ColorLerpValue:0}};
  const gradient={width:3,height:1,data:new Uint8Array([0,0,0,255,128,128,128,255,255,255,255,255])};
  const pixels=fireGradientPixels(source,gradient);
  assert.deepEqual([...pixels.slice(0,4)],[255,0,0,255]);
  assert.deepEqual([...pixels.slice(8,12)],[255,255,0,255]);
  assert.ok(pixels[5]>180 && pixels[5]<190);
  assert.equal(isLegacyFireCore(source),true);
  assert.equal(isLegacyFireMask({shader:'PokeFireMaskShader1'}),true);
  assert.equal(isLegacyFireCore({shader:'PokeDefaultShader',name:'Fire'}),false);
});

test('missing authored flame colors are rejected rather than guessed', () => {
  assert.throws(()=>fireGradientPixels({colors:{}},{width:1,height:1,data:new Uint8Array(4)}),/palette is missing/);
});

test('core stays connected while dedicated silhouette mask clips the masking pass', () => {
  const source={colors:{BaseColor0:[1,0,0],LayerColor0:[1,1,0]},
    scalars:{DiscardValuie:.85,ColorLerpValue:0}};
  const gradient={width:1,height:1,data:new Uint8Array([128,128,128,255])};
  const mask={width:3,height:1,data:new Uint8Array([0,0,0,255,128,128,128,255,255,255,255,255])};
  const pixels=fireGradientPixels(source,gradient,[mask]);
  assert.equal(pixels.length,12);
  assert.deepEqual([pixels[3],pixels[7],pixels[11]],[255,255,255]);
  const silhouette=fireMaskPixels(source,[mask]);
  assert.deepEqual([silhouette.data[3],silhouette.data[7],silhouette.data[11]],[0,0,255]);
  assert.equal(pixels[0],255);assert.equal(pixels[8],255);
});
