/**
 * Browser-native loading and GLB export for formats with well-supported Three.js loaders.
 * GFPAK's compressed Trinity meshes are not included here: no fake geometry is generated.
 */
import * as THREE from 'three';
import JSZip from 'jszip';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as WebGLTextureUtils from 'three/addons/utils/WebGLTextureUtils.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { identifyFormat } from './game-support.js';
import { loadGfbmdl } from './gfbmdl-model.js';
import { loadTrinityModel } from './trinity-model.js';
import { prepareRiggedGlbExport } from './segment-scale-export.js';

export const SUPPORTED = ['.glb', '.gltf', '.fbx', '.obj', '.dae', '.stl', '.ply', '.3ds', '.gfbmdl', '.trmdl', '.trmsh'];
const TEXTURES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga', '.dds', '.ktx2', '.bin']);
const MAX_FILES = 20000;
const MAX_RESOURCE_BYTES = 400 * 1024 * 1024;

export function extension(name) {
  return '.' + name.split('.').pop().toLowerCase();
}

export function normalizePath(value) {
  return decodeURIComponent(String(value).replace(/\\/g, '/').replace(/^(\.\/)+/, ''))
    .replace(/\/+/g, '/').split('?')[0].split('#')[0].toLowerCase();
}

function fileRecord(file) {
  const path = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
  return {
    path,
    size: file.size,
    getBytes: () => file.arrayBuffer(),
    getText: () => file.text()
  };
}

export function projectFromFiles(files) {
  const all = Array.from(files);
  if (!all.length) throw new Error('No files selected');
  if (all.length > MAX_FILES) throw new Error('Too many files in project');
  const entries = all.map(fileRecord);
  return finishProject(entries, 'Selected files');
}

function finishProject(entries, label) {
  const items = entries.filter(e => e.path && !e.path.endsWith('/'));
  if (items.length > MAX_FILES) throw new Error('Too many files in project');
  const trmdlDirectories = new Set(items.filter(e => extension(e.path) === '.trmdl')
    .map(e => e.path.replaceAll('\\', '/').split('/').slice(0, -1).join('/').toLowerCase()));
  const models = items.filter(e => {
    if (!SUPPORTED.includes(extension(e.path))) return false;
    if (extension(e.path) !== '.trmsh') return true;
    const directory = e.path.replaceAll('\\', '/').split('/').slice(0, -1).join('/').toLowerCase();
    // TRMSH is a dependent mesh resource when TRMDL lives beside it.
    return !trmdlDirectories.has(directory);
  });
  const formats = identifyFormat(items.map(item => item.path));
  return { label, items, models, native: formats.native, formats };
}

export async function projectFromZip(file, progress = () => {}) {
  if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('Not a ZIP package');
  progress('Reading ZIP directory…');
  const zip = await JSZip.loadAsync(file);
  const rows = Object.values(zip.files).filter(e => !e.dir);
  if (rows.length > MAX_FILES) throw new Error('ZIP contains too many entries');
  const entries = rows.map(row => {
    const size = row._data?.uncompressedSize ?? 0;
    return {
      path: row.name,
      size,
      getBytes: async () => {
        if (size > MAX_RESOURCE_BYTES) throw new Error('Individual model resource exceeds 400 MiB');
        return row.async('arraybuffer');
      },
      getText: async () => {
        if (size > MAX_RESOURCE_BYTES) throw new Error('Individual text resource exceeds 400 MiB');
        return row.async('string');
      }
    };
  });
  progress('Discovered ' + rows.length + ' ZIP files.');
  return finishProject(entries, file.name);
}

function rankCandidate(row, modelPath) {
  const path = normalizePath(row.path);
  const model = normalizePath(modelPath);
  const parent = model.slice(0, model.lastIndexOf('/') + 1);
  if (!parent) return path.includes('/') ? 0 : 100;
  if (path.startsWith(parent)) return 100;
  let score = 0;
  const folderTokens = parent.split('/').filter(Boolean);
  for (const token of folderTokens) if (path.includes('/' + token + '/')) score += 8;
  return score;
}

function assetFilesForModel(project, modelPath) {
  const candidates = project.items.filter(e => TEXTURES.has(extension(e.path)) ||
    ['.mtl', '.gltf'].includes(extension(e.path)));
  const ranked = candidates.map(e => ({ ...e, rank: rankCandidate(e, modelPath) }))
    .filter(e => e.rank >= 8).sort((a, b) => b.rank - a.rank);
  if (ranked.length > 250) return ranked.slice(0, 250);
  return ranked;
}

