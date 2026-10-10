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
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { identifyFormat } from './game-support.js';
import { loadGfbmdl } from './gfbmdl-model.js';
import { loadTrinityModel } from './trinity-model.js';

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
  const models = items.filter(e => SUPPORTED.includes(extension(e.path)));
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
      for (const item of fileItems) {
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

export async function loadModel(project, selected, report = () => {}) {
  const entry = project.items.find(item => item.path === selected);
  if (!entry) throw new Error('Selected model no longer exists');
  const suffix = extension(entry.path);
  if (!SUPPORTED.includes(suffix)) throw new Error('Unsupported format ' + suffix);
  if (suffix === '.gfbmdl') return loadGfbmdl(project, selected, report);
  if (suffix === '.trmdl' || suffix === '.trmsh') return loadTrinityModel(project, selected, report);

  const dependencyFiles = assetFilesForModel(project, entry.path);
  // There may be many textures in a game dump. Only load nearby files.
  const primaryMtl = project.items.find(item => extension(item.path) === '.mtl' &&
    normalizePath(item.path).slice(0, normalizePath(item.path).lastIndexOf('/') + 1) ===
    normalizePath(entry.path).slice(0, normalizePath(entry.path).lastIndexOf('/') + 1));
  const prepareFiles = dependencyFiles.filter(item => item.path !== entry.path && item.path !== primaryMtl?.path);
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
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, {
    binary: true,
    onlyVisible: false,
    animations,
    trs: true,
    maxTextureSize: 4096
  });
  if (!(result instanceof ArrayBuffer)) throw new Error('GLB exporter did not produce binary data');
  const view = new DataView(result);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB header');
  const chunkLength = view.getUint32(12, true);
  if (chunkLength > view.byteLength - 20) throw new Error('Invalid GLB JSON chunk');
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(result, 20, chunkLength)));
  if (!(document.meshes?.length > 0)) throw new Error('GLB export contains no meshes');
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
  center.position.y = 1.55;
  center.castShadow = true;
  root.add(center);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.7, 0.045, 6, 96),
    new THREE.MeshStandardMaterial({ color: 0xe5b977, metalness: 0.5, roughness: 0.28 })
  );
  ring.position.y = 1.55;
  ring.rotation.x = Math.PI * 0.38;
  ring.castShadow = true;
  root.add(ring);
  return { root, animations: [], selected: 'Demo geometry (not a Pokémon)' };
}
