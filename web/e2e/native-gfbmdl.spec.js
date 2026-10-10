import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { makeGfbmdlTriangle } from '../tests/native-gfbmdl-sample.mjs';

test('native Let’s Go GFBMDL geometry renders in browser and exports real GLB', async ({ page }) => {
  const sample = Buffer.from(makeGfbmdlTriangle());
  await page.goto('/');
  await page.locator('#gameSource').selectOption('lgpe');
  await page.locator('#fileInput').setInputFiles({
    name: 'synthetic-pokemon.gfbmdl',
    mimeType: 'application/octet-stream',
    buffer: sample,
  });
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statVertices')).toHaveText('3');
  await expect(page.locator('#statTriangles')).toHaveText('1');
  await expect(page.locator('#exportButton')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click(),
  ]);
  const data = await fs.readFile(await download.path());
  expect(data.toString('ascii', 0, 4)).toBe('glTF');
  const length = data.readUInt32LE(12);
  const json = JSON.parse(data.toString('utf8', 20, 20 + length));
  expect(json.meshes.length).toBe(1);
  expect(json.meshes[0].primitives).toHaveLength(1);
});

test('invalid native GFBMDL never exports a fake 3D model', async ({ page }) => {
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({
    name: 'broken.gfbmdl',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('Not a legitimate GFBMDL geometry buffer'),
  });
  await expect(page.locator('#logBody')).toContainText('ERROR');
  await expect(page.locator('#exportButton')).toBeDisabled();
});
