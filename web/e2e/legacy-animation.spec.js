import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { makeGfbmdlWithBone } from '../tests/legacy-animation-fixture.mjs';
import { makeAnimatedTrinityTriangle } from '../tests/trinity-animation-fixture.mjs';

test('Lets Go model with GFBANM skeletal track has bones and exports a real GLB animation', async ({ page }) => {
  const animation = makeAnimatedTrinityTriangle()['models/test.tranm'];
  await page.goto('/');
  await page.locator('#gameSource').selectOption('lgpe');
  await page.locator('#fileInput').setInputFiles([
    {name:'pokemon.gfbmdl',mimeType:'application/octet-stream',buffer:Buffer.from(makeGfbmdlWithBone())},
    {name:'pokemon.gfbanm',mimeType:'application/octet-stream',buffer:Buffer.from(animation)}
  ]);
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statBones')).toHaveText('1');
  await expect(page.locator('#statClips')).toHaveText('1');
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#exportButton').click()
  ]);
  const binary = await fs.readFile(await download.path());
  const size = binary.readUInt32LE(12);
  const doc = JSON.parse(binary.toString('utf8',20,20+size));
  expect(doc.meshes?.length).toBeGreaterThan(0);
  expect(doc.animations?.length).toBeGreaterThan(0);
});
