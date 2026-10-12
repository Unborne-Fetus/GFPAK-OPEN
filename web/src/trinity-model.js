import {
  loadDecodedTexture, matchingLinkedDiffuseTexture, matchingLinkedDiffuseSurface,
  textureVariantForItem
} from './texture-loader.js';
import { applyLayerColors } from './trinity-layer-colors.js';
import { associatedNativeAnimations } from './animation-association.js';
/**
 * Resolve companion Trinity model files and construct Three.js meshes.
 * This path requires a readable .trmdl/.trmsh with the matching .trmbf.
 *
 * Original Pokémon shader permutations and many console texture variants
 * remain unsupported. Standard BNTX, PNG, JPEG and DDS inputs are decoded.
 */
import * as THREE from 'three';
import {
  TrinityError, parseTrmdl, parseTrmsh, parseTrmbf,
  parseTrmtr, parseTrskl, decodeTrinityMeshes
} from './trinity.js';
import { bakeNativeDisplacement, animateNativeDisplacement } from './trinity-displacement.js';
import { parseMeshVisibility } from './trinity-visibility.js';
import { parseNativeAnimation } from './trinity-animation.js';

const MAX_BYTES = 450 * 1024 * 1024;
const TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.dds', '.bntx']);

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
  const sourceFilename = basename(sourceRef);
  const expected = suffix || (sourceFilename.includes('.') ? ext(sourceFilename) : '');
  // PLA TRMDL/TRMSH resources often reference bare names such as "head".
  // The recovered archive project must retain actual .trmsh/.trmbf types,
  // so resolve the reference with its requested extension when omitted.
  const filename = sourceFilename && expected && !sourceFilename.endsWith(expected)
    ? sourceFilename + expected : sourceFilename;
  let candidates = list.filter(item => expected ? ext(item.path) === expected : true);
  if (!filename && !expected) {
    if (required) throw new TrinityError('Missing Trinity model resource filename');
    return null;
  }
  const baseDir = dirname(basePath);
  const normalizedRef = normalized(baseDir + (filename && filename!==sourceFilename ? rawRef+expected : rawRef));
  const exact = candidates.filter(item =>
    normalized(item.path) === normalizedRef || normalized(item.path) === sourceRef);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new TrinityError('Ambiguous companion model path: ' + ref);
  // A GFPAK descriptor can reference "head" while its filename-hash
  // dictionary resolves the mesh to an unrelated canonical pathname.
  // The scanner records the real descriptor association independently.
  const aliased=candidates.filter(item=>(item.nativeAliases||[]).some(alias=>{
    const token=normalized(alias);
    return token===sourceRef || token===normalizedRef || basename(token)===filename;
  }));
  if(aliased.length===1)return aliased[0];
  if(aliased.length>1)throw new TrinityError('Ambiguous descriptor companion '+ref);
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

function normalizeMaterialName(value) {return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');}

function findOptionalTexture(project, name, parentPath, variant='regular') {
  if (!name) return null;
  const candidate = basename(name).replace(/\.(bntx|bntx\.gz|dds|ktx2)$/i, '');
  if (!candidate) return null;
  const related = project.items.filter(item => item.linkedKind === 'texture' &&
    TEXTURE_EXT.has(ext(item.path)) &&
    (textureVariantForItem(item) === 'mixed' || textureVariantForItem(item) === variant ||
      (variant === 'regular' && textureVariantForItem(item) !== 'shiny')));
  const exact = item => stem(item.path) === candidate ||
    basename(item.path).startsWith(candidate + '.');
  const matchesSurface = item => (item.textureNames||[]).some(value =>
    stem(value)===candidate || basename(value)===candidate ||
    normalizeMaterialName(value)===normalizeMaterialName(candidate));
  const matched = related.filter(item=>exact(item)||matchesSurface(item));
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) return null;
  const nearby = project.items.filter(item => TEXTURE_EXT.has(ext(item.path)) &&
    exact(item));
  const nearest = nearby.filter(item => dirname(item.path) === dirname(parentPath));
  if (nearest.length === 1) return nearest[0];
  if (nearby.length === 1) return nearby[0];
  if (nearby.length) return null;
  // Explicitly linked texture can be stored under a different filename or in
  // another GFPAK. If there is only one, let its real image/BNTX decoder
  // validate the requested internal surface before applying it.
  if (related.length === 1) return related[0];
  const packed = project.items.filter(item =>
    ext(item.path) === '.bntx' && dirname(item.path) === dirname(parentPath));
  return packed.length === 1 ? packed[0] : null;
}

