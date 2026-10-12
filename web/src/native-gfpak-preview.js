/**
 * Browser-native GFPAK model discovery for PLA/SV/Z-A and GFBMDL games.
 * Names in GFPAKs are hashes: probe strict FlatBuffers structures only where
 * filename hashes cannot be resolved, and read only bounded resource slices.
 * This is a decoder, not a substitute/cube for unknown game geometry.
 */
import {parseGfpakFile, extractResourceAsync, resolvedName, fnv1a64} from './gfpak.js';
import {parseTrmdl,parseTrmsh,parseTrmbf,parseTrskl,parseTrmtr} from './trinity.js';
import {parseNativeAnimation} from './trinity-animation.js';
import {parseBntx} from './bntx.js';
import {decodeGfbmdl} from './gfbmdl.js';

const PROBE_LIMIT=64*1024*1024;
// A split Pokémon can span a dozen GFPAKs; stopping at 1800 probes can miss meshes.
const MAX_PROBES=8192;
const ALLOWED=new Set(['.trmdl','.trmsh','.trmbf','.trskl','.trmtr','.bntx','.dds','.png','.jpg','.jpeg','.webp','.tranm','.gfbanm','.gfbmdl','.tracm']);
const decoder=new TextDecoder();
const ext=name=>'.'+name.split('/').at(-1).split('.').at(-1).toLowerCase();
const normalize=name=>String(name||'').replaceAll('\\','/').replace(/^\/+/,'').toLowerCase();
const unique=(values)=>[...new Set(values.filter(Boolean))];

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
function identifyAuxiliary(buffer) {
  const bytes=new Uint8Array(buffer);
  if(bytes.length>=4){
    const head=String.fromCharCode(...bytes.subarray(0,4));
    if(head==='BNTX')return 'bntx';
    if(head==='DDS ')return 'dds';
    if(head==='\x89PNG')return 'png';
    if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'jpg';
    if(head==='RIFF' && bytes.length>=12 &&
      String.fromCharCode(...bytes.subarray(8,12))==='WEBP')return 'webp';
  }
  try{
    const animation=parseNativeAnimation(buffer,'probed.tranm');
    if(animation.tracks?.length)return 'tranm';
  }catch(_){}
  return '';
}
function identifyTrinity(buffer){
  // FlatBuffers have no resource magic. TRSKL and TRMTR can both look like
  // TRMDL if only the shared string-vector slot is tested. Verify their
  // distinguishing structure *before* selecting a model descriptor.
  try {
    const rig=parseTrskl(buffer);
    if(plausibleRig(rig))return 'trskl';
  }catch(_){}
  try {
    const mats=parseTrmtr(buffer);
    if(mats.materials?.some(m=>m.name &&
      (m.textures?.length || m.shaders?.length ||
       Object.keys(m.colors||{}).length || Object.keys(m.scalars||{}).length)))
      return 'trmtr';
  }catch(_){}
  try {
    const meshes=parseTrmsh(buffer);
    if(meshes.bufferFile && meshes.meshes?.some(m=>
      m.declarations?.length && m.parts?.length))return 'trmsh';
  }catch(_){}
  try {
    if(hasGeometry(buffer))return 'trmbf';
  }catch(_){}
  try {
    const model=parseTrmdl(buffer);
    if(model.meshFiles?.length)return 'trmdl';
  }catch(_){}
  return '';
}
function identifyNativeModel(buffer){
  const trinity=identifyTrinity(buffer);
  if(trinity)return trinity;
  // GFBMDL also uses FlatBuffers but has no reliable magic bytes. Validate
  // its actual vertex/index geometry instead of relying on a hash dictionary.
  try{
    const model=decodeGfbmdl(buffer);
    if(model.stats?.meshCount>0 && model.stats.triangleCount>0)return 'gfbmdl';
  }catch(_){}
  return '';
}
function referenceHashes(reference,containerName,kind=''){
  const filename=normalize(reference);
  const folder=normalize(containerName).split('/').slice(0,-1).join('/');
  const expanded=kind && !filename.endsWith('.'+kind)?[filename+'.'+kind,filename]:[filename];
  const candidates=unique(expanded.flatMap(value=>[
    value,
    value.split('/').at(-1),
    folder?folder+'/'+value:'',
    folder?folder+'/'+value.split('/').at(-1):'',
    value.startsWith('bin/')?value:'bin/'+value
  ]));
  const hashes=new Set();
  for(const name of candidates) for(const candidate of [name,name.toLowerCase()])hashes.add(fnv1a64(candidate));
  return hashes;
}
function matchByHash(rows,reference,containerName,kind){
  const hashes=referenceHashes(reference,containerName,kind);
  return rows.filter(row=>hashes.has(row.resource.pathHash) || hashes.has(row.resource.fileHash));
}
function pathFor(row,stem='pokemon'){
  if(row.known)return row.known;
  const base=(row.sourceArchive||stem).replace(/\.gfpak$/i,'').split('/').at(-1).replace(/[^a-z0-9_-]/gi,'_')||'pokemon';
  return 'recovered/'+base+'/resource_'+String(row.resource.index).padStart(4,'0')+'.'+row.kind;
}
function assignRef(row,kind,reference,base) {
  const name=normalize(reference);
  if(!name)return;
  const basename=name.split('/').at(-1);
  const alias=basename.endsWith('.'+kind)?basename:basename+'.'+kind;
  // Preserve descriptor-to-resource identity even when a hash dictionary
  // supplies a *different* canonical filename for this companion.
  row.nativeAliases=unique([...(row.nativeAliases||[]),alias,name]);
  if(!row.known)row.inferred='recovered/'+base+'/'+alias;
}
async function chooseResource(rows,kind,reference,archiveName,report,read,context=null){
  let filtered=rows.filter(row=>row.kind===kind);
  // A filename hash doesn't necessarily reveal the file extension. A native
  // descriptor has the real reference, so retry unknown members by parsing
  // the required target format before declaring the model incomplete.
  if(kind==='trmbf'&&!filtered.length){
    for(const row of rows.filter(row=>!row.known || ext(row.known)==='.trmbf')){
      if(row.resource.size>PROBE_LIMIT)continue;
      try{
        if(hasGeometry(await read(row))){row.kind='trmbf';filtered.push(row);}
      }catch(_){}
    }
  }
  if(!filtered.length && (kind==='trskl'||kind==='trmtr')){
    for(const row of rows.filter(row=>!row.known || ext(row.known)==='.'+kind)){
      if(row.resource.size>PROBE_LIMIT)continue;
      try{
        const bytes=await read(row);
        const data=kind==='trskl'?parseTrskl(bytes):parseTrmtr(bytes);
        if(kind==='trskl'?data.bones?.length:data.materials?.length){
          row.kind=kind;filtered.push(row);
        }
      }catch(_){}
    }
  }
  const direct=filtered.filter(row=>normalize(row.known)===normalize(reference) ||
    normalize(row.known).endsWith('/'+normalize(reference)));
  const hashed=matchByHash(filtered,reference,archiveName,kind);
  const resolved=unique([...direct,...hashed]);
  if(resolved.length===1)return resolved[0];
  if(resolved.length>1)throw Error('Multiple '+kind+' resources match '+reference);
  const baseName=normalize(reference).split('/').at(-1);
  const byName=filtered.filter(row=>normalize(row.known).split('/').at(-1)===baseName);
  if(byName.length===1)return byName[0];
  if(filtered.length===1)return filtered[0];
  if(!filtered.length)throw Error('Missing '+kind+' file '+reference+' inside this GFPAK');
  // Trinity's real PLA descriptors commonly refer to "head", "body", etc.
  // without extensions, while GFPAK filenames are hashes. When the hashes
  // cannot resolve, preserve a consistent one-to-one association in the
  // model's declared order instead of hard-failing every Pokémon.
  const assignments=context?.assignments;
  if(assignments){
    const refKey=kind+':'+normalize(reference);
    if(assignments.has(refKey))return assignments.get(refKey);
    const unused=filtered.filter(row=>!context.used.has(row));
    const pool=unused.length?unused:filtered;
    const index=context.referenceOrder?.indexOf(normalize(reference))??-1;
    const candidate=pool.slice().sort((a,b)=>a.resource.index-b.resource.index)[
      index>=0 && pool.length===context.referenceOrder.length ? index : 0
    ];
    if(candidate){
      assignments.set(refKey,candidate);context.used.add(candidate);
      report('Matched ambiguous '+kind+' reference "'+reference+'" to archive resource #'+
        candidate.resource.index+' using stable resource order ('+filtered.length+
        ' candidates; hash identity unavailable).');
      return candidate;
    }
  }
  throw Error('Cannot resolve '+kind+' '+reference+' among '+filtered.length+' resources.');
}
/**
 * FlatBuffers tables for TRMDL and TRSKL share a vector-of-names slot, so an
 * unknown hashed rig can be initially identified as a model descriptor. Check
 * rig hierarchy rather than trusting the first shallow parse result.
 */
