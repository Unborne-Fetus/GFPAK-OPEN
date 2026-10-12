import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { makeGfbmdlTriangle } from '../tests/native-gfbmdl-sample.mjs';

function makeArchive(bytes, compression = 0) {
  const archive = Buffer.alloc(112 + bytes.byteLength);
  archive.write('GFLXPACK');
  archive.writeUInt32LE(0x1000, 8);
  archive.writeUInt32LE(1, 16);
  archive.writeUInt32LE(1, 20);
  archive.writeBigUInt64LE(88n, 24);
  archive.writeBigUInt64LE(48n, 32);
  archive.writeBigUInt64LE(56n, 40);
  archive.writeBigUInt64LE(0x12345678n, 48);
  archive.writeBigUInt64LE(0x99n, 56);
  archive.writeUInt32LE(1, 64);
  archive.writeBigUInt64LE(0xABn, 72);
  archive.writeUInt16LE(compression, 90);
  archive.writeUInt32LE(bytes.byteLength, 92);
  archive.writeUInt32LE(bytes.byteLength, 96);
  archive.writeUInt32LE(112, 104);
  Buffer.from(bytes).copy(archive, 112);
  return archive;
}

const dictionary = Buffer.from(JSON.stringify({
  '0000000012345678': 'models/pikachu.gfbmdl'
}));

test('GFLXPACK with stored GFBMDL geometry previews without Blender, exports GLB', async ({ page }) => {
  await page.goto('/');
  const geometry = makeGfbmdlTriangle();
  await page.locator('#fileInput').setInputFiles({
    name: 'sample.gfpak', mimeType: 'application/octet-stream',
    buffer: makeArchive(geometry),
  });
  await expect(page.locator('#archiveResources')).toHaveText('1');
  await page.locator('#hashInput').setInputFiles({
    name: 'test-hashes.json', mimeType: 'application/json', buffer: dictionary,
  });
  await expect(page.locator('#previewArchiveModel')).toBeEnabled();
  await page.locator('#previewArchiveModel').click();
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statVertices')).toHaveText('3');
  await expect(page.locator('#exportButton')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click()
  ]);
  const data = await fs.readFile(await download.path());
  expect(data.toString('ascii', 0, 4)).toBe('glTF');
  const jsonChunkSize = data.readUInt32LE(12);
  const json = JSON.parse(data.toString('utf8', 20, 20 + jsonChunkSize));
  expect(json.meshes.length).toBe(1);
});

test('Corrupted Oodle-compressed GFBMDL reports a decoder error, not false success', async ({ page }) => {
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({
    name: 'sample.gfpak', mimeType: 'application/octet-stream',
    buffer: makeArchive(makeGfbmdlTriangle(), 3),
  });
  await page.locator('#hashInput').setInputFiles({
    name: 'test-hashes.json', mimeType: 'application/json', buffer: dictionary,
  });
  await page.locator('#previewArchiveModel').click();
  await expect(page.locator('#logBody')).toContainText('Oodle resource could not be decoded');
  await expect(page.locator('#exportButton')).toBeDisabled();
});
