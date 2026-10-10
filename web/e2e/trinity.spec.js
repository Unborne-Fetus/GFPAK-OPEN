import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { makeTrinityTriangle } from '../tests/trinity-fixture.mjs';

test('render real TRMDL TRMSH TRMBF geometry from ZIP and export GLB', async ({ page }) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(makeTrinityTriangle())) zip.file(name, data);
  const buffer = await zip.generateAsync({type:'nodebuffer'});
  await page.goto('/');
  await page.locator('#gameSource').selectOption('pla');
  await page.locator('#fileInput').setInputFiles({name:'legends_arceus_model.zip',mimeType:'application/zip',buffer});
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statVertices')).toHaveText('3');
  await expect(page.locator('#statTriangles')).toHaveText('1');
  await expect(page.locator('#exportButton')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click()
  ]);
  const data = await fs.readFile(await download.path());
  expect(data.toString('ascii',0,4)).toBe('glTF');
  const len = data.readUInt32LE(12);
  const json = JSON.parse(data.toString('utf8',20,20+len));
  expect(json.meshes.length).toBeGreaterThan(0);
});

test('incomplete Trinity source reports missing companion, never exports a blank model', async ({ page }) => {
  await page.goto('/');
  const mdl = makeTrinityTriangle()['models/test.trmdl'];
  await page.locator('#fileInput').setInputFiles({name:'test.trmdl',mimeType:'application/octet-stream',buffer:Buffer.from(mdl)});
  await expect(page.locator('#logBody')).toContainText('Missing');
  await expect(page.locator('#exportButton')).toBeDisabled();
});
