import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { makeAnimatedTrinityTriangle } from '../tests/trinity-animation-fixture.mjs';

test('Trinity ZIP with skeletal animation plays a real clip and exports glTF animation', async ({ page }) => {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(makeAnimatedTrinityTriangle())) zip.file(name, bytes);
  const archive = await zip.generateAsync({type:'nodebuffer'});
  await page.goto('/');
  await page.locator('#gameSource').selectOption('pla');
  await page.locator('#fileInput').setInputFiles({
    name:'legends_arceus_animated.zip',mimeType:'application/zip',buffer:archive
  });
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statBones')).toHaveText('1');
  await expect(page.locator('#statClips')).toHaveText('1');
  await expect(page.locator('#toggleAnimation')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#exportButton').click()
  ]);
  const data = await fs.readFile(await download.path());
  expect(data.toString('ascii',0,4)).toBe('glTF');
  const length = data.readUInt32LE(12);
  const scene = JSON.parse(data.toString('utf8',20,20+length));
  expect(scene.meshes.length).toBeGreaterThan(0);
  expect(scene.animations?.length).toBeGreaterThan(0);
});
