import {test,expect} from '@playwright/test';
function packageBytes(name,data){
  const entry=Buffer.from(data);
  const nameBytes=Buffer.from(name+'\0');
  const head=Buffer.alloc(16);
  head.write('PFS0',0);
  head.writeUInt32LE(1,4);
  head.writeUInt32LE(nameBytes.length,8);
  const rec=Buffer.alloc(24);
  rec.writeBigUInt64LE(BigInt(entry.length),8);
  return Buffer.concat([head,rec,nameBytes,entry]);
}
test('Web game reader indexes an NSP locally and exports the exact source file',async({page})=>{
  await page.goto('/');
  await page.locator('#tabBrowserGame').click();
  await expect(page.locator('#browserGamePanel')).toBeVisible();
  const data=Buffer.from('GFLXPACK MOCK GAME DATA');
  const game=packageBytes('pm0094_00_00.gfpak',data);
  await page.locator('#webGameFile').setInputFiles({
    name:'test.nsp',mimeType:'application/octet-stream',buffer:game
  });
  await expect(page.locator('#webGameFiles')).toHaveText('1');
  await expect(page.locator('#webGameRows')).toContainText('pm0094_00_00.gfpak');
  await page.locator('#webGameRows tr').first().click();
  await expect(page.locator('#webGameExport')).toBeEnabled();
  const ready=page.waitForEvent('download');
  await page.locator('#webGameExport').click();
  const saved=await ready;
  expect(saved.suggestedFilename()).toBe('pm0094_00_00.gfpak');
  const read=await saved.createReadStream();
  const pieces=[];for await(const piece of read)pieces.push(piece);
  expect(Buffer.concat(pieces)).toEqual(data);
});
test('Encrypted NCA remains explicitly locked and cannot appear as a found Pokémon',async({page})=>{
  await page.goto('/');
  await page.locator('#tabBrowserGame').click();
  const nca=Buffer.alloc(0x1000);
  nca.write('NOPE',0x200);
  await page.locator('#webGameFile').setInputFiles({
    name:'encrypted.nsp',mimeType:'application/octet-stream',
    buffer:packageBytes('content.nca',nca)
  });
  await expect(page.locator('#webGameFiles')).toHaveText('1');
  await expect(page.locator('#webGameRows')).toContainText('Locked');
  await expect(page.locator('#webGameModels')).toHaveText('0');
  await expect(page.locator('#webGameNotice')).toContainText('encrypted');
});
