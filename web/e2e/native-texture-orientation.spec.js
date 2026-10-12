import {test,expect} from '@playwright/test';

test('native model keeps asymmetric BNTX-style image rows in their authored orientation',async({page})=>{
  await page.goto('/');
  const pixels=await page.evaluate(async()=>{
    const {makeMesh}=await import('/GFPAK-OPEN/src/trinity-model.js');
    const moduleSource=await (await fetch('/GFPAK-OPEN/src/trinity-model.js')).text();
    const threeUrl=moduleSource.match(/import \* as THREE from ["']([^"']+)["']/)[1];
    const THREE=await import(threeUrl);
    // Nintendo image memory stores the red top row before the blue bottom row.
    const map=new THREE.DataTexture(new Uint8Array([
      255,0,0,255,255,0,0,255,0,0,255,255,0,0,255,255]),2,2);
    map.colorSpace=THREE.NoColorSpace;map.needsUpdate=true;
    const source=new Float32Array([0,0,1,0,0,1,1,1]);
    const mesh=makeMesh({name:'native quad',indices:new Uint32Array([0,1,2,2,1,3]),
      vertices:{count:4,position:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),uv:source}
    },new THREE.MeshBasicMaterial({map}));
    const renderer=new THREE.WebGLRenderer({antialias:false});
    renderer.toneMapping=THREE.NoToneMapping;
    const target=new THREE.WebGLRenderTarget(16,16,{depthBuffer:false});
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=1;
    const scene=new THREE.Scene();scene.add(mesh);
    renderer.setRenderTarget(target);renderer.render(scene,camera);
    const top=new Uint8Array(4),bottom=new Uint8Array(4);
    renderer.readRenderTargetPixels(target,8,14,1,1,top);
    renderer.readRenderTargetPixels(target,8,1,1,1,bottom);
    const result={top:Array.from(top),bottom:Array.from(bottom),source:Array.from(source)};
    map.dispose();mesh.geometry.dispose();mesh.material.dispose();target.dispose();renderer.dispose();
    return result;
  });
  expect(pixels.top).toEqual([255,0,0,255]);
  expect(pixels.bottom).toEqual([0,0,255,255]);
  expect(pixels.source).toEqual([0,0,1,0,0,1,1,1]);
});
