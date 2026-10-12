import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';

function nativeBntx() {
  const bytes=Buffer.alloc(0x400);
  bytes.write('BNTX',0,'ascii');
  bytes[12]=255;bytes[13]=254;
  bytes.write('NX  ',0x20,'ascii');
  bytes.writeUInt32LE(1,0x24);
  bytes.writeBigUInt64LE(0x80n,0x28);
  bytes.writeBigUInt64LE(0x100n,0x80);
  bytes.write('BRTI',0x100,'ascii');
  bytes.writeUInt16LE(1,0x116);
  bytes.writeUInt32LE(0x0b01,0x11c);
  bytes.writeUInt32LE(2,0x124);
  bytes.writeUInt32LE(2,0x128);
  bytes.writeUInt32LE(1,0x130);
  bytes.writeUInt32LE(64,0x150);
  bytes.writeBigUInt64LE(0x1a0n,0x160);
  bytes.writeBigUInt64LE(0x1b0n,0x170);
  bytes.writeUInt16LE(4,0x1a0);
  bytes.write('body',0x1a2,'ascii');
  bytes.writeBigUInt64LE(0x200n,0x1b0);
  bytes.set([255,0,0,255,0,255,0,255],0x200);
  bytes.set([0,0,255,255,255,255,255,255],0x220);
  return bytes;
}

test('standalone BNTX surfaces open and export a real PNG',async({page})=>{
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({
    name:'body.bntx',mimeType:'application/octet-stream',buffer:nativeBntx()
  });
  await expect(page.locator('#textureChoice')).toBeVisible();
  await expect(page.locator('#textureCount')).toContainText('1 file');
  await page.locator('#inspectSelectedTexture').click();
  await expect.poll(async () =>
    await page.locator('#textureDialog').evaluate(dialog => dialog.open)
      ? 'open' : 'not open; activity: ' + (await page.locator('#logBody').textContent()).slice(-600),
    {timeout:8000}).toBe('open');
  await expect(page.locator('#textureDialog')).toBeVisible();
  await expect(page.locator('#textureSourceName')).toContainText('1 texture surface');
  await expect(page.locator('#textureSurface option')).toHaveText('body · 2×2');
  await expect(page.locator('#textureMetadata')).toContainText('2 × 2');
  await expect(page.locator('#textureSavePng')).toBeEnabled();
  const [download]=await Promise.all([
    page.waitForEvent('download'), page.locator('#textureSavePng').click()
  ]);
  expect(download.suggestedFilename()).toBe('body_body.png');
  const png=await fs.readFile(await download.path());
  expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  await page.locator('#textureClose').click();
  await expect(page.locator('#textureDialog')).toBeHidden();
});

function anonymousTextureArchive(payload) {
  const b=Buffer.alloc(112+payload.length);
  b.write('GFLXPACK',0,'ascii');
  b.writeUInt32LE(0x1000,8);
  b.writeUInt32LE(1,16);b.writeUInt32LE(1,20);
  b.writeBigUInt64LE(88n,24);
  b.writeBigUInt64LE(48n,32);
  b.writeBigUInt64LE(56n,40);
  b.writeBigUInt64LE(0x12345678n,48);
  b.writeBigUInt64LE(0x99n,56);
  b.writeUInt32LE(1,64);
  b.writeBigUInt64LE(0xabn,72);
  b.writeUInt32LE(0,80);
  b.writeUInt16LE(0,88);b.writeUInt16LE(0,90);
  b.writeUInt32LE(payload.length,92);
  b.writeUInt32LE(payload.length,96);
  b.writeUInt32LE(112,104);
  payload.copy(b,112);
  return b;
}

test('identifies a selected GFPAK texture from magic without a filename dictionary',async({page})=>{
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({
    name:'no-dictionary.gfpak',mimeType:'application/octet-stream',
    buffer:anonymousTextureArchive(nativeBntx())
  });
  await expect(page.locator('#archiveResources')).toHaveText('1');
  await page.locator('#archiveTableBody tr').first().click();
  await expect(page.locator('#previewArchiveTexture')).toBeEnabled();
  await expect(page.locator('#previewArchiveTexture')).toContainText('PROBE SELECTED');
  await page.locator('#previewArchiveTexture').click();
  await expect(page.locator('#textureDialog')).toBeVisible();
  await expect(page.locator('#textureSourceName')).toContainText('resource_0000.bntx');
  await expect(page.locator('#textureSavePng')).toBeEnabled();
});
