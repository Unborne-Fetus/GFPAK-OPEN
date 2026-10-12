import {test,expect} from '@playwright/test';

test('native 3D preview uses streaming OBJ before launching Blender', async ({page}) => {
  await page.addInitScript(() => {
    window.previewStarts = 0;
    window.pywebview = {api: {
      setup_status: async () => ({
        blender:'',addon:'',setup:{state:'ready',error:''},sources:[],
        settings:{hashes:'',oodle:'',textures:''},animations:true
      }),
      browse_choose: async () => ({
        root:{id:'root',kind:'directory',name:'models',category:'folder',expandable:true},
        children:{root:{id:'root',name:'models'},entries:[
          {id:'m',kind:'file',name:'triangle.obj',category:'model',size:32,expandable:false}
        ],counts:{model:1},note:''}
      }),
      browse_fast_preview: async () => ({
        label:'test models',selected:'triangle.obj',items:[
          {path:'triangle.obj',size:37,url:'/__quick_asset/sample/0'}
        ]
      }),
      preview_browser_item: async () => {window.previewStarts++;return true;},
      browse_item_details: async () => ({
        name:'triangle.obj',kind:'file',category:'model',
        size:37,notes:[],hex_lines:[]
      }),
      browse_asset_family: async () => ({asset_id:'',files:[],counts:{}}),
      browse_scan_status: async () => ({running:false,result:null,error:''})
    }};
  });
  await page.route('**/__quick_asset/sample/0', route =>
    route.fulfill({status:200,contentType:'text/plain',
      body:'o FastTriangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'})
  );
  await page.goto('/');
  await page.locator('#tabAssets').click();
  await page.locator('#assetOpenFolder').click();
  await page.locator('#assetRows .asset-open').first().click();
  await expect(page.locator('#statMeshes')).toHaveText('1');
  await expect(page.locator('#viewerPanel')).toBeVisible();
  await expect(page.locator('#assetBrowser')).toBeHidden();
  await expect(page.locator('#tabViewer')).toHaveAttribute('aria-selected','true');
  expect(await page.evaluate(() => window.previewStarts)).toBe(0);
});

