/**
 * Read-only browser game file readers.
 * The File/Blob is never uploaded; package indexes are read by bounded slices.
 * Native decryption, NCZ and encrypted/patch NCA layers are intentionally not faked.
 */
import JSZip from 'jszip';
import {parseGfpakFile, extractResourceAsync, resolvedName} from './gfpak.js';

const utf8 = new TextDecoder('utf-8', {fatal:true});
const MAX_ENTRIES = 150000;
const MAX_INDEX = 32 * 1024 * 1024;
const MAX_ZIP_MEMBER = 256 * 1024 * 1024;
const END = 0xffffffff;

function assertRange(size, offset, length, name = 'file') {
  if (![size,offset,length].every(Number.isSafeInteger) ||
      offset < 0 || length < 0 || offset > size || length > size - offset)
    throw new Error(name + ' is outside its source file bounds.');
}
function u32(v, pos) { return v.getUint32(pos,true); }
function u64(v, pos) {
  const n = v.getBigUint64(pos,true);
  if(n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Unsupported offset above safe integer range');
  return Number(n);
}
function nameSafe(name) {
  return !!name && name !== '.' && name !== '..' &&
    !/[\\/\0]/.test(name) && name.length < 8192;
}
function decodeName(bytes) { return utf8.decode(bytes); }
function boundedName(bytes, offset, tableLength) {
  if(offset >= tableLength) throw Error('Invalid filename offset in package index');
  const end = bytes.indexOf(0,offset);
  if(end < 0 || end >= tableLength) throw Error('Unterminated package filename');
  const name = decodeName(bytes.subarray(offset,end));
  if (!nameSafe(name)) throw Error('Invalid filename in package index');
  return name;
}
export function fromBlob(blob) {
  return {
    size:blob.size, file:blob,
    async read(at,len) {
      assertRange(blob.size,at,len);
      return new Uint8Array(await blob.slice(at,at+len).arrayBuffer());
    }
  };
}
export async function fromZipMember(entry) {
  const size = Number(entry._data?.uncompressedSize ?? 0);
  if(!Number.isSafeInteger(size) || size > MAX_ZIP_MEMBER)
    throw Error('ZIP member exceeds browser memory limit (256 MiB)');
  let pending;
  return {
    size,
    async read(at,len) {
      assertRange(size,at,len);
      // Decode once, on first access; never eagerly expand every ZIP file.
      pending ||= entry.async('uint8array');
      const data = await pending;
      return data.subarray(at,at+len);
    }
  };
}
function relativeSource(source, start, size) {
  assertRange(source.size,start,size);
  return {
    size,
    read(at,len) {
      assertRange(size,at,len);
      return source.read(start+at,len);
    }
  };
}
export function categoryOf(name) {
  if (/\.(gfbmdl|trmdl|trmsh|glb|gltf|fbx|obj|dae|ply|stl|3ds)$/i.test(name))
    return 'model';
  if (/\.(bntx|dds|trtex|png|jpeg|jpg|webp|tga|ktx2)$/i.test(name)) return 'texture';
  if (/\.(tranm|gfbanm|gfbmot|gfanm)$/i.test(name)) return 'animation';
  if (/\.(trskl|gfskl)$/i.test(name)) return 'skeleton';
  if (/\.(trmbf|gfmdlbuf)$/i.test(name)) return 'mesh';
  if (/\.(trmtr|gfmat)$/i.test(name)) return 'material';
  if (/\.(gfpak|zip)$/i.test(name)) return 'asset package';
  if (/\.nca$/i.test(name)) return 'encrypted container';
  if (/\.ncz$/i.test(name)) return 'compressed container';
  if (/\.(tik|cert|cnmt|xml|json)$/i.test(name)) return 'metadata';
  return 'other';
}
export function kindOf(name) {
  if(/\.gfpak$/i.test(name)) return 'gfpak';
  if(/\.nca$/i.test(name)) return 'nca';
  if(/\.(nsp|xci)$/i.test(name)) return 'package';
  if(/\.zip$/i.test(name)) return 'zip';
  return 'file';
}
export async function readPackage(source, offset=0, expected='') {
  const pre=await source.read(offset,16);
  if(pre.length!==16) throw Error('Truncated package header');
  const magic=decodeName(pre.subarray(0,4));
  if(!['PFS0','HFS0'].includes(magic) || (expected && magic!==expected))
    throw Error('Unsupported package index (expected PFS0 or HFS0)');
  const head=new DataView(pre.buffer,pre.byteOffset,pre.byteLength);
  const count=u32(head,4),namesSize=u32(head,8);
  const entrySize=magic==='PFS0'?24:64;
  const length=16+count*entrySize+namesSize;
  if(count>MAX_ENTRIES||length>MAX_INDEX||length>source.size-offset)
    throw Error('Package has an invalid or oversized index');
  const raw=await source.read(offset,length);
  const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const nameBase=16+count*entrySize;
  const nameBytes=raw.subarray(nameBase);
  const entries=[];
  for(let i=0;i<count;i++){
    const at=16+i*entrySize;
    const rel=u64(view,at),size=u64(view,at+8),nameAt=u32(view,at+16);
    const name=boundedName(nameBytes,nameAt,namesSize);
    const absolute=offset+length+rel;
    assertRange(source.size,absolute,size,'Package file '+name);
    entries.push({
      name,size,offset:absolute,source:relativeSource(source,absolute,size),
      category:categoryOf(name),kind:kindOf(name)
    });
  }
  return {magic,indexSize:length,entries};
}
export async function openXci(source) {
  if(source.size<0xf010) throw Error('XCI gamecard image is too small');
  return readPackage(source,0xf000,'HFS0');
}
export async function openZip(blob) {
  const zip=await JSZip.loadAsync(blob,{checkCRC32:false});
  const entries=Object.values(zip.files).filter(item=>!item.dir);
  if(entries.length>MAX_ENTRIES) throw Error('ZIP contains too many entries');
  return entries.map(entry=>{
    const parts=entry.name.replace(/\\/g,'/').split('/');
    if(parts.some(part=>!nameSafe(part))) return null;
    const size=Number(entry._data?.uncompressedSize??0);
    return {
      name:parts.join('/'),size,kind:kindOf(entry.name),category:categoryOf(entry.name),
      loadSource:()=>fromZipMember(entry)
    };
  }).filter(Boolean);
}
export async function openGfpak(blob, dictionary=new Map()) {
  const archive=await parseGfpakFile(blob);
  return archive.resources.map(res=>{
    const found=resolvedName(res,dictionary);
    const fallback='unresolved/'+res.pathHash+'.bin';
    const name=found && found.split('/').every(part=>nameSafe(part)) ? found : fallback;
    return {
      name,size:res.size,packedSize:res.packedSize,offset:res.offset,
      hash:res.pathHash,compression:res.compression,
      category:found?categoryOf(name):'unknown',
      kind:found?kindOf(name):'file',
      async loadSource(packed=false) {
        if(packed) return relativeSource(fromBlob(blob),res.offset,res.packedSize);
        const content=await extractResourceAsync(archive,res);
        return content instanceof Blob ? fromBlob(content) :
          fromBlob(new Blob([content]));
      }
    };
  });
}
export async function inspectNca(source) {
  if(source.size<0xc00) throw Error('NCA header is incomplete');
  const raw=await source.read(0,0xc00);
  if(decodeName(raw.subarray(0x200,0x204))!=='NCA3')
    throw Error('Encrypted NCA header: browser mode cannot decode NCA header keys.');
  const v=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const sections=[];
  for(let i=0;i<4;i++) {
    const a=u32(v,0x240+i*16),b=u32(v,0x244+i*16);
    if(!a&&!b) continue;
    const start=a*0x200,stop=b*0x200;
    if(start<0xc00 || stop<=start || stop>source.size)
      throw Error('Invalid NCA section storage bounds');
    const fs=raw.subarray(0x400+i*0x200,0x600+i*0x200);
    const encryption=fs[4],fsType=fs[2],hashType=fs[3];
    sections.push({
      name:'Section '+i,size:stop-start,number:i,encryption,fsType,hashType,
      source:relativeSource(source,start,stop-start),header:fs,
      category:'folder',kind:'nca_section',
      supported:encryption===1 && ![
        0x108,0x128,0x150,0x180
      ].some(at=>u64(new DataView(fs.buffer,fs.byteOffset,fs.byteLength),at)>0)
    });
  }
  return sections;
}
export async function openNcaSection(section) {
  if(!section.supported)
    throw Error(section.encryption===1 ?
      'Sparse, compressed or patch NCA storage requires desktop decoding.' :
      'Encrypted NCA section requires native decryption; no files were fabricated.');
  const source=section.source;
  const fs=new DataView(section.header.buffer,section.header.byteOffset,section.header.byteLength);
  if([1,2].includes(section.fsType)&&[0,1,2,5].includes(section.hashType)){
    const begin=[2,5].includes(section.hashType)?u64(fs,0x40):0;
    return {type:'pfs',...(await readPackage(source,begin,'PFS0'))};
  }
  if([0,3].includes(section.fsType)||[3,6].includes(section.hashType)){
    if(decodeName(section.header.subarray(8,12))!=='IVFC')
      throw Error('This RomFS IVFC layout is unsupported');
    const levels=u32(fs,0x14);
    if(levels<2||levels>7) throw Error('Invalid IVFC level count');
    const offset=0x18+(levels-2)*0x18;
    if(offset+0x18>0xa8)throw Error('RomFS level descriptor is outside header');
    const romOffset=u64(fs,offset),length=u64(fs,offset+8);
    assertRange(source.size,romOffset,length,'RomFS');
    const rom=relativeSource(source,romOffset,length);
    const header=await rom.read(0,0x50);
    const h=new DataView(header.buffer,header.byteOffset,header.byteLength);
    if(u64(h,0)!==0x50)throw Error('Decrypted RomFS header is invalid');
    const directory={start:u64(h,0x18),size:u64(h,0x20)};
    const fileTable={start:u64(h,0x38),size:u64(h,0x40)};
    const fileData=u64(h,0x48);
    assertRange(rom.size,directory.start,directory.size,'RomFS directory metadata');
    assertRange(rom.size,fileTable.start,fileTable.size,'RomFS file metadata');
    assertRange(rom.size,fileData,0,'RomFS data');
    return {type:'romfs', rom, directory,fileTable,fileData};
  }
  throw Error('Unsupported NCA filesystem format');
}
async function romDirectory(fs, at) {
  assertRange(fs.directory.size,at,24,'RomFS directory record');
  const data=await fs.rom.read(fs.directory.start+at,24);
  const v=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const nameLen=u32(v,20);
  if(nameLen>4096)throw Error('Invalid RomFS directory name length');
  assertRange(fs.directory.size,at+24,nameLen,'RomFS name');
  const name=nameLen?decodeName(await fs.rom.read(fs.directory.start+at+24,nameLen)):'';
  return {name,sibling:u32(v,4),childDir:u32(v,8),childFile:u32(v,12)};
}
async function romFile(fs,at) {
  assertRange(fs.fileTable.size,at,32,'RomFS file record');
  const data=await fs.rom.read(fs.fileTable.start+at,32);
  const v=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const len=u32(v,28);
  if(len>4096)throw Error('Invalid RomFS filename length');
  assertRange(fs.fileTable.size,at+32,len,'RomFS filename');
  const name=decodeName(await fs.rom.read(fs.fileTable.start+at+32,len));
  const begin=u64(v,8),size=u64(v,16);
  assertRange(fs.rom.size,fs.fileData+begin,size,'RomFS file data');
  return {name,size,sibling:u32(v,4),
    source:relativeSource(fs.rom,fs.fileData+begin,size),
    category:categoryOf(name),kind:kindOf(name)};
}
export async function romChildren(fs,dirAt=0,max=10000) {
  const parent=await romDirectory(fs,dirAt);
  const entries=[];
  for(const [field,fn] of [['childDir',romDirectory],['childFile',romFile]]) {
    const seen=new Set();
    let at=parent[field];
    while(at!==END) {
      if(seen.has(at))throw Error('RomFS sibling pointer cycle detected');
      if(entries.length>=max)throw Error('RomFS folder exceeds 10,000 entries');
      seen.add(at);
      const item=await fn(fs,at);
      if(!nameSafe(item.name))throw Error('Invalid RomFS filename');
      entries.push({...item,at,kind:field==='childDir'?'folder':item.kind,
        category:field==='childDir'?'folder':item.category});
      at=item.sibling;
    }
  }
  return entries;
}
export {relativeSource, assertRange};
