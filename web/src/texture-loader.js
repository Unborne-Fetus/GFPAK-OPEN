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

export async function loadDecodedTexture(item, srgb = true) {
  const format = suffix(item.path);
  const data = await item.getBytes();
  if (format === '.bntx') {
    const decoded = decodeBntxTexture(parseBntx(data), 0);
    const texture = new THREE.DataTexture(decoded.data, decoded.width, decoded.height, THREE.RGBAFormat);
    texture.name = decoded.name || item.path;
    texture.flipY = true;
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
