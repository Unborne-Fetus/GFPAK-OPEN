/** Common decoded Pokémon texture files, including DDS BCn surface data.
 *
 * BNTX is a distinct Nintendo container with its own tiling and formats; do
 * not pretend that passing its bytes to createImageBitmap decodes it.
 */
import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { parseBntx, decodeBntxTexture } from './bntx.js';

/** Browser previews should sample the original full-resolution base image.
 * DataTexture otherwise defaults to nearest-neighbor filtering (pixelated).
 * Compressed BNTX blocks cannot generate mipmaps in Three.js without decode.
 */
export function configurePreviewTexture(texture,{compressed=false}={}) {
  texture.magFilter=THREE.LinearFilter;
  texture.minFilter=compressed ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps=!compressed;
  texture.anisotropy=8;
  texture.needsUpdate=true;
  return texture;
}

function suffix(path) {
  const p = String(path).toLowerCase();
  return p.slice(p.lastIndexOf('.'));
}

export function decodeDDSTexture(bytes, srgb = true) {
  const buffer = bytes instanceof ArrayBuffer ? bytes :
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (buffer.byteLength < 128) throw new Error('DDS header truncated');
  const decoded = new DDSLoader().parse(buffer, true);
  if (!decoded.mipmaps?.length || !decoded.width || !decoded.height || !decoded.format)
    throw new Error('DDS uses an unsupported or invalid texture format');
  if (decoded.width > 16384 || decoded.height > 16384)
    throw new Error('DDS texture dimensions exceed safety limits');
  let texture;
  if (decoded.isRGBAUncompressed) {
    texture = new THREE.DataTexture(
      decoded.mipmaps[0].data, decoded.width, decoded.height, THREE.RGBAFormat
    );
  } else {
    texture = new THREE.CompressedTexture(
      decoded.mipmaps, decoded.width, decoded.height, decoded.format
    );
  }
  texture.generateMipmaps = false;
  texture.minFilter = decoded.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  configurePreviewTexture(texture,{compressed:!decoded.isRGBAUncompressed});
  return texture;
}

function normalizeTextureName(name) {
  return String(name || '').replaceAll('\\', '/').split('/').pop()
    .replace(/\.(?:bntx|dds|png|ktx2)$/i, '').toLowerCase();
}

export function textureVariantFromName(name) {
  const value = String(name || '').replaceAll('\\', '/').split('/').pop().toLowerCase();
  if (/(?:^|[_\-.])(shiny|rare|col(?:or)?[ _-]?0?1|s1)(?:$|[_\-.])/.test(value))
    return 'shiny';
  if (/(?:^|[_\-.])(normal|regular|default|col(?:or)?[ _-]?0?0|s0)(?:$|[_\-.])/.test(value))
    return 'regular';
  return 'regular';
}

function matchesVariantName(name, variant = 'regular') {
  if (variant === 'shiny') return textureVariantFromName(name) === 'shiny';
  return textureVariantFromName(name) !== 'shiny';
}

// Descriptor references often point to the original skin, while a user can
// request its counterpart. Strip only explicit skin identifiers; leave the
// material, species and channel identity intact.
export function textureFamilyName(name) {
  return normalizeTextureName(name)
    .replace(/(^|[_.-])(shiny|rare|regular|default)(?=$|[_.-])/g, '$1')
    .replace(/(^|[_.-])(color|col)[_-]?0?[01](?=$|[_.-])/g, '$1$2')
    .replace(/[_.-]+/g, '_').replace(/^_|_$/g, '');
}

export function textureVariantForItem(item) {
  if (['regular', 'shiny', 'mixed'].includes(item?.textureVariant))
    return item.textureVariant;
  // Container paths are often hash aliases and cannot indicate the surface
  // color. Never let a neutral path turn a shiny-only BNTX into "mixed".
  const names = item?.textureNames?.length ? item.textureNames : [item?.path];
  const hasShiny = names.some(name => textureVariantFromName(name) === 'shiny');
  const hasRegular = names.some(name => matchesVariantName(name, 'regular'));
  return hasShiny && hasRegular ? 'mixed' : hasShiny ? 'shiny' : 'regular';
}

function itemHasVariant(item, variant = 'regular') {
  const type = textureVariantForItem(item);
  return type === 'mixed' || type === variant || (variant === 'regular' && type !== 'shiny');
}

