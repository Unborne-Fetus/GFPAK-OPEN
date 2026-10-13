/**
 * Pokédex 3D Max's versioned GFPAK interchange contract.
 *
 * Raw Asset ZIP is intentionally separate: this exporter produces a ZIP only
 * if it contains genuine converted geometry, embedded textures and an idle
 * animation that Pokédex 3D Max can use. A 3D preview is never necessary.
 */
import {loadModel,exportGlb} from './model.js';
import {exportPokemonZip,EXPORT_MANIFEST,EXPORT_MODEL,pokemonExportMetadata} from './pokemon-export.js';

export const POKEDEX_GAMES = Object.freeze(['lgpe','swsh','bdsp','la','sv','za']);
export const POKEDEX_ZIP_MAX = 512 * 1024 * 1024;
export const POKEDEX_GLB_MAX = 256 * 1024 * 1024;
export const POKEDEX_GL_B_MIN = 1025;
export const COMPATIBLE_MODEL_SUFFIXES = /\.(glb|gltf|fbx|obj|dae|trmdl|gfbmdl|trmsh)$/i;

const badIdle = /attack|damage|faint|death|down|bind|t[-_ ]?pose/i;
const goodIdle = /idle|wait|stand|breath|rest|fight[_ -]?a/i;
const utf8 = new TextDecoder();
function dataBuffer(data) {
  if(data instanceof ArrayBuffer)return data;
  if(ArrayBuffer.isView(data))return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
  throw Error('Converted model must be an ArrayBuffer or typed array');
}
export function normalizeExportGame(value) {
  return value==='pla'?'la':String(value||'').toLowerCase();
}
export function modelIdentityFromPath(path) {
  const normalized=String(path||'').replaceAll('\\','/');
  const matches=[...normalized.matchAll(/(?:^|[^a-z0-9])pm(\d{4})(?!\d)/ig)];
  const ids=new Set(matches.map(match=>match[1]));
  if(ids.size!==1)
    throw Error('Pokédex import requires a model path with one unambiguous pm#### Pokémon ID.');
  return {modelId:Number([...ids][0]),selectedModel:normalized};
}
export function validatePokedexGlb(raw) {
  const glb=dataBuffer(raw);
  if(glb.byteLength<POKEDEX_GL_B_MIN||glb.byteLength>POKEDEX_GLB_MAX)
    throw Error('Pokédex model GLB must be larger than 1 KiB and smaller than 256 MiB.');
  const view=new DataView(glb);
  if(view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||
     view.getUint32(8,true)!==glb.byteLength||
     view.getUint32(16,true)!==0x4e4f534a)
    throw Error('Converted file is not a valid GLB v2 with an embedded JSON chunk.');
  const len=view.getUint32(12,true);
  if(len<=0||len>glb.byteLength-20||len>32*1024*1024)
    throw Error('GLB model metadata is missing or unexpectedly large.');
  let doc;
  try{doc=JSON.parse(utf8.decode(new Uint8Array(glb,20,len)));}
  catch{throw Error('Could not parse converted GLB scene metadata.');}
  if(!doc.meshes?.length||!doc.nodes?.length)
    throw Error('Converted GLB has no model geometry or scene nodes.');
  if(!doc.images?.length||!doc.textures?.length)
    throw Error('Converted GLB lacks embedded texture images. Export not compatible with Pokédex 3D Max.');
  for(const tex of doc.textures) {
    const index=tex?.source;
    if(!Number.isInteger(index)||index<0||index>=doc.images.length ||
       !Number.isInteger(doc.images[index]?.bufferView))
      throw Error('GLB texture is external or not linked to an embedded image.');
  }
  if(!doc.materials?.some(mat=>mat?.pbrMetallicRoughness?.baseColorTexture &&
      Number.isInteger(mat.pbrMetallicRoughness.baseColorTexture.index)))
    throw Error('Converted GLB has no base-color texture material.');
  const clips=(doc.animations||[]).filter(clip=>
    Array.isArray(clip?.channels)&&clip.channels.length&&
    Array.isArray(clip?.samplers)&&clip.samplers.length)
    .map((clip,index)=>clip.name||'animation_'+index);
  const idle=clips.find(name=>goodIdle.test(name)&&!badIdle.test(name));
  if(!idle)
    throw Error('No verified idle animation in converted GLB. Original animations must decode before exporting for Pokédex 3D Max.');
  return {animations:clips,idle,meshCount:doc.meshes.length,textureCount:doc.textures.length};
}
export function compatibleProjectItems(model,assets) {
  // Paths are already relative to the selected game root. Reject ZIP slips and
  // accidental shadowing of the official converter/manifest paths.
  const used=new Set(),out=[];
  for(const item of assets) {
    const path=String(item.path||'').replaceAll('\\','/');
    if(!path||path.startsWith('/')||/^[a-z]:/i.test(path)||
       path.split('/').some(p=>p==='..'||p==='.'||!p))
      throw Error('Unsafe or incomplete asset path: '+path);
    const key=path.toLowerCase();
    if(key===EXPORT_MANIFEST||key===EXPORT_MODEL)continue;
    if(used.has(key))throw Error('Conflicting original asset filename: '+path);
    if(typeof item.getBytes!=='function')throw Error('Asset is missing a byte reader: '+path);
    used.add(key);out.push(item);
  }
  if(!out.some(item=>item.path===model))
    throw Error('Selected model was not included in the original asset bundle.');
  return out;
}
export async function buildPokedexZip(project,selectedModel,sourceGame,progress=()=>{},options={}) {
  modelIdentityFromPath(selectedModel);
  const game=normalizeExportGame(sourceGame);
  if(!POKEDEX_GAMES.includes(game))
    throw Error('Select the Pokémon source game (Let’s Go, Sword/Shield, BDSP, PLA, SV or Z-A) before exporting.');
  const items=compatibleProjectItems(selectedModel,project?.items||[]);
  const rawBytes=items.reduce((sum,item)=>sum+Number(item.size||0),0);
  if(rawBytes>POKEDEX_ZIP_MAX-16*1024*1024)
    throw Error('Original asset set is too large for the Pokédex 3D Max browser ZIP importer (512 MiB).');
  const verifiedProject={...project,items,
    models:project?.models?.length?project.models:items.filter(i=>COMPATIBLE_MODEL_SUFFIXES.test(i.path))};
  let glb=options.glb?dataBuffer(options.glb):null;
  let loaded=null;
  try {
    if(!glb){
      const sourceItem=items.find(item=>item.path===selectedModel);
      if(!sourceItem||!COMPATIBLE_MODEL_SUFFIXES.test(selectedModel))
        throw Error('Choose a supported model file, not a raw package or mesh companion.');
      if(/\.glb$/i.test(selectedModel)){
        progress('Checking the original GLB without rendering…');
        glb=dataBuffer(await sourceItem.getBytes());
      }else{
        progress('Decoding original meshes and associated assets without opening a preview…');
        loaded=await loadModel(verifiedProject,selectedModel,message=>progress(message),{fastPreview:false});
        if(loaded.postLoad) {
          progress('Importing native textures, skeleton and animation companions…');
          await loaded.postLoad();
        }
        progress('Building a textured, animated GLB in memory…');
        glb=await exportGlb(loaded.root,loaded.animations);
      }
    }
    const report=validatePokedexGlb(glb);
    const metadata=pokemonExportMetadata(selectedModel,game,glb);
    if(metadata.convertedModel!==EXPORT_MODEL)
      throw Error('Converter manifest does not match Pokédex 3D Max v1 importer.');
    progress('Packaging original assets, verified GLB and Pokédex metadata…');
    const zip=await exportPokemonZip(verifiedProject,selectedModel,{glb,sourceGame:game});
    if(zip.size>POKEDEX_ZIP_MAX)
      throw Error('Final ZIP exceeds the 512 MiB Pokédex 3D Max importer limit.');
    return {blob:zip,metadata,report,memberCount:items.length+2};
  }finally {
    loaded?.disposeAssets?.();
  }
}
