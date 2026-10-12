import {FlatModelReader} from './gfbmdl.js';

/** TRACM material vec4 channels consist of four scalar keyframe curves. */
export function parseMaterialUVAnimation(bytes) {
  const r=new FlatModelReader(bytes),root=r.table(r.root()),result=[];
  const target=(t,i)=>{const at=r.field(t,i);return at?r.table(r.pointer(at)):null;};
  for(const shape of r.objects(root,1,4096)) {
    const materialTrack=target(shape,4);
    if(!materialTrack)continue;
    for(const material of r.objects(materialTrack,2,512)) {
      for(const parameter of r.objects(material,2,512)) {
        const name=r.string(parameter,0);
        if(!/^UVScaleOffset(?:\d+)?$/.test(name))continue;
        const vector=target(parameter,1);
        if(!vector)continue;
        const components=[0,1,2,3].map(index=>{
          const curve=target(vector,index);
          return curve?r.objects(curve,0,240000).map(key=>({
            frame:r.field(key,0)?r.f32(r.field(key,0)):0,
            value:r.field(key,1)?r.f32(r.field(key,1)):0
          })).filter(key=>Number.isFinite(key.frame)&&key.frame>=0&&Number.isFinite(key.value)):[];
        });
        if(components.every(curve=>curve.length))result.push({shape:r.string(shape,0),material:r.string(material,0),parameter:name,components});
      }
    }
  }
  return result;
}

export function sampleMaterialCurve(curve,frame) {
  if(frame<=curve[0].frame)return curve[0].value;
  for(let index=1;index<curve.length;index++)if(frame<=curve[index].frame) {
    const a=curve[index-1],b=curve[index],t=(frame-a.frame)/(b.frame-a.frame);
    return a.value+(b.value-a.value)*t;
  }
  return curve.at(-1).value;
}
