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
  await expect(page.locator('#statClips')).toHaveText('1');
  await expect(page.locator('#clipSelect')).toBeEnabled();
  await expect(page.locator('#clipSelect')).toHaveValue('0');
  await expect(page.locator('#toggleAnimation')).toHaveText('Ⅱ PAUSE ANIMATION');
  await page.locator('#toggleAnimation').click();
  await expect(page.locator('#toggleAnimation')).toHaveText('▶ PLAY ANIMATION');
  await page.locator('#toggleAnimation').click();
  await expect(page.locator('#toggleAnimation')).toHaveText('Ⅱ PAUSE ANIMATION');
  await expect(page.locator('#exportButton')).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click()
  ]);
  expect(download.suggestedFilename()).toBe('gfpak-demo.glb');
  await expectValidGlb(download);
  const bytes = await fs.readFile(await download.path());
  const jsonSize = bytes.readUInt32LE(12);
  const exported = JSON.parse(bytes.toString('utf8', 20, 20 + jsonSize));
  expect(exported.animations?.length).toBe(1);
  expect(exported.animations[0].channels.length).toBeGreaterThanOrEqual(2);
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

test('WebGL canvas and model scale with a wide desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 750 });
  await page.goto('/');
  await page.locator('#demoButton').click();
  await expect(page.locator('#statMeshes')).toHaveText('2');

  const geometry = () => page.evaluate(() => {
    const host = document.querySelector('#canvasHost').getBoundingClientRect();
    const canvas = document.querySelector('#canvasHost canvas').getBoundingClientRect();
    return { hostW: host.width, hostH: host.height,
             canvasW: canvas.width, canvasH: canvas.height,
             centerX: canvas.left + canvas.width / 2,
             hostCenterX: host.left + host.width / 2 };
  });
  const initial = await geometry();
  expect(Math.abs(initial.hostW - initial.canvasW)).toBeLessThan(3);
  expect(Math.abs(initial.hostH - initial.canvasH)).toBeLessThan(3);

  await page.setViewportSize({ width: 2048, height: 950 });
  await expect.poll(async () => (await geometry()).hostW).toBeGreaterThan(initial.hostW);
  await expect.poll(async () => {
    const values = await geometry();
    return Math.abs(values.hostW - values.canvasW);
  }).toBeLessThan(3);
  const wide = await geometry();
  expect(Math.abs(wide.hostCenterX - wide.centerX)).toBeLessThan(3);
  expect(Math.abs(wide.hostH - wide.canvasH)).toBeLessThan(3);
});


test('desktop explorer browses extracted folders and filters animations/textures', async ({ page }) => {
  await page.addInitScript(() => {
    window.pywebview = {
      api: {
        setup_status: async () => ({
          blender: 'C:/Blender/blender.exe',
          addon: 'C:/GFPAK/addons/pokemon',
          setup: {state: 'ready', error: ''},
          sources: [],
          settings: { hashes: '', oodle: '', textures: '' },
          animations: true
        }),
        browse_choose: async () => ({
          root: {id:'root', name:'Pokemon Legends Arceus', category:'folder',
                 kind:'directory', expandable:true, size:0},
          children: {
            root: {id:'root', name:'Pokemon Legends Arceus'},
            entries: [
              {id:'p', name:'pokemon', category:'folder', kind:'directory', expandable:true, size:0},
              {id:'a', name:'idle.tranm', category:'animation', kind:'file', expandable:false, size:12},
              {id:'t', name:'body.bntx', category:'texture', kind:'file', expandable:false, size:24},
              {id:'m', name:'pm0025_00_00.gfpak', category:'model archive', kind:'gfpak', expandable:true, size:900}
            ],
            counts: {'folder':1, 'animation':1, 'texture':1, 'model archive':1},
            truncated:false, note:''
          }
        }),
        browse_children: async () => ({
          root:{id:'p',name:'pokemon'},
          entries:[{id:'another', name:'pm0026_00_00.gfpak',
                    kind:'gfpak', category:'model archive', expandable:true, size:1300}],
          counts:{'model archive':1}, truncated:false, note:''
        }),
        browse_scan_status: async () => ({running:false, result:null, error:''})
      }
    };
  });
  await page.goto('/');
  await expect(page.locator('#tabAssets')).toBeVisible();
  await page.locator('#tabAssets').click();
  await expect(page.locator('#assetBrowser')).toBeVisible();
  await expect(page.locator('#viewerPanel')).toBeHidden();
  await page.locator('#assetOpenFolder').click();
  await expect(page.locator('#assetCountAnimation')).toHaveText('1');
  await expect(page.locator('#assetCountTexture')).toHaveText('1');
  await page.locator('#assetCategory').selectOption('animation');
  await expect(page.locator('#assetRows tr')).toHaveCount(1);
  await expect(page.locator('#assetRows tr')).toContainText('idle.tranm');
  await page.locator('#assetCategory').selectOption('all');
  await page.locator('#assetRows tr').filter({hasText:'pokemon'}).first().locator('button').click();
  await expect(page.locator('#assetBreadcrumb')).toContainText('pokemon');
  await page.locator('#assetBack').click();
  await expect(page.locator('#assetRows')).toContainText('body.bntx');
  await page.locator('#tabViewer').click();
  await expect(page.locator('#assetBrowser')).toBeHidden();
  await expect(page.locator('#viewerPanel')).toBeVisible();
});


