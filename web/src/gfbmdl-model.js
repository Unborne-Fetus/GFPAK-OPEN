import { loadDecodedTexture } from './texture-loader.js';
import { selectNativeAnimations } from './animation-association.js';
/**
 * Turn decoded legacy Game Freak GFBMDL mesh data into an actual Three.js scene.
 * Uses independent FlatBuffers geometry reader; no Blender/Python/remote service.
 */
import * as THREE from 'three';
import { decodeGfbmdl } from './gfbmdl.js';
import { parseNativeAnimation } from './trinity-animation.js';
import { animationTracks } from './trinity-model.js';

function getExtension(name) {
  return name.slice(name.lastIndexOf('.')).toLowerCase();
}

function baseName(path) {
  const clean = path.replace(/\\/g, '/').split('/').pop().toLowerCase();
  return clean.replace(/\.[^.]+$/, '');
}

function nearbyTextures(project, modelPath) {
  const stem = baseName(modelPath);
  const items = project.items.filter(item =>
    ['.png', '.jpg', '.jpeg', '.webp', '.dds'].includes(getExtension(item.path))
  );
  return items.map(item => {
    const normalized = item.path.replace(/\\/g, '/').toLowerCase();
    const modelDir = modelPath.replace(/\\/g, '/').toLowerCase().split('/').slice(0, -1).join('/');
    const score = (modelDir && normalized.startsWith(modelDir + '/') ? 10 : 0) +
      (stem && normalized.includes(stem) ? 2 : 0);
    return { item, score, base: baseName(item.path) };
  }).sort((a, b) => b.score - a.score);
}

function findTexture(name, options) {
  const target = baseName(name);
  if (!target) return null;
  const matches = options.filter(row =>
    row.base === target || row.base.startsWith(target + '_') ||
    target.startsWith(row.base + '_'));
  return matches[0]?.item ?? null;
}

function chooseMap(textureNames, material) {
  const maps = material.maps || [];
  // GFBMDL's material structure exposes each texture index and sampler name.
  // A source may have many shader maps, so do not guess arbitrary colors.
  const candidates = maps.filter(entry =>
    entry.textureIndex >= 0 && entry.textureIndex < textureNames.length
  );
  const colorNames = /color|diff|base|albedo|col|c0/i;
  return candidates.find(entry => colorNames.test(entry.sampler || '')) ||
    (candidates.length === 1 ? candidates[0] : null);
}

function threeMesh(geometrySource, materialArray, rig = null) {
  const attributes = geometrySource.properties;
  const geometry = new THREE.BufferGeometry();
  const position = attributes.position;
  if (!position || position.length % 3) throw new Error('GFBMDL has an invalid position stream');
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  if (attributes.normal?.length >= geometrySource.vertexCount * 3) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(
      attributes.normal.slice(0, geometrySource.vertexCount * 3), 3));
  }
  if (attributes.uv?.length >= geometrySource.vertexCount * 2) {
    const uv = new Float32Array(geometrySource.vertexCount * 2);
    for (let i = 0; i < uv.length; i += 2) {
      uv[i] = attributes.uv[i];
      uv[i + 1] = attributes.uv[i + 1];
    }
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  }
  const colors = attributes.color;
  if (colors?.length >= geometrySource.vertexCount * 3) {
    const components = colors.length / geometrySource.vertexCount;
    if (components === 3 || components === 4) {
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, components));
    }
  }
  geometry.setIndex(geometrySource.indices);
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const assigned = materialArray.length ? materialArray : [
    new THREE.MeshStandardMaterial({ color: 0xd2dce4, roughness: 0.74, side: THREE.DoubleSide })
  ];
  for (const group of geometrySource.groups) {
    geometry.addGroup(group.start, group.count,
      group.materialIndex < assigned.length ? group.materialIndex : 0);
  }
  let mesh = null;
  const indices = attributes.joints;
  const influence = attributes.weights;
  if (rig && indices?.length === geometrySource.vertexCount * 4 &&
      influence?.length === geometrySource.vertexCount * 4) {
    const mapped = new Uint16Array(indices.length);
    const weights = new Float32Array(indices.length);
    let hasValidSkin = false;
    for (let i = 0; i < geometrySource.vertexCount; i++) {
      let total = 0;
      for (let c = 0; c < 4; c++) {
        const offset = i * 4 + c;
        const local = Math.round(indices[offset]);
        const actual = rig.deformingIndices[local];
        const weight = influence[offset];
        if (Number.isInteger(actual) && actual >= 0 && actual < rig.bones.length && weight > 0) {
          mapped[offset] = actual;
          weights[offset] = weight;
          total += weight;
        }
      }
      if (total > 0) {
        hasValidSkin = true;
        for (let c = 0; c < 4; c++) weights[i * 4 + c] /= total;
      }
    }
    if (hasValidSkin) {
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mapped, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
      mesh = new THREE.SkinnedMesh(geometry, assigned);
      mesh.bind(rig.skeleton);
    }
  }
  if (!mesh) mesh = new THREE.Mesh(geometry, assigned);
  mesh.name = 'GFBMDL mesh ' + geometrySource.index;
  mesh.frustumCulled = false;
  return mesh;
}

