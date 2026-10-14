import * as THREE from 'three';

// Trace pixel boundaries instead of revolving row widths: a lathe turns
// every notch into a ring and discards the authored flame's separate tips.
function flameContour(outline) {
  const {width,height,data}=outline,edges=new Map();
  const filled=(x,y)=>x>=0 && y>=0 && x<width && y<height && data[(y*width+x)*4]>=128;
  const add=(x,y,a,b)=>{
    const key=x+','+y;
    if(!edges.has(key))edges.set(key,[]);
    edges.get(key).push([a,b]);
  };
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(filled(x,y)){
    if(!filled(x,y-1))add(x,y,x+1,y);
    if(!filled(x+1,y))add(x+1,y,x+1,y+1);
    if(!filled(x,y+1))add(x+1,y+1,x,y+1);
    if(!filled(x-1,y))add(x,y+1,x,y);
  }
  const loops=[];
  while(edges.size){
    const first=edges.keys().next().value,start=first.split(',').map(Number),loop=[];
    let point=start;
    do{
      loop.push(point);
      const key=point.join(','),next=edges.get(key);
      if(!next?.length)throw new Error('Open native flame outline');
      point=next.pop();if(!next.length)edges.delete(key);
    }while(point[0]!==start[0] || point[1]!==start[1]);
    loops.push(loop);
  }
  const area=loop=>Math.abs(loop.reduce((a,p,i)=>{
    const q=loop[(i+1)%loop.length];return a+p[0]*q[1]-q[0]*p[1];
  },0));
  loops.sort((a,b)=>area(b)-area(a));
  if(!loops.length)throw new Error('Empty native flame outline');
  // Remove collinear grid vertices without removing notches or tips.
  const loop=loops[0];
  return loop.filter((p,i)=>{
    const a=loop[(i+loop.length-1)%loop.length],b=loop[(i+1)%loop.length];
    return (p[0]-a[0])*(b[1]-p[1])!==(p[1]-a[1])*(b[0]-p[0]);
  });
}

export function closedFlameGeometry(source, outline, materialIndex = 0) {
  const positions=source.getAttribute('position');
  source.computeBoundingBox();
  const bounds=source.boundingBox,span=bounds.max.y-bounds.min.y;
  if(!positions || span<=0)throw new Error('Invalid native flame bounds');
  const cx=(bounds.min.x+bounds.max.x)/2,cz=(bounds.min.z+bounds.max.z)/2;
  const width=Math.max(bounds.max.x-bounds.min.x,bounds.max.z-bounds.min.z);
  const contour=flameContour(outline);
  const shape=new THREE.Shape(contour.map(([x,y])=>new THREE.Vector2(
    cx+(x/outline.width-.5)*width,bounds.max.y-y/outline.height*span)));
  // Closed front/back faces and edge walls keep the flame solid from above
  // and below. Moderate depth preserves the jagged profile without rings.
  const depth=width*.4;
  const shell=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:false,steps:1});
  // Subdivide the caps so depth can fall smoothly toward the perimeter,
  // rather than leaving a rectangular extrusion visible from above.
  let triangles=Array.from(shell.getAttribute('position').array);
  shell.dispose();
  const midpoint=(a,b)=>a.map((v,i)=>(v+b[i])/2);
  for(let pass=0;pass<2;pass++){
    const next=[];
    for(let i=0;i<triangles.length;i+=9){
      const a=triangles.slice(i,i+3),b=triangles.slice(i+3,i+6),c=triangles.slice(i+6,i+9);
      const ab=midpoint(a,b),bc=midpoint(b,c),ca=midpoint(c,a);
      next.push(...a,...ab,...ca,...ab,...b,...bc,...ca,...bc,...c,...ab,...bc,...ca);
    }
    triangles=next;
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(triangles,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(triangles.length/3*2),2));
  const perimeter=shape.getPoints();
  const p=geometry.getAttribute('position'),uv=geometry.getAttribute('uv');
  for(let i=0;i<p.count;i++){
    const t=(p.getY(i)-bounds.min.y)/span;
    let edgeDistance=Infinity;
    const x=p.getX(i),y=p.getY(i);
    for(let j=0;j<perimeter.length;j++){
      const a=perimeter[j],b=perimeter[(j+1)%perimeter.length];
      const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
      const f=length?THREE.MathUtils.clamp(((x-a.x)*dx+(y-a.y)*dy)/length,0,1):0;
      edgeDistance=Math.min(edgeDistance,Math.hypot(x-a.x-f*dx,y-a.y-f*dy));
    }
    const thickness=.02+.98*Math.sin(Math.min(1,edgeDistance/(width*.25))*Math.PI/2);
    p.setZ(i,cz+(p.getZ(i)-depth/2)*thickness);
    uv.setXY(i,(p.getX(i)-cx)/width+.5,1-t);
  }
  geometry.setIndex(Array.from({length:p.count},(_,i)=>i));
  geometry.computeVertexNormals();
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
