import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTrinityTriangle} from './trinity-fixture.mjs';
import {makeAnimatedTrinityTriangle} from './trinity-animation-fixture.mjs';
import {Builder} from 'flatbuffers';
import {makeGfbmdlTriangle} from './native-gfbmdl-sample.mjs';
import {prepareGfpakModelPreview,prepareGfpakCompanions} from '../src/native-gfpak-preview.js';
import {loadTrinityModel} from '../src/trinity-model.js';
import {fnv1a64,parseHashDictionary} from '../src/gfpak.js';

function gfpak(contents,codec=0,validOodle=false) {
  const files=Object.entries(contents).map(([name,bytes])=>{
    if(codec!==3||!validOodle)return [name,bytes,bytes.byteLength];
    const n=bytes.byteLength;
    if(n<1||n>131071)throw Error('Unsupported fixture size');
    const length=n-1;
    const frame=Uint8Array.from([0x8c,0x06,(length>>16)&255,(length>>8)&255,length&255,...bytes]);
    return [name,frame,n];
  });
  const total=files.length;
  const tableAt=40,hashAt=tableAt+24*total,bodyAt=hashAt+8*total;
  const sizes=files.map(([,body])=>body.byteLength);
  const size=bodyAt+sizes.reduce((a,b)=>a+b,0);
  const array=new Uint8Array(size),view=new DataView(array.buffer);
  array.set(new TextEncoder().encode('GFLXPACK'));
  view.setUint32(8,0x1000,true);
  view.setUint32(16,total,true);
  view.setBigUint64(24,BigInt(tableAt),true);
  view.setBigUint64(32,BigInt(hashAt),true);
  let offset=bodyAt;
  for(let i=0;i<total;i++) {
    const [name,body,rawSize]=files[i];
    const at=tableAt+i*24;
    view.setUint16(at+2,codec,true);
    view.setUint32(at+4,rawSize,true);
    view.setUint32(at+8,body.byteLength,true);
    view.setUint32(at+16,offset,true);
    view.setBigUint64(hashAt+i*8,BigInt('0x'+fnv1a64(name)),true);
    array.set(body,offset);offset+=body.byteLength;
  }
  return new Blob([array]);
}

test('PLA GFPAK with unknown resource hashes still resolves real TRMDL/TRMSH/TRMBF and renders geometry',async()=>{
  const blob=gfpak(makeTrinityTriangle());
  const {project,selected}=await prepareGfpakModelPreview(blob,'pm0025_00_00.gfpak');
  assert.equal(project.items.length,3);
  assert.match(selected,/\.trmdl$/);
  const real=await loadTrinityModel(project,selected,()=>{},{fastPreview:true});
  let geometry=0;
  real.root.traverse(child=>{if(child.isMesh)geometry+=child.geometry.getAttribute('position')?.count||0;});
  assert.equal(geometry,3);
  real.disposeAssets();
});
test('hash-only GFBMDL GFPAK recognizes and previews an actual model without a dictionary',async()=>{
  const archive=gfpak({'hashed/unknown-resource.bin':new Uint8Array(makeGfbmdlTriangle())});
  const {project,selected}=await prepareGfpakModelPreview(archive,'pm0025_00_00.gfpak');
  assert.match(selected,/\.gfbmdl$/);
  assert.equal(project.items.length,1);
  assert.deepEqual(new Uint8Array(await project.items[0].getBytes()),new Uint8Array(makeGfbmdlTriangle()));
});

test('GFPAK decompression failures are reported instead of mistaken for missing hashes',async()=>{
  const archive=gfpak({'hashed/model.bin':new Uint8Array([1,2,3,4,5,6,7,8])},3);
  const messages=[];
  await assert.rejects(prepareGfpakModelPreview(archive,'pm0025_00_00.gfpak',
    message=>messages.push(message)),/extraction attempts failed.*First error:.*Oodle/i);
  assert.ok(messages.some(message=>message.includes('First resource extraction error')));
});

test('hashed skeleton is not misclassified as the first TRMDL model',async()=>{
  const animated=makeAnimatedTrinityTriangle();
  const rig=animated['models/test.trskl'];
  const models=makeTrinityTriangle();
  const blob=gfpak({'hashed/first-rig.bin':rig,...models});
  const {project,selected}=await prepareGfpakModelPreview(blob,'pm0025_00_00.gfpak');
  assert.match(selected,/\.trmdl$/);
  assert.ok(project.items.some(item=>item.path.endsWith('.trskl')));
  const preview=await loadTrinityModel(project,selected,()=>{},{fastPreview:true});
  assert.equal(preview.sourceStats.bones,1);
  preview.disposeAssets();
});

