import {test,expect} from '@playwright/test';
import JSZip from 'jszip';
import {makeTrinityTriangle} from '../tests/trinity-fixture.mjs';
test('Export Pokémon button downloads original source assets in one ZIP',async({page})=>{
  await page.goto('/');
  await page.locator('#gameSource').selectOption('pla');
  const assets=makeTrinityTriangle();
  assets['models/test.trskl']=new Uint8Array([1,2,3]);
  assets['models/test_idle.tracm']=new Uint8Array([4,5,6]);
  await page.locator('#fileInput').setInputFiles(Object.entries(assets).map(([name,buffer])=>({name:name.split('/').at(-1),mimeType:'application/octet-stream',buffer:Buffer.from(buffer)})));
  await page.locator('#modelSelect').selectOption('test.trmdl');
  await page.locator('#loadSelected').click();
  const button=page.locator('#exportPokemonButton');
  await expect(button).toBeEnabled();
  const pending=page.waitForEvent('download');await button.click();
  const download=await pending;
  expect(download.suggestedFilename()).toBe('test.zip');
  const stream=await download.createReadStream();const chunks=[];
  for await(const chunk of stream) chunks.push(chunk);
  const zip=await JSZip.loadAsync(Buffer.concat(chunks));
  expect(Object.keys(zip.files).filter(name=>!zip.files[name].dir).length).toBe(7);
  expect(Array.from(await zip.file('test_idle.tracm').async('uint8array'))).toEqual([4,5,6]);
  const metadata=JSON.parse(await zip.file('gfpak-pokemon-export.json').async('string'));
  expect(metadata).toMatchObject({format:'gfpak-pokemon-export',version:1,
    selectedModel:'test.trmdl',sourceGame:'la',convertedModel:'pokedex3d/regular.glb'});
  const glb=await zip.file('pokedex3d/regular.glb').async('uint8array');
  expect(new TextDecoder().decode(glb.slice(0,4))).toBe('glTF');
});

test('desktop explorer export prepares a native preview and sends GLB plus metadata to the ZIP writer',async({page})=>{
  const assets=makeTrinityTriangle();
  const items=Object.entries(assets).map(([path,bytes],i)=>({path,size:bytes.length,url:'/__quick_asset/export/'+i}));
  await page.addInitScript(items=>{
    window.exports=[];
    window.pywebview={api:{
      setup_status:async()=>({blender:'',addon:'',setup:{state:'ready'},sources:[],settings:{}}),
      browse_choose:async()=>({root:{id:'root',kind:'directory',name:'pokemon',category:'folder',expandable:true},
        children:{root:{id:'root',name:'pokemon'},entries:[{id:'model',kind:'file',name:'test.trmdl',category:'model',size:100,expandable:false}],counts:{model:1}}}),
      browse_item_details:async()=>({notes:[],hex_lines:[]}),
      browse_asset_family:async()=>({files:[],counts:{}}),
      browse_scan_status:async()=>({running:false,result:null}),
      browse_fast_preview:async()=>({label:'pokemon',selected:'models/test.trmdl',items}),
      browse_export_pokemon:async(id,glb,metadata)=>{
        window.exports.push({id,magic:atob(glb).slice(0,4),metadata});return 'pokemon.zip';
      }
    }};
  },items);
  for(const [i,[,bytes]] of Object.entries(assets).entries())
    await page.route('**/__quick_asset/export/'+i,route=>route.fulfill({body:Buffer.from(bytes)}));
  await page.goto('/');
  await page.locator('#gameSource').selectOption('pla');
  await page.locator('#tabAssets').click();
  await page.locator('#assetOpenFolder').click();
  await page.locator('#assetRows tr').first().click();
  await page.locator('#assetExportPokemon').click();
  await expect.poll(()=>page.evaluate(()=>window.exports.length)).toBe(1);
  expect(await page.evaluate(()=>window.exports[0])).toMatchObject({id:'model',magic:'glTF',
    metadata:{selectedModel:'models/test.trmdl',sourceGame:'la',convertedModel:'pokedex3d/regular.glb'}});
  // The viewer action uses the same native ZIP writer for the same loaded model.
  await page.locator('#exportPokemonButton').click();
  await expect.poll(()=>page.evaluate(()=>window.exports.length)).toBe(2);
});