function buildLegacyRig(root, entries) {
  if (!entries?.length) return null;
  const bones = entries.map(entry => {
    const bone = new THREE.Bone();
    bone.name = entry.name;
    bone.position.fromArray(entry.translation);
    bone.rotation.set(...entry.rotation, 'XYZ');
    bone.scale.fromArray(entry.scale);
    return bone;
  });
  entries.forEach((entry, i) => {
    if (entry.parent >= 0 && entry.parent < bones.length && entry.parent !== i)
      bones[entry.parent].add(bones[i]);
    else root.add(bones[i]);
  });
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  skeleton.calculateInverses();
  const deformingIndices = entries.map((entry, i) => entry.rigid ? -1 : i).filter(i => i >= 0);
  return { bones, skeleton, deformingIndices };
}

async function readLegacyAnimations(project, selected, rig, report) {
  if (!rig?.bones?.length) return [];
  const sources = selectNativeAnimations(project.items, selected, 64)
    .filter(item => getExtension(item.path) === '.gfbanm');
  if (sources.length < project.items.filter(item => getExtension(item.path) === '.gfbanm').length)
    report('Prioritizing ' + sources.length + ' matching GFBANM clips from this project.');
  const clips = [];
  for (const source of sources) {
    try {
      const data = await source.getBytes();
      const binary = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const native = parseNativeAnimation(binary, source.path.split('/').pop());
      const clip = animationTracks(native, rig.bones);
      if (clip) clips.push(clip);
    } catch (error) { report('Animation ' + source.path + ' skipped: ' + error.message); }
  }
  return clips;
}

/**
 * Load an independent, genuine GFBMDL geometry asset in a browser.
 * Preserves decoded positions/normals/UVs/colors/material groups.
 *
 * Some GFBANM animation variants and original game shaders remain unsupported.
 */
export async function loadGfbmdl(project, selected, report = () => {}) {
  const entry = project.items.find(item => item.path === selected);
  if (!entry) throw new Error('GFBMDL file not found');
  report('Decoding GFBMDL FlatBuffers model geometry locally…');
  const model = decodeGfbmdl(await entry.getBytes());
  const root = new THREE.Group();
  root.name = selected.split('/').pop();
  const materials = model.materials.map((source, i) => {
    const material = new THREE.MeshStandardMaterial({
      color: 0xdde2e8,
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    material.name = source.name || 'GFBMDL Material ' + i;
    return material;
  });
  const rig = buildLegacyRig(root, model.bones);
  for (const geometry of model.meshes) {
    root.add(threeMesh(geometry, materials, rig));
  }

  // The original importer orients GFBMDL at +90° X, from the model's native axes.
  root.rotation.x = Math.PI / 2;

  const known = nearbyTextures(project, selected);
  const textureObjects = [];
  for (let i = 0; i < model.materials.length; i++) {
    const match = chooseMap(model.textureNames, model.materials[i]);
    if (!match) continue;
    const file = findTexture(model.textureNames[match.textureIndex], known);
    if (!file) continue;
    try {
      const texture = await loadDecodedTexture(file, true);
      materials[i].map = texture;
      materials[i].color.setRGB(1, 1, 1);
      materials[i].needsUpdate = true;
      textureObjects.push(texture);
    } catch (error) {
      report('Could not apply texture ' + file.path + ': ' + error.message);
    }
  }

  const animations = await readLegacyAnimations(project, selected, rig, report);
  report('Decoded ' + model.stats.meshCount + ' real GFBMDL meshes and ' +
    model.stats.vertexCount.toLocaleString() + ' vertices, ' +
    (rig?.bones.length || 0) + ' bones and ' + animations.length + ' animation clips. ' +
    'Original shaders, some BNTX formats and skeletal variants remain unsupported.');
  return {
    root, animations, selected,
    sourceFormat: 'GFBMDL',
    sourceStats: model.stats,
    disposeAssets: () => {
      for (const texture of textureObjects) {
        texture.image?.close?.();
        texture.dispose();
      }
    }
  };
}