export function createMaterials(materials) {
  const lookup = new Map();
  for (const definition of materials) {
    for (const info of definition.materials) {
      const eyeHighlight = info.textures?.some(t => /^HighlightMaskMap$/i.test(t.name));
      const shader = info.shaders?.[0];
      const unlit = /^(NonDirectional|Unlit)$/i.test(shader?.name || '');
      const Material = unlit ? THREE.MeshBasicMaterial : eyeHighlight ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
      const mat = new Material({
        name: info.name || 'Trinity material',
        color: 0xd9e0e7, side: info.faceCulling === 1 ? THREE.BackSide : info.faceCulling === 2 ? THREE.DoubleSide : THREE.FrontSide,
        ...(!unlit ? {roughness: Number.isFinite(info.scalars?.Roughness) ? info.scalars.Roughness : 0.8,
        metalness: 0.0} : {}), ...(eyeHighlight ? {clearcoat:1,clearcoatRoughness:0.1} : {})
      });
      mat.userData.nativeVertexColor = shader?.flags?.EnableVertexBaseColor === 'True' || shader?.flags?.EnableVertexColor === 'True';
      mat.transparent = !!info.alphaType && !/opaque/i.test(info.alphaType);
      mat.depthWrite = !mat.transparent;
      if (shader?.flags?.EnableAlphaTest === 'True') mat.alphaTest = info.scalars?.DiscardValue || 0.5;
      lookup.set(info.name.toLowerCase(), { material: mat, textures: info.textures,
        colors: info.colors, scalars: info.scalars, shader });
    }
  }
  return lookup;
}