function makeResolver(fileItems) {
  const urls = new Map();
  const byBase = new Map();
  const objects = [];
  for (const item of fileItems) {
    const normalized = normalizePath(item.path);
    urls.set(normalized, item);
    const base = normalized.split('/').pop();
    if (!byBase.has(base)) byBase.set(base, item);
  }
  const objectUrls = new Map();
  const getUrl = item => {
    let url = objectUrls.get(item.path);
    if (!url) {
      throw new Error('Model dependency was not prepared: ' + item.path);
    }
    return url;
  };
  return {
    async prepare() {
      // Desktop preview manifests supply a trusted same-origin, read-only
      // HTTP stream per resource. Let the model loader request referenced
      // textures itself; prefetching 250 images before showing even a simple
      // OBJ or GLB was the main unnecessary source of preview latency.
      for (const item of fileItems) {
        if (typeof item.url === 'string' &&
            /^\/__quick_asset\/[a-f0-9]{32}\/[0-9]+$/.test(item.url)) {
          objectUrls.set(item.path, item.url);
          continue;
        }
        const blob = new Blob([await item.getBytes()]);
        const url = URL.createObjectURL(blob);
        objectUrls.set(item.path, url);
        objects.push(url);
      }
    },
    manager() {
      const manager = new THREE.LoadingManager();
      manager.setURLModifier(request => {
        if (/^(data:|blob:|https?:)/i.test(request)) return request;
        const safe = normalizePath(request);
        const entry = urls.get(safe) ?? byBase.get(safe.split('/').pop());
        return entry ? getUrl(entry) : 'data:,';
      });
      return manager;
    },
    release() { for (const obj of objects) URL.revokeObjectURL(obj); }
  };
}

export async function loadModel(project, selected, report = () => {}, options = {}) {
  const entry = project.items.find(item => item.path === selected);
  if (!entry) throw new Error('Selected model no longer exists');
  const suffix = extension(entry.path);
  if (!SUPPORTED.includes(suffix)) throw new Error('Unsupported format ' + suffix);
  if (suffix === '.gfbmdl') return loadGfbmdl(project, selected, report, options);
  if (suffix === '.trmdl' || suffix === '.trmsh')
    return loadTrinityModel(project, selected, report, options);

  // GLBs normally embed their image data; standalone mesh formats do not
  // need to fetch unrelated images. For OBJ only resolve external materials
  // if an MTL is actually present, and let glTF/FBX/DAE request assets lazily.
  const needsMtl = suffix === '.obj';
  const primaryMtl = needsMtl ? project.items.find(item =>
    extension(item.path) === '.mtl' &&
    normalizePath(item.path).slice(0, normalizePath(item.path).lastIndexOf('/') + 1) ===
    normalizePath(entry.path).slice(0, normalizePath(entry.path).lastIndexOf('/') + 1)
  ) : null;
  const dependencyFiles = ['.gltf', '.fbx', '.dae'].includes(suffix) ||
    (needsMtl && primaryMtl) ? assetFilesForModel(project, entry.path) : [];
  const prepareFiles = dependencyFiles.filter(item =>
    item.path !== entry.path && item.path !== primaryMtl?.path);
  const resolver = makeResolver(prepareFiles);
  report('Preparing nearby texture resources…');
  await resolver.prepare();
  try {
    const manager = resolver.manager();
    let root;
    let animations = [];
    const binaryFormats = new Set(['.glb', '.fbx', '.stl', '.ply', '.3ds']);
    const data = binaryFormats.has(suffix) ? await entry.getBytes() : await entry.getText();
    report('Decoding ' + suffix.toUpperCase() + ' model…');
    if (suffix === '.glb' || suffix === '.gltf') {
      const asset = await new GLTFLoader(manager).parseAsync(data, '');
      root = asset.scene;
      animations = asset.animations ?? [];
    } else if (suffix === '.fbx') {
      root = new FBXLoader(manager).parse(data, '');
      animations = root.animations ?? [];
    } else if (suffix === '.obj') {
      const loader = new OBJLoader(manager);
      if (primaryMtl) {
        const materials = new MTLLoader(manager).parse(await primaryMtl.getText(), '');
        materials.preload();
        loader.setMaterials(materials);
      }
      root = loader.parse(data);
    } else if (suffix === '.dae') {
      const asset = new ColladaLoader(manager).parse(data, '');
      root = asset.scene;
      animations = asset.animations ?? [];
    } else if (suffix === '.stl' || suffix === '.ply') {
      const geometry = suffix === '.stl' ? new STLLoader(manager).parse(data) : new PLYLoader(manager).parse(data);
      geometry.computeBoundingBox();
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const colored = !!geometry.getAttribute('color');
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0xe8eef2, roughness: 0.8, metalness: 0.05,
        vertexColors: colored, side: THREE.DoubleSide
      }));
      root = new THREE.Group();
      root.add(mesh);
    } else if (suffix === '.3ds') {
      root = new TDSLoader(manager).parse(data, '');
    }
    if (!root) throw new Error('No 3D scene was returned by the model decoder');
    let meshes = 0;
    root.traverse(o => { if (o.isMesh && o.geometry?.attributes?.position?.count) meshes++; });
    if (!meshes) throw new Error('The file decoded but contained no renderable mesh geometry');
    root.name ||= entry.path.split('/').pop();
    report('Model loaded: ' + meshes + ' mesh(es).');
    // Retain blob URLs until the model is replaced, since FBX and OBJ texture
    // requests can remain in flight even after mesh parsing has completed.
    return { root, animations, selected: entry.path, disposeAssets: () => resolver.release() };
  } catch (error) {
    resolver.release();
    throw error;
  }
}

