/**
 * Nintendo Switch BNTX/NX texture reader.
 * Supports bounded, read-only 2D RGBA8/BGRA8, BC1 and BC3 (UNORM/sRGB)
 * surfaces in pitch-linear and Tegra block-linear layouts.
 * Refuses unsupported formats rather than rendering scrambled textures.
 */
export class BntxError extends Error {
  constructor(message) { super(message); this.name = 'BntxError'; }
}
const MAX_TEXTURE_BYTES = 256 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
const ascii = new TextDecoder();
function checked(view, pos, count, what) {
  if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(count) ||
      pos < 0 || count < 0 || pos > view.byteLength || count > view.byteLength - pos) {
    throw new BntxError('Invalid ' + what + ' bounds');
  }
}
function reader(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x40 || ascii.decode(bytes.subarray(0, 4)) !== 'BNTX')
    throw new BntxError('Not a BNTX container');
  const marker = view.getUint16(12, true);
  if (marker !== 0xfeff && marker !== 0xfffe)
    throw new BntxError('Invalid BNTX byte order marker');
  const little = marker === 0xfeff;
  const u16 = p => { checked(view,p,2,'16-bit value');return view.getUint16(p,little); };
  const u32 = p => { checked(view,p,4,'32-bit value');return view.getUint32(p,little); };
  const ptr = p => {
    checked(view,p,8,'pointer');
    const n = view.getBigUint64(p,little);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new BntxError('Pointer is too large');
    return Number(n);
  };
  return {bytes,view,little,u16,u32,ptr};
}
export function parseBntx(input) {
  const r = reader(input), {bytes,u16,u32,ptr} = r;
  if (ascii.decode(bytes.subarray(0x20,0x24)) !== 'NX  ')
    throw new BntxError('Unsupported BNTX platform');
  const count = u32(0x24), infoPtr = ptr(0x28);
  if (count > 4096) throw new BntxError('Unreasonable BNTX texture count');
  checked(r.view, infoPtr, count*8, 'texture pointer list');
  const textures = [];
  for(let i=0;i<count;i++) {
    const at = ptr(infoPtr + 8*i);
    checked(r.view,at,0x78,'BRTI header');
    if(ascii.decode(bytes.subarray(at,at+4))!=='BRTI')throw new BntxError('Invalid BRTI entry');
    const tileMode=bytes[at+0x10],mips=u16(at+0x16);
    const format=u32(at+0x1c),width=u32(at+0x24),height=u32(at+0x28);
    const sizeRange=u32(at+0x34),imageSize=u32(at+0x50);
    const namePtr=ptr(at+0x60),mipPtr=ptr(at+0x70);
    if(!width||!height||width*height>MAX_PIXELS||mips<1||mips>32 ||
        sizeRange>5||imageSize>MAX_TEXTURE_BYTES||tileMode>1)
      throw new BntxError('Unsupported or oversized BRTI layout');
    checked(r.view,namePtr,2,'texture name');
    const nameSize=u16(namePtr);
    if(nameSize>2048)throw new BntxError('Texture name exceeds limit');
    checked(r.view,namePtr+2,nameSize,'texture name');
    const name=ascii.decode(bytes.subarray(namePtr+2,namePtr+2+nameSize));
    const dataPtr=ptr(mipPtr);
    checked(r.view,dataPtr,imageSize,'BNTX image');
    textures.push({
      index:i,name,width,height,mips,format,tileMode,sizeRange,
      imageSize,dataOffset:dataPtr,swizzle:u16(at+0x14),
      arrayLength:u32(at+0x30)
    });
  }
  return {textures,byteLength:bytes.length,bytes};
}
const align = (value, alignment) => Math.ceil(value/alignment)*alignment;
function blockAddress(x,y,width,blockBytes,blockHeight) {
  const gobWidth=Math.ceil(width*blockBytes/64);
  const column=x*blockBytes;
  return Math.floor(y/(8*blockHeight))*512*blockHeight*gobWidth +
    Math.floor(column/64)*512*blockHeight +
    Math.floor((y%(8*blockHeight))/8)*512 +
    Math.floor((column%64)/32)*256 +
    Math.floor((y%8)/2)*64 +
    Math.floor((column%32)/16)*32 +
    (y%2)*16 + (column%16);
}
function unswizzle(texture, bytes, blockWidth,blockHeight,blockBytes) {
  const w=Math.ceil(texture.width/blockWidth),h=Math.ceil(texture.height/blockHeight);
  const count=w*h*blockBytes;
  if(count>MAX_TEXTURE_BYTES)throw new BntxError('Decoded texture is too large');
  const result=new Uint8Array(count);
  const pitch=align(w*blockBytes,texture.tileMode===0?32:64);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const src=texture.tileMode===0 ? y*pitch+x*blockBytes :
      blockAddress(x,y,w,blockBytes,1<<texture.sizeRange);
    if(src+blockBytes>bytes.byteLength)
      throw new BntxError('BNTX swizzled surface is truncated');
    result.set(bytes.subarray(src,src+blockBytes),(y*w+x)*blockBytes);
  }
  return result;
}
function rgb565(v) {
  return [((v>>11)&31)*255/31|0,((v>>5)&63)*255/63|0,(v&31)*255/31|0];
}
function bc1Palette(c0,c1,opaque) {
  const a=rgb565(c0),b=rgb565(c1);
  const p=[ [...a,255],[...b,255] ];
  if(opaque||c0>c1) {
    p.push([0,1,2].map(i=>Math.round((2*a[i]+b[i])/3)).concat(255));
    p.push([0,1,2].map(i=>Math.round((a[i]+2*b[i])/3)).concat(255));
  } else {
    p.push([0,1,2].map(i=>Math.round((a[i]+b[i])/2)).concat(255));
    p.push([0,0,0,0]);
  }
  return p;
}
function decodeBC(packed,width,height,alphaMode) {
  const w=Math.ceil(width/4),h=Math.ceil(height/4),out=new Uint8Array(width*height*4);
  const stride=alphaMode?16:8;
  for(let by=0;by<h;by++)for(let bx=0;bx<w;bx++) {
    const at=(by*w+bx)*stride;
    const color=at+(alphaMode?8:0);
    const c0=packed[color]|packed[color+1]<<8,c1=packed[color+2]|packed[color+3]<<8;
    const palette=bc1Palette(c0,c1,alphaMode);
    const bits=(packed[color+4]|packed[color+5]<<8|packed[color+6]<<16|packed[color+7]<<24)>>>0;
    let alpha=null;
    if(alphaMode) {
      const a0=packed[at],a1=packed[at+1];
      alpha=[a0,a1];
      if(a0>a1) for(let i=1;i<=6;i++)alpha.push(Math.round(((7-i)*a0+i*a1)/7));
      else {
        for(let i=1;i<=4;i++)alpha.push(Math.round(((5-i)*a0+i*a1)/5));
        alpha.push(0,255);
      }
    }
    for(let i=0;i<16;i++) {
      const x=bx*4+(i%4),y=by*4+Math.floor(i/4);
      if(x>=width||y>=height)continue;
      const dst=(y*width+x)*4,colour=palette[(bits>>>(i*2))&3];
      out.set(colour,dst);
      if(alpha) {
        const bit=i*3,byte=at+2+Math.floor(bit/8);
        const mask=packed[byte]|(packed[byte+1]??0)<<8|(packed[byte+2]??0)<<16;
        out[dst+3]=alpha[(mask>>>(bit%8))&7];
      }
    }
  }
  return out;
}
/** Decode the first 2D image layer to RGBA8; no external codecs needed. */
export function decodeBntxTexture(container,index=0) {
  const texture=container.textures[index];
  if(!texture)throw new BntxError('Texture index outside container');
  if(texture.arrayLength>1)throw new BntxError('Texture arrays are not supported');
  const id=texture.format>>>8;
  let blockWidth=1,blockHeight=1,blockBytes=4,mode='rgba';
  if(id===0x0b||id===0x0c){mode=id===0x0c?'bgra':'rgba';}
  else if(id===0x1a){blockWidth=blockHeight=4;blockBytes=8;mode='bc1';}
  else if(id===0x1c){blockWidth=blockHeight=4;blockBytes=16;mode='bc3';}
  else throw new BntxError('Unsupported BNTX texture format 0x'+texture.format.toString(16));
  const source=container.bytes.subarray(texture.dataOffset,texture.dataOffset+texture.imageSize);
  const packed=unswizzle(texture,source,blockWidth,blockHeight,blockBytes);
  let rgba;
  if(mode==='bc1'||mode==='bc3')rgba=decodeBC(packed,texture.width,texture.height,mode==='bc3');
  else {
    rgba=packed;
    if(mode==='bgra') {
      rgba=packed.slice();
      for(let i=0;i<rgba.length;i+=4)[rgba[i],rgba[i+2]]=[rgba[i+2],rgba[i]];
    }
  }
  return {name:texture.name,width:texture.width,height:texture.height,data:rgba};
}
