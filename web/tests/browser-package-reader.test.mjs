import test from 'node:test';
import assert from 'node:assert/strict';
import {fromBlob,readPackage,openXci,inspectNca,openNcaSection,
  categoryOf,kindOf} from '../src/browser-package-reader.js';

const text=new TextEncoder();
function pack(magic,rows){
  const hfs=magic==='HFS0',step=hfs?64:24;
  const names=rows.map(r=>text.encode(r.name+'\0'));
  const namesLength=names.reduce((n,b)=>n+b.length,0);
  const dataLength=rows.reduce((n,r)=>n+r.bytes.length,0);
  const size=16+step*rows.length+namesLength+dataLength;
  const raw=new Uint8Array(size),view=new DataView(raw.buffer);
  raw.set(text.encode(magic),0);
  view.setUint32(4,rows.length,true);view.setUint32(8,namesLength,true);
  let at=16+step*rows.length,off=0,nameOff=0;
  for(let i=0;i<rows.length;i++){
    const row=rows[i],entry=16+i*step;
    view.setBigUint64(entry,BigInt(off),true);
    view.setBigUint64(entry+8,BigInt(row.bytes.length),true);
    view.setUint32(entry+16,nameOff,true);
    raw.set(names[i],at);at+=names[i].length;nameOff+=names[i].length;
    off+=row.bytes.length;
  }
  off=16+step*rows.length+namesLength;
  for(const row of rows){raw.set(row.bytes,off);off+=row.bytes.length;}
  return raw;
}
test('read-only NSP PFS0 index preserves filenames and payload offsets',async()=>{
  const bytes=pack('PFS0',[
    {name:'program.nca',bytes:new Uint8Array([1,2,3,4])},
    {name:'manifest.cnmt',bytes:new Uint8Array([5,6])}
  ]);
  const result=await readPackage(fromBlob(new Blob([bytes])),0,'PFS0');
  assert.equal(result.entries.length,2);
  assert.equal(result.entries[0].category,'encrypted container');
  assert.deepEqual(Array.from(await result.entries[1].source.read(0,2)),[5,6]);
  assert.equal(result.indexSize,bytes.length-6);
});
test('XCI HFS0 partition files resolve offsets relative to full index',async()=>{
  const nested=pack('HFS0',[{name:'test.nca',bytes:new Uint8Array([9,8,7])}]);
  const head=pack('HFS0',[{name:'secure',bytes:nested}]);
  const xci=new Uint8Array(0xf000+head.byteLength);
  xci.set(head,0xf000);
  const result=await openXci(fromBlob(new Blob([xci])));
  assert.equal(result.entries[0].name,'secure');
  const sub=await readPackage(result.entries[0].source,0,'HFS0');
  assert.deepEqual(Array.from(await sub.entries[0].source.read(0,3)),[9,8,7]);
});
test('rejects an NSP index whose declared payload is outside the package',async()=>{
  const bytes=pack('PFS0',[{name:'bad.nca',bytes:new Uint8Array([1])}]);
  const view=new DataView(bytes.buffer);
  view.setBigUint64(16+8,123456n,true);
  await assert.rejects(readPackage(fromBlob(new Blob([bytes]))),/outside/);
});
test('plaintext ExeFS NCA sections can expose their PFS0 directory',async()=>{
  const exe=pack('PFS0',[{name:'main',bytes:new Uint8Array([11,12])}]);
  const raw=new Uint8Array(0x1000);
  raw.set(text.encode('NCA3'),0x200);
  const v=new DataView(raw.buffer);
  v.setUint32(0x240,6,true);v.setUint32(0x244,8,true);
  raw[0x400]=2;raw[0x402]=1;raw[0x403]=0;raw[0x404]=1;
  raw.set(exe,0xc00);
  const sections=await inspectNca(fromBlob(new Blob([raw])));
  assert.equal(sections.length,1);
  assert.equal(sections[0].encryption,1);
  const result=await openNcaSection(sections[0]);
  assert.deepEqual(Array.from(await result.entries[0].source.read(0,2)),[11,12]);
});
test('encrypted NCA headers are not falsely listed as readable sections',async()=>{
  const raw=new Uint8Array(0xc00);
  await assert.rejects(inspectNca(fromBlob(new Blob([raw]))),/Encrypted NCA/);
});
test('asset detection does not pretend that unknown files are models',()=>{
  assert.equal(categoryOf('body.trmdl'),'model');
  assert.equal(categoryOf('body.tranm'),'animation');
  assert.equal(categoryOf('unknown.bin'),'other');
  assert.equal(kindOf('body.gfpak'),'gfpak');
});