export function modelStats(root, animations = []) {
  let meshes = 0, vertices = 0, triangles = 0, materials = 0, bones = 0;
  const unique = new Set();
  root.traverse(o => {
    if (o.isBone) bones++;
    if (!o.isMesh || !o.geometry) return;
    meshes++;
    vertices += o.geometry.getAttribute('position')?.count ?? 0;
    triangles += (o.geometry.index?.count ?? o.geometry.getAttribute('position')?.count ?? 0) / 3;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m && !unique.has(m.uuid)) { unique.add(m.uuid); materials++; }
    }
  });
  return { meshes, vertices, triangles: Math.round(triangles), materials, bones, clips: animations.length };
}

export async function exportGlb(root, animations = []) {
  if (!root) throw new Error('No model is loaded');
  // BNTX/DDS BC7/ASTC resources can remain GPU-compressed in the preview.
  // GLTF requires an image, so let Three.js read back an RGBA canvas
  // instead of throwing setTextureUtils() during Pokémon ZIP export.
  // GLTFExporter must draw decompressed GPU textures onto a 2D canvas.
  // Some Three.js decompression paths return an ImageData-like pixel buffer,
  // which CanvasRenderingContext2D.drawImage() cannot accept directly.
  // Normalize those buffers to a genuine canvas without changing preview textures.
  const textureUtils = {
    ...WebGLTextureUtils,
    async decompress(texture, maxTextureSize) {
      const decoded = await WebGLTextureUtils.decompress(texture, maxTextureSize);
      const image = decoded?.image;
      if (image?.data && Number.isInteger(image.width) && Number.isInteger(image.height) &&
          image.width > 0 && image.height > 0 &&
          image.data.length === image.width * image.height * 4 &&
          (image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)) {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Cannot create canvas for decompressed GLB texture');
        context.putImageData(new ImageData(
          new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
        const normalized = decoded.clone();
        normalized.image = canvas;
        normalized.needsUpdate = true;
        return normalized;
      }
      return decoded;
    }
  };
  const exporter = new GLTFExporter().setTextureUtils(textureUtils);
  // Three.js GLTFExporter handles DataTexture in processImage(), but its
  // metalness/roughness combination path calls drawImage() on texture.image
  // directly. GFPAK's native RGBA textures expose {data,width,height}, not
  // CanvasImageSource, so that path throws a TypeError for many models.
  // Give the exporter disposable texture/material clones, leaving the live
  // preview's shared materials and textures untouched.
  const exportTextureCopies = new Map();
  const exportMaterialCopies = new Map();
  const swappedMaterials = [];
  const exportCopies = [];
  function drawableMetalRoughTexture(texture) {
    const image = texture?.image;
    if (!image?.data) return texture;
    if (exportTextureCopies.has(texture)) return exportTextureCopies.get(texture);
    const { width, height, data } = image;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width <= 0 || height <= 0 ||
        texture.format !== THREE.RGBAFormat || texture.type !== THREE.UnsignedByteType ||
        !(data instanceof Uint8Array) || data.length !== width * height * 4) {
      throw new Error('Cannot export metallic/roughness texture "' +
        (texture.name || 'unnamed') + '": expected RGBA8 pixel data');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot create canvas for GLB material texture');
    const rgba = context.createImageData(width, height);
    rgba.data.set(data);
    context.putImageData(rgba, 0, 0);
    const copy = texture.clone();
    copy.source = new THREE.Source(canvas);
    copy.needsUpdate = true;
    exportTextureCopies.set(texture, copy);
    exportCopies.push(copy);
    return copy;
  }
  function exportMaterial(material) {
    if (!material) return material;
    if (exportMaterialCopies.has(material)) return exportMaterialCopies.get(material);
    const maps = ['metalnessMap', 'roughnessMap'];
    if (!maps.some(key => material[key]?.image?.data)) return material;
    const copy = material.clone();
    for (const key of maps) {
      if (material[key]) copy[key] = drawableMetalRoughTexture(material[key]);
    }
    exportMaterialCopies.set(material, copy);
    exportCopies.push(copy);
    return copy;
  }
  const prepareExportMaterials = () => root.traverse(mesh => {
    if (!mesh.isMesh || !mesh.material) return;
    const original = mesh.material;
    const replacement = Array.isArray(original)
      ? original.map(exportMaterial) : exportMaterial(original);
    if (Array.isArray(original)
        ? original.some((material, i) => material !== replacement[i])
        : original !== replacement) {
      swappedMaterials.push([mesh, original]);
      mesh.material = replacement;
    }
  });
  // GLTFExporter serializes geometry colors even when vertexColors is off.
  // Native Pokémon colors often hold shader masks (0..255), not an albedo
  // multiplier. Export the attributes actually used by the preview material.
  const originals = [];
  const prepareExportGeometry = () => root.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('color')) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some(material => material?.vertexColors)) return;
    const geometry = mesh.geometry.clone();
    geometry.deleteAttribute('color');
    originals.push([mesh, mesh.geometry, geometry]);
    mesh.geometry = geometry;
  });
  let result;
  let preparedRig = null;
  try {
    prepareExportMaterials();
    prepareExportGeometry();
    // glTF does not serialize NativeBone.updateMatrix() custom compensation.
    // Bake the compensated rest pose and each clip before export; on failure
    // do not publish a subtly broken tongue/limb mesh.
    preparedRig = prepareRiggedGlbExport(root, animations);
    result = await exporter.parseAsync(root, {
      binary: true,
      onlyVisible: false,
      animations: preparedRig.animations,
      trs: true,
      maxTextureSize: 4096
    });
  } finally {
    preparedRig?.restore();
    for (const [mesh, original, temporary] of originals) {
      mesh.geometry = original;
      temporary.dispose();
    }
    for (const [mesh, original] of swappedMaterials) mesh.material = original;
    for (const copy of exportCopies) copy.dispose();
  }
  if (!(result instanceof ArrayBuffer)) throw new Error('GLB exporter did not produce binary data');
  const view = new DataView(result);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB header');
  const chunkLength = view.getUint32(12, true);
  if (chunkLength > view.byteLength - 20) throw new Error('Invalid GLB JSON chunk');
  const gltfDocument = JSON.parse(new TextDecoder().decode(new Uint8Array(result, 20, chunkLength)));
  if (!(gltfDocument.meshes?.length > 0)) throw new Error('GLB export contains no meshes');
  return result;
}

