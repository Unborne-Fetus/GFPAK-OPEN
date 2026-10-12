import test from 'node:test';
import assert from 'node:assert/strict';
import {decompressOodle,MAX_OODLE_OUTPUT} from '../src/oodle-wasm.js';
import {parseGfpak,parseGfpakFile,extractResourceAsync} from '../src/gfpak.js';

// An Oodle Kraken "stored" quantum: native Oodle framing, not zlib/LZ4.
// This fixture contains only original test bytes, never game resources.
function krakenStored(payload) {
  const data=payload instanceof Uint8Array?payload:new TextEncoder().encode(payload);
  if(data.length===0 || data.length>0x1ffff)
    throw Error('Stored quantum fixture must be between 1 and 131071 bytes');
  const q=data.length-1;
  return Uint8Array.from([0x8c,0x06,(q>>16)&255,(q>>8)&255,q&255,...data]);
}
function makeGfpak(packed,unpackedLength) {
  const header=new Uint8Array(112+packed.length);
  const v=new DataView(header.buffer);
  header.set(new TextEncoder().encode('GFLXPACK'),0);
  v.setUint32(8,0x1000,true);v.setUint32(16,1,true);
  v.setBigUint64(24,88n,true);v.setBigUint64(32,48n,true);
  v.setBigUint64(48,0x12345678n,true);
  v.setUint16(90,3,true); // GFPAK codec 3 = Oodle
  v.setUint32(92,unpackedLength,true);
  v.setUint32(96,packed.length,true);
  v.setUint32(104,112,true);
  header.set(packed,112);
  return header.buffer;
}
test('Oodle WASM decompresses a valid Kraken quantum to original bytes',async()=>{
  const original='GFPAK Open browser Oodle decoder test';
  const output=await decompressOodle(krakenStored(original),new TextEncoder().encode(original).length);
  assert.equal(new TextDecoder().decode(output),original);
});
test('Oodle GFPAK resources decode correctly using lazy file-backed and in-memory APIs',async()=>{
  const original='TRMDL companion data';
  const packed=krakenStored(original);
  const source=makeGfpak(packed,original.length);
  const fileArchive=await parseGfpakFile(new Blob([source]),'pm0092.gfpak');
  const inMemory=parseGfpak(source);
  for(const archive of [fileArchive,inMemory]){
    const raw=await extractResourceAsync(archive,archive.resources[0]);
    const data=raw instanceof Blob?await raw.arrayBuffer():raw;
    assert.equal(new TextDecoder().decode(data),original);
    const originalPacked=await extractResourceAsync(archive,archive.resources[0],{packed:true});
    const packedBytes=originalPacked instanceof Blob?
      new Uint8Array(await originalPacked.arrayBuffer()):originalPacked;
    assert.deepEqual([...packedBytes],[...packed]);
  }
});
test('Oodle decoder rejects invalid lengths before allocation',async()=>{
  await assert.rejects(decompressOodle(new Uint8Array([1]),0),/Invalid Oodle/);
  await assert.rejects(decompressOodle(new Uint8Array([1]),MAX_OODLE_OUTPUT+1),/Invalid Oodle/);
  await assert.rejects(decompressOodle(new Uint8Array(),10),/Invalid Oodle/);
});
test('Corrupt Oodle compressed data fails explicitly rather than fabricating a mesh',async()=>{
  await assert.rejects(decompressOodle(new Uint8Array([1,2,3,4,5]),64),
    /Oodle resource could not be decoded/);
});
