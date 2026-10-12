import { test, expect } from '@playwright/test';
import { makeAnimatedTrinityTriangle } from '../tests/trinity-animation-fixture.mjs';

function redDDS() {
  const b = new Uint8Array(136), v = new DataView(b.buffer);
  for (const [offset, value] of [
    [0,0x20534444],[4,124],[8,0xA1007],[12,4],
    [16,4],[20,8],[28,1],[76,32],[80,4],
    [84,0x31545844],[108,0x1000]
  ]) v.setUint32(offset,value,true);
  b.set([0,0xf8,0x1f,0,0,0,0,0],128);
  return b;
}

test('Preview in 3D automatically imports linked Pokémon textures and playable clips',async({page})=>{
  const fixtures=makeAnimatedTrinityTriangle();
  const clip=fixtures['models/test.tranm'];
  delete fixtures['models/test.tranm'];
  fixtures['animations/idle.tranm']=clip;
  fixtures['textures/body.dds']=redDDS();
  const resources=Object.entries(fixtures).map(([path,bytes],index)=>({
    path,size:bytes.byteLength,
    url:'/__quick_asset/mock/'+index,
    ...(path==='animations/idle.tranm'?{
      linkedKind:'animation',matchConfidence:'verified',
      matchReason:'matched model'
    }:{}),
    ...(path==='textures/body.dds'?{
      linkedKind:'texture',matchConfidence:'verified',
      matchReason:'matched model'
    }:{})
  }));
  await page.addInitScript(({items})=>{
    window.previewFallbacks=0;
    window.pywebview={api:{
      setup_status:async()=>({
        blender:'',addon:'',setup:{state:'ready',error:''},sources:[],
        settings:{hashes:'',oodle:'',textures:''},animations:true
      }),
      browse_choose:async()=>({
        root:{id:'root',name:'pokemon',kind:'directory',
          category:'folder',expandable:true},
        children:{root:{id:'root',name:'pokemon'},entries:[{
          id:'model',name:'test.trmdl',kind:'file',
          category:'model',size:250,expandable:false
        }],counts:{model:1},note:''}
      }),
      browse_start_scan:async()=>true,
      browse_scan_status:async()=>({running:false,error:'',result:{
        source_id:'root',counts:{model:1,texture:1,animation:1},
        scanned:5,truncated:false,unresolved:false
      }}),
      browse_fast_preview:async()=>({
        label:'linked game assets',selected:'models/test.trmdl',
        matched:{texture:1,animation:1},items
      }),
      browse_item_details:async()=>({
        name:'test.trmdl',kind:'file',category:'model',size:250,
        notes:[],hex_lines:[]
      }),
      browse_asset_family:async()=>({asset_id:'',files:[],counts:{}}),
      preview_browser_item:async()=>{window.previewFallbacks++;return true;}
    }};
  },{items:resources});
  for (const [i,[,bytes]] of Object.entries(fixtures).entries()) {
    await page.route('**/__quick_asset/mock/'+i,route=>
      route.fulfill({status:200,contentType:'application/octet-stream',
        body:Buffer.from(bytes)}));
  }
  await page.goto('/');
  await page.locator('#tabAssets').click();
  await page.locator('#assetOpenFolder').click();
  await page.locator('#assetRows .asset-open').first().click();
  await expect(page.locator('#viewerPanel')).toBeVisible();
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#statClips')).toHaveText('1');
  await expect(page.locator('#clipSelect')).toBeEnabled();
  await expect(page.locator('#logBody')).toContainText(
    'Automatically applied the sole matched texture');
  await expect(page.locator('#exportButton')).toBeEnabled();
  expect(await page.evaluate(()=>window.previewFallbacks)).toBe(0);
});
