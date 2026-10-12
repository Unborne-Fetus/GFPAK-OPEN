import test from 'node:test';
import assert from 'node:assert/strict';
import {openGamePackage,openExtractedFolder,assetCategory,exportIndex} from '../src/game-file-reader.js';

function pfs(entries) {
  const strings=Buffer.concat(entries.map(([name])=>Buffer.from(name+'\0')));
  const index=Buffer.alloc(entries.length*24);
  let where=0,dataAt=0;
  for(const [i,[name,payload]] of entries.entries()){
    index.writeBigUInt64LE(BigInt(dataAt),i*24);
    index.writeBigUInt64LE(BigInt(payload.length),i*24+8);
    index.writeUInt32LE(where,i*24+16);
    where+=Buffer.byteLength(name)+1;dataAt+=payload.length;
  }
  const header=Buffer.alloc(16);
  header.write('PFS0',0);
  header.writeUInt32LE(entries.length,4);
  header.writeUInt32LE(strings.length,8);
  return Buffer.concat([header,index,strings,...entries.map(([,payload])=>payload)]);
}
function hfs(entries) {
  const strings=Buffer.concat(entries.map(([name])=>Buffer.from(name+'\0')));
  const index=Buffer.alloc(entries.length*64);
  let where=0,dataAt=0;
  for(const [i,[name,payload]] of entries.entries()){
    index.writeBigUInt64LE(BigInt(dataAt),i*64);
    index.writeBigUInt64LE(BigInt(payload.length),i*64+8);
    index.writeUInt32LE(where,i*64+16);
    where+=Buffer.byteLength(name)+1;dataAt+=payload.length;
  }
  const header=Buffer.alloc(16);header.write('HFS0',0);
  header.writeUInt32LE(entries.length,4);
  header.writeUInt32LE(strings.length,8);
  return Buffer.concat([header,index,strings,...entries.map(([,payload])=>payload)]);
}
function localFile(buffer,name) {
  const blob=new Blob([buffer]);
  blob.name=name;
  return blob;
}
function plainNCA() {
  const payload=pfs([['pm0094_00_00.trmdl',Buffer.from([1,2,3,4])],
    ['pm0094_idle.tranm',Buffer.from([5,6,7])]]);
  const section=Buffer.concat([payload,Buffer.alloc(0x200)]);
  const nca=Buffer.alloc(0xc00 + section.length);
  nca.write('NCA3',0x200);
  nca.writeUInt32LE(6,0x240);
  nca.writeUInt32LE(6+Math.ceil(section.length/0x200),0x244);
  nca[0x400+2]=2; // PFS0 type
  nca[0x400+3]=0; // no hash table
  nca[0x400+4]=1; // plaintext section
  section.copy(nca,0xc00);
  return nca;
}
test('Full NSP inventory uses file-backed slices and preserves every source byte',async()=>{
  const file=localFile(pfs([
    ['game/main.gfpak',Buffer.from('GFLXPACK TEST')],
    ['content.ncz',Buffer.from([1,2,3])],
    ['level.json',Buffer.from('{}')]
  ]),'game.nsz');
  const pkg=await openGamePackage(file);
  assert.equal(pkg.type,'NSZ / PFS0');
  assert.equal(pkg.entries.length,3);
  assert.equal(pkg.entries[0].category,'archive');
  assert.equal(Buffer.from(await pkg.entries[0].getBytes()).toString(),'GFLXPACK TEST');
  assert.match(pkg.warnings.join(' '),/NCZ/);
  assert.equal(exportIndex(pkg).entries.length,3);
});
test('XCI root HFS0 and secure partition expose nested readable game files',async()=>{
  const secure=hfs([['pokemon/pm0025.trmdl',Buffer.from([9,8,7])]]);
  const root=hfs([['secure',secure]]);
  const image=Buffer.alloc(0x200);
  image.write('HEAD',0x100);
  image.writeBigUInt64LE(BigInt(0x200),0x130);
  const pkg=await openGamePackage(localFile(Buffer.concat([image,root]),'cartridge.xci'));
  assert.equal(pkg.type,'XCI / HFS0');
  assert.equal(pkg.entries.length,1);
  assert.equal(pkg.entries[0].name,'secure/pokemon/pm0025.trmdl');
  assert.deepEqual([...new Uint8Array(await pkg.entries[0].getBytes())],[9,8,7]);
});
test('Plaintext NCA PartitionFS is scanned without external executables',async()=>{
  const nca=plainNCA();
  const pkg=await openGamePackage(localFile(pfs([['main.nca',nca]]),'game.nsp'));
  assert.equal(pkg.originals,1);
  assert.equal(pkg.entries.length,3);
  assert.equal(pkg.entries[0].ncaStatus,'partial-plaintext');
  assert.equal(pkg.entries[1].name,'main.nca/section-0/pm0094_00_00.trmdl');
  assert.deepEqual([...new Uint8Array(await pkg.entries[2].getBytes())],[5,6,7]);
});
test('Encrypted NCA stays locked and is never reported as containing zero real assets',async()=>{
  const nca=plainNCA(); nca.write('ENCR',0x200);
  const pkg=await openGamePackage(localFile(pfs([['main.nca',nca]]),'game.nsp'));
  assert.equal(pkg.entries.length,1);
  assert.equal(pkg.entries[0].ncaStatus,'locked');
  assert.match(pkg.warnings.join(' '),/encrypted/i);
});
test('Unsafe names and bounds are rejected rather than read from arbitrary paths',async()=>{
  await assert.rejects(openGamePackage(localFile(pfs([['../bad',Buffer.from([1])]]),'bad.nsp')),
    /Unsafe/);
  const broken=pfs([['model.gfbmdl',Buffer.from([1])]]);
  broken.writeBigUInt64LE(90000000n,16+8);
  await assert.rejects(openGamePackage(localFile(broken,'corrupt.nsp')),/beyond package/);
});
test('A local extracted folder is indexed by real original paths',()=>{
  const file=localFile(Buffer.from([1,2]),'pm0094_body.bntx');
  file.webkitRelativePath='Pokemon/pm0094_body.bntx';
  const pkg=openExtractedFolder([file]);
  assert.equal(pkg.entries[0].category,'texture');
  assert.equal(pkg.entries[0].name,'Pokemon/pm0094_body.bntx');
  assert.equal(assetCategory('pm0094_idle.tranm'),'animation');
});
