/** Bake authored displacement into geometry so the same silhouette exports to GLB.
 * Native effect meshes use a second UV set and the red vertex channel as strength.
 */
import * as THREE from 'three';
import {parseMaterialUVAnimation,sampleMaterialCurve} from './trinity-material-animation.js';

export function bakeNativeDisplacement(root, lookup, report = () => {}) {
  root.traverse(mesh => {
    if (!mesh.isMesh || mesh.userData.nativeDisplacementBaked) return;
    const definition = lookup.get(mesh.material?.name?.toLowerCase());
    if (definition?.shader?.flags?.EnableDisplacementMap !== 'True') return;
    const texture = definition.displacementMap, image = texture?.image;
    const height = definition.scalars?.DisplacementHeight;
    if (!image?.data || texture.isCompressedTexture || !Number.isFinite(height) || height === 0) return;
    const geometry = mesh.geometry, position = geometry.attributes.position;
    const normal = geometry.attributes.normal, uv = geometry.attributes.uv1 || geometry.attributes.uv;
    if (!position || !normal || !uv || image.data.length !== image.width * image.height * 4) return;
    mesh.nativeDisplacementBase = position.array.slice();
    mesh.nativeDisplacementNormal ||= normal.array.slice();
    const color = geometry.attributes.color, point = new THREE.Vector2();
    const repeat = value => ((value % 1) + 1) % 1;
    const pixel = (x,y) => image.data[(repeat(y/image.height)*image.height|0)*image.width*4 +
      (repeat(x/image.width)*image.width|0)*4]/255;
    for (let index=0;index<position.count;index++) {
      point.set(uv.getX(index), uv.getY(index)).applyMatrix3(texture.matrix);
      const x = repeat(point.x)*image.width - .5, y = repeat(point.y)*image.height - .5;
      const left=Math.floor(x), bottom=Math.floor(y), tx=x-left, ty=y-bottom;
      const lower=THREE.MathUtils.lerp(pixel(left,bottom),pixel(left+1,bottom),tx);
      const upper=THREE.MathUtils.lerp(pixel(left,bottom+1),pixel(left+1,bottom+1),tx);
      const strength=color ? color.getX(index) : 1;
      const displacement=(THREE.MathUtils.lerp(lower,upper,ty)-.5)*height*strength;
      position.setXYZ(index,position.getX(index)+normal.getX(index)*displacement,
        position.getY(index)+normal.getY(index)*displacement,
        position.getZ(index)+normal.getZ(index)*displacement);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
    mesh.userData.nativeDisplacementBaked = true;
    report('Applied authored displacement map and UVs to ' + mesh.name + '.');
  });
}


/** Use the authored repeating material UV motion to bake portable smoke morphs.
 * glTF cannot animate a custom displacement shader; morph weights can be exported.
 */
export async function animateNativeDisplacement(root,lookup,project,clips,report=()=>{}) {
  const meshes=[];
  root.traverse(mesh=>{if(mesh.userData.nativeDisplacementBaked)meshes.push(mesh);});
  if(!meshes.length)return;
  for(const item of project.items.filter(item=>/loop[^/]*\.tracm$/i.test(item.path))) {
    let channels;
    try {channels=parseMaterialUVAnimation(await item.getBytes());}
    catch(error){report('Material animation skipped: '+error.message);continue;}
    for(const channel of channels.filter(channel=>channel.parameter==='UVScaleOffset3')) {
      const mesh=meshes.find(mesh=>mesh.name.split(':')[0]===channel.shape&&mesh.material.name===channel.material);
      if(!mesh || mesh.userData.nativeDisplacementAnimated)continue;
      const end=Math.max(...channel.components.flat().map(key=>key.frame));
      if(end<=0 || !channel.components.some(curve=>curve.some(key=>key.value!==curve[0].value)))continue;
      const definition=lookup.get(channel.material.toLowerCase()),texture=definition.displacementMap;
      const base=mesh.nativeDisplacementBase,position=mesh.geometry.attributes.position;
      const restNormal=mesh.nativeDisplacementNormal,savedMatrix=texture.matrix.clone();
      const count=17,morphs=[];
      for(let index=0;index<count;index++) {
        const frame=end*index/(count-1),uv=channel.components.map(curve=>sampleMaterialCurve(curve,frame));
        texture.matrix.setUvTransform(uv[2],uv[3],uv[0],uv[1],0,0,0);
        position.array.set(base);
        mesh.geometry.attributes.normal.array.set(restNormal);
        mesh.userData.nativeDisplacementBaked=false;
        bakeNativeDisplacement(root,lookup,()=>{});
        const delta=position.array.map((value,j)=>value-base[j]);
        const attribute=new THREE.Float32BufferAttribute(delta,3);attribute.name='nativeDisplacement'+index;morphs.push(attribute);
      }
      texture.matrix.copy(savedMatrix);position.array.set(base);
      mesh.geometry.attributes.normal.array.set(restNormal);position.needsUpdate=true;
      mesh.geometry.morphAttributes.position=morphs;mesh.geometry.morphTargetsRelative=true;mesh.updateMorphTargets();
      mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();
      mesh.morphTargetInfluences[0]=1;
      const sourceClip=clips.find(clip=>clip.name===item.path.split('/').at(-1).replace(/\.tracm$/i,''));
      const duration=sourceClip?.duration>0?sourceClip.duration:end/30;
      for(const clip of clips) {
        if(clip.duration<=0)continue;
        const times=[];
        for(let time=0;time<clip.duration;time+=duration/(count-1))times.push(time);
        times.push(clip.duration);
        // Keep export buffers bounded for corrupt or extremely long clips.
        if(times.length>120000)continue;
        for(let index=0;index<count;index++) {
          const values=times.map(time=>{
            const phase=(time%duration)/duration*(count-1);
            return Math.max(0,1-Math.abs(phase-index));
          });
          clip.tracks.push(new THREE.NumberKeyframeTrack(mesh.uuid+'.morphTargetInfluences[nativeDisplacement'+index+']',times,values));
        }
      }
      mesh.userData.nativeDisplacementAnimated=true;
      report('Loaded original displacement UV loop for '+mesh.name+'.');
    }
  }
}