test('descriptor companion aliases resolve when dictionary canonical names differ',async()=>{
  const files=makeTrinityTriangle();
  const named={
    'hashed/root.trmdl':files['models/test.trmdl'],
    'hashed/unexpected_mesh.trmsh':files['models/test.trmsh'],
    'hashed/unexpected_buffer.trmbf':files['models/test.trmbf']
  };
  const dictionary=parseHashDictionary(Object.keys(named).join('\n'));
  const {project,selected}=await prepareGfpakModelPreview(
    gfpak(named),'pm0025_00_00.gfpak',()=>{},dictionary);
  assert.equal(selected,'hashed/root.trmdl');
  const shape=project.items.find(item=>item.path.endsWith('.trmsh'));
  assert.ok(shape.nativeAliases?.includes('test.trmsh'));
  const preview=await loadTrinityModel(project,selected,()=>{},{fastPreview:true});
  assert.ok(preview.sourceStats.vertices>0);
  preview.disposeAssets();
});

test('PLA GFPAK with known hash dictionary preserves real original companion filenames',async()=>{
  const blob=gfpak(makeTrinityTriangle());
  const dictionary=parseHashDictionary('models/\ntest.trmdl\ntest.trmsh\ntest.trmbf\n');
  const {project,selected}=await prepareGfpakModelPreview(blob,'pla-pokemon.gfpak',()=>{},dictionary);
  assert.equal(selected,'models/test.trmdl');
  assert.deepEqual(project.items.map(item=>item.path).sort(),Object.keys(makeTrinityTriangle()).sort());
});
test('Invalid Oodle-compressed GFPAK never fabricates a fake model',async()=>{
  const blob=gfpak(makeTrinityTriangle(),3);
  await assert.rejects(prepareGfpakModelPreview(blob,'pla.gfpak'),/No supported TRMDL|Oodle|unsupported compression/);
});

test('Oodle-compressed PLA GFPAK decodes original Trinity mesh and renders in browser',async()=>{
  const archive=gfpak(makeTrinityTriangle(),3,true);
  const {project,selected}=await prepareGfpakModelPreview(archive,'pm0025_00_00.gfpak');
  assert.equal(project.items.length,3);
  const model=await loadTrinityModel(project,selected,()=>{},{fastPreview:true});
  let meshes=0,vertices=0;
  model.root.traverse(o=>{
    if(o.isMesh){meshes++;vertices+=o.geometry.getAttribute('position')?.count||0;}
  });
  assert.equal(meshes,1);
  assert.equal(vertices,3);
  model.disposeAssets();
});

function bareNameTrmdl(names) {
  const b=new Builder(1024);
  const members=names.map(name=>{
    const value=b.createString(name);
    b.startObject(1);b.addFieldOffset(0,value,0);return b.endObject();
  });
  b.startVector(4,members.length,4);
  for(let i=members.length-1;i>=0;i--)b.addOffset(members[i]);
  const list=b.endVector();
  b.startObject(7);b.addFieldOffset(1,list,0);
  b.finish(b.endObject());
  return b.asUint8Array().slice();
}
test('Extensionless head/body/tail resolve across three indistinguishable hashed PLA meshes',async()=>{
  const triangle=makeTrinityTriangle();
  const data={
    'models/pm0094.trmdl':bareNameTrmdl(['head','body','tail']),
    'hidden/mesh_1.trmsh':triangle['models/test.trmsh'],
    'hidden/mesh_2.trmsh':triangle['models/test.trmsh'],
    'hidden/mesh_3.trmsh':triangle['models/test.trmsh'],
    'hidden/buffers.trmbf':triangle['models/test.trmbf']
  };
  const notes=[];
  const result=await prepareGfpakModelPreview(gfpak(data),'pm0094.gfpak',line=>notes.push(line));
  assert.deepEqual(result.project.items.filter(item=>item.path.endsWith('.trmsh'))
    .map(item=>item.path.split('/').at(-1)).sort(),['body.trmsh','head.trmsh','tail.trmsh']);
  assert.match(notes.join(' '),/ambiguous trmsh reference/);
  const loaded=await loadTrinityModel(result.project,result.selected,()=>{},{fastPreview:true});
  let count=0;
  loaded.root.traverse(node=>{if(node.isMesh)count++;});
  assert.equal(count,3);
  loaded.disposeAssets();
});

