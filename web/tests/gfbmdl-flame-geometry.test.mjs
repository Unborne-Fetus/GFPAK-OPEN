import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {closedFlameGeometry} from '../src/gfbmdl-flame-geometry.js';

export function boundaryEdges(geometry){
  const p=geometry.getAttribute('position'),ids=new Map(),vertices=[];
  for(let i=0;i<p.count;i++){
    const key=[p.getX(i),p.getY(i),p.getZ(i)].map(v=>Math.round(v*10000)).join(',');
    if(!ids.has(key))ids.set(key,ids.size);vertices.push(ids.get(key));
  }
  const edges=new Map(),indices=geometry.index.array;
  for(let i=0;i<indices.length;i+=3){
    const face=[vertices[indices[i]],vertices[indices[i+1]],vertices[indices[i+2]]];
    if(new Set(face).size<3)continue;
    for(let n=0;n<3;n++){
      const a=face[n],b=face[(n+1)%3],key=[Math.min(a,b),Math.max(a,b)].join(',');
      edges.set(key,(edges.get(key)||0)+1);
    }
  }
  return [...edges.values()].filter(count=>count!==2).length;
}

test('flame volume has a sealed base, sealed tip, and no open side edges',()=>{
  const source=new THREE.ConeGeometry(2,6,8);
  source.translate(3,5,-4);
  const data=new Uint8Array(8*8*4);
  for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(Math.abs(x-3.5)<1+y/2)data[(y*8+x)*4]=255;
  const geometry=closedFlameGeometry(source,{width:8,height:8,data},3);
  assert.equal(boundaryEdges(geometry),0);
  geometry.computeBoundingBox();source.computeBoundingBox();
  assert.equal(geometry.boundingBox.min.y,source.boundingBox.min.y);
  assert.equal(geometry.boundingBox.max.y,source.boundingBox.max.y);
  assert.equal(geometry.groups[0].materialIndex,3);
});

test('replacement flame preserves native skinning weights and gradient UV origin',()=>{
  const source=new THREE.ConeGeometry(1,4,8),count=source.getAttribute('position').count;
  const ids=new Uint16Array(count*4),weights=new Float32Array(count*4);
  for(let i=0;i<count;i++){ids[i*4]=7;weights[i*4]=1;}
  source.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(ids,4));
  source.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const data=new Uint8Array(4*4*4).fill(255);
  const geometry=closedFlameGeometry(source,{width:4,height:4,data});
  const p=geometry.getAttribute('position'),uv=geometry.getAttribute('uv');
  for(let i=0;i<p.count;i++){
    assert.equal(geometry.getAttribute('skinIndex').getX(i),7);
    assert.equal(geometry.getAttribute('skinWeight').getX(i),1);
    if(p.getY(i)===-2)assert.equal(uv.getY(i),1);
    if(p.getY(i)===2)assert.equal(uv.getY(i),0);
  }
});

test('separate authored flame tips retain the gap between them instead of becoming circular rings',()=>{
  const source=new THREE.BoxGeometry(8,8,4);
  const data=new Uint8Array(8*8*4);
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    if(y<3 && x>=3 && x<=4)continue;
    data[(y*8+x)*4]=255;
  }
  const geometry=closedFlameGeometry(source,{width:8,height:8,data});
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  const ray=new THREE.Raycaster(new THREE.Vector3(0,3,20),new THREE.Vector3(0,0,-1));
  assert.equal(ray.intersectObject(mesh).length,0,'gap between tips remains open in the silhouette');
  ray.set(new THREE.Vector3(-2,3,20),new THREE.Vector3(0,0,-1));
  assert.ok(ray.intersectObject(mesh).length>0,'neighboring tip remains solid');
  assert.equal(boundaryEdges(geometry),0);
});
