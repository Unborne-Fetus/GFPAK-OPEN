/**
 * Optional, desktop-only effect-motion preview.
 *
 * These are clearly labelled visual approximations for *already decoded*
 * effect materials, not a replacement for the original Switch GPU shaders.
 * No arbitrary particles or textures are fabricated. In particular, motion
 * is never applied to ordinary body/eye materials just because a Pokémon has
 * a flame/smoke companion in the same archive.
 */
const PRESETS = Object.freeze([
  {name:'fire', test:/(?:firecore|flame|ember|fire[_ -])/i, u:0.035, v:0.32, pulse:0.18},
  {name:'smoke', test:/(?:smoke|fog|mist|vapor|vapour|gas(?:[_ -]|$)|steam)/i,
    u:0.03, v:0.08, pulse:0},
  {name:'electricity', test:/(?:electric|spark|lightning|thunder)/i,
    u:0.08, v:0.06, pulse:0.32},
  {name:'energy', test:/(?:aura|glow|energy|pulse|beam)/i,
    u:0.02, v:0.06, pulse:0.12},
  {name:'water', test:/(?:bubble|splash|spray|waterfall)/i,
    u:0.02, v:0.09, pulse:0},
  {name:'ice', test:/(?:frost|snow|blizzard|ice[_ -])/i,
    u:0.015, v:0.025, pulse:0.06}
]);

export function previewEffectKind(material) {
  if (!material || material.colorWrite === false || material.visible === false ||
      !material.map?.isTexture) return '';
  const shader = material.userData?.gfpakNativeShader || '';
  // Native shader metadata is stronger than the shared texture name. A body
  // atlas can reuse a flame palette without being a flame material itself.
  // FireMask is a depth/silhouette-only pass and must never be animated.
  if (/PokeFireMaskShader/i.test(shader)) return '';
  const labels = [shader, material.name || ''].join(' ');
  const explicit = PRESETS.find(preset => preset.test.test(labels))?.name;
  if (explicit) return explicit;
  // A shared texture's label is never sufficient evidence that this
  // material itself is an effect. Require the material or native shader.
  return '';
}

export class DesktopEffectPreview {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.root = null;
    this.enabled = false;
    this.speed = 1;
    this.intensity = 0.75;
    this.items = [];
    this.frame = 0;
    this.epoch = 0;
    this.tick = this.tick.bind(this);
  }

  attach(root) {
    this.stop();
    this.root = root || null;
    this.refresh();
  }

  setEnabled(enabled) {
    const next = !!enabled;
    if (next === this.enabled) return;
    this.enabled = next;
    this.refresh();
  }

  setSpeed(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.speed = Math.min(3, Math.max(0.1, number));
  }

  setIntensity(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.intensity = Math.min(1, Math.max(0, number));
  }

  refresh() {
    this.stop();
    if (!this.root) {
      this.onStatus({count:0, types:[], enabled:this.enabled});
      return;
    }
    const counts = new Map();
    const materials = new Set();
    this.root.traverse(object => {
      if (!object.isMesh) return;
      for (const material of Array.isArray(object.material) ?
        object.material : [object.material]) {
        if (!material || materials.has(material)) continue;
        materials.add(material);
        const kind = previewEffectKind(material);
        if (!kind) continue;
        counts.set(kind, (counts.get(kind) || 0) + 1);
        if (!this.enabled) continue;
        const preset = PRESETS.find(item => item.name === kind);
        const originalMap = material.map;
        // Clone the *texture wrapper*, not the image. Only the recognized
        // material receives animated UVs, even when the body shares an atlas.
        const map = originalMap.clone();
        map.needsUpdate = true;
        const item = {
          material, map, originalMap, preset,
          originalEmission: material.emissiveIntensity,
          originalEmissiveMap: material.emissiveMap,
          originalTransparent: material.transparent,
          originalDepthWrite: material.depthWrite,
          originalOpacity: material.opacity,
          startU: map.offset.x, startV: map.offset.y,
        };
        material.map = map;
        if (material.emissiveMap === originalMap) material.emissiveMap = map;
        // Preserve the native alpha channel; do not add procedural blobs or
        // make nontransparent parts of a texture disappear.
        if (kind === 'smoke' && material.transparent)
          material.depthWrite = false;
        material.needsUpdate = true;
        this.items.push(item);
      }
    });
    this.onStatus({
      count:[...counts.values()].reduce((a,b) => a+b,0),
      types:[...counts.keys()],
      enabled:this.enabled,
    });
    if (this.enabled && this.items.length) {
      this.epoch = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  tick(now) {
    if (!this.enabled || !this.root) return;
    if (!document.hidden) {
      const seconds = Math.min((now - this.epoch) / 1000, 3600) * this.speed;
      for (const entry of this.items) {
        const factor = this.intensity;
        entry.map.offset.set(
          entry.startU + seconds * entry.preset.u * factor,
          entry.startV - seconds * entry.preset.v * factor);
        // Only pulse emissive surfaces. Do not turn opaque body textures
        // into lights or overwrite source-game emission colors.
        if (entry.originalEmissiveMap && entry.preset.pulse)
          entry.material.emissiveIntensity = entry.originalEmission *
            (1 + Math.sin(seconds * 6) * entry.preset.pulse * factor);
      }
    }
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const entry of this.items) {
      const material = entry.material;
      material.map = entry.originalMap;
      material.emissiveMap = entry.originalEmissiveMap;
      material.emissiveIntensity = entry.originalEmission;
      material.transparent = entry.originalTransparent;
      material.depthWrite = entry.originalDepthWrite;
      material.opacity = entry.originalOpacity;
      material.needsUpdate = true;
      entry.map.dispose();
    }
    this.items = [];
  }

  dispose() {
    this.stop();
    this.root = null;
    this.enabled = false;
  }
}
