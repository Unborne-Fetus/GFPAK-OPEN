import {
  loadDecodedTexture, matchingLinkedDiffuseTexture
} from './texture-loader.js';
import { associatedNativeAnimations } from './animation-association.js';
import { parseGfbmdlVisibility, applyGfbmdlRestVisibility } from './gfbmdl-visibility.js';
/**
 * Turn decoded legacy Game Freak GFBMDL mesh data into an actual Three.js scene.
 * Uses independent FlatBuffers geometry reader; no Blender/Python/remote service.
 */
import * as THREE from 'three';
import { decodeGfbmdl } from './gfbmdl.js';
import { parseNativeAnimation } from './trinity-animation.js';
import { animationTracks } from './trinity-model.js';
import { parseBntx } from './bntx.js';
import { applyLegacyEyeLayer } from './gfbmdl-eye-layer.js';
import { isLegacyFireCore, isLegacyFireMask, applyLegacyFire } from './gfbmdl-fire.js';
import { closedFlameGeometry } from './gfbmdl-flame-geometry.js';

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
  // GFPAK aliases do not preserve texture filenames. BNTX retains the
  // actual surface names: match those exactly, including normal/shiny names.
  const internal = options.filter(row => row.internalNames?.includes(target));
  const localInternal = internal.filter(row => row.score >= 10 ||
    row.item.linkedKind === 'texture');
  if (localInternal.length) return localInternal.length === 1 ? localInternal[0].item : null;
  if (internal.length) return internal.length === 1 ? internal[0].item : null;
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

export function chooseMap(textureNames, material) {
  const maps = material.maps || [];
  // GFBMDL's material structure exposes each texture index and sampler name.
  // A source may have many shader maps, so do not guess arbitrary colors.
  const candidates = maps.filter(entry =>
    entry.textureIndex >= 0 && entry.textureIndex < textureNames.length
  );
  const colorNames = /color|diff|base|albedo|col|c0/i;
  return candidates.find(entry => /^(?:Col0Tex|BaseColorTex|AlbedoTex|DiffuseTex)$/i.test(entry.sampler || '')) ||
    candidates.find(entry => colorNames.test(entry.sampler || '')) ||
    (candidates.length === 1 ? candidates[0] : null);
}

export function legacyTextureTransform(source, prefix = 'Color') {
  const values = source.scalars || {};
  const value = (name, fallback) => Number.isFinite(values[prefix + name])
    ? values[prefix + name] : fallback;
  const u = value('UVScaleU', 1), v = value('UVScaleV', 1);
  // Base/translate offsets are already in the scaled texture domain.
  // Scaling them again selects the mirrored opposite eye in legacy atlases.
  return [u, v, value('BaseU', 0) + value('UVTranslateU', 0),
    value('BaseV', 0) + value('UVTranslateV', 0)];
}

export function applyLegacyTextureTransform(texture, transform) {
  const [u, v, x, y] = transform;
  texture.repeat.set(u, v);
  // Geometry uses flipped V, so convert the native transform as well.
  texture.offset.set(x, 1 - v - y);
  texture.wrapS = Math.abs(u) > 1 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  texture.wrapT = Math.abs(v) > 1 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  texture.updateMatrix();
  return texture;
}

function materialUvCenter(model, materialIndex) {
  let u=0,v=0,x=0,ux=0,count=0;
  for(const mesh of model.meshes){
    const uv=mesh.properties.uv;
    if(!uv)continue;
    const indices=new Set(mesh.groups.filter(group=>group.materialIndex===materialIndex)
      .flatMap(group=>mesh.indices.slice(group.start,group.start+group.count)));
    for(const i of indices){
      const px=mesh.properties.position[i*3],pu=uv[i*2];
      u+=pu;v+=1-uv[i*2+1];x+=px;ux+=pu*px;count++;
    }
  }
  return count?{center:[u/count,v/count],
    inwardDirection:Math.sign(-x*(ux-u*x/count))}:{center:[.5,.5],inwardDirection:0};
}

