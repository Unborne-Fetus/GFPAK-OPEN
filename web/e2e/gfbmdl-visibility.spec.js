import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import {boundTriangle,visibilityFixture} from '../tests/gfbmdl-visibility-fixture.mjs';

test('Sword/Shield alternate wings render hidden and export as step-scale animation',async({page})=>{
  const zip=new JSZip();
  zip.file('pm0519_resource_0000.gfbmdl',new Uint8Array(boundTriangle()));
  zip.file('pm0519_00_ba10_waitA01.gfbanm',new Uint8Array(visibilityFixture()));
  const buffer=await zip.generateAsync({type:'nodebuffer'});
  await page.goto('/');
  await page.locator('#gameSource').selectOption('swsh');
  await page.locator('#fileInput').setInputFiles({
    name:'synthetic_pm0519.zip',mimeType:'application/zip',buffer
  });
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statClips')).toHaveText('1');
  const [download]=await Promise.all([
    page.waitForEvent('download'),page.locator('#exportButton').click()
  ]);
  const data=await fs.readFile(await download.path());
  expect(data.toString('ascii',0,4)).toBe('glTF');
  const length=data.readUInt32LE(12);
  const json=JSON.parse(data.toString('utf8',20,20+length));
  const meshNode=json.nodes.find(node=>node.name==='pm0519_00_LWingSkin');
  expect(meshNode).toBeTruthy();
  expect(meshNode.scale).toEqual([0,0,0]);
  expect(json.animations?.some(a=>a.channels.some(ch=>ch.target.path==='scale'))).toBe(true);
  expect(json.animations?.some(a=>a.samplers.some(s=>s.interpolation==='STEP'))).toBe(true);
});