/** Resolve real texture names from multi-surface Nintendo BNTX containers. */
export async function loadDecodedTexture(item, srgb = true, preferredNames = [], options = {}) {
  const variant = options.variant || 'regular';
  const format = suffix(item.path);
  const data = await item.getBytes();
  if (format === '.bntx') {
    const archive = parseBntx(data);
    const names = (Array.isArray(preferredNames) ? preferredNames : [preferredNames])
      .map(normalizeTextureName).filter(Boolean);
    const searchTextures = archive.textures.filter(tex => matchesVariantName(tex.name, variant));
    if (!searchTextures.length)
      throw new Error('No '+variant+' texture surface is present in this BNTX');
    const matched = searchTextures.filter(tex => names.includes(normalizeTextureName(tex.name)));
    const families = new Set(names.map(textureFamilyName));
    const familyMatches = searchTextures.filter(tex => families.has(textureFamilyName(tex.name)));
    const chosen = matched.length ? matched : familyMatches;
    if (chosen.length > 1) throw new Error('Several BNTX textures match the requested material');
    if (!chosen.length && searchTextures.length !== 1) {
      throw new Error('BNTX contains ' + archive.textures.length +
        ' textures; select a matching internal texture name (no uniquely matching '+variant+' surface for this material)');
    }
    const surfaceIndex = chosen[0]?.index ?? searchTextures[0].index;
    const decoded = decodeBntxTexture(archive, surfaceIndex);
    // BC5 normal maps store only X/Y. Reconstruct positive Z before Three.js
    // expands RGB from [0,1] to a tangent-space normal in [-1,1].
    if (!srgb && archive.textures[surfaceIndex].format >>> 8 === 0x1e &&
        /(?:normal|_nrm)(?:[._]|$)/i.test([item.path,...preferredNames].join(' '))) {
      for (let i=0;i<decoded.data.length;i+=4) {
        const x=decoded.data[i]/127.5-1, y=decoded.data[i+1]/127.5-1;
        decoded.data[i+2]=Math.round((Math.sqrt(Math.max(0,1-x*x-y*y))+1)*127.5);
      }
    }
    let texture;
    if (decoded.compressed) {
      const gpuFormat = decoded.compressed === 'bc7'
        ? THREE.RGBA_BPTC_Format
        : THREE['RGBA_ASTC_' + decoded.blockWidth + 'x' + decoded.blockHeight + '_Format'];
      if (!gpuFormat) throw new Error('This browser does not recognize the native BNTX compression format');
      texture = new THREE.CompressedTexture(
        [{data:decoded.data,width:decoded.width,height:decoded.height}],
        decoded.width, decoded.height, gpuFormat
      );
      // BPTC / ASTC textures require corresponding WebGL GPU extensions.
      // THREE uploads the original deswizzled blocks without fabricating pixels.
    } else {
      texture = new THREE.DataTexture(decoded.data, decoded.width, decoded.height, THREE.RGBAFormat);
      texture.flipY = false;
    }
    texture.name = decoded.name || item.path;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    configurePreviewTexture(texture,{compressed:!!decoded.compressed});
    return texture;
  }
  if (format === '.trtex')
    throw new Error('TRTEX texture needs its game-specific layout; no texture was guessed');
  if (format === '.dds') {
    const texture = decodeDDSTexture(data, srgb);
    texture.name = item.path;
    return texture;
  }
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(format))
    throw new Error('Not a supported decoded image type: ' + format);
  const image = await createImageBitmap(new Blob([data]));
  const texture = new THREE.Texture(image);
  texture.name = item.path;
  texture.flipY = true;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  configurePreviewTexture(texture);
  return texture;
}

/** Pick only a demonstrably related base-color image for a native material.
 *
 * If shader references are missing, map a linked image to a material by
 * an unambiguous filename match, or use the sole linked color image when the
 * model has exactly one material. Never substitute normal/roughness maps for
 * a diffuse skin, or choose arbitrarily between multiple texture variants.
 */
const diffuseSuffixes=['diffuse','color','basecolor','base','albedo','alb','col','skin'];
function trimMaterialName(value) {
  return String(value||'').toLowerCase()
    .replace(/(?:material|_mat)$/i,'').replace(/[^a-z0-9]/g,'');
}
function trimTextureSurface(value){
  return String(value||'').replaceAll('\\','/').split('/').at(-1)
    .replace(/\.(?:bntx|dds|png|ktx2|webp|jpe?g)$/i,'')
    .replace(/^pm\d{4}(?:_\d{2}){0,2}[_-]?/i,'')
    .replace(/[^a-z0-9]/gi,'').toLowerCase();
}
/** A multi-surface BNTX may be stored under a hash. Use its *real internal*
 * surface names and accept only a single demonstrably matching diffuse map.
 */
export function matchingLinkedDiffuseSurface(item,materialName,variant='regular') {
  const key=trimMaterialName(materialName);
  if(!key||key.length<3)return null;
  const names=(item.textureNames||[]).filter(value=>matchesVariantName(value,variant));
  const matched=names.filter(value=>{
    const v=trimTextureSurface(value);
    return v===key||diffuseSuffixes.some(s=>v===key+s);
  });
  return matched.length===1?matched[0]:null;
}

export function matchingLinkedDiffuseTexture(items, materialName, materialCount = 1, variant = 'regular') {
  const linked = items.filter(item => item.linkedKind === 'texture' &&
    /\.(bntx|dds|png|jpe?g|webp)$/i.test(item.path) && itemHasVariant(item, variant));
  const diffuse = linked.filter(item => {
    const name = item.path.replaceAll('\\', '/').split('/').at(-1)
      .replace(/\.[^.]+$/, '').toLowerCase();
    return !/(?:^|[_-])(normal|nrm|rough|metal|mask|alpha|orm|occlusion|ao|emissive|emission)(?:$|[_-])/i.test(name);
  });
  const key=trimMaterialName(materialName);
  const internal=diffuse.filter(item=>matchingLinkedDiffuseSurface(item,materialName,variant));
  if(internal.length===1)return internal[0];
  if(internal.length>1)return null;
  if (key.length >= 3) {
    const candidates = diffuse.filter(item => {
      const basename = item.path.replaceAll('\\', '/').split('/').at(-1)
        .replace(/\.[^.]+$/, '').toLowerCase()
        .replace(/^pm\d{4}(?:_\d\d){0,2}_?/, '');
      const stem = basename.replace(/[^a-z0-9]/g, '');
      return stem === key || stem.startsWith(key + 'diffuse') ||
        stem.startsWith(key + 'color') || stem.startsWith(key + 'base');
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return null;
  }
  return materialCount === 1 && diffuse.length === 1 ? diffuse[0] : null;
}
