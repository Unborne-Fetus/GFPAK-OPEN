import JSZip from 'jszip';
import {speciesToken} from './animation-association.js';

export const EXPORT_MANIFEST = 'gfpak-pokemon-export.json';
export const EXPORT_MODEL = 'pokedex3d/regular.glb';

export function pokemonExportMetadata(selected, sourceGame, glb) {
  sourceGame = sourceGame === 'pla' ? 'la' : sourceGame;
  if (!['lgpe','swsh','la','sv','za','bdsp'].includes(sourceGame))
    throw new Error('Choose the source game before exporting a Pokémon for Pokédex 3D Max.');
  const view = new DataView(glb);
  if (view.byteLength < 20 || view.getUint32(0,true) !== 0x46546c67 ||
      view.getUint32(4,true) !== 2 || view.getUint32(8,true) !== view.byteLength ||
      view.getUint32(16,true) !== 0x4e4f534a || view.getUint32(12,true) > view.byteLength-20)
    throw new Error('Converted Pokémon model is not a valid GLB.');
  const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(glb,20,view.getUint32(12,true))));
  if (!doc.meshes?.length) throw new Error('Converted Pokémon model has no meshes.');
  return {
    format:'gfpak-pokemon-export', version:1,
    selectedModel:selected, sourceGame, convertedModel:EXPORT_MODEL,
    animations:(doc.animations || []).map(clip=>clip.name || ''),
  };
}

export async function exportPokemonZip(project,selected, options = {}) {
  if(!project?.items?.length) throw new Error('No source assets available for export');
  const family=speciesToken(selected), zip=new JSZip(), used=new Set();
  for(const item of project.items) {
    const other=speciesToken(item.path);
    if(family && other && other!==family) continue;
    const path=String(item.path).replaceAll('\\','/');
    if(path.startsWith('/') || path.split('/').some(part=>part==='..') || /^[a-z]:/i.test(path))
      throw new Error('Unsafe export path: '+item.path);
    // Re-exporting a previously exported ZIP replaces generated bridge files.
    if ([EXPORT_MANIFEST,EXPORT_MODEL].includes(path.toLowerCase())) continue;
    if(used.has(path.toLowerCase())) throw new Error('Duplicate export path: '+path);
    used.add(path.toLowerCase());
    zip.file(path,await item.getBytes());
  }
  if (options.glb) {
    const metadata = pokemonExportMetadata(selected,options.sourceGame,options.glb);
    zip.file(EXPORT_MODEL,options.glb);
    zip.file(EXPORT_MANIFEST,JSON.stringify(metadata,null,2));
  }
  return zip.generateAsync({type:'blob',compression:'DEFLATE'});
}
