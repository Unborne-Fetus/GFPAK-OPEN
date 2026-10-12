/** Game Freak's four color layers blend over albedo using RGBA mask weights.
 * Bake these colors to an ordinary map so preview and GLB retain the skin.
 */
import * as THREE from 'three';

export function layerPalette(colors = {}) {
  const palette = [1, 2, 3, 4].map(i => colors['BaseColorLayer' + i]);
  return palette.every(c => c?.length === 4 && c.every(Number.isFinite))
    ? palette.map(c => new THREE.Vector3(...c.slice(0, 3))) : null;
}

export function applyLayerColors(definition, created, report = () => {}) {
  const palette = layerPalette(definition.colors);
  const material = definition.material, mask = definition.layerMaskMap;
  if (!palette || !mask || !material.map) return;
  const scalars = definition.scalars || {};
  const scales = new THREE.Vector4(...[1, 2, 3, 4].map(i =>
    Number.isFinite(scalars['LayerMaskScale' + i]) ? scalars['LayerMaskScale' + i] : 1));
  const uniforms = {
    gfLayerMask: {value:mask}, gfLayerColors:{value:palette},
    gfLayerScales:{value:scales}, gfMaskTransform:{value:mask.matrix}
  };
  // Fallback for an unavailable offscreen GPU; preserves colors in preview.
  const shaderFallback = () => {
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = 'varying vec2 gfBaseUv;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\ngfBaseUv = uv;');
      shader.fragmentShader = 'varying vec2 gfBaseUv;\nuniform mat3 gfMaskTransform;\nuniform sampler2D gfLayerMask;\nuniform vec3 gfLayerColors[4];\nuniform vec4 gfLayerScales;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\nvec4 gfWeights = clamp(texture2D(gfLayerMask, (gfMaskTransform*vec3(gfBaseUv,1.0)).xy) * gfLayerScales, 0.0, 1.0);\ndiffuseColor.rgb = mix(diffuseColor.rgb,gfLayerColors[0],gfWeights.r);\ndiffuseColor.rgb = mix(diffuseColor.rgb,gfLayerColors[1],gfWeights.g);\ndiffuseColor.rgb = mix(diffuseColor.rgb,gfLayerColors[2],gfWeights.b);\ndiffuseColor.rgb = mix(diffuseColor.rgb,gfLayerColors[3],gfWeights.a);');
    };
    material.customProgramCacheKey = () => 'trinity-four-color-layers';
    material.needsUpdate = true;
  };
  if (typeof document === 'undefined') { shaderFallback(); return; }
  let renderer, target, geometry, pass;
  try {
    renderer = new THREE.WebGLRenderer({alpha:true,antialias:false});
    renderer.debug.onShaderError = () => { throw new Error("Layer-color shader compilation failed"); };
    const gl = renderer.getContext();
    const compressed = [material.map, mask].filter(t => t.isCompressedTexture);
    if (compressed.some(t => t.format === THREE.RGBA_BPTC_Format) &&
        !gl.getExtension('EXT_texture_compression_bptc'))
      throw new Error('GPU does not support BC7');
    const width = Math.max(mask.image.width, material.map.image.width);
    const height = Math.max(mask.image.height, material.map.image.height);
    target = new THREE.WebGLRenderTarget(width, height, {depthBuffer:false,stencilBuffer:false});
    target.texture.colorSpace = THREE.SRGBColorSpace;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    pass = new THREE.ShaderMaterial({
      uniforms:{...uniforms, gfAlbedo:{value:material.map}, gfAlbedoTransform:{value:material.map.matrix}},
      vertexShader:'varying vec2 gfUV; void main(){gfUV=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:`varying vec2 gfUV;
        uniform sampler2D gfAlbedo; uniform sampler2D gfLayerMask;
        uniform vec3 gfLayerColors[4]; uniform vec4 gfLayerScales;
        uniform mat3 gfMaskTransform; uniform mat3 gfAlbedoTransform;
        void main(){
          vec4 weights=clamp(texture2D(gfLayerMask,(gfMaskTransform*vec3(gfUV,1.0)).xy)*gfLayerScales,0.0,1.0);
          vec4 albedo=texture2D(gfAlbedo,(gfAlbedoTransform*vec3(gfUV,1.0)).xy);
          vec3 color=mix(albedo.rgb,gfLayerColors[0],weights.r);
          color=mix(color,gfLayerColors[1],weights.g);
          color=mix(color,gfLayerColors[2],weights.b);
          color=mix(color,gfLayerColors[3],weights.a);
          gl_FragColor=vec4(color,albedo.a);
          #include <colorspace_fragment>
        }`
    });
    geometry = new THREE.PlaneGeometry(2,2);
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geometry,pass));
    renderer.setRenderTarget(target);
    renderer.render(scene,new THREE.Camera());
    const data = new Uint8Array(width*height*4);
    renderer.readRenderTargetPixels(target,0,0,width,height,data);
    const baked = new THREE.DataTexture(data,width,height,THREE.RGBAFormat);
    baked.name = material.name + ' layered base color';
    baked.colorSpace = THREE.SRGBColorSpace;
    baked.wrapS = baked.wrapT = THREE.RepeatWrapping;
    // UV transforms were sampled into this map; applying them again distorts it.
    baked.minFilter = baked.magFilter = THREE.LinearFilter;
    baked.needsUpdate = true; created.push(baked);
    material.map = baked; material.needsUpdate = true;
    report('Applied original layer colors to ' + material.name + '.');
  } catch (error) {
    shaderFallback();
    report('Using native layer-color shader for ' + material.name + ': ' + error.message);
  } finally {
    geometry?.dispose();pass?.dispose();target?.dispose();renderer?.dispose();renderer?.forceContextLoss();
  }
}
