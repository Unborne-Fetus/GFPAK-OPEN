import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { makeTrinityTriangle } from '../tests/trinity-fixture.mjs';

function packTrinity(files) {
  const entries = Object.entries(files);
  const count = entries.length;
  const folderAt = 64;
  const hashAt = folderAt + 16 + count * 16;
  const tableAt = hashAt + count * 8;
  const contentAt = tableAt + count * 24;
  const total = contentAt + entries.reduce((total, [, bytes]) => total + bytes.byteLength, 0);
  const buffer = Buffer.alloc(total);
  buffer.write('GFLXPACK', 0, 'ascii');
  buffer.writeUInt32LE(0x1000, 8);
  buffer.writeUInt32LE(count, 16);
  buffer.writeUInt32LE(1, 20);
  buffer.writeBigUInt64LE(BigInt(tableAt), 24);
  buffer.writeBigUInt64LE(BigInt(hashAt), 32);
  buffer.writeBigUInt64LE(BigInt(folderAt), 40);
  buffer.writeBigUInt64LE(0xCCn, folderAt);
  buffer.writeUInt32LE(count, folderAt + 8);
  const dictionary = {};
  let cursor = contentAt;
  entries.forEach(([filename, bytes], i) => {
    const hash = BigInt(i + 1);
    dictionary[hash.toString(16).padStart(16, '0')] = filename;
    buffer.writeBigUInt64LE(hash, hashAt + i * 8);
    buffer.writeBigUInt64LE(hash + 100n, folderAt + 16 + i * 16);
    buffer.writeUInt32LE(i, folderAt + 16 + i * 16 + 8);
    buffer.writeUInt32LE(bytes.byteLength, tableAt + i * 24 + 4);
    buffer.writeUInt32LE(bytes.byteLength, tableAt + i * 24 + 8);
    buffer.writeUInt32LE(cursor, tableAt + i * 24 + 16);
    Buffer.from(bytes).copy(buffer, cursor);
    cursor += bytes.byteLength;
  });
  return { buffer, dictionary: Buffer.from(JSON.stringify(dictionary)) };
}

test('browser previews real TRMDL triangles inside a GFPAK without Blender', async ({ page }) => {
  const { buffer, dictionary } = packTrinity(makeTrinityTriangle());
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({
    name: 'pokemon-trinity.gfpak', mimeType: 'application/octet-stream', buffer
  });
  await expect(page.locator('#archiveResources')).toHaveText('3');
  await page.locator('#hashInput').setInputFiles({
    name: 'trinity-names.json', mimeType: 'application/json', buffer: dictionary
  });
  await expect(page.locator('#previewArchiveModel')).toBeEnabled();
  await page.locator('#previewArchiveModel').click();
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statVertices')).toHaveText('3');
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#exportButton').click()
  ]);
  const data = await fs.readFile(await download.path());
  expect(data.toString('ascii', 0, 4)).toBe('glTF');
  const jsonLength = data.readUInt32LE(12);
  const scene = JSON.parse(data.toString('utf8', 20, 20 + jsonLength));
  expect(scene.meshes).toHaveLength(1);
});