export function downloadBlob(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function demoModel() {
  const root = new THREE.Group();
  root.name = 'Demo geometry (not a Pokémon)';
  const center = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.25, 1),
    new THREE.MeshStandardMaterial({ color: 0x58e0bb, metalness: 0.38, roughness: 0.26, flatShading: true })
  );
  center.name = 'DemoCrystal';
  center.position.y = 1.55;
  center.castShadow = true;
  root.add(center);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.7, 0.045, 6, 96),
    new THREE.MeshStandardMaterial({ color: 0xe5b977, metalness: 0.5, roughness: 0.28 })
  );
  ring.name = 'DemoOrbit';
  ring.position.y = 1.55;
  ring.rotation.x = Math.PI * 0.38;
  ring.castShadow = true;
  root.add(ring);
  // Real glTF-exportable animation tracks, not a viewer-only visual effect.
  // Subtle floating and orbiting motions repeat seamlessly every four seconds.
  const times = [0, 1, 2, 3, 4];
  const heights = [1.55, 1.69, 1.55, 1.43, 1.55];
  const bob = new THREE.VectorKeyframeTrack(
    'DemoCrystal.position', times, heights.flatMap(y => [0, y, 0])
  );
  const angles = [0, 0.24, 0.42, 0.18, 0];
  const orientations = angles.flatMap(angle => {
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.PI * 0.38, angle, 0, 'XYZ')
    );
    return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
  });
  const orbit = new THREE.QuaternionKeyframeTrack('DemoOrbit.quaternion', times, orientations);
  const animations = [new THREE.AnimationClip('Gentle Float & Orbit', 4, [bob, orbit])];
  return { root, animations, selected: 'Demo geometry (not a Pokémon)' };
}
