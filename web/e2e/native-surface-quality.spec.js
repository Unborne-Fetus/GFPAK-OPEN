import {test,expect} from '@playwright/test';

test('an open native wing remains visible when viewed from either face',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {makeMesh}=await import('/GFPAK-OPEN/src/trinity-model.js');
    const source=await (await fetch('/GFPAK-OPEN/src/trinity-model.js')).text();
    const THREE=await import(source.match(/import \* as THREE from ["']([^"']+)["']/)[1]);
    const mesh=makeMesh({name:'wing',indices:new Uint32Array([0,1,2,2,1,3]),vertices:{count:4,
      position:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0])}},
      new THREE.MeshBasicMaterial({color:0xff0000,side:THREE.FrontSide}));
    const scene=new THREE.Scene();scene.add(mesh);
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);
    const renderer=new THREE.WebGLRenderer();renderer.toneMapping=THREE.NoToneMapping;
    const target=new THREE.WebGLRenderTarget(16,16,{depthBuffer:false});renderer.setRenderTarget(target);
    const read=z=>{
      camera.position.set(0,0,z);camera.lookAt(0,0,0);renderer.render(scene,camera);
      const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,8,8,1,1,pixel);return Array.from(pixel);
    };
    const pixels={front:read(1),back:read(-1)};
    mesh.geometry.dispose();mesh.material.dispose();target.dispose();renderer.dispose();return pixels;
  });
  expect(result.front).toEqual([255,0,0,255]);
  expect(result.back).toEqual([255,0,0,255]);
});

test('layer masks on UV1 shade the correct regions independently of the base-color UV',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {makeMesh}=await import('/GFPAK-OPEN/src/trinity-model.js');
    const {applyLayerColors}=await import('/GFPAK-OPEN/src/trinity-layer-colors.js');
    const source=await (await fetch('/GFPAK-OPEN/src/trinity-model.js')).text();
    const THREE=await import(source.match(/import \* as THREE from ["']([^"']+)["']/)[1]);
    const albedo=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);albedo.needsUpdate=true;
    const mask=new THREE.DataTexture(new Uint8Array([255,0,0,0,0,255,0,0]),2,1);mask.channel=1;mask.needsUpdate=true;
    const material=new THREE.MeshBasicMaterial({map:albedo});
    applyLayerColors({material,layerMaskMap:mask,colors:{BaseColorLayer1:[1,0,0,1],BaseColorLayer2:[0,1,0,1],BaseColorLayer3:[0,0,1,1],BaseColorLayer4:[0,0,0,1]}},[]);
    const mesh=makeMesh({name:'masked quad',indices:new Uint32Array([0,1,2,2,1,3]),vertices:{count:4,
      position:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
      uv:new Float32Array([.25,.5,.25,.5,.25,.5,.25,.5]),
      uv1:new Float32Array([0,0,1,0,0,1,1,1])}},material);
    const scene=new THREE.Scene();scene.add(mesh);
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=1;
    const renderer=new THREE.WebGLRenderer();renderer.toneMapping=THREE.NoToneMapping;
    const target=new THREE.WebGLRenderTarget(16,16,{depthBuffer:false});renderer.setRenderTarget(target);renderer.render(scene,camera);
    const read=x=>{const p=new Uint8Array(4);renderer.readRenderTargetPixels(target,x,8,1,1,p);return Array.from(p);};
    const pixels={left:read(2),right:read(13)};
    albedo.dispose();mask.dispose();mesh.geometry.dispose();material.dispose();target.dispose();renderer.dispose();return pixels;
  });
  expect(result.left).toEqual([255,0,0,255]);
  expect(result.right).toEqual([0,255,0,255]);
});