test('hashed native PLA GFPAK discovers actual skeletal animation and skeleton files for playback',async()=>{
  const assets=makeAnimatedTrinityTriangle();
  const archive=gfpak(assets);
  const {project,selected}=await prepareGfpakModelPreview(archive,'pm0025_00_00.gfpak');
  assert.equal(project.items.filter(item=>item.linkedKind==='animation').length,1,
    'Detected companion items: '+JSON.stringify(project.items.map(i=>({path:i.path,kind:i.linkedKind}))));
  assert.equal(project.items.filter(item=>item.path.endsWith('.trskl')).length,1);
  const model=await loadTrinityModel(project,selected,()=>{},{fastPreview:true});
  assert.equal(model.animations.length,0);
  await model.postLoad();
  assert.equal(model.animations.length,1);
  assert.ok(model.animations[0].tracks.length>0);
  model.disposeAssets();
});
test('hashed PLA GFPAK recognizes BNTX header as texture companion and preserves original bytes',async()=>{
  const original=makeTrinityTriangle();
  const bntx=new Uint8Array(64);bntx.set([66,78,84,88]);
  const archive=gfpak({...original,'hashed/unnamed-resource.bin':bntx});
  const {project}=await prepareGfpakModelPreview(archive,'pm0025_00_00.gfpak');
  const texture=project.items.find(item=>item.linkedKind==='texture');
  assert.ok(texture);
  assert.match(texture.path,/\.bntx$/);
  assert.deepEqual(new Uint8Array(await texture.getBytes()),bntx);
});

test('separately packed PLA skeleton with hashed member filename is recognized as TRSKL',async()=>{
  const skeleton=makeAnimatedTrinityTriangle()['models/test.trskl'];
  const archive=gfpak({'unresolved/unnamed-portion.bin':skeleton});
  const items=await prepareGfpakCompanions(archive,'pm0025_00_00_skeleton.gfpak');
  assert.equal(items.filter(item=>item.path.endsWith('.trskl')).length,1,
    JSON.stringify(items.map(item=>item.path)));
});

test('separate matching GFPAK exposes hashed PLA texture and animation companions',async()=>{
  const files=makeAnimatedTrinityTriangle();
  const texture=new Uint8Array(64);texture.set([66,78,84,88]);
  const companion=gfpak({
    'hashed/animation-resource.bin':files['models/test.tranm'],
    'hashed/texture-resource.bin':texture
  });
  const found=await prepareGfpakCompanions(companion,'pm0025_00_00_animation.gfpak');
  assert.equal(found.filter(item=>item.linkedKind==='animation').length,1);
  assert.equal(found.filter(item=>item.linkedKind==='texture').length,1);
});

function unreferencedTrmtr() {
  const b=new Builder(256);
  const name=b.createString('body');
  b.startObject(8);b.addFieldOffset(0,name,0);
  const material=b.endObject();
  b.startVector(4,1,4);b.addOffset(material);
  const materials=b.endVector();
  b.startObject(2);b.addFieldOffset(1,materials,0);
  b.finish(b.endObject());
  return b.asUint8Array().slice();
}

test('full hashed GFPAK rig/material/animation association works without TRMDL pointers',async()=>{
  const animated=makeAnimatedTrinityTriangle();
  const archive=gfpak({
    ...makeTrinityTriangle(),
    'unknown/original-hash-rig.bin':animated['models/test.trskl'],
    'unknown/original-hash-material.bin':unreferencedTrmtr(),
    'unknown/original-hash-idle.bin':animated['models/test.tranm']
  });
  const reports=[];
  const {project,selected}=await prepareGfpakModelPreview(
    archive,'pm0025_00_00.gfpak',line=>reports.push(line));
  assert.ok(project.items.some(item=>item.path.endsWith('.trskl')),reports.join('\n'));
  assert.ok(project.items.some(item=>item.path.endsWith('.trmtr')),reports.join('\n'));
  assert.equal(project.items.filter(item=>item.linkedKind==='animation').length,1);
  const model=await loadTrinityModel(project,selected,line=>reports.push(line),{fastPreview:true});
  assert.equal(model.sourceStats.bones,1,reports.join('\n'));
  await model.postLoad();
  assert.equal(model.animations.length,1,reports.join('\n'));
  assert.match(reports.join(' '),/Recovered.+TRSKL bones/);
  assert.match(reports.join(' '),/Recovered TRMTR materials/);
  model.disposeAssets();
});
