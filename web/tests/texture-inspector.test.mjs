import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectTexture, drawTextureSurface, isInspectableTexture, texturePngName,
  detectTextureExtension
} from '../src/texture-inspector.js';
import {findLegacyTexture} from '../src/gfbmdl-model.js';

function bntxFixture() {
  const bytes = new Uint8Array(0x600), v = new DataView(bytes.buffer);
  const u16 = (p,n)=>v.setUint16(p,n,true);
  const u32 = (p,n)=>v.setUint32(p,n,true);
  const u64 = (p,n)=>v.setBigUint64(p,BigInt(n),true);
  const text = (p,s)=>bytes.set(new TextEncoder().encode(s),p);
  text(0,'BNTX');bytes.set([255,254],12);text(0x20,'NX  ');
  u32(0x24,2);u64(0x28,0x80);
  u64(0x80,0x100);u64(0x88,0x280);
  for(const [base,name,pointer,dataPos] of [
    [0x100,'body',0x1b0,0x400],[0x280,'eyes',0x330,0x500]]) {
    text(base,'BRTI');bytes[base+0x10]=0;u16(base+0x16,1);
    u32(base+0x1c,0x0b01);u32(base+0x24,2);u32(base+0x28,1);
    u32(base+0x30,1);u32(base+0x50,32);
    u64(base+0x60,base+0x80);u64(base+0x70,pointer);
    u16(base+0x80,name.length);text(base+0x82,name);
    u64(pointer,dataPos);
  }
  bytes.set([255,0,0,255,0,255,0,255],0x400);
  bytes.set([3,4,5,255,9,8,7,255],0x500);
  return bytes;
}

test('inspects both internal BNTX surfaces and decodes the selected one',async()=>{
  const archive=inspectTexture(bntxFixture(),'pokemon/pm0025_00.bntx');
  assert.equal(archive.kind,'bntx');
  assert.deepEqual(archive.surfaces.map(s=>s.name),['body','eyes']);
  assert.equal(archive.surfaces[1].width,2);
  const savedImageData=globalThis.ImageData;
  let displayed;
  globalThis.ImageData=class {
    constructor(data,width,height){this.data=data;this.width=width;this.height=height;}
  };
  try {
    const canvas={
      getContext(kind){assert.equal(kind,'2d');return {putImageData(image){displayed=image;}}}
    };
    const rendered=await drawTextureSurface(archive,1,canvas);
    assert.deepEqual(Array.from(displayed.data.slice(0,8)),
      [3,4,5,255,9,8,7,255]);
    assert.equal(rendered.width,2);
    assert.equal(rendered.height,1);
    assert.equal(canvas.width,2);
    rendered.dispose();
  } finally { globalThis.ImageData=savedImageData; }
  assert.equal(texturePngName(archive,1),'pm0025_00_eyes.png');
});

test('texture inspector accepts ordinary pictures but rejects unsupported formats',()=>{
  assert.ok(isInspectableTexture('pokemon/body.BNTX'));
  assert.ok(isInspectableTexture('picture.webp'));
  assert.equal(isInspectableTexture('scan.trtex'),false);
  const image=inspectTexture(Uint8Array.from([1,2,3]),'folder/a.png');
  assert.equal(image.kind,'image');
  assert.equal(image.mime,'image/png');
  assert.equal(image.surfaces.length,1);
  assert.throws(()=>inspectTexture(new Uint8Array(), 'a.bntx'),/empty/);
  assert.throws(()=>inspectTexture(Uint8Array.from([1]),'a.trtex'),/Unsupported standalone/);
});

test('legacy GFBMDL texture mapping prefers unique exact/local matches',()=>{
  const local={path:'mon/body.png'},remote={path:'other/body.png'},
    packed={path:'mon/skins.bntx'},second={path:'mon/extra.bntx'};
  const rows=[
    {item:remote,base:'body',score:0},
    {item:local,base:'body',score:10},
    {item:packed,base:'skins',score:10}
  ];
  assert.equal(findLegacyTexture('body',rows),local);
  assert.equal(findLegacyTexture('eyes',rows),packed);
  assert.equal(findLegacyTexture('eyes',[...rows,{item:second,base:'extra',score:10}]),null);
  assert.equal(findLegacyTexture('body',[...rows,{item:local,base:'body',score:10}]),null);
});

test('DDS textures expose real dimensions and retain native compressed blocks',()=>{
  const bytes=new Uint8Array(136);
  const view=new DataView(bytes.buffer);
  view.setUint32(0,0x20534444,true);
  view.setUint32(4,124,true);
  view.setUint32(8,0xa1007,true);
  view.setUint32(12,4,true);view.setUint32(16,4,true);
  view.setUint32(20,8,true);view.setUint32(28,1,true);
  view.setUint32(76,32,true);view.setUint32(80,4,true);
  view.setUint32(84,0x31545844,true);
  view.setUint32(108,0x1000,true);
  bytes.set([0,248,31,0,0,0,0,0],128);
  assert.equal(isInspectableTexture('body.dds'),true);
  const info=inspectTexture(bytes,'textures/body.dds');
  assert.equal(info.kind,'dds');
  assert.equal(info.surfaces[0].width,4);
  assert.equal(info.surfaces[0].height,4);
  assert.equal(texturePngName(info,0),'body_body.dds.png');
});

test('magic detection is conservative for unnamed archive resources',()=>{
 const png=Uint8Array.from([137,80,78,71,13,10,26,10]);
 const dds=Uint8Array.from([68,68,83,32,0]);
 const jpeg=Uint8Array.from([255,216,255,0]);
 const webp=Uint8Array.from([82,73,70,70,0,0,0,0,87,69,66,80]);
 assert.equal(detectTextureExtension(bntxFixture()),'.bntx');
 assert.equal(detectTextureExtension(png),'.png');
 assert.equal(detectTextureExtension(dds),'.dds');
 assert.equal(detectTextureExtension(jpeg),'.jpg');
 assert.equal(detectTextureExtension(webp),'.webp');
 assert.equal(detectTextureExtension(new Uint8Array([1,2,3,4])),null);
});
