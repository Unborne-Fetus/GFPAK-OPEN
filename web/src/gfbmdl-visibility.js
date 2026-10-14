/**
 * Sword/Shield / Let's Go GFBANM skin-visibility channels.
 * GF visibility is stored in root slot 3 (SkinAnimation), not in a
 * separate Trinity TRACM file. The byte arrays are packed boolean bits.
 */
import { FlatModelReader } from './gfbmdl.js';

export function parseGfbmdlVisibility(bytes) {
  const reader = new FlatModelReader(bytes);
  const root = reader.table(reader.root());
  const obj = (parent, slot) => {
    const field = parent && reader.field(parent, slot);
    return field ? reader.table(reader.pointer(field)) : null;
  };
  const info = obj(root, 0);
  const skin = obj(root, 3);
  if (!skin) return {frameCount: 0, frameRate: 30, channels: []};
  const frameCount = info ? reader.uint(info, 1) : 0;
  const frameRate = info ? reader.uint(info, 2) || 30 : 30;
  if (frameCount > 120000 || frameRate > 1000)
    throw new Error('GFBANM visibility frame count/rate exceeds safety limits');
  const channels = [];
  for (const track of reader.objects(skin, 0, 4096)) {
    const name = reader.string(track, 0);
    const slot = reader.field(track, 1);
    const type = slot ? reader.u8(slot) : 0;
    const data = obj(track, 2);
    if (!name || !data || !type) continue;
    let frames = [], values = [];
    if (type === 1) {
      const at = reader.field(data, 0);
      frames = [0];
      values = [!!(at && reader.u8(at))];
    } else if ([2, 3, 4].includes(type)) {
      const valuesInfo = reader.vector(data, type === 2 ? 0 : 1, 1);
      if (!valuesInfo || valuesInfo.count > 15000)
        throw new Error('GFBANM has invalid packed visibility values');
      if (type === 2) {
        if (!frameCount) throw new Error('Dense visibility needs a frame count');
        frames = Array.from({length: frameCount}, (_, i) => i);
      } else {
        const width = type === 3 ? 2 : 1;
        const keys = reader.vector(data, 0, width);
        if (!keys || keys.count > 120000)
          throw new Error('GFBANM has invalid visibility frame keys');
        frames = Array.from({length: keys.count}, (_, i) =>
          width === 2 ? reader.u16(keys.start + i * 2) : reader.u8(keys.start + i));
      }
      if (valuesInfo.count !== Math.ceil(frames.length / 8))
        throw new Error('GFBANM packed visibility size does not match its frames');
      values = frames.map((_, i) => !!(reader.u8(valuesInfo.start + (i >> 3)) & (1 << (i & 7))));
    } else {
      // Later titles may add track variants; preserve the rest of the model.
      continue;
    }
    if (frames.length && values.length)
      channels.push({name, frames, values});
  }
  return {frameCount, frameRate, channels};
}

export function applyGfbmdlRestVisibility(root, channels) {
  const visibility = new Map(channels.filter(c => c.frames?.[0] === 0)
    .map(c => [c.name.toLowerCase(), !!c.values[0]]));
  let applied = 0;
  root.traverse(object => {
    if (!object.isMesh) return;
    const name = object.name.toLowerCase();
    if (!visibility.has(name)) return;
    // GLB has no standard mesh-visibility animation channel. Encoding the
    // authored show/hide state as an instantaneous node scale preserves it
    // in both the browser preview and exported, animated glTF files.
    object.scale.setScalar(visibility.get(name) ? 1 : 0);
    object.userData.nativeIdleVisibility = true;
    applied++;
  });
  return applied;
}
