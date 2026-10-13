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