export async function applyDecodedTextures(project, lookup, modelPath, report, created, options = {}) {
  const requestedVariant = options.textureVariant || 'regular';
  const channels = [
    { names: /^(basecolormap|basemap|diffusemap|albedomap|color0map)$/i, property: 'map', srgb: true },
    { names: /^displacementmap$/i, property: 'nativeDisplacementMap', srgb: false },
    { names: /^layermaskmap$/i, property: 'layerMaskMap', srgb: false },
    { names: /^normalmap\d*$/i, property: 'normalMap', srgb: false },
    { names: /^roughnessmap\d*$/i, property: 'roughnessMap', srgb: false },
    { names: /^metallicmap\d*$/i, property: 'metalnessMap', srgb: false },
    { names: /^aomap$/i, property: 'aoMap', srgb: false },
    { names: /^(emissivemap|emissionmap)$/i, property: 'emissiveMap', srgb: true },
    { names: /^highlightmaskmap$/i, property: 'emissiveMap', srgb: false, highlight:true },
  ];
  const textureCache = new Map();
  for (const [materialName, definition] of lookup.entries()) {
    const textures = definition.textures ?? [];
    if (!textures.length) continue;
    for (const channel of channels) {
      const reference = textures.find(t => channel.names.test(t.name));
      const selected = reference || (channel.property === 'map' && textures.length === 1 &&
        !/(normal|mask|rough|metal|occlusion|ao|emissive|emission)/i.test(textures[0].name) &&
        !/(?:_|-)(nrm|lym|msk|ao)(?:\.|$)/i.test(textures[0].file) ? textures[0] : null);
      if (!selected) continue;
      const variant = (channel.property === 'map' || channel.property === 'emissiveMap')
        ? requestedVariant : 'regular';
      const textureItem = findOptionalTexture(project, selected.file, modelPath, variant);
      if (!textureItem) {
        report('No decoded image for ' + selected.file + ' (' + materialName + ')');
        continue;
      }
      try {
        const requestedNames = [selected.file, selected.name];
        const uv = definition.colors?.[channel.property === 'normalMap'
          ? 'UVScaleOffsetNormal' : channel.property === 'nativeDisplacementMap' ? 'UVScaleOffset3' : channel.highlight ? 'UVScaleOffset1' : 'UVScaleOffset'];
        const cacheKey = textureItem.path + '|' + (uv?.join(',') || '') + '|' + channel.srgb +
          (ext(textureItem.path) === '.bntx' ? '|' + requestedNames.join('|') : '');
        let texture = textureCache.get(cacheKey);
        if (!texture) {
          texture = await loadDecodedTexture(textureItem, channel.srgb, requestedNames, {variant});
          textureCache.set(cacheKey, texture);
          created.push(texture);
        }
        texture.name = selected.file || selected.name || channel.property;
        if (uv?.length === 4 && uv.every(Number.isFinite) &&
            texture.image.width !== texture.image.height) {
          texture.repeat.set(uv[0], uv[1]);
          texture.offset.set(uv[2], uv[3]);
          if (uv[0] > 1) texture.wrapS = THREE.MirroredRepeatWrapping;
          texture.updateMatrix();
        }
        const material = definition.material;
        if (channel.property === 'nativeDisplacementMap') definition.displacementMap = texture;
        else if (channel.property === 'layerMaskMap') definition.layerMaskMap = texture;
        else material[channel.property] = texture;
        if (channel.property === 'map') material.color.setRGB(1, 1, 1);
        if (channel.property === 'emissiveMap') {
          const color = definition.colors?.[channel.highlight ? 'EmissionColorLayer5' : 'EmissionColor'];
          material.emissive.setRGB(...(color?.slice(0,3) || [1,1,1]));
          const intensity = definition.scalars?.[channel.highlight ? 'EmissionIntensityLayer5' : 'EmissionIntensity'];
          material.emissiveIntensity = Number.isFinite(intensity) ? intensity : 1;
        }
        material.needsUpdate = true;
      } catch (error) {
        report('Could not decode texture ' + textureItem.path + ': ' + error.message);
      }
    }
  }
  for (const definition of lookup.values()) {
    applyLayerColors(definition, created, report);
  }
  return Array.from(textureCache.values()).map(texture => texture.image).filter(image => image?.close);
}

async function applyMatchedLinkedTextures(project, root, report, created, options = {}) {
  const variant = options.textureVariant || 'regular';
  const materials = new Set();
  root.traverse(object => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ?
      object.material : [object.material]) {
      if (material) materials.add(material);
    }
  });
  const loaded = new Map(), images = new Set();
  for (const material of materials) {
    if (material.map) continue;
    const item = matchingLinkedDiffuseTexture(
      project.items, material.name, materials.size, variant);
    if (!item) continue;
    try {
      let texture = loaded.get(item.path);
      if (!texture) {
        // A multi-surface BNTX must still match the real material's
        // surface name, otherwise the decoder rejects applying a guess.
        const matchingSurface=matchingLinkedDiffuseSurface(item,material.name,variant);
        texture = await loadDecodedTexture(item, true, matchingSurface ?
          [matchingSurface] : [material.name], {variant});
        loaded.set(item.path, texture);
        created.push(texture);
        if (texture.image?.close) images.add(texture.image);
      }
      material.map = texture;
      material.color.setRGB(1, 1, 1);
      material.needsUpdate = true;
      report('Automatically applied linked texture ' + item.path +
        ' to material ' + material.name + '.');
    } catch (error) {
      report('Linked texture ' + item.path +
        ' could not be applied: ' + (error.message || error));
    }
  }
  return [...images];
}