function plausibleRig(data){
  const bones=data?.bones;
  if(!Array.isArray(bones)||!bones.length||bones.length>3000)return false;
  if(bones.some((b,i)=>!b.name||b.parent===i||
    b.parent>=bones.length||b.parent< -1||!b.translation?.every(Number.isFinite)))return false;
  const hierarchy=bones.some(b=>b.parent>=0);
  const jointed=bones.some(b=>b.jointInfoIndex>=0)||data.joints?.length>0;
  return hierarchy||jointed||
    (bones.length===1 && /^(?:root|root_joint|rootnode|joint_0|bone_0)$/i.test(bones[0].name));
}
const materialToken=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
function textureVariantName(name){
  const value=String(name||'').replaceAll('\\','/').split('/').pop().toLowerCase();
  if(/(?:^|[_\-.])(shiny|rare|col(?:or)?[ _-]?0?1|s1)(?:$|[_\-.])/.test(value))
    return 'shiny';
  if(/(?:^|[_\-.])(normal|regular|default|col(?:or)?[ _-]?0?0|s0)(?:$|[_\-.])/.test(value))
    return 'regular';
  return 'regular';
}
function textureVariant(path,names=[]){
  // A hashed container filename carries no color information. Prefer the
  // actual BNTX surface names, or an explicitly marked archive filename.
  const values=names.length?names:[path];
  const hasShiny=values.some(value=>textureVariantName(value)==='shiny');
  const hasRegular=values.some(value=>textureVariantName(value)!=='shiny');
  return hasShiny&&hasRegular?'mixed':hasShiny?'shiny':'regular';
}
async function recoverUnreferencedCompanions(rows,required,materialNames,read,report){
  // A model with no rig pointer still frequently has one valid TRSKL member.
  if(![...required].some(row=>row.kind==='trskl')){
    const rigs=[];
    for(const row of rows){
      if(required.has(row)||row.resource.size>PROBE_LIMIT||
        ['tranm','gfbanm','bntx','dds','png','jpg','webp','trmsh','trmbf'].includes(row.kind))continue;
      try{
        const data=parseTrskl(await read(row));
        if(plausibleRig(data))rigs.push({row,count:data.bones.length});
      }catch(_){}
    }
    if(rigs.length===1){
      const {row,count}=rigs[0];
      row.kind='trskl';
      required.add(row);
      report('Recovered '+count+' TRSKL bones from resource #'+row.resource.index+
        ': skeleton existed but its name was hashed or absent from TRMDL.');
    }else if(rigs.length>1)report('Found '+rigs.length+
      ' candidate skeletons but none uniquely linked; avoiding an incorrect rig.');
    else report('No structurally valid TRSKL found inside this GFPAK.');
  }
  const existingMaterials=[...required].some(row=>row.kind==='trmtr');
  if(!existingMaterials){
    const candidates=[];
    for(const row of rows){
      if(required.has(row)||row.resource.size>PROBE_LIMIT ||
        ['tranm','gfbanm','bntx','dds','png','jpg','webp','trmsh','trmbf','trskl'].includes(row.kind))continue;
      try{
        const data=parseTrmtr(await read(row));
        if(!data.materials?.length)continue;
        const overlap=data.materials.filter(m=>materialNames.has(materialToken(m.name))).length;
        const detailed=data.materials.some(m=>m.textures?.length||m.shaders?.length||
          Object.keys(m.colors||{}).length);
        if(overlap>0||(detailed&&data.materials.length>0))
          candidates.push({row,overlap,detailed});
      }catch(_){}
    }
    const matches=candidates.filter(x=>x.overlap>0);
    const chosen=matches.length?matches:candidates.length===1?candidates:[];
    for(const {row,overlap} of chosen){
      row.kind='trmtr';required.add(row);
      report('Recovered TRMTR materials from resource #'+row.resource.index+
        (overlap?' ('+overlap+' named mesh material matches).':'.'));
    }
    if(!chosen.length)report('No reliably linked TRMTR material resources found.');
  }
}
/** Prepare a genuine directly-renderable Trinity project from any readable GFPAK. */
export async function prepareGfpakModelPreview(blob,filename,report=()=>{},dictionary=null,supplements=[]) {
  const archive=await parseGfpakFile(blob,filename);
  // A model's TRMSH/TRMBF can be packed separately. Only explicitly supplied
  // same-Pokémon GFPAKs may contribute dependencies; no cross-species search.
  const archives=[archive];
  for(const entry of supplements){
    if(!entry?.blob || !entry.filename)continue;
    archives.push(await parseGfpakFile(entry.blob,entry.filename));
  }
  const rows=archives.flatMap(source=>source.resources
    .filter(resource=>[0,2,3].includes(resource.compression))
    .map(resource=>({
      resource,archive:source,sourceArchive:source.filename,
      known:resolvedName(resource,dictionary)||'',
      kind:'',buffer:null,parsed:null,inferred:''
    })));
  if(!rows.length){
    throw Error('No supported GFPAK compression codecs found (expected stored, LZ4 or Oodle).');
  }
  const stem=filename.replace(/\.gfpak$/i,'').split('/').at(-1);
  const read=async row=>{
    if(!row.buffer){
      const raw=await extractResourceAsync(row.archive,row.resource);
      row.buffer=await peekData(raw);
    }
    return row.buffer;
  };
  let probed=0,unreadable=0,decoded=0,skippedLarge=0,skippedLimit=0;
  let firstReadError='';
  for(const row of rows){
    const knownType=ext(row.known);
    if(ALLOWED.has(knownType)){row.kind=knownType.slice(1);continue;}
    if(row.kind)continue;
    if(row.resource.size>PROBE_LIMIT){skippedLarge++;continue;}
    if(probed>=MAX_PROBES){skippedLimit++;continue;}
    probed++;
    try{
      const bytes=await read(row);
      decoded++;
      const type=identifyAuxiliary(bytes)||identifyNativeModel(bytes);
      if(type) row.kind=type;
      else row.buffer=null; // Never retain thousands of unrelated decoded assets.
    }catch(error){
      unreadable++;
      if(!firstReadError)firstReadError=String(error?.message||error);
      row.buffer=null;
    }
    if(probed % 32===0){
      report('Checked '+probed+' GFPAK resources for genuine Trinity models…');
      // WASM decompression is synchronous once initialized: yield a frame
      // regularly so the browser remains responsive on larger archives.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  const models=rows.filter(row=>['trmdl','trmsh','gfbmdl'].includes(row.kind));
  if(!models.length){
    const unknownCodecs=archives.reduce((sum,source)=>sum+source.resources.length,0)-rows.length;
    const summary=probed+' unnamed resources probed, '+decoded+' successfully extracted, '+
      unreadable+' failed extraction, '+skippedLarge+' above the '+
      (PROBE_LIMIT/1048576)+' MiB probe limit, '+skippedLimit+
      ' beyond the scan limit, '+unknownCodecs+' with unsupported compression.';
    report('No model identified: '+summary);
    if(firstReadError)report('First resource extraction error: '+firstReadError);
    if(unreadable===probed && probed>0){
      throw Error('GFPAK preview cannot read its model resources. All '+probed+
        ' extraction attempts failed (the compression code being recognized does not '+
        'mean decompression succeeded). First error: '+firstReadError+'.');
    }
    throw Error('No supported TRMDL/TRMSH/GFBMDL model was identified in this GFPAK. '+
      summary+(firstReadError?' First extraction error: '+firstReadError+'.':'')+
      ' A filename-hash dictionary can identify resources, but cannot repair '+
      'failed decompression or unsupported model layouts.');
  }
  const primary=models.filter(row=>row.archive===archive);
  const preferred=primary.length?primary:models;
  let root=preferred.find(row=>row.kind==='trmdl')||
    preferred.find(row=>row.kind==='gfbmdl')||preferred[0];
  const required=new Set([root]);
  const context={assignments:new Map(),used:new Set(),referenceOrder:[]};
  const meshMaterialNames=new Set();
  if(root.kind==='trmdl'){
    const meta=parseTrmdl(await read(root));
    context.referenceOrder=meta.meshFiles.map(normalize);
    for(const name of meta.meshFiles){
      const shape=await chooseResource(rows,'trmsh',name,filename,report,read,context);
      const meshes=parseTrmsh(await read(shape));
      for(const mesh of meshes.meshes||[])for(const part of mesh.parts||[])
        if(part.material)meshMaterialNames.add(materialToken(part.material));
      assignRef(shape,'trmsh',name,stem);
      required.add(shape);
      const buffer=await chooseResource(rows,'trmbf',meshes.bufferFile,filename,report,read,context);
      assignRef(buffer,'trmbf',meshes.bufferFile,stem);
      required.add(buffer);
    }
    for(const [kind,names] of [
      ['trskl',meta.skeleton?[meta.skeleton]:[]],
      ['trmtr',meta.materials||[]]
    ])for(const name of names){
      try{
        const match=await chooseResource(rows,kind,name,filename,report,read,context);
        assignRef(match,kind,name,stem);required.add(match);
      }catch(e){report(e.message);}
    }
  }else if(root.kind==='trmsh'){
    const mesh=parseTrmsh(await read(root));
    for(const shape of mesh.meshes||[])for(const part of shape.parts||[])
      if(part.material)meshMaterialNames.add(materialToken(part.material));
    const buffer=await chooseResource(rows,'trmbf',mesh.bufferFile,filename,report,read,context);
    assignRef(buffer,'trmbf',mesh.bufferFile,stem);required.add(buffer);
  }
  await recoverUnreferencedCompanions(rows,required,meshMaterialNames,read,report);
  for(const row of rows)if(['trskl','trmtr','bntx','dds','png','jpg','jpeg','webp','tranm','gfbanm','tracm'].includes(row.kind))
    required.add(row);
  // Unambiguous fallback works even when a PLA GFPAK has no dictionary:
  // recovered companion names are the references found in the actual model.
  const items=[];
  for(const row of required){
    const path=row.known||row.inferred||pathFor(row,stem);
    let textureNames=[];
    if(row.kind==='bntx')try{
      textureNames=parseBntx(await read(row)).textures.map(t=>t.name).filter(Boolean);
    }catch(_){}
    const linkedKind=['bntx','dds','png','jpg','jpeg','webp'].includes(row.kind)?'texture':
      ['tranm','gfbanm'].includes(row.kind)?'animation':undefined;
    items.push({
      path,size:row.resource.size,textureNames,
      sourceArchive:row.sourceArchive, nativeAliases:row.nativeAliases||[],
      getBytes:()=>read(row),
      getText:async()=>decoder.decode(await read(row)),
      linkedKind,
      textureVariant: linkedKind==='texture'?textureVariant(path,textureNames):undefined
    });
  }
  const original=items.find(item=>
    item.path===(root.known||root.inferred||pathFor(root,stem)));
  report('Found '+models.length+' model descriptor(s) and '+items.length+
    ' genuine render resources in '+filename+
    (unreadable?' ('+unreadable+' failed probes)':'')+'.');
  return {project:{label:filename,items},selected:original.path,archive};
}


/** Read real texture/animation/skeleton resources from other GFPAKs for the
 * same Pokémon. No placeholder textures/clips or cross-species guessing.
 */
export async function prepareGfpakCompanions(blob,filename,report=()=>{}) {
  const archive=await parseGfpakFile(blob,filename);
  const list=[];
  let count=0;
  for(const resource of archive.resources){
    if(![0,2,3].includes(resource.compression) ||
      resource.size>PROBE_LIMIT || ++count>MAX_PROBES)continue;
    let type='',bytes;
    try{
      const raw=await extractResourceAsync(archive,resource);
      bytes=await peekData(raw);
      type=identifyAuxiliary(bytes);
      if(!type){
        const detected=identifyTrinity(bytes);
        if(detected==='trskl'||detected==='trmtr')type=detected;
      }
    }catch(error){continue;}
    if(!['bntx','dds','png','jpg','webp','tranm','trskl','trmtr'].includes(type))continue;
    const name='companions/'+filename.replace(/[^a-z0-9_-]/gi,'_')+
      '/resource_'+resource.index+'.'+type;
    let textureNames=[];
    if(type==='bntx')try{textureNames=parseBntx(bytes).textures.map(t=>t.name).filter(Boolean);}catch(_){}
    const linkedKind=['bntx','dds','png','jpg','webp'].includes(type)?'texture':
      type==='tranm'?'animation':undefined;
    list.push({
      path:name,size:resource.size,textureNames,sourceArchive:filename,
      getBytes:async()=>bytes,
      getText:async()=>new TextDecoder().decode(bytes),
      linkedKind,
      textureVariant: linkedKind==='texture'?textureVariant(name,textureNames):undefined,
    });
  }
  report('Found '+list.length+' actual texture/animation companion resources in '+filename);
  return list;
}