test('NSP package workbench displays roles, hex and integrity results without exposing keys', async ({ page }) => {
  await page.addInitScript(() => {
    window.pywebview = {
      api: {
        setup_status: async () => ({
          blender: 'C:/Blender/blender.exe', addon: 'C:/addons/pokemon',
          setup: {state:'ready',error:''}, sources:[],
          settings: {hashes:'',oodle:'',textures:''}, animations:true
        }),
        browse_choose: async () => ({
          root: {id:'pkg',kind:'nsp',name:'pokemon-demo.nsp',
                 category:'archive',expandable:true,size:4096},
          children: {
            root:{id:'pkg',kind:'nsp',name:'pokemon-demo.nsp'},
            entries:[
              {id:'nca',kind:'nspfile',name:'0123456789abcdef0123456789abcdef.nca',
               category:'encrypted container',role:'Content archive NCA',
               format:'Encrypted NCA',content_id:'0123456789abcdef0123456789abcdef',
               offset:128,size:64,expandable:false},
              {id:'art',kind:'nspfile',name:'cover.png',
               category:'texture',role:'Artwork',format:'Image',
               offset:192,size:8,expandable:false}
            ],
            counts:{'encrypted container':1,texture:1},
            truncated:false,note:'Outer NSP package only'
          }
        }),
        browse_nsp_summary: async () => ({
          filename:'pokemon-demo.nsp',bytes:4096,files:2,header_bytes:128,
          formats:{'Encrypted NCA':1,Image:1},
          roles:{'Content archive NCA':1,Artwork:1},
          role_bytes:{'Content archive NCA':64,Artwork:8},
          warnings:[],content_ids:1
        }),
        browse_nsp_inspect: async (node, offset, length) => ({
          name:'0123456789abcdef0123456789abcdef.nca',
          hex_lines:[{offset:0,hex:'50 46 53 30',ascii:'PFS0'}],
          signature:'Encrypted NCA (opaque; header cannot be decoded here)',
          note:'Raw encrypted bytes',sample_size:4
        }),
        browse_nsp_start_task: async () => true,
        browse_nsp_task_status: async () => ({
          running:false,done:64,total:64,error:'',
          result:{sha256:'a'.repeat(64),content_id_comparison:'differs',
                  bytes_hashed:64}
        }),
        browse_nsp_cancel_task: async () => true,
        browse_nsp_manifest: async () => 'C:/Downloads/package-index.json',
        browse_children: async () => ({root:{id:'pkg'},entries:[],counts:{},note:''})
      }
    };
  });
  await page.goto('/');
  await page.locator('#tabAssets').click();
  await page.locator('#assetOpenFile').click();
  await expect(page.locator('#nspWorkbench')).toBeVisible();
  await expect(page.locator('#nspFiles')).toHaveText('2');
  await expect(page.locator('#nspNcas')).toHaveText('1');
  await expect(page.locator('#nspRoleBreakdown')).toContainText('Content archive NCA');
  await page.locator('#assetRows tr').filter({hasText:'.nca'}).click();
  await expect(page.locator('#nspSelection')).toBeVisible();
  await expect(page.locator('#nspSignature')).toContainText('Encrypted NCA');
  await expect(page.locator('#nspHexDump')).toContainText('50 46 53 30');
  await page.locator('#nspHash').click();
  await expect(page.locator('#nspHashResult')).toContainText('SHA-256:');
  await expect(page.locator('#nspHashResult')).toContainText('advisory');
  await page.locator('#nspManifest').click();
  await expect(page.locator('#assetNotice')).toContainText('package-index.json');
});
