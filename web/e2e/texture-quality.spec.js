import {test,expect} from '@playwright/test';

test('native texel boundaries interpolate instead of producing staircase edges',async({page})=>{
  await page.goto('/');
  const samples=await page.evaluate(async()=>{
    const {configureTextureSampling}=await import('/GFPAK-OPEN/src/texture-quality.js');
    const source=await (await fetch('/GFPAK-OPEN/src/texture-quality.js')).text();
    const THREE=await import(source.match(/import \* as THREE from ["']([^"']+)["']/)[1]);
    const texture=new THREE.DataTexture(new Uint8Array([255,0,0,255,0,0,255,255]),2,1);
    texture.needsUpdate=true;
    const material=new THREE.MeshBasicMaterial({map:texture});
    const geometry=new THREE.PlaneGeometry(2,2);
    const scene=new THREE.Scene();scene.add(new THREE.Mesh(geometry,material));
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=1;
    const renderer=new THREE.WebGLRenderer();renderer.toneMapping=THREE.NoToneMapping;
    const target=new THREE.WebGLRenderTarget(64,64,{depthBuffer:false});
    renderer.setRenderTarget(target);
    const read=()=>{
      renderer.render(scene,camera);
      const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,31,32,1,1,pixel);
      return Array.from(pixel);
    };
    const nearest=read();configureTextureSampling(texture);
    const filtered=read();
    texture.dispose();geometry.dispose();material.dispose();target.dispose();renderer.dispose();
    return {nearest,filtered};
  });
  expect(samples.nearest).toEqual([255,0,0,255]);
  expect(samples.filtered[0]).toBeGreaterThan(100);
  expect(samples.filtered[0]).toBeLessThan(160);
  expect(samples.filtered[2]).toBeGreaterThan(100);
  expect(samples.filtered[2]).toBeLessThan(160);
  expect(samples.filtered[3]).toBe(255);
});
