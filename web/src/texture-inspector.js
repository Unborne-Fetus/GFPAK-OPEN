/** Standalone local Nintendo texture inspection, without requiring a mesh.
 * A BNTX may contain many independently named surfaces. Unsupported formats
 * remain visible in the inventory, and never become fabricated RGBA pixels.
 */
import * as THREE from 'three';
import {parseBntx, decodeBntxTexture} from './bntx.js';

const IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']
]);
const MAX_INPUT = 256 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
const extension = path => '.' + String(path).split('.').at(-1).toLowerCase();

export function isInspectableTexture(path) {
  return extension(path) === '.bntx' || IMAGE_MIME.has(extension(path));
}

export function inspectTexture(bytes, filename) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!input.byteLength || input.byteLength > MAX_INPUT)
    throw new Error('Texture container is empty or exceeds the 256 MiB preview limit');
  const kind = extension(filename);
  if (kind === '.bntx') {
    const archive = parseBntx(input);
    if (!archive.textures.length) throw new Error('BNTX container has no surfaces');
    return {
      kind: 'bntx', filename, archive,
      surfaces: archive.textures.map(tex => ({
        index: tex.index, name: tex.name || 'Surface ' + (tex.index + 1),
        width: tex.width, height: tex.height, format: tex.format,
        mips: tex.mips
      }))
    };
  }
  if (!IMAGE_MIME.has(kind)) throw new Error('Unsupported standalone texture: ' + kind);
  return {
    kind: 'image', filename, bytes: input, mime: IMAGE_MIME.get(kind),
    surfaces: [{index:0,name:String(filename).split(/[\\/]/).at(-1)}]
  };
}

function outputName(name, index, surfaceName) {
  const namePart = String(name).replaceAll('\\', '/').split('/').at(-1)
    .replace(/\.[^.]+$/, '');
  const surface = String(surfaceName || '').replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 90);
  return (namePart + (surface ? '_' + surface : '_' + index))
    .replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 170) + '.png';
}

export function texturePngName(info, index) {
  return outputName(info.filename, index, info.surfaces[index]?.name);
}

function compressedFormat(decoded) {
  return decoded.compressed === 'bc7' ? THREE.RGBA_BPTC_Format
    : THREE['RGBA_ASTC_' + decoded.blockWidth + 'x' + decoded.blockHeight + '_Format'];
}

/** Render one texture to a new canvas. Returns a teardown function so repeated
 * previews do not leak WebGL contexts. BC7/ASTC uses the user's GPU only if
 * the necessary WebGL extension is available.
 */
export async function drawTextureSurface(info, index, canvas) {
  const entry = info.surfaces[index];
  if (!entry) throw new Error('Texture surface index is outside the archive');
  if (info.kind === 'image') {
    const bitmap = await createImageBitmap(new Blob([info.bytes], {type:info.mime}));
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_PIXELS)
        throw new Error('Image is too large to preview safely');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return {width:bitmap.width,height:bitmap.height,dispose(){}};
    } finally { bitmap.close(); }
  }
  const decoded = decodeBntxTexture(info.archive, entry.index);
  if (!decoded.compressed) {
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D Canvas is unavailable');
    const rgba = new Uint8ClampedArray(decoded.data.buffer,
      decoded.data.byteOffset, decoded.data.byteLength);
    context.putImageData(new ImageData(rgba, decoded.width, decoded.height), 0, 0);
    return {width:decoded.width,height:decoded.height,dispose(){}};
  }
  // Native BC7/ASTC blocks are not CPU-decoded. Only offer an actual GPU
  // preview when the browser reports the relevant hardware extension.
  const gl = canvas.getContext('webgl2', {preserveDrawingBuffer:true}) ||
    canvas.getContext('webgl', {preserveDrawingBuffer:true});
  if (!gl) throw new Error('This GPU texture requires WebGL support');
  const required = decoded.compressed === 'bc7'
    ? 'EXT_texture_compression_bptc' : 'WEBGL_compressed_texture_astc';
  if (!gl.getExtension(required))
    throw new Error('The GPU does not support ' + required + '; packed texture remains available');
  const format = compressedFormat(decoded);
  if (!format) throw new Error('Unknown GPU texture block dimensions');
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const renderer = new THREE.WebGLRenderer({
    canvas, context:gl, alpha:true, antialias:false, preserveDrawingBuffer:true
  });
  let geometry, material, texture;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(decoded.width, decoded.height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    texture = new THREE.CompressedTexture(
      [{data:decoded.data,width:decoded.width,height:decoded.height}],
      decoded.width, decoded.height, format
    );
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    geometry = new THREE.PlaneGeometry(2, 2);
    material = new THREE.MeshBasicMaterial({map:texture,transparent:true,side:THREE.DoubleSide});
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry,material));
    renderer.render(scene,new THREE.OrthographicCamera(-1,1,1,-1,0.1,10));
    return {width:decoded.width,height:decoded.height,
      dispose() {texture.dispose();material.dispose();geometry.dispose();renderer.dispose();}};
  } catch (error) {
    texture?.dispose();material?.dispose();geometry?.dispose();renderer.dispose();
    throw error;
  }
}
