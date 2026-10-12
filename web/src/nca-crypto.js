/** WebCrypto-based, memory-only AES for authorized local NCA files.
 * No key storage, remote calls, external binary, or console-key downloads.
 */
const EMPTY_IV = new Uint8Array(16);
export function parseLocalKeys(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024)
    throw Error('Local keys file is invalid or exceeds 1 MiB');
  const result = new Map();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z0-9_]+)\s*=\s*([0-9a-fA-F]+)\s*(?:[;#].*)?$/.exec(line);
    if (!match || ![32,64].includes(match[2].length)) continue;
    const hex = match[2];
    result.set(match[1].toLowerCase(), Uint8Array.from(
      {length:hex.length/2},(_,i)=>parseInt(hex.slice(i*2,i*2+2),16)));
  }
  return {
    get(...names) {
      for (const name of names) {
        const key = result.get(String(name).toLowerCase());
        if (key) return key;
      }
      return null;
    },
    get size(){return result.size;},
    clear(){for(const bytes of result.values()) bytes.fill(0);result.clear();}
  };
}
function subtle() {
  const crypto = globalThis.crypto?.subtle;
  if (!crypto) throw Error('Local NCA decryption requires a secure browser context (HTTPS or localhost).');
  return crypto;
}
async function aesKey(bytes,name) {
  if (!bytes || ![16,32].includes(bytes.length)) throw Error('Missing or invalid local AES key');
  return subtle().importKey('raw',bytes,{name},false,['encrypt','decrypt']);
}
const zero =()=>new Uint8Array(16);
function xor16(dst,a,b){
  for(let i=0;i<16;i++) dst[i]=a[i]^b[i];
}
/** ECB over many blocks using native AES-CBC with a final known PKCS#7 block.
 * WebCrypto intentionally lacks AES-ECB; no third-party crypto dependency needed.
 */
export async function decryptEcb(keyBytes,data) {
  if (!(data instanceof Uint8Array) || data.length===0 || data.length%16)
    throw Error('AES blocks must be 16-byte aligned');
  const key=await aesKey(keyBytes,'AES-CBC');
  const last=data.slice(data.length-16);
  const padding=new Uint8Array(await subtle().encrypt(
    {name:'AES-CBC',iv:last},key,new Uint8Array(0)));
  const chained=new Uint8Array(data.length+16);
  chained.set(data);chained.set(padding.subarray(0,16),data.length);
  const plain=new Uint8Array(await subtle().decrypt({name:'AES-CBC',iv:zero()},key,chained));
  const output=new Uint8Array(data.length);
  for(let i=0;i<data.length;i+=16) {
    const prior=i ? data.subarray(i-16,i) : EMPTY_IV;
    for(let j=0;j<16;j++)output[i+j]=plain[i+j]^prior[j];
  }
  return output;
}
async function encryptEcbSingle(key,block) {
  const imported=await aesKey(key,'AES-CBC');
  const cipher=new Uint8Array(await subtle().encrypt({name:'AES-CBC',iv:zero()},imported,block));
  return cipher.subarray(0,16);
}
function multiplyXtsTweak(tweak){
  let carry=0;
  for(let i=0;i<16;i++){
    const n=tweak[i];
    tweak[i]=((n<<1)&255)|carry;
    carry=n>>7;
  }
  if(carry)tweak[0]^=0x87;
}
function tweakNumber(sector,endian){
  const n=new Uint8Array(16);
  const v=new DataView(n.buffer);
  if(endian==='big') v.setBigUint64(8,BigInt(sector),false);
  else v.setBigUint64(0,BigInt(sector),true);
  return n;
}
export async function decryptXtsSector(keyBytes,sectorData,sectorNumber,endian='big'){
  if (keyBytes?.length!==32 || sectorData.length!==0x200)
    throw Error('AES-XTS needs a 32-byte header key and a 0x200-byte sector');
  const tweakKey=keyBytes.subarray(16);
  const dataKey=keyBytes.subarray(0,16);
  let tweak=new Uint8Array(await encryptEcbSingle(tweakKey,tweakNumber(sectorNumber,endian)));
  const mask=new Uint8Array(0x200);
  const whitened=new Uint8Array(0x200);
  for(let at=0;at<0x200;at+=16){
    mask.set(tweak,at);
    for(let i=0;i<16;i++)whitened[at+i]=sectorData[at+i]^tweak[i];
    multiplyXtsTweak(tweak);
  }
  const dec=await decryptEcb(dataKey,whitened);
  for(let i=0;i<dec.length;i++) dec[i]^=mask[i];
  return dec;
}
export async function decryptXtsHeader(header,keyBytes){
  if(header?.length!==0xc00)throw Error('Encrypted NCA header must be 0xC00 bytes');
  for(const endian of ['big','little']){
    const result=new Uint8Array(0xc00);
    for(let at=0;at<0xc00;at+=0x200)
      result.set(await decryptXtsSector(keyBytes,header.subarray(at,at+0x200),at/0x200,endian),at);
    if(String.fromCharCode(...result.subarray(0x200,0x204))==='NCA3')
      return {header:result,endian};
  }
  throw Error('The supplied local NCA header key could not decrypt this NCA3 header');
}
export async function decryptCtr(keyBytes,payload,prefix,absoluteOffset) {
  if (prefix?.length!==8 || !Number.isSafeInteger(absoluteOffset) || absoluteOffset<0)
    throw Error('Invalid NCA AES-CTR counter');
  const counter=new Uint8Array(16);
  counter.set(prefix,0);
  new DataView(counter.buffer).setBigUint64(8,BigInt(Math.floor(absoluteOffset/16)),false);
  const key=await aesKey(keyBytes,'AES-CTR');
  return new Uint8Array(await subtle().decrypt({name:'AES-CTR',counter,length:64},key,payload));
}
