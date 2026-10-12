import {test,expect} from '@playwright/test';
import {makeAnimatedTrinityTriangle} from '../tests/trinity-animation-fixture.mjs';

test('standalone converter previews linked animations and exports the selected source ZIP',async({page})=>{
  const assets=Object.entries(makeAnimatedTrinityTriangle());
  const items=assets.map(([path,bytes],index)=>({path,size:bytes.byteLength,url:'/__quick_asset/source/'+index}));
  await page.addInitScript(({items})=>{
    window.savedSource=null;
    window.pywebview={api:{
      setup_status:async()=>({setup:{state:'ready',error:''},sources:['test.gfpak'],settings:{},animations:true}),
      source_models:async()=>({models:[{key:'chosen-source',name:'test.trmdl'}],errors:[]}),
      source_preview:async()=>({label:'test.gfpak',selected:'models/test.trmdl',exportKey:'chosen-source',items}),
      source_export_pokemon:async key=>{window.savedSource=key;return 'pokemon.zip';},
      set_options:async()=>true
    }};
  },{items});
  for(const [index,[,bytes]] of assets.entries()) await page.route('**/__quick_asset/source/'+index,route=>route.fulfill({body:Buffer.from(bytes),contentType:'application/octet-stream'}));
  await page.goto('/');
  await page.locator('#tabConverter').click();
  await expect(page.locator('#nativeDecoderStatus')).toContainText('Built-in');
  await expect(page.locator('#nativeBlender')).toHaveCount(0);
  await page.locator('#nativeConvert').click();
  await expect(page.locator('#viewerPanel')).toBeVisible();
  await expect(page.locator('#clipSelect option')).toHaveCount(1);
  await page.locator('#exportPokemonButton').click();
  await expect.poll(()=>page.evaluate(()=>window.savedSource)).toBe('chosen-source');
});
