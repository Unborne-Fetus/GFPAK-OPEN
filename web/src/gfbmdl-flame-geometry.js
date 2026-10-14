import * as THREE from 'three';

// Convert the authored silhouette into a closed Y-up volume. An alpha cutout
// on the game's curved effect shell otherwise exposes its empty interior.
export function closedFlameGeometry(source, outline, materialIndex = 0) {
  const positions=source.getAttribute('position');
  source.computeBoundingBox();
  const bounds=source.boundingBox,span=bounds.max.y-bounds.min.y;
  if(!positions || span<=0)throw new Error('Invalid native flame bounds');
  const cx=(bounds.min.x+bounds.max.x)/2,cz=(bounds.min.z+bounds.max.z)/2;
  const radius=Math.max(bounds.max.x-bounds.min.x,bounds.max.z-bounds.min.z)/2;
  const points=[];
  for(let row=0;row<outline.height;row++){
    const maskRow=outline.height-1-row;
    let first=outline.width,last=-1;
    for(let x=0;x<outline.width;x++)if(outline.data[(maskRow*outline.width+x)*4]>=128){
      first=Math.min(first,x);last=Math.max(last,x);
    }
    const width=last>=first?(last-first+1)/outline.width:0;
    const r=row===0 || row===outline.height-1?0:radius*width;
    points.push(new THREE.Vector2(r,bounds.min.y+span*row/(outline.height-1)));
  }
  const geometry=new THREE.LatheGeometry(points,32);
  geometry.translate(cx,0,cz);
  const uv=geometry.getAttribute('uv');
  for(let i=0;i<uv.count;i++)uv.setY(i,1-uv.getY(i));
  geometry.clearGroups();geometry.addGroup(0,geometry.index.count,materialIndex);
  // Keep the native tail rig: transfer the closest source vertex's weights
  // and already-resolved bone indices to the replacement volume.
  const joints=source.getAttribute('skinIndex'),weights=source.getAttribute('skinWeight');
  if(joints && weights){
    const p=geometry.getAttribute('position'),ids=new Uint16Array(p.count*4),skin=new Float32Array(p.count*4);
    for(let i=0;i<p.count;i++){
      let nearest=0,distance=Infinity;
      for(let j=0;j<positions.count;j++){
        const d=(positions.getX(j)-p.getX(i))**2+(positions.getY(j)-p.getY(i))**2+(positions.getZ(j)-p.getZ(i))**2;
        if(d<distance){distance=d;nearest=j;}
      }
      for(let c=0;c<4;c++){
        ids[i*4+c]=joints.array[nearest*4+c];skin[i*4+c]=weights.array[nearest*4+c];
      }
    }
    geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(ids,4));
    geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(skin,4));
  }
  return geometry;
}