test('asset scanner displays three clear categories without reading file payloads',async({page})=>{
  await page.addInitScript(()=>{
    window.scanCalls=[];
    const models={id:'m',name:'pm0025.trmdl',relative:'pokemon/pm0025.trmdl',
      category:'model',kind:'nca_file',size:100,expandable:false};
    const texture={id:'t',name:'body.bntx',relative:'pokemon/body.bntx',
      category:'texture',kind:'nca_file',size:30,expandable:false};
    const animation={id:'a',name:'idle.tranm',relative:'pokemon/idle.tranm',
      category:'animation',kind:'nca_file',size:45,expandable:false};
    window.pywebview={api:{
      setup_status:async()=>({
        blender:'',addon:'',setup:{state:'ready',error:''},sources:[],
        settings:{hashes:'',oodle:'',textures:''},animations:true
      }),
      browse_choose:async()=>({
        root:{id:'root',kind:'nsp',name:'pokemon.nsp',category:'archive',expandable:true},
        children:{root:{id:'root',kind:'nsp',name:'pokemon.nsp'},entries:[
          {id:'nca',kind:'nspfile',name:'content.nca',category:'encrypted container',expandable:true}
        ],counts:{'encrypted container':1},note:''}
      }),
      browse_nsp_summary:async()=>({
        filename:'pokemon.nsp',bytes:100,files:1,header_bytes:30,formats:{},
        roles:{},role_bytes:{},warnings:[],content_ids:0
      }),
      browse_children:async nodeId=>nodeId==='nca'
        ?{root:{id:'nca',name:'content.nca'},entries:[
          {id:'sec',kind:'nca_section',name:'Section 0',category:'folder',expandable:true}
        ],counts:{folder:1},note:''}
        :{root:{id:'sec',kind:'nca_section',name:'Section 0'},entries:[
          {id:'folder',kind:'nca_dir',name:'pokemon',category:'folder',expandable:true}
        ],counts:{folder:1},note:''},
      browse_start_scan:async nodeId=>{window.scanCalls.push(nodeId);return true;},
      browse_scan_status:async()=>({running:false,error:'',result:{
        assets:[models,texture,animation],
        counts:{model:1,texture:1,animation:1},
        scanned:3,truncated:false
      }}),
      browse_item_details:async()=>({notes:[],hex_lines:[]}),
      browse_asset_family:async()=>({asset_id:'',files:[],counts:{}})
    }};
  });
  await page.goto('/');
  await page.locator('#tabAssets').click();
  await page.locator('#assetOpenFile').click();
  await page.locator('#assetRows tr').filter({hasText:'content.nca'}).locator('button').click();
  await page.locator('#assetRows tr').filter({hasText:'Section 0'}).locator('button').click();
  await expect(page.locator('#assetScan')).toBeEnabled();
  await page.locator('#assetScan').click();
  await expect(page.locator('#assetClassModels')).toHaveText('1');
  await expect(page.locator('#assetClassTextures')).toHaveText('1');
  await expect(page.locator('#assetClassAnimations')).toHaveText('1');
  await expect(page.locator('#assetRows')).toContainText('pm0025.trmdl');
  await expect(page.locator('#assetRows')).not.toContainText('idle.tranm');
  await page.locator('[data-asset-class="animations"]').click();
  await expect(page.locator('#assetRows')).toContainText('idle.tranm');
  await expect(page.locator('#assetRows')).not.toContainText('pm0025.trmdl');
  await page.locator('[data-asset-class="textures"]').click();
  await expect(page.locator('#assetRows')).toContainText('body.bntx');
  // Whole-source discovery starts automatically, and the user can refine to
  // one RomFS section without losing access to the earlier game-wide results.
  expect(await page.evaluate(()=>window.scanCalls)).toEqual(['root','sec']);
});

test('a discovered texture opens native inspector without Blender',async({page})=>{
  await page.addInitScript(()=>{
    window.fallbackConverts=0;
    window.pywebview={api:{
      setup_status:async()=>({
        blender:'',addon:'',setup:{state:'ready',error:''},sources:[],
        settings:{hashes:'',oodle:'',textures:''},animations:true
      }),
      browse_choose:async()=>({
        root:{id:'root',kind:'directory',name:'textures',category:'folder',expandable:true},
        children:{root:{id:'root',name:'textures'},entries:[
          {id:'t',kind:'file',name:'body.png',category:'texture',size:77,expandable:false}
        ],counts:{texture:1},note:''}
      }),
      browse_fast_texture:async()=>({
        path:'body.png',size:77,url:'/__quick_asset/texture/0'
      }),
      preview_browser_item:async()=>{window.fallbackConverts++;return true;},
      browse_item_details:async()=>({notes:[],hex_lines:[]}),
      browse_asset_family:async()=>({asset_id:'',files:[],counts:{}}),
      browse_scan_status:async()=>({running:false,result:null,error:''})
    }};
  });
  const png=Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=',
    'base64');
  await page.route('**/__quick_asset/texture/0',route=>
    route.fulfill({status:200,contentType:'image/png',body:png})
  );
  await page.goto('/');
  await page.locator('#tabAssets').click();
  await page.locator('#assetOpenFolder').click();
  await expect(page.locator('#assetRows')).toContainText('View texture');
  await page.locator('#assetRows .asset-open').first().click();
  await expect(page.locator('#textureDialog')).toBeVisible();
  await expect(page.locator('#textureSourceName')).toContainText('body.png');
  await expect(page.locator('#textureSavePng')).toBeEnabled();
  expect(await page.evaluate(()=>window.fallbackConverts)).toBe(0);
});


