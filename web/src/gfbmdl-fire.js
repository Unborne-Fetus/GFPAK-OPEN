import * as THREE from 'three';
import {parseBntx,decodeBntxTexture} from './bntx.js';
import {configureTextureSampling} from './texture-quality.js';

export function isLegacyFireCore(source) {
  return /^PokeFireCoreShader\d*$/i.test(source.shader || '');
}
export function isLegacyFireMask(source) {
  return /^PokeFireMaskShader\d*$/i.test(source.shader || '');
}

export function fireGradientPixels(source, gradient) {
  const colors=source.colors || {};
  const mix=THREE.MathUtils.clamp(source.scalars?.ColorLerpValue || 0,0,1);
  const palette=prefix=>{
    const a=colors[prefix+'0'],b=colors[prefix+'1'] || a;
    if(!a?.length || !b?.length || ![...a,...b].every(Number.isFinite))
      throw new Error('Native fire palette is missing '+prefix);
    return a.map((value,i)=>value*(1-mix)+b[i]*mix);
  };
  const base=palette('BaseColor'),layer=palette('LayerColor');
  const pixels=new Uint8Array(gradient.width*gradient.height*4);
  const color=new THREE.Color();
  for(let i=0;i<pixels.length;i+=4){
    const weight=gradient.data[i]/255;
    color.setRGB(...base.map((value,c)=>value*(1-weight)+layer[c]*weight));
    color.convertLinearToSRGB();
    pixels[i]=Math.round(THREE.MathUtils.clamp(color.r,0,1)*255);
    pixels[i+1]=Math.round(THREE.MathUtils.clamp(color.g,0,1)*255);
    pixels[i+2]=Math.round(THREE.MathUtils.clamp(color.b,0,1)*255);
    pixels[i+3]=gradient.data[i+3];
  }
  return pixels;
}

export async function applyLegacyFire(source, material, item, name, textures) {
  const archive=parseBntx(await item.getBytes());
  const surface=archive.textures.filter(t=>t.name.toLowerCase()===name.toLowerCase());
  if(surface.length!==1)throw new Error('Fire gradient surface is missing or ambiguous');
  const gradient=decodeBntxTexture(archive,surface[0].index);
  if(gradient.compressed)throw new Error('Native fire gradient requires a decoded mask');
  const texture=new THREE.DataTexture(fireGradientPixels(source,gradient),
    gradient.width,gradient.height,THREE.RGBAFormat);
  texture.name=source.name+' native fire palette';
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.flipY=false;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  configureTextureSampling(texture);texture.needsUpdate=true;textures.push(texture);
  // Fire is self-lit. Emission preserves its authored colors under scene lights
  // and in GLB exports instead of shading the flame as a solid grey surface.
  material.map=null;material.color.setRGB(0,0,0);
  material.emissive.setRGB(1,1,1);material.emissiveMap=texture;
  material.emissiveIntensity=source.scalars?.OnGameEmissionVal ?? 1;
  material.toneMapped=false;material.needsUpdate=true;
  return texture;
}