export class NativeBone extends THREE.Bone {
  constructor() {
    super();
    this.segmentScaleCompensate = false;
    this.inverseParentScale = new THREE.Matrix4();
  }
  updateMatrix() {
    super.updateMatrix();
    if (this.segmentScaleCompensate && this.parent?.isBone) {
      const scale = this.parent.scale;
      const inverse = value => Math.abs(value) > 1e-10 ? 1/value : 1;
      this.inverseParentScale.makeScale(inverse(scale.x),inverse(scale.y),inverse(scale.z));
      // Compensation applies to the joint basis, after translation (T*IS*R*S).
      // Cancelling the translation prevents scaled chains from retracting.
      this.matrix.premultiply(this.inverseParentScale);
      this.matrix.setPosition(this.position);
    }
  }
}

export function buildBones(trskl, sceneRoot) {
  if (!trskl?.bones?.length) return null;
  const bones = trskl.bones.map(info => {
    const bone = new NativeBone();
    bone.segmentScaleCompensate = !!trskl.joints?.[info.jointInfoIndex]?.segmentScaleCompensate;
    bone.name = info.name;
    bone.position.fromArray(info.translation);
    // Native extrinsic X -> Y -> Z rotations compose as qZ*qY*qX.
    bone.rotation.set(...info.rotation, 'ZYX');
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
  for (const info of trskl.bones) {
    const axes = trskl.joints?.[info.jointInfoIndex]?.inverseBind;
    if (axes?.length === 4 && axes.every(a => a.length === 3 && a.every(Number.isFinite))) {
      const matrix = new THREE.Matrix4().fromArray([
        ...axes[0],0,...axes[1],0,...axes[2],0,...axes[3],1]);
      if (Math.abs(matrix.determinant()) > 1e-10) rig.boneInverses[info.index] = matrix;
    }
  }
  const jointNodes = new Map();
  for (const info of trskl.bones) {
    if (info.jointInfoIndex >= 0) {
      if (jointNodes.has(info.jointInfoIndex)) jointNodes.set(info.jointInfoIndex, -1);
      else jointNodes.set(info.jointInfoIndex, info.index);
    }
  }
  return { bones, rig, jointNodes };
}

export function makeMesh(part, material, skeletonInfo) {
  const vertices = part.vertices;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices.position, 3));
  if (vertices.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(vertices.normal, 3));
  if (vertices.uv) {
    // Native Trinity coordinates use the opposite V origin from the GL
    // sampling convention. Flip the coordinates once for every material map,
    // including BC7/ASTC blocks which cannot be flipped on texture upload.
    const uv = vertices.uv.slice();
    for (let i=1;i<uv.length;i+=2) uv[i]=1-uv[i];
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  if (vertices.uv1) {
    const uv = vertices.uv1.slice();
    for (let i=1;i<uv.length;i+=2) uv[i]=1-uv[i];
    geometry.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
  }
  if (vertices.color?.length === vertices.count * 4) {
    geometry.setAttribute('color', new THREE.BufferAttribute(vertices.color, 4));
    material.vertexColors = material.userData.nativeVertexColor === true;
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
        // Vertex IDs address TRSKL jointInfoIndex, not the node array.
        // TRMSH boneWeights summarizes influences; its order is not a palette.
        const actual = skeletonInfo.jointNodes.size
          ? (skeletonInfo.jointNodes.get(local) ?? -1) : local;
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
      mesh.bind(skel, new THREE.Matrix4());
      mesh.frustumCulled = false;
      return mesh;
    }
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = part.name + (part.material ? ':' + part.material : '');
  mesh.frustumCulled = false;
  return mesh;
}

function normalizeBoneName(name) {
  return String(name).split(/[/:|\\]/).at(-1).toLowerCase().trim();
}

export function animationTracks(source, bones) {
  // Identically named bones can occur in separate rig branches. Skip
  // ambiguous names instead of silently retargeting a clip to the last one.
  const lookup = new Map();
  for (const bone of bones) {
    const name = normalizeBoneName(bone.name);
    if (!lookup.has(name)) lookup.set(name, bone);
    else lookup.set(name, null);
  }
  const frameRate = Number.isFinite(source.frameRate) && source.frameRate > 0
    ? source.frameRate : 30;
  const tracks = [];
  const occupied = new Set();
  for (const channel of source.tracks) {
    const bone = lookup.get(normalizeBoneName(channel.bone));
    if (!bone) continue;
    for (const [kind, property, width] of [
      ['translation', 'position', 3], ['rotation', 'quaternion', 4], ['scale', 'scale', 3]
    ]) {
      const keys = channel[kind];
      if (!keys?.length) continue;
      const key = bone.uuid + ':' + property;
      if (occupied.has(key)) continue;
      const valid = keys.filter(row => Number.isFinite(row.frame) && row.frame >= 0 &&
        row.value?.length === width && row.value.every(Number.isFinite));
      if (!valid.length) continue;
      const times = valid.map(row => row.frame / frameRate);
      const values = [];
      let previous = null;
      for (const row of valid) {
        const vector = row.value.slice();
        if (property === 'quaternion') {
          const magnitude = Math.hypot(...vector);
          if (magnitude < 1e-9) continue;
          for (let i = 0; i < 4; i++) vector[i] /= magnitude;
          // q and -q encode the same pose, but sudden sign changes can
          // interpolate through the long rotation arc.
          if (previous && vector.reduce((sum, v, i) => sum + v * previous[i], 0) < 0) {
            for (let i = 0; i < 4; i++) vector[i] = vector[i] === 0 ? 0 : -vector[i];
          }
          previous = vector.slice();
        }
        values.push(...vector);
      }
      if (values.length !== times.length * width) continue;
      const path = bone.name + '.' + property;
      const track = property === 'quaternion'
        ? new THREE.QuaternionKeyframeTrack(path, times, values)
        : new THREE.VectorKeyframeTrack(path, times, values);
      tracks.push(track);
      occupied.add(key);
    }
  }
  if (!tracks.length) return null;
  const duration = source.frameCount > 1 ? (source.frameCount - 1) / frameRate : -1;
  const clip = new THREE.AnimationClip(source.name, duration, tracks);
  if (!clip.validate()) return null;
  clip.optimize();
  return clip;
}

async function loadNativeClips(project, selected, skeleton, report, scene) {
  if (!skeleton?.bones?.length) return [];
  const compatible = associatedNativeAnimations(project.items, selected, report);
  const clips = [];
  const available = project.items.filter(item => ['.tranm', '.gfbanm'].includes(ext(item.path))).length;
  if (available > compatible.length) {
    report('Found ' + available + ' native animation files; selected ' + compatible.length +
      ' likely companions for this Pokémon rather than scanning unrelated species.');
  }
  for (const item of compatible) {
    try {
      const native = parseNativeAnimation(await bytesFor(item), basename(item.path));
      const clip = animationTracks(native, skeleton.bones);
      if (clip) {
        const companion = findResource(project, item.path.replace(/\.(tranm|gfbanm)$/i,'.tracm'), '', '.tracm', false);
        if (companion) {
          try {
            for (const channel of parseMeshVisibility(await bytesFor(companion))) {
              scene.traverse(mesh => {
                if (!mesh.isMesh || mesh.name.split(':')[0] !== channel.name) return;
                clip.tracks.push(new THREE.BooleanKeyframeTrack(mesh.uuid+'.visible',
                  channel.frames.map(frame=>frame/native.frameRate),channel.values));
                // Preserve authored idle visibility even before playback starts.
                if (/defaultwait|battlewait|idle/i.test(item.path) && channel.frames[0] === 0 &&
                    !mesh.userData.nativeIdleVisibility) {
                  mesh.visible = channel.values[0];
                  mesh.userData.nativeIdleVisibility = true;
                }
              });
            }
          } catch (error) { report('Mesh visibility skipped: '+error.message); }
        }
        clips.push(clip);
      }
    } catch (error) {
      report('Native animation ' + basename(item.path) + ' skipped: ' + error.message);
    }
  }
  return clips;
}

/**
 * Some Switch TRMDL versions omit skeleton/material references entirely, while
 * the files still exist as hashed GFPAK siblings. Recover only validated,
 * unambiguous companions from the selected Pokémon project.
 */
async function recoverTrinitySkeleton(project, selected, reference, report) {
  const candidates=project.items.filter(item=>ext(item.path)==='.trskl');
  if(reference){
    try {
      const explicit=findResource(project,reference,selected,'.trskl',false);
      if(explicit){
        const parsed=parseTrskl(await bytesFor(explicit));
        if(parsed.bones?.length){
          report('Verified skeleton reference '+reference+': '+parsed.bones.length+' bones.');
          return parsed;
        }
      }
    }catch(error){report('Referenced skeleton could not be decoded: '+error.message);}
  }
  const parsed=[];
  for(const item of candidates.slice(0,48)){
    try{
      const value=parseTrskl(await bytesFor(item));
      if(!value.bones?.length || value.bones.some(b=>!b.name ||
        (b.parent>=value.bones.length)||(b.parent===b.index)))continue;
      parsed.push({item,value});
    }catch(error){report('Skipped invalid skeleton '+item.path+': '+error.message);}
  }
  if(parsed.length===1){
    report('Recovered unambiguous '+parsed[0].value.bones.length+
      '-bone skeleton from '+parsed[0].item.path+' (model did not identify its rig).');
    return parsed[0].value;
  }
  if(!parsed.length)
    report('No valid TRSKL rig available for this model; bones and skeletal clips cannot load.');
  else report('Found '+parsed.length+
    ' valid TRSKL rigs without a unique model reference; skipping unsafe rig substitution.');
  return null;
}

async function recoverTrinityMaterials(project, selected, references, parts, report) {
  const sourceNames=new Set(parts.map(part=>normalizeMaterialName(part.material)).filter(Boolean));
  const entries=project.items.filter(item=>ext(item.path)==='.trmtr');
  const byPath=new Set();
  for(const ref of references){
    try {
      const entry=findResource(project,ref,selected,'.trmtr',false);
      if(entry)byPath.add(entry.path);
    }catch(error){report('Material reference '+ref+' cannot be resolved: '+error.message);}
  }
  const parsed=[];
  for(const item of entries.slice(0,48)){
    try{
      const data=parseTrmtr(await bytesFor(item));
      if(!data.materials?.length)continue;
      const names=new Set(data.materials.map(m=>normalizeMaterialName(m.name)));
      const overlap=[...sourceNames].filter(n=>names.has(n)).length;
      if(byPath.has(item.path)||overlap>0)parsed.push({item,data,overlap,explicit:byPath.has(item.path)});
    }catch(error){report('Skipped invalid TRMTR '+item.path+': '+error.message);}
  }
  if(!parsed.length && entries.length===1){
    try{
      const data=parseTrmtr(await bytesFor(entries[0]));
      if(data.materials?.length){
        parsed.push({item:entries[0],data,overlap:0,explicit:false});
        report('Recovered sole material definition '+entries[0].path+'.');
      }
    }catch(error){report('Material definition could not be decoded: '+error.message);}
  }
  for(const item of parsed)report('Matched '+item.data.materials.length+
    ' material definition(s) from '+item.item.path+
    (item.explicit?' by model reference':' by mesh material names')+'.');
  if(!parsed.length)report('No matching TRMTR definition: using neutral materials until a compatible source is found.');
  return parsed.map(item=>item.data);
}

/**
 * Resolve native Trinity .trmdl and companions inside ZIPs or directories,
 * render geometry/decoded textures, and export through regular GLTFExporter.
 */
export async function loadTrinityModel(project, selected, report = () => {}, options = {}) {
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
  // LOD meshes are alternate versions of the same surface. Drawing all of
  // them at once overlays three skins and produces flicker during animation.
  const primaryMeshes = meta.meshFiles.filter(ref => !/[_-]lod[1-9]\d*(?:\.|$)/i.test(ref));
  for (const meshRef of primaryMeshes.length ? primaryMeshes : meta.meshFiles) {
    const shape = suffix === '.trmsh'
      ? entry
      : findResource(project, meshRef, selected, '.trmsh');
    const trmsh = parseTrmsh(await bytesFor(shape));
    const buffer = findResource(project, trmsh.bufferFile, shape.path, '.trmbf');
    const trmbf = parseTrmbf(await bytesFor(buffer));
    parts.push(...decodeTrinityMeshes(trmsh, trmbf));
  }
  if (!parts.length) throw new TrinityError('No renderable Trinity geometry was decoded');

  const skeleton=await recoverTrinitySkeleton(project,selected,meta.skeleton,report);
  const materialDefs=await recoverTrinityMaterials(project,selected,meta.materials,parts,report);
  const lookup=createMaterials(materialDefs);
  const created = [];
  let sourceImages = [];
  const scene = new THREE.Group();
  scene.name = basename(selected);
  const rig = buildBones(skeleton, scene);
  const defaults = new Map();
  for (const part of parts) {
    const name = (part.material || '').toLowerCase();
    let material = lookup.get(name)?.material ||
      [...lookup.entries()].find(([key])=>normalizeMaterialName(key)===normalizeMaterialName(name))?.[1].material;
    if (!material) {
      if (!defaults.has(name)) defaults.set(name, new THREE.MeshStandardMaterial({
        name: part.material || 'Unassigned material', color: 0xd9e0e7,
        roughness: 0.8, side: THREE.DoubleSide
      }));
      material = defaults.get(name);
    }
    scene.add(makeMesh(part, material, rig));
  }
  const animations = [];
  let disposed = false;
  let extrasPromise = null;
  let released = false;
  const releaseTextures = () => {
    if (released) return;
    released = true;
    for (const texture of created) texture.dispose();
    for (const image of sourceImages) image.close?.();
  };
  const postLoad = () => {
    if (disposed) return Promise.resolve([]);
    if (!extrasPromise) {
      // Meshes and bones are already ready to draw. Fetch optional textures
      // and animation clips after the first 3D frame instead of making users
      // wait on dozens of unrelated game assets.
      extrasPromise = (async () => {
        const [images, clips] = await Promise.all([
          (async () => {
            const images = await applyDecodedTextures(
              project, lookup, selected, report, created, options);
            if (!disposed) bakeNativeDisplacement(scene, lookup, report);
            const fallbackImages = await applyMatchedLinkedTextures(
              project, scene, report, created, options);
            return images.concat(fallbackImages);
          })(),
          loadNativeClips(project, selected, rig, report, scene),
        ]);
        sourceImages = images;
        if (!disposed) {
          await animateNativeDisplacement(scene, lookup, project, clips, report);
          animations.push(...clips);
        }
        report('Finished ' + created.length + ' texture(s) and ' +
          clips.length + ' native animation clip(s).');
        return animations;
      })();
      extrasPromise.finally(() => { if (disposed) releaseTextures(); }).catch(() => {});
    }
    return extrasPromise;
  };
  const vCount = parts.reduce((sum, p) => sum + p.vertices.count, 0);
  report('Decoded ' + parts.length + ' Trinity mesh parts / ' + vCount.toLocaleString() +
    ' vertices' + (rig ? ' / ' + rig.bones.length + ' skeleton bones' : '') +
    (options.fastPreview ? '. Geometry ready; loading textures and animations next.' :
      '. Loading native textures and animations.') +
    ' Game-native shaders and some texture/track variants still require more support.');
  const result = {
    root: scene, animations, selected,
    sourceFormat: 'TRMDL',
    sourceStats: { meshParts: parts.length, vertices: vCount, bones: rig?.bones.length ?? 0 },
    disposeAssets: () => {
      disposed = true;
      if (extrasPromise) extrasPromise.finally(releaseTextures).catch(() => {});
      else releaseTextures();
    }
  };
  if (options.fastPreview) {
    result.postLoad = postLoad;
  } else {
    await postLoad();
  }
  return result;
}
