import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createDecipheriv,randomBytes,webcrypto} from 'node:crypto';
import {decryptEcb,decryptCtr,decryptXtsHeader,parseLocalKeys} from '../src/nca-crypto.js';
import {openGamePackage} from '../src/game-file-reader.js';

if(!globalThis.crypto?.subtle)globalThis.crypto=webcrypto;
function encryptEcb(key,blocks){
  const cipher=createCipheriv('aes-128-ecb',key,null);cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(blocks),cipher.final()]);
}
function ctr(block,contentKey,iv){
  const cipher=createCipheriv('aes-128-ctr',contentKey,iv);
  return Buffer.concat([cipher.update(block),cipher.final()]);
}
function encXts(block,key,sector,order='big'){
  const tweak=Buffer.alloc(16);
  if(order==='big')tweak.writeBigUInt64BE(BigInt(sector),8);
  else tweak.writeBigUInt64LE(BigInt(sector),0);
  const cipher=createCipheriv('aes-128-xts',key,tweak);
  return Buffer.concat([cipher.update(block),cipher.final()]);
}
function pfs(files){
  const strings=Buffer.concat(files.map(([name])=>Buffer.from(name+'\0')));
  const header=Buffer.alloc(16);
  header.write('PFS0',0);header.writeUInt32LE(files.length,4);
  header.writeUInt32LE(strings.length,8);
  const table=Buffer.alloc(files.length*24);
  let offset=0,nameAt=0;
  for(const [i,[name,body]] of files.entries()){
    table.writeBigUInt64LE(BigInt(offset),i*24);
    table.writeBigUInt64LE(BigInt(body.length),i*24+8);
    table.writeUInt32LE(nameAt,i*24+16);
    offset+=body.length;nameAt+=Buffer.byteLength(name)+1;
  }
  return Buffer.concat([header,table,strings,...files.map(([,data])=>data)]);
}
function romfs(){
  const filename=Buffer.from('pokemon/invalid');
  // A flat root file is enough to test recursive directory metadata parsing.
  const name=Buffer.from('pm0025_00_00.gfpak');
  const raw=Buffer.from('GFLXPACK sample');
  const dirs=Buffer.alloc(24,0);
  dirs.writeUInt32LE(0xffffffff,0);
  dirs.writeUInt32LE(0xffffffff,4);
  dirs.writeUInt32LE(0xffffffff,8);
  dirs.writeUInt32LE(0,12);
  dirs.writeUInt32LE(0xffffffff,16);
  const files=Buffer.alloc(32+name.length,0);
  files.writeUInt32LE(0,0);
  files.writeUInt32LE(0xffffffff,4);
  files.writeBigUInt64LE(0n,8);
  files.writeBigUInt64LE(BigInt(raw.length),16);
  files.writeUInt32LE(0xffffffff,24);
  files.writeUInt32LE(name.length,28);
  name.copy(files,32);
  const table=Buffer.alloc(0x200+raw.length);
  table.writeBigUInt64LE(0x50n,0);
  table.writeBigUInt64LE(0x50n,0x18);
  table.writeBigUInt64LE(BigInt(dirs.length),0x20);
  table.writeBigUInt64LE(BigInt(0x50+dirs.length),0x38);
  table.writeBigUInt64LE(BigInt(files.length),0x40);
  table.writeBigUInt64LE(0x200n,0x48);
  dirs.copy(table,0x50);
  files.copy(table,0x50+dirs.length);
  raw.copy(table,0x200);
  return {table,raw,name:name.toString()};
}
function nca(payload,{kind='PFS0',headerEncrypted=true,encryptContent=true,rights=false}={}){
  const headerKey=randomBytes(32),areaKey=randomBytes(16),contentKey=randomBytes(16);
  const other0=randomBytes(16),other1=randomBytes(16),other3=randomBytes(16);
  const head=Buffer.alloc(0xc00);
  head.write('NCA3',0x200);
  head[0x206]=1;head[0x207]=0;
  head.writeUInt32LE(6,0x240);
  const extent=Math.ceil(payload.length/0x200)*0x200;
  head.writeUInt32LE(6+extent/0x200,0x244);
  const fs=0x400;
  head[fs+2]=kind==='PFS0'?2:0;
  head[fs+3]=kind==='PFS0'?0:3;
  head[fs+4]=encryptContent?3:1;
  const prefix=Buffer.from('0123456789abcdef','hex');
  Buffer.from(prefix).reverse().copy(head,fs+0x140);
  const rightsId=randomBytes(16);
  if(rights)rightsId.copy(head,0x230);
  if(kind==='RomFS'){
    head.write('IVFC',fs+8);
    head.writeUInt32LE(2,fs+0x14);
    head.writeBigUInt64LE(0n,fs+0x18);
    head.writeBigUInt64LE(BigInt(payload.length),fs+0x20);
  }
  const keysArea=Buffer.concat([other0,other1,contentKey,other3]);
  encryptEcb(areaKey,keysArea).copy(head,0x300);
  const aligned=Buffer.alloc(extent);payload.copy(aligned);
  const ctrIv=Buffer.concat([prefix,Buffer.alloc(8)]);
  ctrIv.writeBigUInt64BE(BigInt(0xc00/16),8);
  const encoded=encryptContent?ctr(aligned,contentKey,ctrIv):aligned;
  const encHeader=Buffer.alloc(0xc00);
  for(let i=0;i<6;i++){
    const block=head.subarray(i*0x200,(i+1)*0x200);
    const output=headerEncrypted?encXts(block,headerKey,i):block;
    output.copy(encHeader,i*0x200);
  }
  const content=Buffer.concat([encHeader,encoded]);
  const file=new Blob([pfs([['main.nca',content]])]);
  file.name='secure.nsp';
  const keyLines=[
    'nca_header_key = '+headerKey.toString('hex'),
    'nca_key_area_key_application_00 = '+areaKey.toString('hex')
  ];
  if(rights)keyLines.push('titlekey_'+rightsId.toString('hex')+' = '+contentKey.toString('hex'));
  return {file,keyLines,headerKey,areaKey,contentKey,content};
}

