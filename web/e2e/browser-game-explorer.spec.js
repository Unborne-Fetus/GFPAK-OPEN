import {test,expect} from '@playwright/test';
import {makeTrinityTriangle} from '../tests/trinity-fixture.mjs';
import {fnv1a64} from '../src/gfpak.js';
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

test('Preview a readable game-package Trinity model in-browser and export GLB',async({page})=>{
  await page.goto('/');
  await page.locator('#tabBrowserGame').click();
  const entries=Object.entries(makeTrinityTriangle());
  const names=Buffer.concat(entries.map(([name])=>Buffer.from(name+String.fromCharCode(0))));
  const records=Buffer.alloc(entries.length*24);
  let offset=0,start=0;
  for(const [i,[name,body]] of entries.entries()){
    records.writeBigUInt64LE(BigInt(start),i*24);
    records.writeBigUInt64LE(BigInt(body.byteLength),i*24+8);
    records.writeUInt32LE(offset,i*24+16);
    offset+=Buffer.byteLength(name)+1;
    start+=body.byteLength;
  }
  const header=Buffer.alloc(16);
  header.write('PFS0');
  header.writeUInt32LE(entries.length,4);
  header.writeUInt32LE(names.length,8);
  const packed=Buffer.concat([header,records,names,...entries.map(([,body])=>Buffer.from(body))]);
  await page.locator('#webGameFile').setInputFiles({
    name:'readable.nsp',mimeType:'application/octet-stream',buffer:packed
  });
  await expect(page.locator('#webGameFiles')).toHaveText(String(entries.length));
  // The desktop-style viewer now requires entering the game's model folder.
  await page.locator('#webGameRows tr').filter({hasText:'models'}).first().dblclick();
  await expect(page.locator('#webGameTitle')).toContainText('models');
  const selected=page.locator('#webGameRows tr').filter({hasText:'test.trmdl'}).first();
  await selected.click();
  await expect(page.locator('#webGamePreview')).toBeEnabled();
  await page.locator('#webGamePreview').click();
  await expect(page.locator('#viewerPanel')).toBeVisible();
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#exportButton')).toBeEnabled();
});

test('Local prod.keys picker accepts keys in memory and forgets them without uploading',async({page})=>{
  await page.goto('/');
  await page.locator('#tabBrowserGame').click();
  await page.locator('#webGameFile').setInputFiles({
    name:'sample.nsp',mimeType:'application/octet-stream',
    buffer:packageBytes('metadata.xml',Buffer.from('safe test data'))
  });
  await expect(page.locator('#webGameFiles')).toHaveText('1');
  await page.locator('#webGameKeysFile').setInputFiles({
    name:'prod.keys',mimeType:'text/plain',
    buffer:Buffer.from('nca_header_key = '+'10'.repeat(32)+String.fromCharCode(10))
  });
  await expect(page.locator('#webGameKeysStatus')).toContainText('Local keys loaded (1 entries)');
  await expect(page.locator('#webGameFiles')).toHaveText('1');
  await page.locator('#webGameClearKeys').click();
  await expect(page.locator('#webGameKeysStatus')).toContainText('Keys forgotten');
  await expect(page.locator('#webGameFiles')).toHaveText('0');
});

test('Desktop-like folder tree navigates large game indexes and retains global asset filters',async({page})=>{
  await page.goto('/');
  await page.locator('#tabBrowserGame').click();
  const entries=[
    ['content.nca/section-1/bin/archive/pokemon/pm0094_00_00.trmdl',Buffer.from([1,2,3])],
    ['content.nca/section-1/bin/archive/pokemon/pm0094_idle.tranm',Buffer.from([4,5,6])],
    ['content.nca/section-1/bin/archive/pokemon/pm0094_body.bntx',Buffer.from([7,8])],
    ['readme.txt',Buffer.from('game files')]];
  const filenames=Buffer.concat(entries.map(([name])=>Buffer.from(name+String.fromCharCode(0))));
  const headers=Buffer.alloc(entries.length*24);
  let offset=0,start=0;
  for(const [index,[name,data]] of entries.entries()){
    headers.writeBigUInt64LE(BigInt(start),index*24);
    headers.writeBigUInt64LE(BigInt(data.length),index*24+8);
    headers.writeUInt32LE(offset,index*24+16);
    offset+=Buffer.byteLength(name)+1;
    start+=data.length;
  }
  const head=Buffer.alloc(16);
  head.write('PFS0');head.writeUInt32LE(entries.length,4);
  head.writeUInt32LE(filenames.length,8);
  await page.locator('#webGameFile').setInputFiles({
    name:'nested.nsp',mimeType:'application/octet-stream',
    buffer:Buffer.concat([head,headers,filenames,...entries.map(([,data])=>data)])
  });
  await expect(page.locator('#webGameTree')).toContainText('content.nca');
  await expect(page.locator('#webGameRows')).toContainText('content.nca');
  await expect(page.locator('#webGameRows')).not.toContainText('pm0094_idle.tranm');
  await page.locator('#webGameTree .nx-tree-name',{hasText:'content.nca'}).click();
  await expect(page.locator('#webGameTitle')).toContainText('content.nca');
  await expect(page.locator('#webGameRows')).toContainText('section-1');
  await page.locator('#webGameSearch').fill('pm0094');
  await expect(page.locator('#webGameRows')).toContainText('pm0094_body.bntx');
  await expect(page.locator('#webGameRows')).toContainText('pm0094_idle.tranm');
  await page.locator('[data-web-asset-class="animation"]').click();
  await expect(page.locator('#webGameRows tr')).toHaveCount(1);
  await expect(page.locator('#webGameRows')).toContainText('pm0094_idle.tranm');
  await page.locator('#webGameSearch').fill('');
  await page.locator('[data-web-asset-class="all"]').click();
  await expect(page.locator('#webGameRows')).toContainText('section-1');
  await page.locator('#webGameBack').click();
  await expect(page.locator('#webGameRows')).toContainText('content.nca');
  await expect(page.locator('#webGameTreeStatus')).toContainText('indexed folders');
});


