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

// A genuine BC1 DDS file is sufficient to verify Three.js material assignment
// without browser-only ImageBitmap APIs or game-copyrighted assets.
function sampleDDS() {
  const b = new Uint8Array(136), v = new DataView(b.buffer);
  v.setUint32(0, 0x20534444, true);
  v.setUint32(4, 124, true);
  v.setUint32(8, 0xA1007, true);
  v.setUint32(12, 4, true);
  v.setUint32(16, 4, true);
  v.setUint32(20, 8, true);
  v.setUint32(28, 1, true);
  v.setUint32(76, 32, true);
  v.setUint32(80, 4, true);
  v.setUint32(84, 0x31545844, true);
  v.setUint32(108, 0x1000, true);
  b.set([0, 0xf8, 0x1f, 0, 0, 0, 0, 0], 128);
  return b;
}

test('Preview in 3D imports linked cross-folder animation and texture into Trinity scene', async() => {
  const {makeAnimatedTrinityTriangle} = await import('./trinity-animation-fixture.mjs');
  const source = makeAnimatedTrinityTriangle();
  const animation = source['models/test.tranm'];
  delete source['models/test.tranm'];
  source['animations/idle.tranm'] = animation;
  source['textures/body.dds'] = sampleDDS();
  const reads = [];
  const project = {items:Object.entries(source).map(([path,bytes])=>({
    path, size:bytes.byteLength,
    linkedKind: path.endsWith('idle.tranm') ? 'animation' :
      path.endsWith('body.dds') ? 'texture' : null,
    matchConfidence:'verified',
    getBytes:async()=>{reads.push(path);return bufferOf(bytes);}
  }))};
  const result = await loadTrinityModel(project, 'models/test.trmdl',
    ()=>{}, {fastPreview:true});
  assert.equal(result.animations.length,0);
  assert.ok(!reads.includes('animations/idle.tranm'));
  assert.ok(!reads.includes('textures/body.dds'));
  await result.postLoad();
  assert.equal(result.animations.length,1);
  assert.ok(result.animations[0].validate());
  const mesh = result.root.children.find(child => child.isMesh);
  assert.ok(mesh.material.map?.isCompressedTexture);
  assert.ok(reads.includes('animations/idle.tranm'));
  assert.ok(reads.includes('textures/body.dds'));
  result.disposeAssets();
});

test('Preview in 3D imports one linked cross-folder texture into legacy GFBMDL scene',async()=>{
  const model=makeGfbmdlTriangle(), image=sampleDDS();
  const project={items:[
    {path:'models/legacy.gfbmdl',size:model.byteLength,getBytes:async()=>model},
    {path:'materials/body.dds',size:image.byteLength,
      linkedKind:'texture',matchConfidence:'verified',
      getBytes:async()=>bufferOf(image)}
  ]};
  const result=await loadGfbmdl(project,'models/legacy.gfbmdl',
    ()=>{}, {fastPreview:true});
  const mesh=result.root.children.find(child=>child.isMesh);
  assert.ok(mesh);
  const material = Array.isArray(mesh.material) ?
    mesh.material[0] : mesh.material;
  assert.equal(material.map,null);
  await result.postLoad();
  assert.ok(material.map?.isCompressedTexture);
  result.disposeAssets();
});
