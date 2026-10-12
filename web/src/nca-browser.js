/** Read-only NCA3 filesystem reader for browser-selected local keys.
 * Only reads selected slices: NCA header, PFS0 table, RomFS directory metadata,
 * and individual requested asset data. No keys are serialized or uploaded.
 */
import {decryptEcb,decryptXtsHeader,decryptXtsSector,decryptCtr} from './nca-crypto.js';
const text = new TextDecoder('utf-8',{fatal:true});
const BLOCK=0x200, NONE=0xffffffff;
const MAX_FILES=200000,MAX_META=256*1024*1024,MAX_SINGLE=512*1024*1024;
const safe64=(v,at)=>{
  const n=v.getBigUint64(at,true);
  if(n>BigInt(Number.MAX_SAFE_INTEGER)) throw Error('NCA offset exceeds JavaScript safe integer range');
  return Number(n);
};
function check(at,size,bound,label){
  if (!Number.isSafeInteger(at)||!Number.isSafeInteger(size)||
      at<0||size<0||at>bound||size>bound-at)
    throw Error(label+' is outside the NCA filesystem');
}
function valueName(data) {
  const name=text.decode(data);
  if(!name || name==='.' || name==='..' || /[/\\\0]/.test(name))
    throw Error('Invalid name in NCA filesystem');
  return name;
}
function partitionFilename(data) {
  const value=text.decode(data).replaceAll('\\\\','/');
  if(!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) ||
    value.split('/').some(part=>!part || part==='.' || part==='..'))
    throw Error('Unsafe PartitionFS filename');
  return value;
}
async function sliceBytes(blob,offset,size){
  check(offset,size,blob.size,'NCA read');
  return new Uint8Array(await blob.slice(offset,offset+size).arrayBuffer());
}
function toBuffer(array){return array.buffer.slice(array.byteOffset,array.byteOffset+array.byteLength);}
async function bufferedBlob(read,size){
  if(size>MAX_SINGLE) throw Error('This file is too large for a browser in-memory decrypted export (512 MiB limit)');
  const chunks=[];
  for(let i=0;i<size;i+=2*1024*1024) chunks.push(await read(i,Math.min(2*1024*1024,size-i)));
  return new Blob(chunks,{type:'application/octet-stream'});
}
function virtualEntry(name,size,offset,section) {
  return {
    name,size,offset,kind:'decrypted-nca-file',
    getBytes: async()=>toBuffer(await section.read(offset,size)),
    getBlob: async()=>bufferedBlob((pos,n)=>section.read(offset+pos,n),size)
  };
}
async function sectionReader(blob,head,number,start,size,mode,key,xtsEndian){
  const fs=head.subarray(0x400+number*0x200,0x600+number*0x200);
  const prefix=Uint8Array.from(fs.subarray(0x140,0x148)).reverse();
  const read=async(relative,length)=>{
    check(relative,length,size,'NCA section read');
    const absolute=start+relative;
    if(!length)return new Uint8Array();
    if(mode===1) return sliceBytes(blob,absolute,length);
    if(mode===3){
      if(key?.length!==16)throw Error('Compatible NCA content key not provided');
      const aligned=Math.floor(absolute/16)*16,leading=absolute-aligned;
      const payload=await sliceBytes(blob,aligned,length+leading);
      const plaintext=await decryptCtr(key,payload,prefix,aligned);
      return plaintext.slice(leading,leading+length);
    }
    if(mode===2){
      if(key?.length!==32)throw Error('Compatible NCA AES-XTS section key not provided');
      const lower=Math.floor(relative/BLOCK)*BLOCK;
      const upper=Math.ceil((relative+length)/BLOCK)*BLOCK;
      if(upper>size)throw Error('NCA XTS read is not media-block aligned');
      const out=new Uint8Array(upper-lower);
      for(let at=lower;at<upper;at+=BLOCK) {
        const raw=await sliceBytes(blob,start+at,BLOCK);
        const plain=await decryptXtsSector(key,raw,at/BLOCK,xtsEndian);
        out.set(plain,at-lower);
      }
      return out.slice(relative-lower,relative-lower+length);
    }
    throw Error('Unsupported NCA section encryption mode '+mode);
  };
  return {read,size,fs,number};
}
async function pfsRows(section,start,prefix) {
  const header=await section.read(start,16);
  if(text.decode(header.subarray(0,4))!=='PFS0')throw Error('No PFS0 filesystem at declared section offset');
  const v=new DataView(header.buffer,header.byteOffset,header.byteLength);
  const count=v.getUint32(4,true),strings=v.getUint32(8,true);
  if(count>MAX_FILES||strings>MAX_META||count*24+strings>MAX_META)
    throw Error('NCA PartitionFS index exceeds safe bounds');
  const length=16+count*24+strings;
  check(start,length,section.size,'PartitionFS');
  const metadata=await section.read(start+16,length-16);
  const view=new DataView(metadata.buffer,metadata.byteOffset,metadata.byteLength);
  const names=metadata.subarray(count*24);
  const dataStart=start+length;
  const output=[];
  for(let i=0;i<count;i++){
    const at=i*24;
    const offset=safe64(view,at),size=safe64(view,at+8);
    const off=view.getUint32(at+16,true);
    if(off>=names.length)throw Error('PartitionFS filename outside string table');
    let end=off;while(end<names.length&&names[end]!==0)end++;
    if(end===names.length)throw Error('Unterminated PartitionFS filename');
    const name=partitionFilename(names.subarray(off,end));
    check(dataStart+offset,size,section.size,'PartitionFS file');
    output.push(virtualEntry(prefix+name,size,dataStart+offset,section));
  }
  return output;
}
function metadataPages(section,base,size){
  const cached=new Map();
  return async(offset,length)=>{
    check(offset,length,size,'RomFS metadata');
    const out=new Uint8Array(length);
    let copied=0;
    while(copied<length){
      const page=Math.floor((offset+copied)/65536);
      let data=cached.get(page);
      if(!data){
        const at=page*65536;
        data=await section.read(base+at,Math.min(65536,size-at));
        cached.set(page,data);
        if(cached.size>128)cached.delete(cached.keys().next().value);
      }
      const p=(offset+copied)%65536;
      const n=Math.min(length-copied,data.length-p);
      out.set(data.subarray(p,p+n),copied);
      copied+=n;
    }
    return out;
  };
}
async function romfsRows(section,start,prefix) {
  const header=await section.read(start,0x50);
  const v=new DataView(header.buffer,header.byteOffset,header.byteLength);
  if(safe64(v,0)!==0x50)throw Error('Unsupported RomFS header');
  const dOff=safe64(v,0x18), dSize=safe64(v,0x20);
  const fOff=safe64(v,0x38), fSize=safe64(v,0x40);
  const dataOff=safe64(v,0x48);
  if(dSize<0x18||dSize>MAX_META||fSize>MAX_META)
    throw Error('RomFS metadata exceeds browser index limits');
  for(const [at,size] of [[dOff,dSize],[fOff,fSize],[dataOff,0]])
    check(start+at,size,section.size,'RomFS region');
  const readDir=metadataPages(section,start+dOff,dSize);
  const readFile=metadataPages(section,start+fOff,fSize);
  const directory=async(at)=>{
    check(at,24,dSize,'RomFS directory entry');
    const b=await readDir(at,24),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    const sibling=v.getUint32(4,true),childDir=v.getUint32(8,true),
      childFile=v.getUint32(12,true),length=v.getUint32(20,true);
    if(length>4096)throw Error('RomFS directory name exceeds 4096 bytes');
    check(at+24,length,dSize,'RomFS directory name');
    const name=length?valueName(await readDir(at+24,length)):'';
    return {name,sibling,childDir,childFile};
  };
  const file=async(at)=>{
    check(at,32,fSize,'RomFS file entry');
    const b=await readFile(at,32),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    const sibling=v.getUint32(4,true),pos=safe64(v,8),size=safe64(v,16),
      length=v.getUint32(28,true);
    if(length>4096)throw Error('RomFS filename exceeds 4096 bytes');
    check(at+32,length,fSize,'RomFS filename');
    const name=valueName(await readFile(at+32,length));
    check(start+dataOff+pos,size,section.size,'RomFS file content');
    return {name,sibling,offset:start+dataOff+pos,size};
  };
  const root=await directory(0);
  const folders=[{path:'',childDir:root.childDir,childFile:root.childFile}];
  const seenDir=new Set([0]),seenFile=new Set(),result=[];
  for(let index=0;index<folders.length;index++){
    if(folders.length>MAX_FILES)throw Error('RomFS has too many directories');
    const parent=folders[index];
    for(let p=parent.childDir;p!==NONE;){
      if(seenDir.has(p))throw Error('RomFS directory cycle detected');
      seenDir.add(p);
      const dir=await directory(p);
      if(!dir.name)throw Error('Unnamed nested RomFS directory');
      const name=(parent.path+dir.name+'/');
      folders.push({path:name,childDir:dir.childDir,childFile:dir.childFile});
      p=dir.sibling;
    }
    for(let p=parent.childFile;p!==NONE;){
      if(seenFile.has(p)||seenFile.size>MAX_FILES)
        throw Error('RomFS file cycle or too many entries');
      seenFile.add(p);
      const item=await file(p);
      result.push(virtualEntry(prefix+parent.path+item.name,item.size,item.offset,section));
      p=item.sibling;
    }
  }
  return result;
}
function ivfcRegion(fs) {
  if(text.decode(fs.subarray(8,12))!=='IVFC')throw Error('Unsupported RomFS hash superblock');
  const v=new DataView(fs.buffer,fs.byteOffset,fs.byteLength),levels=v.getUint32(0x14,true);
  if(levels<2||levels>7)throw Error('Invalid IVFC filesystem level count');
  const offset=0x18+(levels-2)*0x18;
  if(offset+0x18>0xa8)throw Error('IVFC final descriptor is outside header');
  return {offset:safe64(v,offset),size:safe64(v,offset+8)};
}
export async function parseNcaWithKeys(entry,keys=null) {
  const blob=entry.getBlob();
  if(blob.size<0xc00)return {entries:[],status:'invalid',reason:'Truncated NCA header'};
  const raw=await sliceBytes(blob,0,0xc00);
  let header=raw,xtsEndian='big',encryptedHeader=false;
  if(text.decode(header.subarray(0x200,0x204))!=='NCA3'){
    const key=keys?.get('nca_header_key','header_key');
    if(!key)return {entries:[],status:'locked',reason:'Requires the local nca_header_key from prod.keys'};
    const decoded=await decryptXtsHeader(raw,key);
    header=decoded.header;xtsEndian=decoded.endian;encryptedHeader=true;
  }
  const v=new DataView(header.buffer,header.byteOffset,header.byteLength);
  const generation=Math.max(header[0x206],header[0x220]),revision=Math.max(0,generation-1);
  const kind=['application','ocean','system'][header[0x207]];
  let areaKeys=null;
  const rights=header.subarray(0x230,0x240);
  if(rights.some(Boolean)){
    const hex=Array.from(rights,n=>n.toString(16).padStart(2,'0')).join('');
    const key=keys?.get('titlekey_'+hex,hex);
    if(key?.length===16)areaKeys=[key,key,key,key];
  }else if(kind){
    const suffix=revision.toString(16).padStart(2,'0');
    const area=keys?.get('nca_key_area_key_'+kind+'_'+suffix,
      'key_area_key_'+kind+'_'+suffix);
    if(area?.length===16){
      const plain=await decryptEcb(area,header.subarray(0x300,0x340));
      areaKeys=Array.from({length:4},(_,i)=>plain.slice(i*16,i*16+16));
    }
  }
  const output=[];
  let locked=0,unsupported=0,readable=0;
  const reasons=[];
  for(let i=0;i<4;i++){
    const at=0x240+i*0x10;
    const start=v.getUint32(at,true)*BLOCK,stop=v.getUint32(at+4,true)*BLOCK;
    if(!start&&!stop)continue;
    if(start<0xc00 || stop<=start || stop>blob.size){
      unsupported++;reasons.push('Invalid section '+i+' bounds');continue;
    }
    const fs=header.subarray(0x400+i*0x200,0x600+i*0x200);
    const fv=new DataView(fs.buffer,fs.byteOffset,fs.byteLength);
    const enc=fs[4],type=fs[2],hash=fs[3];
    if([0x100,0x120,0x150,0x180].some(offset=>safe64(fv,offset)>0)){
      unsupported++;reasons.push('Section '+i+': patch, sparse, or compressed NCA mapping is not supported');continue;
    }
    if(![1,2,3].includes(enc)){
      unsupported++;reasons.push('Section '+i+': unsupported encryption '+enc);continue;
    }
    if(enc!==1&&!areaKeys){
      locked++;reasons.push('Section '+i+': compatible title/content key unavailable');continue;
    }
    const key=enc===3?areaKeys?.[2] : enc===2?
      new Uint8Array([...areaKeys[0],...areaKeys[1]]) : null;
    const section=await sectionReader(blob,header,i,start,stop-start,enc,key,xtsEndian);
    try {
      let files;
      if([1,2].includes(type)&&[0,1,2,5].includes(hash)){
        const offset=[2,5].includes(hash)?safe64(fv,0x40):0;
        files=await pfsRows(section,offset,entry.name+'/section-'+i+'/');
      }else if([0,3].includes(type)||[3,6].includes(hash)){
        const region=ivfcRegion(fs);
        check(region.offset,region.size,section.size,'RomFS IVFC region');
        files=await romfsRows(section,region.offset,entry.name+'/section-'+i+'/');
      }else throw Error('Unsupported NCA filesystem type '+type+' hash '+hash);
      output.push(...files);readable++;
    }catch(error){
      unsupported++;reasons.push('Section '+i+': '+error.message);
    }
  }
  return {
    entries:output,locked,unsupported,readable,encryptedHeader,
    status:readable?'decrypted':locked?'locked':'unsupported',
    reason:reasons.slice(0,8).join('; ')
  };
}
