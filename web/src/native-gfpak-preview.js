/**
 * Browser-native GFPAK model discovery for PLA/SV/Z-A and GFBMDL games.
 * Names in GFPAKs are hashes: probe strict FlatBuffers structures only where
 * filename hashes cannot be resolved, and read only bounded resource slices.
 * This is a decoder, not a substitute/cube for unknown game geometry.
 */
import {parseGfpakFile, extractResourceAsync, resolvedName, fnv1a64} from './gfpak.js';
import {parseTrmdl,parseTrmsh,parseTrmbf,parseTrskl,parseTrmtr} from './trinity.js';

const PROBE_LIMIT=20*1024*1024;
const MAX_PROBES=1800;
const ALLOWED=new Set(['.trmdl','.trmsh','.trmbf','.trskl','.trmtr','.bntx','.dds','.png','.jpg','.jpeg','.webp','.tranm','.gfbanm','.gfbmdl','.tracm']);
const decoder=new TextDecoder();
const ext=name=>'.'+name.split('/').at(-1).split('.').at(-1).toLowerCase();
const normalize=name=>String(name||'').replaceAll('\\','/').replace(/^\/+/,'').toLowerCase();
const unique=(values)=>[...new Set(values.filter(Boolean))];
const probeOrder=['trmdl','trmsh','trmbf','trskl','trmtr'];
function peekData(raw) {
  if(raw instanceof Blob)return raw.arrayBuffer();
  if(raw instanceof ArrayBuffer)return raw;
  if(ArrayBuffer.isView(raw))return raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
  throw Error('Invalid GFPAK resource');
}
function hasGeometry(buffer){
  const info=parseTrmbf(buffer);
  return Boolean(info?.buffers?.some(part =>
    part.vertexBuffers?.some(b=>b.byteLength>=12) &&
    part.indexBuffers?.some(b=>b.byteLength>=2)));
}
function identifyTrinity(buffer){
  for(const kind of probeOrder){
    try{
      const data=kind==='trmdl'?parseTrmdl(buffer):
        kind==='trmsh'?parseTrmsh(buffer):
        kind==='trmbf'?hasGeometry(buffer):
        kind==='trskl'?parseTrskl(buffer):parseTrmtr(buffer);
      if(kind==='trmdl' && data.meshFiles?.length)return kind;
      if(kind==='trmsh' && data.meshes?.length && data.bufferFile)return kind;
      if(kind==='trmbf' && data)return kind;
      if(kind==='trskl' && data.bones?.length)return kind;
      if(kind==='trmtr' && data.materials?.length)return kind;
    }catch(_){}
  }
  return '';
}
function referenceHashes(reference,containerName){
  const filename=normalize(reference);
  const folder=normalize(containerName).split('/').slice(0,-1).join('/');
  const candidates=unique([
    filename,
    filename.split('/').at(-1),
    folder?folder+'/'+filename:'',
    folder?folder+'/'+filename.split('/').at(-1):'',
    filename.startsWith('bin/')?filename:'bin/'+filename
  ]);
  const hashes=new Set();
  for(const name of candidates) for(const candidate of [name,name.toLowerCase()])hashes.add(fnv1a64(candidate));
  return hashes;
}
function matchByHash(rows,reference,containerName){
  const hashes=referenceHashes(reference,containerName);
  return rows.filter(row=>hashes.has(row.resource.pathHash) || hashes.has(row.resource.fileHash));
}
function pathFor(row,stem='pokemon'){
  if(row.known)return row.known;
  const base=stem.replace(/\.gfpak$/i,'').split('/').at(-1).replace(/[^a-z0-9_-]/gi,'_')||'pokemon';
  return 'recovered/'+base+'/resource_'+String(row.resource.index).padStart(4,'0')+'.'+row.kind;
}
function assignRef(row,kind,reference,base) {
  const name=normalize(reference);
  if(name && ext(name)==='.'+kind){
    if(!row.known)row.inferred='recovered/'+base+'/'+name.split('/').at(-1);
  }
}
async function chooseResource(rows,kind,reference,archiveName,report,read){
  let filtered=rows.filter(row=>row.kind===kind);
  // A filename hash doesn't necessarily reveal the file extension. A native
  // descriptor has the real reference, so retry unknown members by parsing
  // the required target format before declaring the model incomplete.
  if(kind==='trmbf'&&!filtered.length){
    for(const row of rows.filter(row=>!row.kind||row.kind==='trmsh')){
      if(row.resource.size>PROBE_LIMIT)continue;
      try{
        if(hasGeometry(await read(row))){row.kind='trmbf';filtered.push(row);}
      }catch(_){}
    }
  }
  const direct=filtered.filter(row=>normalize(row.known)===normalize(reference) ||
    normalize(row.known).endsWith('/'+normalize(reference)));
  const hashed=matchByHash(filtered,reference,archiveName);
  const resolved=unique([...direct,...hashed]);
  if(resolved.length===1)return resolved[0];
  if(resolved.length>1)throw Error('Multiple '+kind+' resources match '+reference);
  const baseName=normalize(reference).split('/').at(-1);
  const byName=filtered.filter(row=>normalize(row.known).split('/').at(-1)===baseName);
  if(byName.length===1)return byName[0];
  if(filtered.length===1)return filtered[0];
  if(!filtered.length)throw Error('Missing '+kind+' file '+reference+' inside this GFPAK');
  throw Error('Unable to distinguish '+filtered.length+' '+kind+' resources for '+reference+
    ' without a matching filename-hash dictionary.');
}
/** Prepare a genuine directly-renderable Trinity project from any readable GFPAK. */
export async function prepareGfpakModelPreview(blob,filename,report=()=>{},dictionary=null) {
  const archive=await parseGfpakFile(blob,filename);
  const uncompressed=archive.resources.filter(row=>[0,2].includes(row.compression));
  if(!uncompressed.length){
    throw Error('All '+archive.count+' resources use unsupported compression; PLA GFPAK Oodle resources need a browser Oodle decoder.');
  }
  const rows=uncompressed.map(resource=>({
    resource,known:resolvedName(resource,dictionary)||'',
    kind:'',buffer:null,parsed:null,inferred:''
  }));
  const stem=filename.replace(/\.gfpak$/i,'').split('/').at(-1);
  const read=async row=>{
    if(!row.buffer){
      const raw=await extractResourceAsync(archive,row.resource);
      row.buffer=await peekData(raw);
    }
    return row.buffer;
  };
  let probed=0,unreadable=0;
  for(const row of rows){
    const knownType=ext(row.known);
    if(ALLOWED.has(knownType)){row.kind=knownType.slice(1);continue;}
    if(row.kind)continue;
    if(row.resource.size>PROBE_LIMIT || probed++>=MAX_PROBES)continue;
    try{
      const bytes=await read(row);
      const type=identifyTrinity(bytes);
      if(type) row.kind=type;
    }catch(_){unreadable++;}
  }
  const models=rows.filter(row=>['trmdl','trmsh','gfbmdl'].includes(row.kind));
  if(!models.length){
    throw Error('No supported TRMDL/TRMSH/GFBMDL model could be decoded in this GFPAK. '+
      (archive.resources.length-rows.length)+' compressed resources are unsupported; '+
      'native model resources may need a hash dictionary.');
  }
  let root=models.find(row=>row.kind==='trmdl')||models.find(row=>row.kind==='gfbmdl')||models[0];
  const required=new Set([root]);
  if(root.kind==='trmdl'){
    const meta=parseTrmdl(await read(root));
    for(const name of meta.meshFiles){
      const shape=await chooseResource(rows,'trmsh',name,filename,report,read);
      const meshes=parseTrmsh(await read(shape));
      assignRef(shape,'trmsh',name,stem);
      required.add(shape);
      const buffer=await chooseResource(rows,'trmbf',meshes.bufferFile,filename,report,read);
      assignRef(buffer,'trmbf',meshes.bufferFile,stem);
      required.add(buffer);
    }
    for(const [kind,names] of [
      ['trskl',meta.skeleton?[meta.skeleton]:[]],
      ['trmtr',meta.materials||[]]
    ])for(const name of names){
      try{
        const match=await chooseResource(rows,kind,name,filename,report,read);
        assignRef(match,kind,name,stem);required.add(match);
      }catch(e){report(e.message);}
    }
  }else if(root.kind==='trmsh'){
    const mesh=parseTrmsh(await read(root));
    const buffer=await chooseResource(rows,'trmbf',mesh.bufferFile,filename,report,read);
    assignRef(buffer,'trmbf',mesh.bufferFile,stem);required.add(buffer);
  }
  for(const row of rows)if(['trskl','trmtr','bntx','dds','png','jpg','jpeg','webp','tranm','gfbanm','tracm'].includes(row.kind))
    required.add(row);
  // Unambiguous fallback works even when a PLA GFPAK has no dictionary:
  // recovered companion names are the references found in the actual model.
  const items=[...required].map(row=>{
    const path=row.known||row.inferred||pathFor(row,stem);
    return {
      path,
      size:row.resource.size,
      getBytes:()=>read(row),
      getText:async()=>decoder.decode(await read(row)),
      linkedKind:row.kind==='bntx'?'texture':undefined
    };
  });
  const original=items.find(item=>
    item.path===(root.known||root.inferred||pathFor(root,stem)));
  report('Found '+models.length+' model descriptor(s) and '+items.length+
    ' genuine render resources in '+filename+
    (unreadable?' ('+unreadable+' failed probes)':'')+'.');
  return {project:{label:filename,items},selected:original.path,archive};
}
