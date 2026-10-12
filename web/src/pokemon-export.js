import JSZip from 'jszip';
import {speciesToken} from './animation-association.js';

// Shared with Pokédex 3D Max's import_gfpak_zip.py. The original resources are
// always retained: a compatible GLB is an optional additional export.
export async function exportPokemonZip(project, selected, options = {}) {
  if (!project?.items?.length) throw new Error('No source assets available for export');
  const family = speciesToken(selected), zip = new JSZip(), used = new Set();
  for (const item of project.items) {
    const other = speciesToken(item.path);
    if (family && other && other !== family) continue;
    const path = String(item.path).replaceAll('\\', '/');
    if (path.startsWith('/') || path.split('/').some(part => part === '..') || /^[a-z]:/i.test(path))
      throw new Error('Unsafe export path: ' + item.path);
    if (used.has(path.toLowerCase())) throw new Error('Duplicate export path: ' + path);
    used.add(path.toLowerCase());
    zip.file(path, await item.getBytes());
  }
  const convertedPath = options.glb ? 'pokedex3d/regular.glb' : null;
  const manifestPath = 'gfpak-pokemon-export.json';
  for (const path of [manifestPath, convertedPath].filter(Boolean)) {
    if (used.has(path.toLowerCase())) throw new Error('Reserved export path already exists: ' + path);
  }
  if (convertedPath) {
    const view = new Uint8Array(options.glb instanceof ArrayBuffer ? options.glb : options.glb.buffer ?? options.glb);
    if (view.byteLength < 20 || new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0, true) !== 0x46546c67)
      throw new Error('Converted model is not a valid GLB');
    zip.file(convertedPath, view);
  }
  zip.file(manifestPath, JSON.stringify({
    format: 'gfpak-pokemon-export',
    version: 1,
    sourceGame: options.sourceGame || 'auto',
    selectedModel: selected,
    convertedModel: convertedPath,
    conversion: convertedPath ? 'glb-included' : 'original-assets-only'
  }, null, 2));
  return zip.generateAsync({type: 'blob', compression: 'DEFLATE'});
}
