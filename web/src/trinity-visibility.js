import { FlatModelReader } from './gfbmdl.js';

/** TRACM shape tracks: visibility is the boolean union inside slot 5, slot 2. */
export function parseMeshVisibility(bytes) {
  const r = new FlatModelReader(bytes);
  const target = (t,i) => {const at=r.field(t,i);return at?r.table(r.pointer(at)):null;};
  const root=r.table(r.root()), info=target(root,0);
  const frameCount=info ? r.uint(info,1) : 0;
  const result=[];
  for(const shape of r.objects(root,1,4096)) {
    const visibility=target(shape,5), union=visibility && target(visibility,2);
    if(!union) continue;
    const type=r.field(union,0)?r.u8(r.field(union,0)):0;
    const data=target(union,1);
    if(!data || !type) continue;
    let frames,values;
    if(type===1) {
      frames=[0]; values=[!!(r.field(data,0)&&r.u8(r.field(data,0)))];
    } else if([2,3,4].includes(type)) {
      const v=r.vector(data,type===2?0:1,1);
      if(!v || v.count>240000) throw new Error('Invalid visibility sample count');
      if(type===2) {
        if(!frameCount || frameCount>120000) throw new Error('Invalid visibility frame count');
        // Dense channels can stop before playback ends; retain their final state.
        frames=Array.from({length:Math.min(frameCount,v.count*8)},(_,i)=>i);
      } else {
        const width=type===3?2:1,keys=r.vector(data,0,width);
        if(!keys || keys.count>240000) throw new Error('Invalid visibility keys');
        frames=Array.from({length:keys.count},(_,i)=>width===2?r.u16(keys.start+i*2):r.u8(keys.start+i));
      }
      if(v.count!==Math.ceil(frames.length/8)) throw new Error('Visibility bit count mismatch');
      values=frames.map((_,i)=>!!(r.u8(v.start+(i>>3)) & (1<<(i&7))));
    } else throw new Error('Unsupported visibility channel '+type);
    if(frames.length) result.push({name:r.string(shape,0),frames,values});
  }
  return result;
}
