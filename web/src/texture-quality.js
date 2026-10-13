import * as THREE from 'three';

/** Keep the full source image and interpolate texels rather than stair-stepping
 * native DataTextures. GPU-compressed surfaces need supplied mip levels;
 * decoded RGBA surfaces can generate their own complete chain.
 */
export function configureTextureSampling(texture, maxAnisotropy = 1) {
  const canGenerate = !texture.isCompressedTexture && !texture.isVideoTexture &&
    !texture.isRenderTargetTexture;
  const hasMipmaps = texture.mipmaps?.length > 1;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = canGenerate && !hasMipmaps;
  texture.minFilter = hasMipmaps || texture.generateMipmaps
    ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.anisotropy = Math.max(1, Math.min(16, maxAnisotropy));
  texture.needsUpdate = true;
  return texture;
}
