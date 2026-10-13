import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,randomBytes,webcrypto} from 'node:crypto';
import {parseNcaKeys,keyInfo,aesEcbDecrypt,decryptXts,decodeNcaHeader,
  parseNcaTicket} from '../src/browser-nca-crypto.js';
import {inspectNca,openNcaSection,fromBlob} from '../src/browser-package-reader.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const encoder=new TextEncoder();
function encrypt(algorithm,key,iv,plaintext){
  const cipher=createCipheriv(algorithm,key,iv);
  cipher.setAutoPadding?.(false);
  return Buffer.concat([cipher.update(plaintext),cipher.final()]);
}
function pfs(filename,content){
  const name=encoder.encode(filename+'\0');
  const body=new Uint8Array(16+24+name.length+content.length);
  const v=new DataView(body.buffer);
  body.set(encoder.encode('PFS0'),0);
  v.setUint32(4,1,true);v.setUint32(8,name.length,true);
  v.setBigUint64(16,0n,true);
  v.setBigUint64(24,BigInt(content.length),true);
  body.set(name,40);body.set(content,40+name.length);
  return body;
}
function fixture(encryption=3,rightsManaged=false){
  const keyAreaKey=randomBytes(16),kek=randomBytes(16);
  const blocks=[randomBytes(16),randomBytes(16),randomBytes(16),randomBytes(16)];
  const areaPlain=Buffer.concat(blocks);
  const contentKey=blocks[2],rights=randomBytes(16);
  const header=new Uint8Array(0xc00),section=new Uint8Array(0x400);
  header.set(encoder.encode('NCA3'),0x200);
  const h=new DataView(header.buffer);
  h.setUint32(0x240,6,true);h.setUint32(0x244,8,true);
  header[0x400]=2;header[0x402]=1;header[0x403]=0;header[0x404]=encryption;
  // AES-CTR section counter prefix is zero in this synthetic fixture.
  header.set(encrypt('aes-128-ecb',keyAreaKey,null,areaPlain),0x300);
  const keys=new Map([['nca_key_area_key_application_00',new Uint8Array(keyAreaKey)]]);
  if(rightsManaged){
    header.set(rights,0x230);
    keys.set('titlekek_00',new Uint8Array(kek));
    keys.set('titlekey_'+rights.toString('hex'),new Uint8Array(
      encrypt('aes-128-ecb',kek,null,contentKey)));
  }
  const body=pfs('main',new Uint8Array([9,8,7]));
  section.set(body,0);
  if(encryption===3){
    const counter=new Uint8Array(16);
    // Absolute 0xC00 byte position = block 0xC0.
    counter[15]=0xc0;
    const encrypted=encrypt('aes-128-ctr',contentKey,counter,section);
    section.set(encrypted);
  }else if(encryption===2){
    const full=Buffer.concat([blocks[0],blocks[1]]);
    for(let i=0;i<section.length;i+=512){
      const tweak=Buffer.alloc(16);tweak.writeUInt32BE(i/512,12);
      section.set(encrypt('aes-128-xts',full,tweak,section.subarray(i,i+512)),i);
    }
  }
  const raw=new Uint8Array(header.length+section.length);
  raw.set(header);raw.set(section,header.length);
  return {raw,keys,body};
}
test('key-file parser accepts locally supplied key values and skips unrelated lines',()=>{
  const raw='nca_header_key = '+ '42'.repeat(32)+'\n'+
    'titlekey_'+ 'ab'.repeat(16)+' = '+'27'.repeat(16)+'\n'+
    'invalid = ohno\n';
  const keys=parseNcaKeys(raw);
  assert.equal(keyInfo(keys).entries,2);
  assert.equal(keyInfo(keys).header,true);
  assert.equal(keyInfo(keys).titleCount,1);
});
test('AES-ECB decrypt matches encrypted 64-byte NCA key area',async()=>{
  const key=randomBytes(16),plain=randomBytes(64);
  const encrypted=encrypt('aes-128-ecb',key,null,plain);
  assert.deepEqual(Buffer.from(await aesEcbDecrypt(key,new Uint8Array(encrypted))),plain);
});
test('AES-XTS decrypt supports both sector tweak byte orders',async()=>{
  const key=randomBytes(32),plaintext=randomBytes(0xc00);
  for(const order of ['big','little']){
    const encrypted=new Uint8Array(plaintext.length);
    for(let i=0;i<plaintext.length;i+=512){
      const tweak=Buffer.alloc(16);
      if(order==='big')tweak.writeUInt32BE(i/512,12);
      else tweak.writeUInt32LE(i/512,0);
      const result=encrypt('aes-128-xts',key,tweak,plaintext.subarray(i,i+512));
      encrypted.set(result,i);
    }
    assert.deepEqual(Buffer.from(await decryptXts(key,encrypted,0,order)),plaintext);
  }
});
test('encrypted NCA3 header decodes from only first 3072 bytes of a huge source',async()=>{
  const key=randomBytes(32),plain=new Uint8Array(0xc00);
  plain.set(encoder.encode('NCA3'),0x200);
  const ciphertext=new Uint8Array(plain.length);
  for(let i=0;i<plain.length;i+=512){
    const tweak=Buffer.alloc(16);tweak.writeUInt32BE(i/512,12);
    ciphertext.set(encrypt('aes-128-xts',key,tweak,plain.subarray(i,i+512)),i);
  }
  const reads=[];
  const huge={size:6*1024**3,async read(at,len){
    reads.push([at,len]);assert.equal(at,0);assert.equal(len,0xc00);
    return ciphertext;
  }};
  const result=await decodeNcaHeader(huge,new Map([['nca_header_key',new Uint8Array(key)]]));
  assert.equal(result.tweakOrder,'big');
  assert.equal(result.plaintext,false);
  assert.deepEqual(reads,[[0,0xc00]]);
});
test('AES-CTR encrypted ExeFS can expose files when the correct key-area key is supplied',async()=>{
  const {raw,keys}=fixture(3,false);
  const sections=await inspectNca(fromBlob(new Blob([raw])),keys);
  assert.equal(sections.length,1);
  const result=await openNcaSection(sections[0]);
  assert.equal(result.entries[0].name,'main');
  assert.deepEqual(Array.from(await result.entries[0].source.read(0,3)),[9,8,7]);
});
test('rights-managed AES-CTR section accepts a matching encrypted title key',async()=>{
  const {raw,keys}=fixture(3,true);
  const sections=await inspectNca(fromBlob(new Blob([raw])),keys);
  const result=await openNcaSection(sections[0]);
  assert.equal(result.entries[0].name,'main');
});
test('AES-XTS-encrypted plaintext ExeFS section can be traversed with its content keys',async()=>{
  const {raw,keys}=fixture(2,false);
  const sections=await inspectNca(fromBlob(new Blob([raw])),keys);
  const result=await openNcaSection(sections[0]);
  assert.equal(result.entries[0].name,'main');
});
test('missing titlekeys fail visibly instead of inventing readable assets',async()=>{
  const {raw}=fixture(3,true);
  const sections=await inspectNca(fromBlob(new Blob([raw])),new Map());
  await assert.rejects(openNcaSection(sections[0]),/Rights-managed NCA/);
});
test('supported ticket signature extracts metadata without displaying raw keys',()=>{
  const raw=new Uint8Array(0x3b0),v=new DataView(raw.buffer);
  v.setUint32(0,0x10000,false);
  const off=0x240;
  raw[off+0x141]=0;raw[off+0x145]=2;
  raw.set(randomBytes(16),off+0x160);
  const info=parseNcaTicket(raw);
  assert.equal(info.type,0);assert.equal(info.generation,2);
});
