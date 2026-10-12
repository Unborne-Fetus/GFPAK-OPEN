import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTrinityModel} from '../src/trinity-model.js';
import {loadGfbmdl} from '../src/gfbmdl-model.js';
import {makeTrinityTriangle} from './trinity-fixture.mjs';
import {makeGfbmdlTriangle} from './native-gfbmdl-sample.mjs';

const bufferOf = value => value.buffer.slice(
  value.byteOffset, value.byteOffset + value.byteLength);

test('fast Trinity preview displays real geometry before awaiting companion passes',async()=>{
  const files = makeTrinityTriangle();
  const accessed = [];
  const project = {
    items:Object.entries(files).map(([path,bytes])=>({
      path,size:bytes.byteLength,getBytes:async()=>{
        accessed.push(path);return bufferOf(bytes);
      }
    }))
  };
  const result = await loadTrinityModel(project,'models/test.trmdl',
    ()=>{}, {fastPreview:true});
  assert.equal(result.root.children.filter(c=>c.isMesh).length,1);
  assert.equal(typeof result.postLoad,'function');
  assert.equal(result.animations.length,0);
  assert.deepEqual(new Set(accessed), new Set(Object.keys(files)));
  await result.postLoad();
  assert.equal(result.animations.length,0);
  result.disposeAssets();
});

test('fast GFBMDL preview shows original mesh before optional native tracks',async()=>{
  const data=makeGfbmdlTriangle();
  const project={items:[{
    path:'models/legacy.gfbmdl',size:data.byteLength,getBytes:async()=>data
  }]};
  const result=await loadGfbmdl(project,'models/legacy.gfbmdl',
    ()=>{}, {fastPreview:true});
  assert.equal(result.root.children.filter(c=>c.isMesh).length,1);
  assert.equal(typeof result.postLoad,'function');
  await result.postLoad();
  assert.equal(result.animations.length,0);
  result.disposeAssets();
});
