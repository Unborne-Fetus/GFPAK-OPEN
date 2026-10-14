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

test('desktop raw ZIP bypasses preview while Pokédex export still produces a GLB',async({page})=>{
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
        window.exports.push({id,magic:glb ? atob(glb).slice(0,4) : null,
          metadata:metadata || null});return 'pokemon.zip';
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
  // Raw assets must export without ever asking the 3D decoder to render.
  await page.locator('#assetExportPokemon').click();
  await expect.poll(()=>page.evaluate(()=>window.exports.length)).toBe(1);
  expect(await page.evaluate(()=>window.exports[0])).toEqual({
    id:'model',magic:null,metadata:null});
  // Compatible exports still need a real decoded mesh and GLB metadata.
  await page.locator('#assetExportPokedex3d').click();
  await expect.poll(()=>page.evaluate(()=>window.exports.length)).toBe(2);
  expect(await page.evaluate(()=>window.exports[1])).toMatchObject({id:'model',magic:'glTF',
    metadata:{selectedModel:'models/test.trmdl',sourceGame:'la',convertedModel:'pokedex3d/regular.glb'}});
  // The viewer export uses the same GLB ZIP writer.
  await page.locator('#exportPokemonButton').click();
  await expect.poll(()=>page.evaluate(()=>window.exports.length)).toBe(3);
});


test('GLB exporter converts a GPU-compressed Pokémon texture into an embedded PNG',async({page})=>{
  await page.goto('/');
  const outcome=await page.evaluate(async()=>{
    const {exportGlb}=await import('/GFPAK-OPEN/src/model.js');
    const source=await (await fetch('/GFPAK-OPEN/src/model.js')).text();
    const THREE=await import(source.match(/import \\* as THREE from ["']([^"']+)["']/)[1]);
    // A real BC1/DXT1 block: solid green. This exercises the exporter
    // path that formerly failed with "setTextureUtils() must be called".
    const probe=new THREE.WebGLRenderer({antialias:false});
    const supported=probe.extensions.has('WEBGL_compressed_texture_s3tc');
    probe.dispose();
    if(!supported)return {unsupported:true};
    const block=new Uint8Array([0xe0,0x07,0x1f,0x00,0,0,0,0]);
    const texture=new THREE.CompressedTexture(
      [{data:block,width:4,height:4}],4,4,THREE.RGB_S3TC_DXT1_Format
    );
    texture.colorSpace=THREE.SRGBColorSpace;
    texture.needsUpdate=true;
    const geometry=new THREE.PlaneGeometry(1,1);
    const material=new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide});
    const root=new THREE.Group();
    root.add(new THREE.Mesh(geometry,material));
    try {
      const data=await exportGlb(root);
      const view=new DataView(data);
      const jsonLength=view.getUint32(12,true);
      const gltf=JSON.parse(new TextDecoder().decode(new Uint8Array(data,20,jsonLength)));
      const image=gltf.images?.[0];
      const bufferView=gltf.bufferViews?.[image?.bufferView];
      const binaryStart=20+jsonLength+8;
      const png=new Uint8Array(data,binaryStart+(bufferView?.byteOffset||0),bufferView?.byteLength||0);
      const bitmap=await createImageBitmap(new Blob([png],{type:'image/png'}));
      const canvas=document.createElement('canvas');
      canvas.width=canvas.height=4;
      const context=canvas.getContext('2d');
      context.drawImage(bitmap,0,0,4,4);
      const pixel=Array.from(context.getImageData(2,2,1,1).data);
      bitmap.close();
      return {meshes:gltf.meshes?.length,textures:gltf.textures?.length,
        mimeType:image?.mimeType,pixel};
    } finally {
      geometry.dispose();material.dispose();texture.dispose();
    }
  });
  test.skip(outcome.unsupported===true,'Browser GPU lacks the BC1 texture extension');
  expect(outcome.meshes).toBe(1);
  expect(outcome.textures).toBe(1);
  expect(outcome.mimeType).toBe('image/png');
  expect(outcome.pixel[1]).toBeGreaterThan(220);
  expect(outcome.pixel[0]).toBeLessThan(35);
  expect(outcome.pixel[2]).toBeLessThan(35);
});
