/**
 * Resolve companion Trinity model files and construct Three.js meshes.
 * This path requires a readable .trmdl/.trmsh with the matching .trmbf.
 *
 * Original Pokémon game shader permutations and BNTX texture decoding are
 * separate; decoded PNGs/JPEGs may be provided alongside the model.
 */
import * as THREE from 'three';
import {
  TrinityError, parseTrmdl, parseTrmsh, parseTrmbf,
  parseTrmtr, parseTrskl, decodeTrinityMeshes
} from './trinity.js';

const MAX_BYTES = 450 * 1024 * 1024;
const TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function normalized(s) {
  const stack = [];
  for (const item of String(s).replaceAll('\\', '/').replace(/^([a-z]:)?\//i, '').split('/')) {
    if (item === '..') stack.pop();
    else if (item && item !== '.') stack.push(item.toLowerCase());
  }
  return stack.join('/');
}

function dirname(s) { const path = normalized(s); return path.slice(0, path.lastIndexOf('/') + 1); }
function basename(s) { return normalized(s).split('/').at(-1); }
function ext(s) { return '.' + basename(s).split('.').at(-1).toLowerCase(); }
function stem(s) { return basename(s).replace(/\.[^.]+$/, ''); }

function findResource(project, ref, basePath, suffix, required = true) {
  const list = project.items ?? [];
  const rawRef = String(ref || '').replaceAll('\\', '/');
  const sourceRef = normalized(rawRef);
  const filename = basename(sourceRef);
  const expected = suffix || (filename.includes('.') ? ext(filename) : '');
  let candidates = list.filter(item => expected ? ext(item.path) === expected : true);
  if (!filename && !expected) {
    if (required) throw new TrinityError('Missing Trinity model resource filename');
    return null;
  }
  const baseDir = dirname(basePath);
  const normalizedRef = normalized(baseDir + rawRef);
  const exact = candidates.filter(item =>
    normalized(item.path) === normalizedRef || normalized(item.path) === sourceRef);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new TrinityError('Ambiguous companion model path: ' + ref);
  if (filename) candidates = candidates.filter(item => basename(item.path) === filename);
  if (!filename && expected) {
    const expectedStem = stem(basePath);
    const matching = candidates.filter(item => stem(item.path) === expectedStem);
    if (matching.length) candidates = matching;
  }
  if (candidates.length === 1) return candidates[0];
  const local = candidates.filter(item => dirname(item.path) === baseDir);
  if (local.length === 1) return local[0];
  if (required) throw new TrinityError(candidates.length > 1
    ? 'Several files match ' + (ref || expected) + '; put matching Trinity companion files in the same folder.'
    : 'Missing ' + (ref || expected) + ' companion file. Import the complete model folder or ZIP.');
  return null;
}

async function bytesFor(item) {
  const original = await item.getBytes();
  const data = original instanceof ArrayBuffer ? original
    : ArrayBuffer.isView(original)
      ? original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength)
      : null;
  if (!data || data.byteLength <= 4 || data.byteLength > MAX_BYTES) {
    throw new TrinityError('Invalid size for ' + item.path);
  }
  return data;
}

function findOptionalTexture(project, name, parentPath) {
  if (!name) return null;
  const candidate = basename(name).replace(/\.(bntx|bntx\.gz|dds|ktx2)$/i, '');
  if (!candidate) return null;
  const nearby = project.items.filter(item => TEXTURE_EXT.has(ext(item.path)) &&
    (stem(item.path) === candidate || basename(item.path).startsWith(candidate + '.')));
  const nearest = nearby.filter(item => dirname(item.path) === dirname(parentPath));
  return (nearest.length === 1 ? nearest[0] : nearby.length === 1 ? nearby[0] : null);
}

function createMaterials(materials) {
  const lookup = new Map();
  for (const definition of materials) {
    for (const info of definition.materials) {
      const mat = new THREE.MeshStandardMaterial({
        name: info.name || 'Trinity material',
        color: 0xd9e0e7, side: THREE.DoubleSide,
        roughness: 0.8, metalness: 0.0
      });
      lookup.set(info.name.toLowerCase(), { material: mat, textures: info.textures });
    }
  }
  return lookup;
}

