import * as THREE from 'three';
import {parseBntx,decodeBntxTexture} from './bntx.js';
import {configureTextureSampling} from './texture-quality.js';

export function isLegacyFireCore(source) {
  return /^PokeFireCoreShader\d*$/i.test(source?.shader || '');
}
export function isLegacyFireMask(source) {
  return /^PokeFireMaskShader\d*$/i.test(source?.shader || '');
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
  const color=new THREE.Color();
  for(let i=0;i<pixels.length;i+=4){
    const u=(i/4%width+.5)/width,v=(Math.floor(i/4/width)+.5)/height;
    const weight=sample(gradient,u,v)/255;
    color.setRGB(...base.map((value,c)=>value*(1-weight)+layer[c]*weight));
    color.convertLinearToSRGB();
    pixels[i]=Math.round(THREE.MathUtils.clamp(color.r,0,1)*255);
    pixels[i+1]=Math.round(THREE.MathUtils.clamp(color.g,0,1)*255);
    pixels[i+2]=Math.round(THREE.MathUtils.clamp(color.b,0,1)*255);
    // Blend textures shape the shader's color layers; they are not holes in
    // the core. Silhouette clipping belongs to the separate FireMask pass.
    pixels[i+3]=255;
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
  material.alphaTest=0;
  material.emissive.setRGB(1,1,1);material.emissiveMap=texture;
  material.emissiveIntensity=source.scalars?.OnGameEmissionVal ?? 1;
  material.toneMapped=false;material.needsUpdate=true;
  return texture;
}

export function fireMaskPixels(source, masks) {
  if(!masks.length)throw new Error('Missing native fire silhouette masks');
  const width=Math.max(...masks.map(m=>m.width)),height=Math.max(...masks.map(m=>m.height));
  const pixels=new Uint8Array(width*height*4);
  const cutoff=source.scalars?.DiscardValuie ?? .85;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const blocked=masks.some((m,index)=>{
      const s=source.scalars || {},p='Mask'+index;
      const u=(x+.5)/width*(s[p+'UVScaleU'] ?? 1)+(s[p+'UVTranslateU'] ?? 0);
      const v=(y+.5)/height*(s[p+'UVScaleV'] ?? 1)+(s[p+'UVTranslateV'] ?? 0);
      const mx=Math.min(m.width-1,Math.floor(((u%1+1)%1)*m.width));
      const my=Math.min(m.height-1,Math.floor(((v%1+1)%1)*m.height));
      return m.data[(my*m.width+mx)*4]/255>=cutoff;
    });
    const i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=255;pixels[i+3]=blocked?255:0;
  }
  return {data:pixels,width,height};
}

export async function applyLegacyFireMask(source,material,companions,textures) {
  const masks=[];
  for(const {item,name} of companions){
    const archive=parseBntx(await item.getBytes());
    const surface=archive.textures.filter(t=>t.name.toLowerCase()===name.toLowerCase());
    if(surface.length!==1)throw new Error('Missing native fire silhouette surface');
    const image=decodeBntxTexture(archive,surface[0].index);
    if(image.compressed)throw new Error('Fire silhouette needs decoded pixels');
    masks.push(image);
  }
  const image=fireMaskPixels(source,masks);
  const map=new THREE.DataTexture(image.data,image.width,image.height,THREE.RGBAFormat);
  map.name='native fire silhouette depth mask';map.wrapS=map.wrapT=THREE.RepeatWrapping;
  configureTextureSampling(map);textures.push(map);
  material.map=map;material.opacity=1;material.transparent=false;
  material.colorWrite=false;material.depthWrite=true;material.alphaTest=.5;
  material.needsUpdate=true;
}
