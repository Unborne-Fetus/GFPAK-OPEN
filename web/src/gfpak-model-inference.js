/** Port of desktop model_discovery.py: recover common native resource suffixes
 * from independently matching FNV-1a 64 suffix hashes.
 * Alias labels are NOT authoritative original filenames; a supplied hash
 * dictionary always wins. No Pokémon identity or format is guessed from an ID.
 */
const MASK=(1n<<64n)-1n;
const INV_PRIME=0xce965057aff6957bn;
const EXTENSIONS=['.trmdl','.trmsh','.trmbf','.trmtr','.trskl',
  '.trmmt','.bntx','.dds','.tranm','.gfbanm','.trtex'];
const PRIMARY=['.trmdl','.trmsh','.trmbf'];
function unwindSuffix(hex,suffix) {
  let value;
  try{value=BigInt('0x'+hex);}catch{return null;}
  for(let i=suffix.length-1;i>=0;i--){
    value=((value*INV_PRIME)&MASK)^BigInt(suffix.charCodeAt(i));
  }
  return value.toString(16);
}
function groups(resources,field) {
  const byStem=new Map();
  for(const resource of resources) {
    const hash=resource[field];
    if(!/^[a-f0-9]{16}$/i.test(hash||''))continue;
    for(const extension of EXTENSIONS) {
      const key=unwindSuffix(hash,extension);
      let group=byStem.get(key);
      if(!group){group=new Map();byStem.set(key,group);}
      if(!group.has(extension))group.set(extension,resource);
      else group.set(extension,null); // multiple hits are not evidence
    }
  }
  return [...byStem.values()].filter(group=>PRIMARY.every(ext=>group.get(ext)));
}
/** Return Map<resource index, inferred alias> for confidently linked trios. */
export function inferGfpakModelNames(resources,filename='model.gfpak') {
  const archive=filename.replaceAll('\\','/').split('/').at(-1)
    .replace(/\.gfpak$/i,'').replace(/[^a-z0-9_-]/gi,'_')||'model';
  const found=groups(resources,'pathHash');
  if(!found.length)found.push(...groups(resources,'fileHash'));
  found.sort((a,b)=>b.size-a.size||
    a.get('.trmdl').index-b.get('.trmdl').index);
  const result=new Map();
  for(let i=0;i<found.length;i++){
    const base=i?archive+'_model'+(i+1):archive;
    for(const [ext,resource] of found[i]){
      if(resource && !result.has(resource.index))
        result.set(resource.index,base+ext);
    }
  }
  return result;
}

const REFERENCE=/[A-Za-z0-9_][A-Za-z0-9_./-]{2,190}\.(?:trmdl|trmsh|trmbf|trmtr|trskl|trmmt|tranm|gfbanm|gfbmdl|tracn|tracp|tracr|tracs|tracm|traef|tracl|tralk|trslp|trtex|bntx|png|dds|tga|jpeg|jpg|webp)/gi;
const DESCRIPTOR=/\.(trmdl|trmsh|trmtr|trskl|gfbmdl)$/i;
const BASIS=[0xcbf29ce484222325n,0xcbf29ce484222645n];
function fnv64(value,seed) {
  let hash=seed;
  for(const byte of new TextEncoder().encode(value))
    hash=((hash^BigInt(byte))*0x100000001b3n)&MASK;
  return hash.toString(16).padStart(16,'0');
}
/**
 * Port desktop resource_discovery.py: reveal exact companion filenames only
 * after an embedded native FlatBuffer reference matches a GFPAK hash.
 * Decodes at most 24 MiB of previously discovered descriptor files. Oodle
 * and corrupted descriptors remain unknown rather than wrongly named.
 */
export async function discoverGfpakReferenceNames(archive,initial,readResource){
  const names=new Map(initial), hashOwners=new Map();
  for(const resource of archive.resources){
    for(const hash of [resource.pathHash,resource.fileHash]){
      if(!hash)continue;
      let indices=hashOwners.get(hash);
      if(!indices){indices=new Set();hashOwners.set(hash,indices);}
      indices.add(resource.index);
    }
  }
  const queue=archive.resources.filter(res=>
    DESCRIPTOR.test(names.get(res.index)||'')).map(res=>res.index);
  const seen=new Set();
  let budget=24*1024*1024;
  while(queue.length&&seen.size<96&&budget>0){
    const index=queue.shift();
    if(seen.has(index))continue;
    seen.add(index);
    const res=archive.resources[index];
    if(!res||res.size>8*1024*1024||res.size>budget)continue;
    budget-=res.size;
    let raw;
    try{raw=await readResource(res);}
    catch{continue;}
    const bytes=raw instanceof Blob?new Uint8Array(await raw.arrayBuffer()):
      raw instanceof Uint8Array?raw:new Uint8Array(raw);
    const content=new TextDecoder('latin1').decode(bytes);
    const references=new Set(content.match(REFERENCE)||[]);
    for(const reference of references){
      const path=reference.replaceAll('\\','/');
      const parts=path.split('/');
      if(parts.some(p=>!p||p==='.'||p==='..')||parts.length>32)continue;
      const basename=parts.at(-1);
      const matches=new Set();
      for(const spelling of new Set([path,basename]))for(const seed of BASIS){
        const hash=fnv64(spelling,seed);
        for(const owner of hashOwners.get(hash)||[])matches.add(owner);
      }
      if(matches.size!==1)continue;
      const owner=[...matches][0];
      const previous=names.get(owner)||'';
      // Proven original filenames beat hash-suffix aliases; no duplicate paths.
      if(previous===path)continue;
      if([...names.entries()].some(([id,name])=>id!==owner&&name.toLowerCase()===path.toLowerCase()))
        continue;
      names.set(owner,path);
      if(DESCRIPTOR.test(path)&&!seen.has(owner))queue.push(owner);
    }
  }
  return names;
}