async function applyDecodedTextures(project, lookup, modelPath, report, created) {
  const channels = [
    { names: /^(basecolormap|basemap|diffusemap|albedomap|color0map)$/i, property: 'map', srgb: true },
    { names: /^normalmap\d*$/i, property: 'normalMap', srgb: false },
    { names: /^roughnessmap\d*$/i, property: 'roughnessMap', srgb: false },
    { names: /^metallicmap\d*$/i, property: 'metalnessMap', srgb: false },
    { names: /^aomap$/i, property: 'aoMap', srgb: false },
    { names: /^(emissivemap|emissionmap)$/i, property: 'emissiveMap', srgb: true },
  ];
  const imageCache = new Map();
  for (const [materialName, definition] of lookup.entries()) {
    const textures = definition.textures ?? [];
    if (!textures.length) continue;
    for (const channel of channels) {
      const reference = textures.find(t => channel.names.test(t.name));
      const selected = reference || (channel.property === 'map' && textures.length === 1 ? textures[0] : null);
      if (!selected) continue;
      const textureItem = findOptionalTexture(project, selected.file, modelPath);
      if (!textureItem) {
        report('No decoded image for ' + selected.file + ' (' + materialName + ')');
        continue;
      }
      try {
        let bitmap = imageCache.get(textureItem.path);
        if (!bitmap) {
          bitmap = await createImageBitmap(new Blob([await textureItem.getBytes()]));
          imageCache.set(textureItem.path, bitmap);
        }
        const texture = new THREE.Texture(bitmap);
        texture.name = selected.name || channel.property;
        texture.colorSpace = channel.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.flipY = true;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.needsUpdate = true;
        const material = definition.material;
        material[channel.property] = texture;
        if (channel.property === 'map') material.color.setRGB(1, 1, 1);
        if (channel.property === 'emissiveMap') material.emissive.setRGB(1, 1, 1);
        material.needsUpdate = true;
        created.push(texture);
      } catch (error) {
        report('Could not decode texture ' + textureItem.path + ': ' + error.message);
      }
    }
  }
  return Array.from(imageCache.values());
}

function buildBones(trskl, sceneRoot) {
  if (!trskl?.bones?.length) return null;
  const bones = trskl.bones.map(info => {
    const bone = new THREE.Bone();
    bone.name = info.name;
    bone.position.fromArray(info.translation);
    bone.rotation.set(...info.rotation, 'XYZ');
    bone.scale.fromArray(info.scale);
    return bone;
  });
  for (let index = 0; index < trskl.bones.length; index++) {
    const info = trskl.bones[index];
    if (info.parent >= 0 && info.parent < bones.length && info.parent !== index) {
      bones[info.parent].add(bones[index]);
    } else {
      sceneRoot.add(bones[index]);
    }
  }
  sceneRoot.updateMatrixWorld(true);
  const rig = new THREE.Skeleton(bones);
  rig.calculateInverses();
  return { bones, rig };
}

