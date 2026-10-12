/** Common decoded Pokémon texture files, including DDS BCn surface data.
 *
 * BNTX is a distinct Nintendo container with its own tiling and formats; do
 * not pretend that passing its bytes to createImageBitmap decodes it.
 */
import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { parseBntx, decodeBntxTexture } from './bntx.js';

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
  texture.needsUpdate = true;
  return texture;
}

function normalizeTextureName(name) {
  return String(name || '').replaceAll('\\', '/').split('/').pop()
    .replace(/\.(?:bntx|dds|png|ktx2)$/i, '').toLowerCase();
}

/** Resolve real texture names from multi-surface Nintendo BNTX containers. */
export async function loadDecodedTexture(item, srgb = true, preferredNames = []) {
  const format = suffix(item.path);
  const data = await item.getBytes();
  if (format === '.bntx') {
    const archive = parseBntx(data);
    const names = (Array.isArray(preferredNames) ? preferredNames : [preferredNames])
      .map(normalizeTextureName).filter(Boolean);
    const matched = archive.textures.filter(tex => names.includes(normalizeTextureName(tex.name)));
    if (matched.length > 1) throw new Error('Several BNTX textures match the requested name');
    if (!matched.length && archive.textures.length !== 1) {
      throw new Error('BNTX contains ' + archive.textures.length +
        ' textures; select a matching internal texture name rather than guessing the first');
    }
    const decoded = decodeBntxTexture(archive, matched[0]?.index ?? 0);
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
      texture.flipY = true;
    }
    texture.name = decoded.name || item.path;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.needsUpdate = true;
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
  texture.needsUpdate = true;
  return texture;
}
