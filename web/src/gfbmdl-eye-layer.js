import * as THREE from 'three';
import {configureTextureSampling} from './texture-quality.js';

export function nearestEyeOpening(pixels, width, height, uvCenter) {
  const seen=new Uint8Array(width*height);
  let best=null,bestDistance=Infinity;
  for(let start=0;start<seen.length;start++){
    if(seen[start] || pixels[start*4+3]>=128)continue;
    const queue=[start];seen[start]=1;let x=0,y=0;
    for(let at=0;at<queue.length;at++){
      const i=queue[at],px=i%width,py=Math.floor(i/width);x+=px+.5;y+=py+.5;
      for(const n of [px>0?i-1:-1,px+1<width?i+1:-1,py>0?i-width:-1,py+1<height?i+width:-1]){
        if(n>=0 && !seen[n] && pixels[n*4+3]<128){seen[n]=1;queue.push(n);}
      }
    }
    if(queue.length<4 || queue.length>seen.length/2)continue;
    const center=[x/queue.length/width,y/queue.length/height];
    const distance=center.reduce((sum,v,i)=>{
      const a=((uvCenter[i]%1)+1)%1,d=Math.abs(v-a);return sum+Math.min(d,1-d)**2;
    },0);
    if(distance<bestDistance){bestDistance=distance;best=center;}
  }
  return best;
}

export function centerEyeIris(iris, center) {
  const point=new THREE.Vector2(...center).applyMatrix3(iris.matrix);
  // Move the authored iris center to the eyelid aperture. Integer periods
  // retain the native texture orientation and scale, including mirrored U.
  for(const [axis,value] of [['x',point.x],['y',point.y]]){
    const target=Math.floor(value)+.5;
    iris.offset[axis]+=target-value;
  }
  iris.updateMatrix();
}

// Legacy Pokémon eyes use a transparent eyelid sheet over a separately
// transformed iris. Bake the combination so exported GLBs retain it too.
export function applyLegacyEyeLayer(material, iris, created, report = () => {}, uvCenter = [.5,.5]) {
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
    // Sampling SRGB surfaces produces linear values. Encode the baked target
    // back to SRGB before labelling its readback bytes as an SRGB DataTexture.
    target.texture.colorSpace=THREE.SRGBColorSpace;
    pass=new THREE.ShaderMaterial({uniforms,
      vertexShader:'varying vec2 gfEyeUV; void main(){gfEyeUV=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:'varying vec2 gfEyeUV;\n'+declarations+'\nvoid main(){'+sample+
        '\ngl_FragColor=vec4(eyeColor,1.0);\n#include <colorspace_fragment>\n}'});
    geometry=new THREE.PlaneGeometry(2,2);
    const scene=new THREE.Scene();scene.add(new THREE.Mesh(geometry,pass));
    const pixels=new Uint8Array(width*height*4);
    const composite=pass.fragmentShader;
    pass.fragmentShader='varying vec2 gfEyeUV;\n'+declarations+
      '\nvoid main(){gl_FragColor=texture2D(gfEyeBase,(gfEyeBaseTransform*vec3(gfEyeUV,1.0)).xy);\n#include <colorspace_fragment>\n}';
    renderer.setRenderTarget(target);renderer.render(scene,new THREE.Camera());
    renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
    const opening=nearestEyeOpening(pixels,width,height,uvCenter);
    if(opening)centerEyeIris(iris,opening);
    pass.fragmentShader=composite;pass.needsUpdate=true;
    renderer.render(scene,new THREE.Camera());
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
