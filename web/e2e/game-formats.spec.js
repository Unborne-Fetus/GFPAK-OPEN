import { test, expect } from '@playwright/test';
import JSZip from 'jszip';

function toyPly() {
  return 'ply\nformat ascii 1.0\ncomment local geometry test\n' +
    'element vertex 3\nproperty float x\nproperty float y\nproperty float z\n' +
    'element face 1\nproperty list uchar int vertex_indices\nend_header\n' +
    '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
}
function nativePack() {
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
  b.writeUInt32LE(0, 90);
  b.writeUInt32LE(0, 92);
  b.writeUInt32LE(5, 92);
  b.writeUInt32LE(5, 96);
  b.writeUInt32LE(112, 104);
  b.write('HELLO', 112);
  return b;
}

test('game selector lists all engine families and Z-A Mega Dimension', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#gameSource')).toHaveCount(1);
  await expect(page.locator('#gameSource option')).toHaveCount(9);
  await page.locator('#gameSource').selectOption('za');
  await expect(page.locator('#gameHint')).toContainText('Z-A');
  await expect(page.locator('#gameEngine')).toContainText('TRINITY');
  await page.locator('#gameSource').selectOption('bdsp');
  await expect(page.locator('#gameEngine')).toHaveText('UNITY');
  await expect(page.locator('#gameHint')).toContainText('Asset');
});

test('native Let’s Go GFBMDL is recognized without faking a GLB', async ({ page }) => {
  await page.goto('/');
  await page.locator('#gameSource').selectOption('lgpe');
  await page.locator('#fileInput').setInputFiles({
    name: 'pokemon.gfbmdl',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect(page.locator('#nativeGuide')).toBeVisible();
  await expect(page.locator('#nativeTitle')).toContainText('GFBMDL');
  await expect(page.locator('#exportButton')).toBeDisabled();
});

test('GFPAK inside Pokémon Z-A ZIP can be inspected', async ({ page }) => {
  const zip = new JSZip();
  zip.file('legends_za/mega_dimension/test.gfpak', nativePack());
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({name:'z-a.zip', mimeType:'application/zip',buffer});
  await expect(page.locator('#gameSource')).toHaveValue('za');
  await expect(page.locator('#inspectPackagedArchive')).toBeVisible();
  await page.locator('#inspectPackagedArchive').click();
  await expect(page.locator('#archiveResources')).toHaveText('1');
  await expect(page.locator('#archiveFolders')).toHaveText('1');
});

test('Unity export PLY loads a nonempty 3D mesh', async ({ page }) => {
  await page.goto('/');
  await page.locator('#gameSource').selectOption('bdsp');
  await page.locator('#fileInput').setInputFiles({
    name:'pokemon.ply',mimeType:'application/octet-stream',buffer:Buffer.from(toyPly())
  });
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#exportButton')).toBeEnabled();
});