test('complete catalog pages beyond 250 entries and offers clickable matched companions',async({page})=>{
  await page.addInitScript(()=>{
    window.catalogRequests=[];
    const model={id:'model',name:'pm0025_00_00.trmdl',
      relative:'pokemon/pm0025_00_00.trmdl',category:'model',kind:'file',
      size:128,companions:{texture:1,animation:1},expandable:false};
    const texture={id:'texture',name:'pm0025_body.bntx',
      relative:'textures/pm0025_body.bntx',category:'texture',kind:'file',
      size:64,expandable:false};
    const animation={id:'animation',name:'pm0025_idle.tranm',
      relative:'animations/pm0025_idle.tranm',category:'animation',kind:'file',
      size:96,expandable:false};
    window.pywebview={api:{
      setup_status:async()=>({
        blender:'',addon:'',setup:{state:'ready',error:''},sources:[],
        settings:{hashes:'',oodle:'',textures:''},animations:true
      }),
      browse_choose:async()=>({
        root:{id:'root',kind:'directory',name:'Extracted Game',category:'folder',expandable:true},
        children:{root:{id:'root',kind:'directory',name:'Extracted Game'},
          entries:[{id:'dir',name:'pokemon',category:'folder',kind:'directory',expandable:true}],
          counts:{folder:1},note:''}
      }),
      browse_start_scan:async()=>true,
      browse_scan_status:async()=>({running:false,error:'',result:{
        source_id:'root',counts:{model:1,texture:1,animation:260},
        scanned:45000,truncated:false,unresolved:false,matched_models:1
      }}),
      browse_scan_page:async(source,offset,limit,group,query,category)=>{
        window.catalogRequests.push({source,offset,group,query,category});
        const rows=group==='models'?[model]:group==='textures'?[texture]:
          group==='animations'?Array.from({length:260},(_,i)=>({
            ...animation,id:'ani'+i,name:'pm0025_idle_'+i+'.tranm',
            relative:'animations/pm0025_idle_'+i+'.tranm'
          })):[model,texture,animation];
        const filtered=rows.filter(row=>!query||
          row.name.toLowerCase().includes(query.toLowerCase()));
        return {assets:filtered.slice(offset,offset+limit),
          total:filtered.length,offset,
          next_offset:offset+limit<filtered.length?offset+limit:null,source_id:source};
      },
      browse_item_details:async()=>({
        size:100,category:'model',kind:'file',notes:[],hex_lines:[]
      }),
      browse_asset_family:async id=>id==='model'?{
        asset_id:'pm0025',counts:{texture:1,animation:1},
        files:[{id:'texture',path:'textures/pm0025_body.bntx',
          kind:'texture',confidence:'verified',reason:'Matching Pokémon family'},
          {id:'animation',path:'animations/pm0025_idle.tranm',
          kind:'animation',confidence:'verified',reason:'Matching Pokémon family'}]
      }:{asset_id:'',counts:{},files:[]},
      browse_catalog_item:async id=>id==='texture'?texture:animation
    }};
  });
  await page.goto('/');
  await page.locator('#tabAssets').click();
  await page.locator('#assetOpenFolder').click();
  await expect(page.locator('#assetClassAnimations')).toHaveText('260');
  await page.locator('[data-asset-class="animations"]').click();
  await expect(page.locator('#assetRows')).toContainText('Load next 250 assets');
  await page.locator('.asset-table-wrap .nx-pagination-button').click();
  await expect(page.locator('#assetRows tr.asset-row')).toHaveCount(260);
  await page.locator('[data-asset-class="models"]').click();
  await expect(page.locator('#assetRows')).toContainText('1 textures / 1 animations');
  await page.locator('#assetRows tr.asset-row').first().click();
  await expect(page.locator('#assetFamilyFiles')).toContainText('pm0025_idle.tranm');
  await page.locator('#assetFamilyFiles button').filter({hasText:'pm0025_idle.tranm'}).click();
  await expect(page.locator('#assetSelected')).toContainText('pm0025_idle.tranm');
  expect(await page.evaluate(()=>window.catalogRequests.some(r=>
    r.group==='animations' && r.offset===250))).toBe(true);
});
