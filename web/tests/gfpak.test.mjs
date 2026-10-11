import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGfpak, parseGfpakFile, summary, extractResource, extractResourceAsync, decompressLz4, parseHashDictionary, fnv1a64 } from '../src/gfpak.js';

function syntheticArchive(codec = 0, corruptOffset = false) {
  const buffer = new ArrayBuffer(117);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode('GFLXPACK'));
  view.setUint32(8, 0x1000, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, 88n, true);
  view.setBigUint64(32, 48n, true);
  view.setBigUint64(40, 56n, true);
  view.setBigUint64(48, 0x12345678n, true);
  view.setBigUint64(56, 0x99n, true);
  view.setUint32(64, 1, true);
  view.setBigUint64(72, 0xabn, true);
  view.setUint16(88, 0, true);
  view.setUint16(90, codec, true);
  view.setUint32(92, 5, true);
  view.setUint32(96, 5, true);
  view.setUint32(104, corruptOffset ? 5000 : 112, true);
  bytes.set(new TextEncoder().encode('HELLO'), 112);
  return buffer;
}


test('lazy file-backed parser reads index ranges rather than the full GFPAK', async () => {
  const input = new Blob([syntheticArchive()]);
  input.arrayBuffer = () => { throw new Error('whole archive must not be read'); };
  const archive = await parseGfpakFile(input, 'lazy.gfpak');
  assert.equal(archive.count, 1);
  assert.equal(archive.filename, 'lazy.gfpak');
  assert.equal(archive.resources[0].pathHash, '0000000012345678');
  assert.equal(summary(archive).file, undefined);
  assert.equal(summary(archive).buffer, undefined);
  assert.equal(new TextDecoder().decode(await (await extractResourceAsync(archive, archive.resources[0])).arrayBuffer()), 'HELLO');
  assert.equal((await extractResourceAsync(archive, archive.resources[0], { packed: true })).size, 5);
});

test('file-backed GFPAK rejects truncated index and lazy Oodle remains explicit', async () => {
  await assert.rejects(parseGfpakFile(new Blob([new Uint8Array(15)])), /outside archive/);
  const archive = await parseGfpakFile(new Blob([syntheticArchive(3)]));
  await assert.rejects(extractResourceAsync(archive, archive.resources[0]), /Oodle/);
  assert.equal((await extractResourceAsync(archive, archive.resources[0], { packed: true })).size, 5);
});

test('parses a valid GFLXPACK archive and extracts stored data', () => {
  const a = parseGfpak(syntheticArchive(), 'test.gfpak');
  assert.equal(a.count, 1);
  assert.equal(a.folderCount, 1);
  assert.equal(a.resources[0].pathHash, '0000000012345678');
  assert.equal(a.resources[0].fileHash, '00000000000000ab');
  assert.equal(new TextDecoder().decode(extractResource(a, a.resources[0])), 'HELLO');
  assert.equal(summary(a).resources.length, 1);
  assert.equal(summary(a).buffer, undefined);
});

test('rejects malformed archives and out-of-bounds resource offsets', () => {
  assert.throws(() => parseGfpak(new ArrayBuffer(40)), /Not a GFLXPACK/);
  assert.throws(() => parseGfpak(syntheticArchive(0, true)), /outside archive/);
});

test('requires Oodle for type 3 archives, supports packed export', () => {
  const a = parseGfpak(syntheticArchive(3));
  assert.throws(() => extractResource(a, a.resources[0]), /Oodle/);
  assert.equal(extractResource(a, a.resources[0], { packed: true }).byteLength, 5);
});

test('decodes LZ4 raw literal-only and backreference blocks', () => {
  assert.equal(new TextDecoder().decode(decompressLz4(new Uint8Array([0x50, ...new TextEncoder().encode('HELLO')]), 5)), 'HELLO');
  assert.equal(new TextDecoder().decode(decompressLz4(new Uint8Array([0x11, 65, 1, 0]), 6)), 'AAAAAA');
  assert.throws(() => decompressLz4(new Uint8Array([0x11, 65, 0, 0]), 6), /backreference/);
});

test('parses GFPAK hash dictionaries', () => {
  assert.equal(fnv1a64('hello'), 'a430d84680aabd0b');
  const dict = parseHashDictionary('bin/pokemon/\nmodel.trmdl\n');
  assert.equal(dict.get(fnv1a64('model.trmdl')), 'bin/pokemon/model.trmdl');
  const explicit = parseHashDictionary('{"0123456789abcdef":"pokemon/model.trmdl"}', true);
  assert.equal(explicit.get('0123456789abcdef'), 'pokemon/model.trmdl');
});
