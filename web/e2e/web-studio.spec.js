import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import JSZip from 'jszip';

function syntheticGfpak() {
  const b = Buffer.alloc(117);
  b.write('GFLXPACK', 0, 'ascii');
  b.writeUInt32LE(0x1000, 8);
  b.writeUInt32LE(1, 16);
  b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(88n, 24);
  b.writeBigUInt64LE(48n, 32);
  b.writeBigUInt64LE(56n, 40);
  b.writeBigUInt64LE(0x12345678n, 48);
  b.writeBigUInt64LE(0x99n, 56);
  b.writeUInt32LE(1, 64);
  b.writeBigUInt64LE(0xABn, 72);
  b.writeUInt32LE(0, 80);
  b.writeUInt16LE(0, 88);
  b.writeUInt16LE(0, 90);
  b.writeUInt32LE(5, 92);
  b.writeUInt32LE(5, 96);
  b.writeUInt32LE(112, 104);
  b.write('HELLO', 112, 'ascii');
  return b;
}

async function expectValidGlb(download) {
  const data = await fs.readFile(await download.path());
  expect(data.toString('ascii', 0, 4)).toBe('glTF');
  expect(data.readUInt32LE(4)).toBe(2);
  const chunkSize = data.readUInt32LE(12);
  const body = JSON.parse(data.toString('utf8', 20, 20 + chunkSize));
  expect(body.meshes?.length).toBeGreaterThan(0);
}

test('3D demo loads and exports real nonempty GLB', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#objectName')).toContainText('No active object');
  await page.locator('#demoButton').click();
  await expect(page.locator('#statMeshes')).toHaveText('2');
  await expect(page.locator('#exportButton')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click()
  ]);
  expect(download.suggestedFilename()).toBe('gfpak-demo.glb');
  await expectValidGlb(download);
});

test('OBJ model from a ZIP can be previewed and exported', async ({ page }) => {
  const zip = new JSZip();
  zip.file('Pokemon/Test/test.obj', 'o Test\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({ name: 'test-models.zip', mimeType: 'application/zip', buffer });
  await expect(page.locator('#statMeshes')).toHaveText('1');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click()
  ]);
  await expectValidGlb(download);
});

test('GFPAK index browser correctly extracts a stored internal resource', async ({ page }) => {
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({ name: 'sample.gfpak', mimeType: 'application/octet-stream', buffer: syntheticGfpak() });
  await expect(page.locator('#archiveResources')).toHaveText('1');
  await expect(page.locator('#archiveFolders')).toHaveText('1');
  await page.locator('#archiveTableBody tr').first().click();
  await expect(page.locator('#downloadResource')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#downloadResource').click()
  ]);
  const data = await fs.readFile(await download.path());
  expect(data.toString('utf8')).toBe('HELLO');
});
