import * as THREE from 'three';
import {parseBntx,decodeBntxTexture} from './bntx.js';
import {configureTextureSampling} from './texture-quality.js';

export function isLegacyFireCore(source) {
  return /^PokeFireCoreShader\d*$/i.test(source.shader || '');
}
export function isLegacyFireMask(source) {
  return /^PokeFireMaskShader\d*$/i.test(source.shader || '');
}

export function fireGradientPixels(source, gradient, masks = []) {
  const colors=source.colors || {};
  const mix=THREE.MathUtils.clamp(source.scalars?.ColorLerpValue || 0,0,1);
  const palette=prefix=>{
    const a=colors[prefix+'0'],b=colors[prefix+'1'] || a;
    if(!a?.length || !b?.length || ![...a,...b].every(Number.isFinite))
      throw new Error('Native fire palette is missing '+prefix);
    return a.map((value,i)=>value*(1-mix)+b[i]*mix);
  };
  const base=palette('BaseColor'),layer=palette('LayerColor');
  const width=Math.max(gradient.width,...masks.map(m=>m.width));
  const height=Math.max(gradient.height,...masks.map(m=>m.height));
  const pixels=new Uint8Array(width*height*4);
  const sample=(image,u,v,channel=0)=>{
    const x=Math.min(image.width-1,Math.floor(((u%1+1)%1)*image.width));
    const y=Math.min(image.height-1,Math.floor(((v%1+1)%1)*image.height));
    return image.data[(y*image.width+x)*4+channel];
  };
  const maskAt=(mask,index,u,v)=>{
    const s=source.scalars || {},p='Blend'+index;
    return sample(mask,u*(s[p+'UVScaleU'] ?? 1)+(s[p+'UVTranslateU'] ?? 0),
      v*(s[p+'UVScaleV'] ?? 1)+(s[p+'UVTranslateV'] ?? 0))/255;
  };
  const color=new THREE.Color();
  for(let i=0;i<pixels.length;i+=4){
    const u=(i/4%width+.5)/width,v=(Math.floor(i/4/width)+.5)/height;
    const weight=sample(gradient,u,v)/255;
    color.setRGB(...base.map((value,c)=>value*(1-weight)+layer[c]*weight));
    color.convertLinearToSRGB();
    pixels[i]=Math.round(THREE.MathUtils.clamp(color.r,0,1)*255);
    pixels[i+1]=Math.round(THREE.MathUtils.clamp(color.g,0,1)*255);
    pixels[i+2]=Math.round(THREE.MathUtils.clamp(color.b,0,1)*255);
    const mask=masks.length ? maskAt(masks[0],0,u,v)*(1-mix)+
      maskAt(masks[1] || masks[0],1,u,v)*mix : 0;
    const cutoff=source.scalars?.DiscardValuie ?? .85;
    pixels[i+3]=masks.length && mask>=cutoff ? 0 : sample(gradient,u,v,3);
  }
  return pixels;
}

export async function applyLegacyFire(source, material, item, name, textures, companions = []) {
  const archive=parseBntx(await item.getBytes());
  const surface=archive.textures.filter(t=>t.name.toLowerCase()===name.toLowerCase());
  if(surface.length!==1)throw new Error('Fire gradient surface is missing or ambiguous');
  const gradient=decodeBntxTexture(archive,surface[0].index);
  if(gradient.compressed)throw new Error('Native fire gradient requires a decoded mask');
  const masks=[];
  for(const companion of companions){
    const packed=parseBntx(await companion.item.getBytes());
    const found=packed.textures.filter(t=>t.name.toLowerCase()===companion.name.toLowerCase());
    if(found.length!==1)throw new Error('Flame edge mask is missing or ambiguous');
    const decoded=decodeBntxTexture(packed,found[0].index);
    if(decoded.compressed)throw new Error('Flame edge mask requires decoded pixels');
    masks.push(decoded);
  }
  const width=Math.max(gradient.width,...masks.map(m=>m.width));
  const height=Math.max(gradient.height,...masks.map(m=>m.height));
  const texture=new THREE.DataTexture(fireGradientPixels(source,gradient,masks),width,height,THREE.RGBAFormat);
  texture.name=source.name+' native fire palette';
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.flipY=false;
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  configureTextureSampling(texture);texture.needsUpdate=true;textures.push(texture);
  // Fire is self-lit. Emission preserves its authored colors under scene lights
  // and in GLB exports instead of shading the flame as a solid grey surface.
  material.map=texture;material.color.setRGB(0,0,0);
  material.alphaTest=masks.length ? .5 : 0;
  material.emissive.setRGB(1,1,1);material.emissiveMap=texture;
  material.emissiveIntensity=source.scalars?.OnGameEmissionVal ?? 1;
  material.toneMapped=false;material.needsUpdate=true;
  return texture;
}
