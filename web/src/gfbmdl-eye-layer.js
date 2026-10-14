import * as THREE from 'three';
import {configureTextureSampling} from './texture-quality.js';

// Legacy Pokémon eyes use a transparent eyelid sheet over a separately
// transformed iris. Bake the combination so exported GLBs retain it too.
export function applyLegacyEyeLayer(material, iris, created, report = () => {}) {
  const base=material.map;
  if (!base || !iris) return;
  base.updateMatrix(); iris.updateMatrix();
  const uniforms={gfEyeBase:{value:base},gfEyeIris:{value:iris},
    gfEyeBaseTransform:{value:base.matrix},gfEyeIrisTransform:{value:iris.matrix}};
  const declarations=`uniform sampler2D gfEyeBase; uniform sampler2D gfEyeIris;
    uniform mat3 gfEyeBaseTransform; uniform mat3 gfEyeIrisTransform;`;
  const sample=`vec4 eyelid=texture2D(gfEyeBase,(gfEyeBaseTransform*vec3(gfEyeUV,1.0)).xy);
    vec4 pupil=texture2D(gfEyeIris,(gfEyeIrisTransform*vec3(gfEyeUV,1.0)).xy);
    vec3 eyeColor=mix(pupil.rgb,eyelid.rgb,eyelid.a);`;
  const fallback=()=>{
    material.onBeforeCompile=shader=>{
      Object.assign(shader.uniforms,uniforms);
      shader.vertexShader='varying vec2 gfEyeUV;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <uv_vertex>',
        '#include <uv_vertex>\ngfEyeUV=uv;');
      shader.fragmentShader='varying vec2 gfEyeUV;\n'+declarations+'\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',
        sample+'\ndiffuseColor.rgb*=eyeColor;');
    };
    material.customProgramCacheKey=()=> 'gfbmdl-eyelid-iris';
    material.needsUpdate=true;
  };
  if(typeof document==='undefined'){fallback();return;}
  let renderer,target,geometry,pass;
  try{
    renderer=new THREE.WebGLRenderer({alpha:true,antialias:false});
    renderer.debug.onShaderError=()=>{throw new Error('Eye layer shader compilation failed');};
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.NoToneMapping;
    const width=base.image?.width || 512,height=base.image?.height || 512;
    target=new THREE.WebGLRenderTarget(width,height,{type:THREE.UnsignedByteType});
    pass=new THREE.ShaderMaterial({uniforms,
      vertexShader:'varying vec2 gfEyeUV; void main(){gfEyeUV=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:'varying vec2 gfEyeUV;\n'+declarations+'\nvoid main(){'+sample+
        '\ngl_FragColor=vec4(eyeColor,1.0);\n#include <colorspace_fragment>\n}'});
    geometry=new THREE.PlaneGeometry(2,2);
    const scene=new THREE.Scene();scene.add(new THREE.Mesh(geometry,pass));
    renderer.setRenderTarget(target);renderer.render(scene,new THREE.Camera());
    const pixels=new Uint8Array(width*height*4);
    renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
    const baked=new THREE.DataTexture(pixels,width,height,THREE.RGBAFormat);
    baked.name=material.name+' eyelid and iris';
    baked.colorSpace=THREE.SRGBColorSpace;
    baked.wrapS=baked.wrapT=THREE.RepeatWrapping;
    configureTextureSampling(baked);baked.needsUpdate=true;created.push(baked);
    material.map=baked;material.needsUpdate=true;
    report('Combined eyelid and iris textures for '+material.name+'.');
  }catch(error){
    fallback();report('Using live eyelid/iris shader for '+material.name+': '+error.message);
  }finally{
    geometry?.dispose();pass?.dispose();target?.dispose();renderer?.dispose();renderer?.forceContextLoss();
  }
}