test('Preview a hashed PLA GFPAK straight from an NSP without leaving to the Archive Inspector',async({page})=>{
  await page.goto('/');
  await page.locator('#tabBrowserGame').click();
  const members=Object.entries(makeTrinityTriangle());
  const total=members.length, tableOffset=40, hashesOffset=40+24*total;
  const dataOffset=hashesOffset+8*total;
  const gfpak=Buffer.alloc(dataOffset+members.reduce((sum,[,bytes])=>sum+bytes.byteLength,0));
  gfpak.write('GFLXPACK',0);
  gfpak.writeUInt32LE(0x1000,8);
  gfpak.writeUInt32LE(total,16);
  gfpak.writeBigUInt64LE(BigInt(tableOffset),24);
  gfpak.writeBigUInt64LE(BigInt(hashesOffset),32);
  let offset=dataOffset;
  for(const [i,[name,bytes]] of members.entries()){
    const entry=tableOffset+i*24;
    gfpak.writeUInt32LE(bytes.byteLength,entry+4);
    gfpak.writeUInt32LE(bytes.byteLength,entry+8);
    gfpak.writeUInt32LE(offset,entry+16);
    gfpak.writeBigUInt64LE(BigInt('0x'+fnv1a64(name)),hashesOffset+i*8);
    Buffer.from(bytes).copy(gfpak,offset);offset+=bytes.byteLength;
  }
  await page.locator('#webGameFile').setInputFiles({
    name:'arceus.nsp',mimeType:'application/octet-stream',
    buffer:packageBytes('bin/archive/pokemon/pm0025_00_00.gfpak',gfpak)
  });
  await page.locator('[data-web-asset-class="all"]').click();
  await page.locator('#webGameSearch').fill('pm0025_00_00.gfpak');
  await page.locator('#webGameRows tr').filter({hasText:'pm0025_00_00.gfpak'}).click();
  await expect(page.locator('#webGamePreview')).toBeEnabled();
  await page.locator('#webGamePreview').click();
  await expect(page.locator('#viewerPanel')).toBeVisible();
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statVertices')).toHaveText('3');
  await expect(page.locator('#archivePanel')).toBeHidden();
});


test('Standalone GFPAK Inspector can preview a PLA Trinity model with hashed internal names',async({page})=>{
  await page.goto('/');
  const members=Object.entries(makeTrinityTriangle());
  const count=members.length,table=40,hashes=40+count*24,start=hashes+count*8;
  const archive=Buffer.alloc(start+members.reduce((size,[,data])=>size+data.length,0));
  archive.write('GFLXPACK');
  archive.writeUInt32LE(0x1000,8);
  archive.writeUInt32LE(count,16);
  archive.writeBigUInt64LE(BigInt(table),24);
  archive.writeBigUInt64LE(BigInt(hashes),32);
  let where=start;
  for(const [i,[name,data]] of members.entries()){
    archive.writeUInt32LE(data.byteLength,table+i*24+4);
    archive.writeUInt32LE(data.byteLength,table+i*24+8);
    archive.writeUInt32LE(where,table+i*24+16);
    archive.writeBigUInt64LE(BigInt('0x'+fnv1a64(name)),hashes+i*8);
    Buffer.from(data).copy(archive,where);
    where+=data.byteLength;
  }
  await page.locator('#fileInput').setInputFiles({
    name:'pm0025_00_00.gfpak',mimeType:'application/octet-stream',buffer:archive
  });
  await expect(page.locator('#archivePanel')).toBeVisible();
  await expect(page.locator('#previewArchiveModel')).toBeEnabled();
  await expect(page.locator('#previewArchiveModel')).toContainText('AUTO-DETECT');
  await page.locator('#previewArchiveModel').click();
  await expect(page.locator('#viewerPanel')).toBeVisible();
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statVertices')).toHaveText('3');
  await expect(page.locator('#exportButton')).toBeEnabled();
});