function threeMesh(geometrySource, materialArray, rig = null) {
  const attributes = geometrySource.properties;
  const geometry = new THREE.BufferGeometry();
  const position = attributes.position;
  if (!position || position.length % 3) throw new Error('GFBMDL has an invalid position stream');
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  if (attributes.normal?.length >= geometrySource.vertexCount * 3) {
    // Native normals may be XYZW. Copy XYZ per vertex instead of slicing
    // the whole stream, which feeds W into the next vertex's normal.
    const stride = attributes.normal.length / geometrySource.vertexCount;
    const normals = new Float32Array(geometrySource.vertexCount * 3);
    for (let i = 0; i < geometrySource.vertexCount; i++) {
      normals.set(attributes.normal.subarray(i * stride, i * stride + 3), i * 3);
    }
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(
      normals, 3));
  }
  if (attributes.uv?.length >= geometrySource.vertexCount * 2) {
    const uv = new Float32Array(geometrySource.vertexCount * 2);
    for (let i = 0; i < uv.length; i += 2) {
      uv[i] = attributes.uv[i];
      // Match native texture V origin, including compressed BNTX surfaces.
      uv[i + 1] = 1 - attributes.uv[i + 1];
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
  mesh.name = geometrySource.name || 'GFBMDL mesh ' + geometrySource.index;
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

function legacyAnimationSources(project, selected, report) {
  return associatedNativeAnimations(project.items, selected, report)
    .filter(item => getExtension(item.path) === '.gfbanm');
}

function preferredIdleScore(item) {
  const name = baseName(item.path);
  return /ba10_waita/i.test(name) ? 50 :
    /ba10_waitb/i.test(name) ? 40 :
    /kw01_wait/i.test(name) ? 30 :
    /fi01_wait/i.test(name) ? 20 :
    /(?:idle|standby|wait)/i.test(name) ? 10 : 0;
}

async function loadLegacyRestVisibility(project, selected, root, report) {
  // Use the actual GFBANM idle visibility, not a wing/tail naming heuristic.
  // Read just one small idle file so the first 3D frame stays responsive.
  const sources = legacyAnimationSources(project, selected, report)
    .filter(item => preferredIdleScore(item) > 0)
    .sort((a,b) => preferredIdleScore(b) - preferredIdleScore(a) ||
      a.path.localeCompare(b.path));
  for (const item of sources) {
    try {
      const data = await item.getBytes();
      const binary = data instanceof ArrayBuffer ? data :
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const {channels} = parseGfbmdlVisibility(binary);
      const count = applyGfbmdlRestVisibility(root, channels);
      if (count) {
        report('Applied ' + count + ' native idle skin visibility state(s).');
        return;
      }
    } catch (error) {
      report('Idle skin visibility skipped: ' + error.message);
    }
  }
}

function legacyVisibilityTracks(channels, frameRate, meshesByName) {
  const tracks = [];
  const covered = new Set();
  const rate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 30;
  for (const channel of channels) {
    const name = channel.name.toLowerCase();
    const meshes = meshesByName.get(name) || [];
    if (!meshes.length || !channel.values.length) continue;
    const times = channel.frames.map(frame => frame / rate);
    for (const mesh of meshes) {
      const values = channel.values.flatMap(value => value ? [1,1,1] : [0,0,0]);
      const track = new THREE.VectorKeyframeTrack(mesh.uuid + '.scale', times, values);
      // Shape swaps must happen at frame boundaries, not by growing an
      // alternate wing or tail gradually between visibility keys.
      track.setInterpolation(THREE.InterpolateDiscrete);
      tracks.push(track);
      covered.add(mesh.uuid);
    }
  }
  return {tracks, covered};
}

async function readLegacyAnimations(project, selected, rig, root, report) {
  const sources = legacyAnimationSources(project, selected, report);
  if (sources.length < project.items.filter(item => getExtension(item.path) === '.gfbanm').length)
    report('Prioritizing ' + sources.length + ' matching GFBANM clips from this project.');
  const meshesByName = new Map();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const name = mesh.name.toLowerCase();
    if (!meshesByName.has(name)) meshesByName.set(name, []);
    meshesByName.get(name).push(mesh);
  });
  const entries = [];
  const animatedMeshes = new Set();
  for (const source of sources) {
    try {
      const data = await source.getBytes();
      const binary = data instanceof ArrayBuffer ? data :
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const {channels, frameRate, frameCount} = parseGfbmdlVisibility(binary);
      const {tracks:visTracks, covered} = legacyVisibilityTracks(channels, frameRate, meshesByName);
      for (const id of covered) animatedMeshes.add(id);
      let clip = null;
      if (rig?.bones?.length) {
        try {
          const native = parseNativeAnimation(binary, source.path.split('/').pop());
          clip = animationTracks(native, rig.bones);
        } catch (error) {
          if (!visTracks.length) throw error;
        }
      }
      if (!clip && !visTracks.length) continue;
      if (!clip) {
        clip = new THREE.AnimationClip(baseName(source.path),
          frameCount > 1 ? (frameCount - 1) / (frameRate || 30) : -1, []);
      }
      clip.tracks.push(...visTracks);
      entries.push({clip, covered, visTracks, frameRate, frameCount});
    } catch (error) { report('Animation ' + source.path + ' skipped: ' + error.message); }
  }
  const meshByUuid = new Map();
  root.traverse(mesh => {if (mesh.isMesh) meshByUuid.set(mesh.uuid, mesh);});
  for (const entry of entries) {
    if (entry.visTracks.length) {
      // A clip only lists surfaces that differ from the model's default
      // visibility (all skin meshes enabled). Restore unmentioned alternate
      // surfaces when switching from a different clip's idle visibility.
      for (const uuid of animatedMeshes) {
        if (entry.covered.has(uuid)) continue;
        const mesh = meshByUuid.get(uuid);
        if (mesh) {
          const track = new THREE.VectorKeyframeTrack(uuid + '.scale', [0], [1,1,1]);
          track.setInterpolation(THREE.InterpolateDiscrete);
          entry.clip.tracks.push(track);
        }
      }
    }
    entry.clip.resetDuration();
    entry.clip.optimize();
  }
  const clips = entries.map(entry => entry.clip);
  // Landing/attack clips can begin airborne or rotated. Start with the
  // authored neutral wait loop when present, retaining every selectable clip.
  clips.sort((a, b) => Number(!/(?:ba10_waita|idle|standby)/i.test(a.name)) -
    Number(!/(?:ba10_waita|idle|standby)/i.test(b.name)));
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
    if (isLegacyFireMask(source)) {
      // This is an auxiliary effect mask, not a visible grey flame shell.
      material.transparent=true;material.opacity=0;
      material.depthWrite=false;material.colorWrite=false;
    }
    return material;
  });
  const rig = buildLegacyRig(root, model.bones);
  for (const geometry of model.meshes) {
    const mesh=threeMesh(geometry, materials, rig);
    if(geometry.groups.every(group=>isLegacyFireMask(model.materials[group.materialIndex])))
      mesh.renderOrder=-10;
    root.add(mesh);
  }
  await loadLegacyRestVisibility(project, selected, root, report);

  // GFBMDL is already Y-up like Three.js. The Blender importer applies
  // +90° X only to convert to Blender's Z-up coordinate system.

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
        // Index metadata once. Keep the bytes for the selected surfaces so
        // matching does not fetch/decode every texture a second time.
        for (const row of known) {
          if (getExtension(row.item.path) !== '.bntx') continue;
          try {
            const bytes = await row.item.getBytes();
            row.internalNames = parseBntx(bytes).textures.map(tex => baseName(tex.name));
            row.item = { ...row.item, getBytes: async () => bytes };
          } catch (error) {
            report('Could not inspect texture ' + row.item.path + ': ' + error.message);
          }
        }
        const renderTextures = async () => {
      for (let i = 0; i < model.materials.length; i++) {
        const definition=model.materials[i];
        if(isLegacyFireMask(definition)){
          continue;
        }
        if(isLegacyFireCore(definition)){
          const map=definition.maps.find(map=>map.sampler==='LerpTex');
          const name=model.textureNames[map?.textureIndex];
          const item=name && findLegacyTexture(name,known);
          try{
            if(!item)throw new Error('Missing native flame gradient '+name);
            const masks=['Blend0Tex','Blend1Tex'].map(sampler=>{
              const map=definition.maps.find(map=>map.sampler===sampler);
              const name=model.textureNames[map?.textureIndex];
              return {name,item:name && findLegacyTexture(name,known)};
            }).filter(mask=>mask.item);
            const maskSource=model.materials.find(source=>isLegacyFireMask(source) &&
              (source.scalars?.MatLinkID ?? 0)===(definition.scalars?.MatLinkID ?? 0));
            const silhouetteMap=maskSource?.maps.find(map=>map.sampler==='Mask1Texture');
            const silhouetteName=model.textureNames[silhouetteMap?.textureIndex];
            const silhouetteItem=silhouetteName && findLegacyTexture(silhouetteName,known);
            const flame=await applyLegacyFire(definition,materials[i],item,name,textureObjects,masks,
              silhouetteItem ? {name:silhouetteName,item:silhouetteItem} : null);
            if(flame.outline)root.traverse(mesh=>{
              if(!mesh.isMesh || !mesh.geometry.groups.length ||
                !mesh.geometry.groups.every(group=>group.materialIndex===i))return;
              const old=mesh.geometry;
              mesh.geometry=closedFlameGeometry(old,flame.outline,i);
              old.dispose();
            });
            report('Applied native flame outline and palette to '+definition.name+'.');
          }catch(error){report('Could not render native fire: '+error.message);}
          continue;
        }
        const match = chooseMap(model.textureNames, model.materials[i]);
        if (!match) continue;
        const referencedName = model.textureNames[match.textureIndex];
        const file = findLegacyTexture(referencedName, known);
        if (!file) {
          report('Could not uniquely match texture ' + referencedName + ' to a local image or BNTX container.');
          continue;
        }
        try {
          const transform = legacyTextureTransform(model.materials[i]);
          const key = file.path + (getExtension(file.path) === '.bntx' ? '|' + referencedName : '') +
            '|' + transform.join(',');
          let texture = textureCache.get(key);
          if (!texture) {
            texture = await loadDecodedTexture(file, true, [referencedName]);
            applyLegacyTextureTransform(texture, transform);
            textureCache.set(key, texture);
            textureObjects.push(texture);
          }
          materials[i].map = texture;
          materials[i].color.setRGB(1, 1, 1);
          materials[i].needsUpdate = true;
          const source = model.materials[i];
          const layer = source.flags?.Layer1Enable && source.maps.find(map =>
            /^LyCol0Tex$/i.test(map.sampler) && map.textureIndex >= 0 &&
            map.textureIndex < model.textureNames.length);
          if (layer) {
            const name = model.textureNames[layer.textureIndex];
            const item = findLegacyTexture(name, known);
            if (item) {
              const iris = await loadDecodedTexture(item, true, [name]);
              applyLegacyTextureTransform(iris, legacyTextureTransform(source, 'Layer1'));
              textureObjects.push(iris);
              const placement=materialUvCenter(model, i);
              applyLegacyEyeLayer(materials[i], iris, textureObjects, report,
                placement.center, placement.inwardDirection);
            } else report('Could not match eye layer ' + name + '.');
          }
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
          readLegacyAnimations(project, selected, rig, root, report)
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
