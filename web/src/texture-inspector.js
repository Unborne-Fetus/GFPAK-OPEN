/** Standalone local Nintendo texture inspection, without requiring a mesh.
 * A BNTX may contain many independently named surfaces. Unsupported formats
 * remain visible in the inventory, and never become fabricated RGBA pixels.
 */
import * as THREE from 'three';
import {parseBntx, decodeBntxTexture} from './bntx.js';
import {decodeDDSTexture} from './texture-loader.js';

const IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']
]);
const MAX_INPUT = 256 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
const extension = path => '.' + String(path).split('.').at(-1).toLowerCase();

export function isInspectableTexture(path) {
  return extension(path) === '.bntx' || extension(path) === '.dds' ||
    IMAGE_MIME.has(extension(path));
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
  if (kind === '.dds') {
    const texture = decodeDDSTexture(input);
    try {
      return {
        kind:'dds', filename, bytes:input,
        surfaces:[{
          index:0, name:String(filename).split(/[\\/]/).at(-1),
          width:texture.image.width, height:texture.image.height,
          format:'DDS ' + texture.format, mips:texture.mipmaps?.length || 1
        }]
      };
    } finally { texture.dispose(); }
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

function drawGpuTexture(canvas,width,height,texture,requiredExtension) {
  let renderer, geometry, material;
  try {
    const gl = canvas.getContext('webgl2', {preserveDrawingBuffer:true}) ||
      canvas.getContext('webgl', {preserveDrawingBuffer:true});
    if (!gl) throw new Error('This compressed texture requires WebGL support');
    if (!gl.getExtension(requiredExtension))
      throw new Error('The GPU does not support ' + requiredExtension +
        '; original packed bytes remain available');
    canvas.width = width;
    canvas.height = height;
    renderer = new THREE.WebGLRenderer({
      canvas,context:gl,alpha:true,antialias:false,preserveDrawingBuffer:true
    });
    renderer.setPixelRatio(1);
    renderer.setSize(width,height,false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    geometry = new THREE.PlaneGeometry(2,2);
    material = new THREE.MeshBasicMaterial({
      map:texture,transparent:true,side:THREE.DoubleSide
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry,material));
    const camera = new THREE.OrthographicCamera(-1,1,1,-1,0.1,10);
    camera.position.z = 1;
    renderer.render(scene,camera);
    return {width,height,dispose(){
      texture.dispose();material.dispose();geometry.dispose();renderer.dispose();
    }};
  } catch (error) {
    texture.dispose();material?.dispose();geometry?.dispose();renderer?.dispose();
    throw error;
  }
}

const DDS_S3TC_FORMATS = new Set([
  THREE.RGB_S3TC_DXT1_Format,THREE.RGBA_S3TC_DXT1_Format,
  THREE.RGBA_S3TC_DXT3_Format,THREE.RGBA_S3TC_DXT5_Format
]);

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
  if (info.kind === 'dds') {
    const texture = decodeDDSTexture(info.bytes);
    if (texture.isDataTexture) {
      try {
        const {width,height,data} = texture.image;
        canvas.width = width;canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2D Canvas is unavailable');
        context.putImageData(new ImageData(new Uint8ClampedArray(data),width,height),0,0);
        return {width,height,dispose(){}};
      } finally { texture.dispose(); }
    }
    const required = texture.format === THREE.RGBA_BPTC_Format
      ? 'EXT_texture_compression_bptc'
      : DDS_S3TC_FORMATS.has(texture.format) ? 'WEBGL_compressed_texture_s3tc' : null;
    if (!required) {
      texture.dispose();
      throw new Error('DDS GPU compression format cannot be previewed in this browser');
    }
    return drawGpuTexture(canvas,texture.image.width,texture.image.height,texture,required);
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
  // Hardware-compressed BC7 / ASTC has no fake CPU conversion.
  const texture = new THREE.CompressedTexture(
    [{data:decoded.data,width:decoded.width,height:decoded.height}],
    decoded.width, decoded.height, compressedFormat(decoded)
  );
  const required = decoded.compressed === 'bc7'
    ? 'EXT_texture_compression_bptc' : 'WEBGL_compressed_texture_astc';
  return drawGpuTexture(canvas,decoded.width,decoded.height,texture,required);
}
