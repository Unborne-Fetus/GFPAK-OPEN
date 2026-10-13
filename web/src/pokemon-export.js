import JSZip from 'jszip';
import {speciesToken} from './animation-association.js';

export async function exportPokemonZip(project,selected) {
  if(!project?.items?.length) throw new Error('No source assets available for export');
  const family=speciesToken(selected), zip=new JSZip(), used=new Set();
  for(const item of project.items) {
    const other=speciesToken(item.path);
    if(family && other && other!==family) continue;
    const path=String(item.path).replaceAll('\\','/');
    if(path.startsWith('/') || path.split('/').some(part=>part==='..') || /^[a-z]:/i.test(path))
      throw new Error('Unsafe export path: '+item.path);
    if(used.has(path.toLowerCase())) throw new Error('Duplicate export path: '+path);
    used.add(path.toLowerCase());
    zip.file(path,await item.getBytes());
  }
  return zip.generateAsync({type:'blob',compression:'DEFLATE'});
}