test('WebCrypto AES-ECB decrypt matches native AES-ECB across 4 key-area blocks',async()=>{
  const key=randomBytes(16),input=randomBytes(64);
  assert.deepEqual(Buffer.from(await decryptEcb(key,encryptEcb(key,input))),input);
});
test('WebCrypto AES-XTS NCA header matches native Node AES-XTS in big/little tweaks',async()=>{
  for(const order of ['big','little']){
    const key=randomBytes(32),body=Buffer.alloc(0xc00);
    randomBytes(0xc00).copy(body);
    body.write('NCA3',0x200);
    const encrypted=Buffer.alloc(0xc00);
    for(let i=0;i<6;i++)encXts(body.subarray(i*0x200,(i+1)*0x200),key,i,order)
      .copy(encrypted,i*0x200);
    const result=await decryptXtsHeader(encrypted,key);
    assert.equal(result.endian,order);
    assert.deepEqual(Buffer.from(result.header),body);
  }
});
test('AES-CTR decrypt supports aligned absolute positions beyond signed 32-bit',async()=>{
  const key=randomBytes(16),prefix=randomBytes(8);
  const absolute=0x80001000,iv=Buffer.concat([prefix,Buffer.alloc(8)]);
  iv.writeBigUInt64BE(BigInt(absolute/16),8);
  const message=randomBytes(1024);
  assert.deepEqual(Buffer.from(await decryptCtr(key,ctr(message,key,iv),prefix,absolute)),message);
});
test('Only valid local key lines are accepted and keys can be forgotten',()=>{
  const values=parseLocalKeys('nca_header_key = '+randomBytes(32).toString('hex')+
    '\nignored = 1234\n# comment\n');
  assert.equal(values.size,1);
  assert.equal(values.get('nca_header_key').length,32);
  values.clear();
  assert.equal(values.size,0);
});
test('Encrypted NSP NCA PFS0 files can be listed and exported using local prod.keys',async()=>{
  const original=Buffer.from('Original pokemon file data, never uploaded');
  const source=nca(pfs([['pokemon/pm0025_00_00.gfpak',original]]));
  const without=await openGamePackage(source.file);
  assert.equal(without.entries.length,1);
  assert.equal(without.entries[0].ncaStatus,'locked');
  const keys=parseLocalKeys(source.keyLines.join('\n'));
  const decoded=await openGamePackage(source.file,{keys});
  assert.equal(decoded.entries.length,2,decoded.warnings.join('; '));
  assert.equal(decoded.entries[0].ncaStatus,'decrypted');
  assert.equal(decoded.entries[1].category,'archive');
  assert.deepEqual(Buffer.from(await decoded.entries[1].getBytes()),original);
  assert.deepEqual(Buffer.from(await (await decoded.entries[1].getBlob()).arrayBuffer()),original);
  keys.clear();
});
test('AES-CTR decrypted NCA RomFS exposes native game assets, not only PFS0 tables',async()=>{
  const fs=romfs();
  const source=nca(fs.table,{kind:'RomFS'});
  const decoded=await openGamePackage(source.file,{keys:parseLocalKeys(source.keyLines.join('\n'))});
  assert.equal(decoded.entries.length,2,decoded.warnings.join('; '));
  assert.match(decoded.entries[1].name,/pm0025_00_00\.gfpak$/);
  assert.deepEqual(Buffer.from(await decoded.entries[1].getBytes()),fs.raw);
});
test('Wrong content key never yields a false successful model listing',async()=>{
  const source=nca(pfs([['pm0094_00_00.trmdl',Buffer.from([1,2,3])]]));
  const bad=parseLocalKeys([
    source.keyLines[0],
    'nca_key_area_key_application_00 = '+randomBytes(16).toString('hex')
  ].join('\n'));
  const result=await openGamePackage(source.file,{keys:bad});
  assert.equal(result.entries.length,1);
  assert.notEqual(result.entries[0].ncaStatus,'decrypted');
});
test('Rights-managed NCAs need a matching title key beyond prod.keys',async()=>{
  const source=nca(pfs([['pm0094.trmdl',Buffer.from([1])]]),{rights:true});
  const notEnough=parseLocalKeys(source.keyLines.slice(0,2).join('\n'));
  const blocked=await openGamePackage(source.file,{keys:notEnough});
  assert.equal(blocked.entries.length,1);
  assert.equal(blocked.entries[0].ncaStatus,'locked');
  const both=parseLocalKeys(source.keyLines.join('\n'));
  const decoded=await openGamePackage(source.file,{keys:both});
  assert.equal(decoded.entries.length,2,decoded.warnings.join('; '));
});
