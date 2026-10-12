/** Local, read-only, file-backed Switch package indexes for browser use.
 * Handles PFS0 NSP/NSZ, HFS0 XCI, and plaintext PFS0 in NCA3 sections.
 * Encrypted NCA sections and NCZ payloads are NOT silently interpreted.
 * No original game bytes leave the browser.
 */
import {parseNcaWithKeys} from './nca-browser.js';
const decoder = new TextDecoder();
const MAX_ENTRIES = 50000;
const MAX_NAMES = 8 * 1024 * 1024;
const MAX_INDEX = MAX_ENTRIES * 0x40 + MAX_NAMES + 16;
const BLOCK = 0x200;
function requireRange(blob, start, length, what) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
      start < 0 || length < 0 || start > blob.size || length > blob.size - start)
    throw Error(what + ' is outside the file');
}
async function bytes(blob, start, length, what) {
  requireRange(blob, start, length, what);
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}
function number(view, at) {
  const n = view.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Unsupported 64-bit file offset');
  return Number(n);
}
function nameFromTable(strings, start) {
  if (start >= strings.length) throw Error('Filename offset outside string table');
  let end = start;
  while (end < strings.length && strings[end] !== 0) end++;
  if (end === strings.length || end === start) throw Error('Missing or empty filename');
  const name = decoder.decode(strings.subarray(start,end));
  if (name.startsWith('/') || name.startsWith('\\') || /^[a-z]:/i.test(name) ||
      name.replaceAll('\\','/').split('/').includes('..'))
    throw Error('Unsafe package filename: ' + name);
  return name;
}
export function assetCategory(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['trmdl','gfbmdl','glb','gltf','fbx','dae','obj','trmsh','nusrcmdlb'].includes(ext)) return 'model';
  if (['bntx','dds','png','jpg','jpeg','webp','tga','ktx2','bmp'].includes(ext)) return 'texture';
  if (['tranm','gfbanm','tracm','tracn','tracp','tracr','tracs','tralk','trslp','traef'].includes(ext)) return 'animation';
  if (['trskl','trmtr','trmbf','mtl','trmsh'].includes(ext)) return 'companion';
  if (['gfpak'].includes(ext)) return 'archive';
  if (['nca','ncz'].includes(ext)) return 'container';
  return 'other';
}
function row(name, blob, absolute, size, details = {}) {
  requireRange(blob, absolute, size, name);
  return {
    name, size, offset:absolute, category:assetCategory(name),
    kind:details.kind || 'file', ...details,
    getBlob: () => blob.slice(absolute, absolute + size),
    getBytes: () => blob.slice(absolute, absolute + size).arrayBuffer()
  };
}
async function readIndex(blob, base, length, format, prefix = '') {
  requireRange(blob, base, length, format);
  const header = await bytes(blob, base, 16, format + ' header');
  const magic = decoder.decode(header.subarray(0,4));
  if (magic !== format) throw Error('Expected ' + format + ' header, found ' + magic);
  const h = new DataView(header.buffer);
  const count = h.getUint32(4,true), namesSize = h.getUint32(8,true);
  if (count > MAX_ENTRIES || namesSize > MAX_NAMES) throw Error('Package index exceeds safety limits');
  const width = format === 'HFS0' ? 0x40 : 0x18;
  const size = 16 + width * count + namesSize;
  if (size > length || size > MAX_INDEX) throw Error('Package index is truncated or too large');
  const index = await bytes(blob, base + 16, size - 16, format + ' index');
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  const names = index.subarray(width * count);
  const dataStart = base + size;
  const result = [], seen = new Set();
  for (let i = 0; i < count; i++) {
    const at = i * width;
    const rel = number(view, at);
    const fileSize = number(view, at + 8);
    const nameAt = view.getUint32(at + 16, true);
    const name = nameFromTable(names, nameAt);
    if (seen.has(name.toLowerCase())) throw Error('Duplicate filename in ' + format + ': ' + name);
    seen.add(name.toLowerCase());
    if (rel > length - size || fileSize > length - size - rel)
      throw Error('Indexed file extends beyond package: ' + name);
    result.push(row(prefix + name, blob, dataStart + rel, fileSize, {
      kind: 'indexed', container:format, originalName:name
    }));
  }
  return {entries:result, headerBytes:size, count};
}
export async function parsePlainNcaRows(entry) {
  const blob = entry.getBlob();
  if (blob.size < 0xc00) return {entries:[], status:'invalid'};
  const head = await bytes(blob,0,0xc00,'NCA header');
  if (decoder.decode(head.subarray(0x200,0x204)) !== 'NCA3')
    return {entries:[],status:'locked'};
  const v = new DataView(head.buffer);
  const entries = [];
  let locked = 0, unsupported = 0, readable = 0;
  for (let i=0;i<4;i++) {
    const at = 0x240+i*0x10;
    const start = v.getUint32(at,true)*BLOCK;
    const stop = v.getUint32(at+4,true)*BLOCK;
    if (!start && !stop) continue;
    if (stop <= start || stop > blob.size) {unsupported++;continue;}
    const fs = 0x400 + i*0x200;
    const enc = head[fs+4], fileSystem = head[fs+2], hashType = head[fs+3];
    const patch = number(v,fs+0x100) || number(v,fs+0x120);
    const sparse = number(v,fs+0x150);
    const compressed = number(v,fs+0x180);
    if (enc !== 1) {locked++; continue;}
    if (patch || sparse || compressed) {unsupported++; continue;}
    if (![1,2].includes(fileSystem) || ![0,1,2,5].includes(hashType)) {
      unsupported++;continue; // RomFS needs its own filesystem parser.
    }
    const rel = [2,5].includes(hashType) ? number(v,fs+0x40) : 0;
    if (rel >= stop-start) {unsupported++;continue;}
    try {
      const data = await readIndex(blob,start+rel,stop-start-rel,'PFS0',
        entry.name + '/section-' + i + '/');
      entries.push(...data.entries.map(r=>({
        ...r,
        kind:'plaintext-nca-file',
        getBlob:()=>entry.getBlob().slice(r.offset,r.offset+r.size),
        getBytes:()=>entry.getBlob().slice(r.offset,r.offset+r.size).arrayBuffer()
      })));
      readable++;
    } catch (_) {unsupported++;}
  }
  return {entries,status:readable ? 'partial-plaintext' : locked ? 'locked' : 'unsupported',
    locked,unsupported,readable};
}
export async function openGamePackage(file,{scanPlainNCAs=true,keys=null,onProgress=()=>{}}={}) {
  if (!file || typeof file.slice !== 'function') throw Error('Select a local package File');
  const title = file.name || 'Game package';
  const initial = await bytes(file,0,Math.min(0x200,file.size),'package signature');
  let entries, container, headerBytes;
  if (decoder.decode(initial.subarray(0,4)) === 'PFS0') {
    const parsed = await readIndex(file,0,file.size,'PFS0');
    entries=parsed.entries; headerBytes=parsed.headerBytes;
    container = title.toLowerCase().endsWith('.nsz') ? 'NSZ / PFS0' : 'NSP / PFS0';
  } else if (file.size >= 0x200 &&
             decoder.decode(initial.subarray(0x100,0x104)) === 'HEAD') {
    const v = new DataView(initial.buffer);
    const rootOffset = number(v,0x130);
    if (rootOffset < 0x200 || rootOffset >= file.size) throw Error('Invalid XCI root location');
    const root = await readIndex(file,rootOffset,file.size-rootOffset,'HFS0');
    entries=[];headerBytes=root.headerBytes; container='XCI / HFS0';
    for (const part of root.entries) {
      if (!['secure','normal','update','logo'].includes(part.originalName)) {
        entries.push(part);
        continue;
      }
      const sub=await readIndex(file,part.offset,part.size,'HFS0',part.name+'/');
      entries.push(...sub.entries);
    }
  } else {
    throw Error('Unrecognized NSP/NSZ PFS0 or XCI HFS0 package. Use the extracted folder for other formats.');
  }
  const originals = entries.length;
  const warnings = [];
  if (scanPlainNCAs) {
    const list=entries.filter(e=>/\.nca$/i.test(e.name));
    for (let i=0;i<list.length;i++) {
      const item=list[i];
      try {
        const decoded=await parseNcaWithKeys(item,keys);
        entries.push(...decoded.entries.map(row=>({
          ...row, category:assetCategory(row.name)
        })));
        item.ncaStatus=decoded.status;
        if (decoded.entries.length) warnings.push(item.name + ': ' + decoded.entries.length + ' decrypted/readable NCA files');
        if(decoded.reason)warnings.push(item.name+': '+decoded.reason);
      } catch(e) {
        item.ncaStatus='unavailable';
        warnings.push(item.name + ': ' + e.message);
      }
      if (i%8===0 || i===list.length-1) onProgress(i+1,list.length,entries.length);
    }
  }
  const locked=entries.filter(e=>e.ncaStatus==='locked').length;
  if (locked) warnings.push(locked + ' encrypted or unreadable NCA(s) still require compatible local keys; their locked contents were NOT scanned.');
  if (entries.some(e=>/\.ncz$/i.test(e.name))) warnings.push('NCZ compressed payload decoding is not supported by this browser reader.');
  return {name:title,type:container,headerBytes,entries,originals,warnings};
}
export function openExtractedFolder(files) {
  const source=Array.from(files||[]);
  if (!source.length) throw Error('Choose an extracted game folder');
  const entries=source.map(file=>row(
    String(file.webkitRelativePath||file.name).replaceAll('\\','/'),file,0,file.size,
    {kind:'extracted'}));
  return {name:'Extracted game folder',type:'Local files',entries,
    originals:entries.length,headerBytes:0,warnings:[]};
}
export function exportIndex(packageInfo) {
  return {
    source:packageInfo.name,format:packageInfo.type,files:packageInfo.originals,
    scannedEntries:packageInfo.entries.length,warnings:packageInfo.warnings,
    entries:packageInfo.entries.map(({name,size,offset,category,kind,ncaStatus})=>
      ({name,size,offset,category,kind,...(ncaStatus?{ncaStatus}: {})}))
  };
}
