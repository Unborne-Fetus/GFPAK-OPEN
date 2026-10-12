import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {exportModelBatch} from '../src/native-batch.js';
test('batch export waits for companions, keeps all clips and continues after failure',async()=>{
  let disposed=0;
  const models=[{key:'a',name:'folder/pm0001.trmdl'},{key:'bad',name:'broken.trmdl'},{key:'b',name:'pm0002.trmdl'}];
  const result=await exportModelBatch(models,async key=>{
    if(key==='bad')throw Error('Unsupported native variant');
    return {label:key,selected:key,items:[]};
  },()=>{},async()=>{
    const clips=[];
    return {root:{traverse:()=>{}},animations:clips,postLoad:async()=>clips.push('original clip'),disposeAssets:()=>disposed++};
  },async(root,clips)=>{
    assert.deepEqual(clips,['original clip']);return new Uint8Array([1,2,3]);
  });
  assert.equal(result.completed,2);assert.equal(result.errors.length,1);assert.equal(disposed,2);
  const zip=await JSZip.loadAsync(await result.blob.arrayBuffer());
  assert.ok(zip.file('0001_pm0001.glb'));assert.ok(zip.file('0003_pm0002.glb'));
  const report=JSON.parse(await zip.file('export-report.json').async('string'));
  assert.match(report.errors[0].error,/Unsupported/);
});
