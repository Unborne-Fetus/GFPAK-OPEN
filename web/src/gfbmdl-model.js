import {
  loadDecodedTexture, matchingLinkedDiffuseTexture
} from './texture-loader.js';
import { associatedNativeAnimations } from './animation-association.js';
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
    ['.png', '.jpg', '.jpeg', '.webp', '.dds', '.bntx'].includes(getExtension(item.path))
  );
  return items.map(item => {
    const normalized = item.path.replace(/\\/g, '/').toLowerCase();
    const modelDir = modelPath.replace(/\\/g, '/').toLowerCase().split('/').slice(0, -1).join('/');
    const score = ((modelDir && normalized.startsWith(modelDir + '/')) ||
      (!modelDir && !normalized.includes('/')) ? 10 : 0) +
      (stem && normalized.includes(stem) ? 2 : 0);
    return { item, score, base: baseName(item.path) };
  }).sort((a, b) => b.score - a.score);
}

export function findLegacyTexture(name, options) {
  const target = baseName(name);
  if (!target) return null;
  // Prefer an exact referenced file in the source model directory.
  // Several identical textures in different game folders must not be
  // silently combined into the same model.
  const associated = options.filter(row => row.item.linkedKind === 'texture');
  const linkedNamed = associated.filter(row => row.base === target ||
    row.base.startsWith(target + '_') || target.startsWith(row.base + '_'));
  if (linkedNamed.length === 1) return linkedNamed[0].item;
  if (linkedNamed.length > 1) return null;
  const matching = options.filter(row => row.base === target ||
    row.base.startsWith(target + '_') || target.startsWith(row.base + '_'));
  const local = matching.filter(row => row.score >= 10);
  if (local.length === 1) return local[0].item;
  if (local.length > 1) {
    const exact = local.filter(row => row.base === target);
    return exact.length === 1 ? exact[0].item : null;
  }
  if (matching.length === 1) return matching[0].item;
  if (matching.length > 1) return null;
  // Many games pack multiple named textures into one BNTX. Let the
  // BNTX decoder select by the exact GFBMDL texture name; never choose
  // a random surface or one of several unrelated BNTX files.
  // A resolved model link may point into an entirely different file/package.
  // Prefer that single explicit companion to an unrelated local BNTX. Actual
  // internal surface-name matching is still validated by loadDecodedTexture.
  if (associated.length === 1) return associated[0].item;
  const packed = options.filter(row => row.score >= 10 &&
    getExtension(row.item.path) === '.bntx');
  return packed.length === 1 ? packed[0].item : null;
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
    bone.rotation.set(...entry.rotation, 'ZYX');
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
  const sources = associatedNativeAnimations(project.items, selected, report)
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
export async function loadGfbmdl(project, selected, report = () => {}, options = {}) {
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
  const textureCache = new Map();
  const animations = [];
  let disposed = false;
  let extrasPromise = null;
  let released = false;
  const releaseTextures = () => {
    if (released) return;
    released = true;
    for (const texture of textureObjects) {
      texture.image?.close?.();
      texture.dispose();
    }
  };
  const postLoad = () => {
    if (disposed) return Promise.resolve([]);
    if (!extrasPromise) {
      extrasPromise = (async () => {
        const renderTextures = async () => {
      for (let i = 0; i < model.materials.length; i++) {
        const match = chooseMap(model.textureNames, model.materials[i]);
        if (!match) continue;
        const referencedName = model.textureNames[match.textureIndex];
        const file = findLegacyTexture(referencedName, known);
        if (!file) {
          report('Could not uniquely match texture ' + referencedName + ' to a local image or BNTX container.');
          continue;
        }
        try {
          const key = file.path + (getExtension(file.path) === '.bntx' ? '|' + referencedName : '');
          let texture = textureCache.get(key);
          if (!texture) {
            texture = await loadDecodedTexture(file, true, [referencedName]);
            textureCache.set(key, texture);
            textureObjects.push(texture);
          }
          materials[i].map = texture;
          materials[i].color.setRGB(1, 1, 1);
          materials[i].needsUpdate = true;
        } catch (error) {
          report('Could not apply texture ' + file.path + ': ' + error.message);
        }
      }
        };
        const attachMatchedLinkedTextures = async () => {
          const visible = new Set();
          root.traverse(object => {
            if (!object.isMesh) return;
            for (const material of Array.isArray(object.material) ?
              object.material : [object.material]) {
              if (material) visible.add(material);
            }
          });
          for (const material of visible) {
            if (material.map) continue;
            const item = matchingLinkedDiffuseTexture(
              project.items, material.name, visible.size);
            if (!item) continue;
            try {
              let texture = textureCache.get('linked|' + item.path);
              if (!texture) {
                texture = await loadDecodedTexture(
                  item, true, [material.name]);
                textureCache.set('linked|' + item.path, texture);
                textureObjects.push(texture);
              }
              material.map = texture;
              material.color.setRGB(1, 1, 1);
              material.needsUpdate = true;
              report('Automatically applied linked texture ' +
                item.path + ' to GFBMDL material ' + material.name + '.');
            } catch (error) {
              report('Could not apply linked texture ' + item.path +
                ': ' + (error.message || error));
            }
          }
        };
        const [_, clips] = await Promise.all([
          (async () => {
            await renderTextures();
            await attachMatchedLinkedTextures();
          })(),
          readLegacyAnimations(project, selected, rig, report)
        ]);
        if (!disposed) animations.push(...clips);
        report('GFBMDL companion textures and ' + clips.length +
          ' native animation clip(s) loaded.');
        return animations;
      })();
      extrasPromise.finally(() => { if (disposed) releaseTextures(); }).catch(() => {});
    }
    return extrasPromise;
  };
  report('Decoded ' + model.stats.meshCount + ' real GFBMDL meshes and ' +
    model.stats.vertexCount.toLocaleString() + ' vertices, ' +
    (rig?.bones.length || 0) + ' bones. ' +
    (options.fastPreview ? 'Geometry ready; loading textures and clips next.' :
      'Loading textures and clips.') +
    ' Original shaders and some skeletal variants remain unsupported.');
  const result = {
    root, animations, selected,
    sourceFormat: 'GFBMDL',
    sourceStats: model.stats,
    disposeAssets: () => {
      disposed = true;
      if (extrasPromise) extrasPromise.finally(releaseTextures).catch(() => {});
      else releaseTextures();
    }
  };
  if (options.fastPreview) result.postLoad = postLoad;
  else await postLoad();
  return result;
}
