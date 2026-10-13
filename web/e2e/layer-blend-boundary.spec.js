import {test,expect} from '@playwright/test';

for(const fallback of [false,true]) test(`palette boundaries have no white fringe in ${fallback?'live shader':'baked texture'}`,async({page})=>{
  await page.goto('/');
  const pixels=await page.evaluate(async(fallback)=>{
    const {applyLayerColors}=await import('/GFPAK-OPEN/src/trinity-layer-colors.js');
    const source=await(await fetch('/GFPAK-OPEN/src/trinity-layer-colors.js')).text();
    const THREE=await import(source.match(/import \* as THREE from ["']([^"']+)["']/)[1]);
    const albedo=new THREE.DataTexture(new Uint8Array([
      255,255,255,255,128,128,128,255,64,64,64,255,255,255,255,255]),4,1);
    const mask=new THREE.DataTexture(new Uint8Array([
      128,127,0,0,128,127,0,0,0,0,0,0,255,255,0,0]),4,1);
    albedo.needsUpdate=mask.needsUpdate=true;mask.channel=fallback?1:0;
    const material=new THREE.MeshBasicMaterial({map:albedo});const created=[];
    applyLayerColors({material,layerMaskMap:mask,colors:{
      BaseColorLayer1:[1,0,0,1],BaseColorLayer2:[0,0,1,1],
      BaseColorLayer3:[0,0,0,1],BaseColorLayer4:[0,0,0,1]}},created);
    const geometry=new THREE.PlaneGeometry(2,2);geometry.setAttribute('uv1',geometry.getAttribute('uv').clone());
    const scene=new THREE.Scene();scene.add(new THREE.Mesh(geometry,material));
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=1;
    const renderer=new THREE.WebGLRenderer();renderer.toneMapping=THREE.NoToneMapping;
    const target=new THREE.WebGLRenderTarget(4,1,{depthBuffer:false});renderer.setRenderTarget(target);renderer.render(scene,camera);
    const data=new Uint8Array(16);renderer.readRenderTargetPixels(target,0,0,4,1,data);
    const result={data:Array.from(data),baked:created.length===1};
    for(const texture of [albedo,mask,...created])texture.dispose();
    material.dispose();geometry.dispose();target.dispose();renderer.dispose();return result;
  },fallback);
  expect(pixels.baked).toBe(!fallback);
  // Equal red/blue coverage must not retain green from the white base texture.
  expect(pixels.data[1]).toBeLessThanOrEqual(1);
  expect(pixels.data[0]).toBeGreaterThan(120);expect(pixels.data[0]).toBeLessThan(136);
  expect(pixels.data[2]).toBeGreaterThan(120);expect(pixels.data[2]).toBeLessThan(136);
  // Authored albedo detail remains, including unmasked regions.
  expect(pixels.data[4]).toBeGreaterThan(59);expect(pixels.data[4]).toBeLessThan(69);
  expect(pixels.data[6]).toBeGreaterThan(59);expect(pixels.data[6]).toBeLessThan(69);
  for(const value of pixels.data.slice(8,11))expect(value).toBeGreaterThan(60);
  for(const value of pixels.data.slice(8,11))expect(value).toBeLessThan(68);
  // Compression overlap is normalized instead of brightening the edge.
  expect(pixels.data[13]).toBeLessThanOrEqual(1);
  expect(pixels.data[12]).toBeGreaterThan(120);expect(pixels.data[12]).toBeLessThan(136);
});
