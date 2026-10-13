/**
 * Desktop asset_matching.py semantics for browser-file nodes.
 * Scores filename evidence instead of assigning every nearby resource to
 * arbitrary Pokémon. Anonymous GFPAK resources are retained as originals but
 * never mislabelled as an animation or a texture.
 */
const TYPES=new Set(['mesh','skeleton','material','texture','animation','unknown','other','model']);
function lower(value){return String(value||'').replaceAll('\\','/').toLowerCase();}
function stem(name){return lower(name).replace(/\.[^/.]+$/,'');}
function token(value){
  return lower(value).match(/(?:^|[/_.-])(pm\d{4})(?=$|[/_.-])/)?.[1]||'';
}
function parentName(node){return lower(node.parent?.path||'');}
function nearestArchive(node){
  for(let p=node;p;p=p.parent)if(['gfpak','zip'].includes(p.kind))return p;
  return null;
}
function candidateScope(node){
  return nearestArchive(node)?.path||node.parent?.path||'';
}
export function browserModelAssetMatches(selected,all) {
  if(!selected)return [];
  const models=all.filter(row=>row.category==='model'&&row.kind!=='gfpak');
  const modelScope=candidateScope(selected);
  const modelDir=parentName(selected),modelStem=stem(selected.name);
  const modelFamily=token(selected.path);
  const sameDirModels=models.filter(item=>parentName(item)===modelDir).length;
  const sameArchiveModels=models.filter(item=>
    nearestArchive(item)===nearestArchive(selected) &&
    nearestArchive(item)!==null).length;
  const sameScope=(a,b)=>candidateScope(a)===candidateScope(b);
  const matches=[selected];
  for(const item of all){
    if(item===selected||item.children!==null||(!item.source&&!item.lazySource)||
       !TYPES.has(item.category))continue;
    const candidateToken=token(item.path);
    if(modelFamily && candidateToken && candidateToken!==modelFamily)continue;
    const itemDir=parentName(item),itemStem=stem(item.name);
    const sameDirectory=itemDir===modelDir;
    const sameContainer=sameScope(selected,item);
    let score=0;
    if(modelStem && itemStem===modelStem && sameContainer)score=100;
    else if(modelFamily&&candidateToken===modelFamily)
      score=sameContainer?(sameDirectory?90:78):70;
    else if(sameDirectory && sameContainer &&
      (itemStem.startsWith(modelStem+'_')||modelStem.startsWith(itemStem+'_')))
      score=85;
    else if(sameDirectory&&sameContainer&&sameDirModels===1)score=65;
    else if(nearestArchive(selected)&&nearestArchive(item)===nearestArchive(selected)&&
      sameArchiveModels===1)score=65;
    // Linked assets with no species and no exclusive parent cannot be proven.
    if(!score)continue;
    if(score===65 && sameDirModels>1 && sameArchiveModels>1)continue;
    if(score>=65)matches.push(item);
  }
  return matches.sort((a,b)=>a===selected?-1:b===selected?1:
    (['mesh','skeleton','material','texture','animation'].indexOf(a.category)-
     ['mesh','skeleton','material','texture','animation'].indexOf(b.category)) ||
     a.path.localeCompare(b.path));
}
export function relativeBrowserAssetPath(node,root){
  const prefix=root.path+'/';
  if(!node.path.startsWith(prefix))
    throw Error('Model asset is outside the selected source');
  return node.path.slice(prefix.length);
}
export function browserNativeProject(selected,matched,root,ensureSource) {
  const selectedPath=relativeBrowserAssetPath(selected,root);
  const result=[];
  const paths=new Set();
  for(const item of matched){
    const path=relativeBrowserAssetPath(item,root);
    if(paths.has(path.toLowerCase()))throw Error('Model asset paths collide: '+path);
    paths.add(path.toLowerCase());
    let pending=null;
    const readBytes=async()=>{
      if(!pending){
        pending=(async()=>{
          const source=await ensureSource(item);
          if(!source.size||source.size>256*1024*1024)
            throw Error('Resource exceeds browser 256 MiB decoder limit: '+path);
          const bytes=await source.read(0,source.size);
          return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
        })();
      }
      return pending;
    };
    result.push({
      path,size:item.size,
      linkedKind:item===selected?'model':item.category,
      matchConfidence:item===selected?'verified':undefined,
      getBytes:readBytes,
      getText:async()=>new TextDecoder().decode(await readBytes())
    });
  }
  return {
    project:{label:root.name,items:result,
      models:result.filter(row=>/\.(trmdl|trmsh|gfbmdl|glb|gltf|fbx|obj|dae)$/i.test(row.path))},
    selected:selectedPath
  };
}
