/** Choose likely Pokémon animation companions from large extracted game folders.
 *
 * This ranks real files; it never fabricates clips or claims a decoded track.
 * Selected assets still pass through the format-specific animation decoder and
 * are included only when their actual skeleton tracks match loaded bones.
 */
const NATIVE_ANIMS = new Set(['.tranm', '.gfbanm']);

export function speciesToken(path) {
  const value = String(path).replaceAll('\\', '/').toLowerCase();
  return value.match(/(?:^|[/_.-])(pm\d{4})(?=$|[/_.-])/)?.[1] || '';
}

function fileExtension(path) {
  const clean = String(path).toLowerCase();
  const index = clean.lastIndexOf('.');
  return index < 0 ? '' : clean.slice(index);
}

export function selectNativeAnimations(items, selectedModel, limit = 64) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128)
    throw new RangeError('Animation selection limit out of range');
  const sourcePath = String(selectedModel).replaceAll('\\', '/').toLowerCase();
  const sourceDirectory = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
  const sourceParent = sourceDirectory.replace(/[^/]+\/$/, '');
  const sourceSpecies = speciesToken(sourcePath);
  const rows = [];
  for (const item of items) {
    const path = String(item.path || '').replaceAll('\\', '/').toLowerCase();
    if (!NATIVE_ANIMS.has(fileExtension(path))) continue;
    const candidateSpecies = speciesToken(path);
    // Never misapply an animation explicitly belonging to another Pokémon.
    if (sourceSpecies && candidateSpecies && sourceSpecies !== candidateSpecies) continue;
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    let score = 0;
    if (sourceSpecies && candidateSpecies === sourceSpecies) score += 200;
    if (sourceDirectory && dir === sourceDirectory) score += 90;
    else if (sourceDirectory && (dir.startsWith(sourceDirectory) ||
                                  sourceDirectory.startsWith(dir))) score += 50;
    else if (sourceParent && dir.startsWith(sourceParent)) score += 35;
    if (/\b(idle|wait|walk|run|attack|battle|motion)\b/.test(path.replace(/[_./-]/g, ' ')))
      score += 3;
    if (sourceSpecies && !candidateSpecies && score < 35) continue;
    if (!sourceSpecies && score === 0 && items.length > 96) continue;
    if (item.size > 64 * 1024 * 1024) continue;
    rows.push({item, score, path});
  }
  rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return rows.slice(0, limit).map(row => row.item);
}