function makeMesh(part, material, skeletonInfo) {
  const vertices = part.vertices;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices.position, 3));
  if (vertices.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(vertices.normal, 3));
  if (vertices.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(vertices.uv, 2));
  if (vertices.color?.length === vertices.count * 4) {
    geometry.setAttribute('color', new THREE.BufferAttribute(vertices.color, 4));
    material.vertexColors = true;
  }
  geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
  if (!vertices.normal) geometry.computeVertexNormals();
  const skel = skeletonInfo?.rig;
  if (skel && vertices.joints && vertices.weights &&
      vertices.joints.length === vertices.count * 4 &&
      vertices.weights.length === vertices.count * 4) {
    const joints = new Uint16Array(vertices.joints.length);
    const weights = new Float32Array(vertices.weights.length);
    let rigged = false;
    for (let i = 0; i < vertices.count; i++) {
      let total = 0;
      for (let j = 0; j < 4; j++) {
        const idx = i * 4 + j;
        const local = Math.round(vertices.joints[idx]);
        const remap = part.boneWeights?.[local]?.rigIndex;
        const actual = Number.isInteger(remap) && remap >= 0 ? remap : local;
        const weight = vertices.weights[idx];
        if (actual >= 0 && actual < skel.bones.length && weight > 0) {
          joints[idx] = actual;
          weights[idx] = weight;
          total += weight;
        }
      }
      if (total > 0) {
        rigged = true;
        for (let j = 0; j < 4; j++) weights[i * 4 + j] /= total;
      }
    }
    if (rigged) {
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
      const mesh = new THREE.SkinnedMesh(geometry, material);
      mesh.name = part.name + (part.material ? ':' + part.material : '');
      mesh.bind(skel);
      mesh.frustumCulled = false;
      return mesh;
    }
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = part.name + (part.material ? ':' + part.material : '');
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Resolve native Trinity .trmdl and companions inside ZIPs or directories,
 * render geometry/decoded textures, and export through regular GLTFExporter.
 */
export async function loadTrinityModel(project, selected, report = () => {}) {
  const entry = project.items.find(item => item.path === selected);
  if (!entry) throw new TrinityError('Selected Trinity model not found');
  const suffix = ext(entry.path);
  if (suffix !== '.trmdl' && suffix !== '.trmsh') {
    throw new TrinityError('Choose .trmdl or .trmsh to load Trinity model geometry');
  }
  report('Parsing native Trinity model references…');
  const meta = suffix === '.trmdl' ? parseTrmdl(await bytesFor(entry)) :
    { meshFiles: [entry.path], skeleton: '', materials: [] };
  const parts = [];
  for (const meshRef of meta.meshFiles) {
    const shape = suffix === '.trmsh'
      ? entry
      : findResource(project, meshRef, selected, '.trmsh');
    const trmsh = parseTrmsh(await bytesFor(shape));
    const buffer = findResource(project, trmsh.bufferFile, shape.path, '.trmbf');
    const trmbf = parseTrmbf(await bytesFor(buffer));
    parts.push(...decodeTrinityMeshes(trmsh, trmbf));
  }
  if (!parts.length) throw new TrinityError('No renderable Trinity geometry was decoded');

  let skeleton = null;
  if (meta.skeleton) {
    try {
      const skeletonFile = findResource(project, meta.skeleton, selected, '.trskl', false);
      if (skeletonFile) skeleton = parseTrskl(await bytesFor(skeletonFile));
      else report('Skeleton reference found, but TRSKL file is unavailable.');
    } catch (error) { report('TRSKL decoding error: ' + error.message); }
  }
  const materialDefs = [];
  for (const ref of meta.materials) {
    const materialFile = findResource(project, ref, selected, '.trmtr', false);
    if (!materialFile) continue;
    try { materialDefs.push(parseTrmtr(await bytesFor(materialFile))); }
    catch (error) { report('Material decode skipped: ' + error.message); }
  }
  const lookup = createMaterials(materialDefs);
  const created = [];
  const sourceImages = await applyDecodedTextures(project, lookup, selected, report, created);
  const scene = new THREE.Group();
  scene.name = basename(selected);
  const rig = buildBones(skeleton, scene);
  const defaults = new Map();
  for (const part of parts) {
    const name = (part.material || '').toLowerCase();
    let material = lookup.get(name)?.material;
    if (!material) {
      if (!defaults.has(name)) defaults.set(name, new THREE.MeshStandardMaterial({
        name: part.material || 'Unassigned material', color: 0xd9e0e7,
        roughness: 0.8, side: THREE.DoubleSide
      }));
      material = defaults.get(name);
    }
    scene.add(makeMesh(part, material, rig));
  }
  // Avoid inventing native animations: a TRSKL is rest pose, not a clip.
  const vCount = parts.reduce((sum, p) => sum + p.vertices.count, 0);
  report('Decoded ' + parts.length + ' Trinity mesh parts / ' + vCount.toLocaleString() +
    ' vertices' + (rig ? ' / ' + rig.bones.length + ' skeleton bones' : '') +
    '. Game-native shaders, BNTX and animation tracks require additional support.');
  return {
    root: scene, animations: [], selected,
    sourceFormat: 'TRMDL',
    sourceStats: { meshParts: parts.length, vertices: vCount, bones: rig?.bones.length ?? 0 },
    disposeAssets: () => {
      for (const texture of created) texture.dispose();
      for (const image of sourceImages) image.close?.();
    }
  };
}
