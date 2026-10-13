/** Local-only Switch NCA3 cryptography. No server calls, persistence or key logging.
 * AES-XTS/ECB use the browser's AES-CBC primitive with PKCS#7-safe block framing.
 * NCA content is processed in bounded pieces, without staging a complete image.
 */
const ZERO = new Uint8Array(16);
const keysize = n => n === 16 || n === 24 || n === 32;
const hex = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
const fromHex = value => Uint8Array.from(value.match(/../g) || [], n => parseInt(n, 16));
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u32 = (bytes, at) => viewOf(bytes).getUint32(at, true);

function assertCrypto() {
  if (!globalThis.crypto?.subtle) throw Error('A secure browser context with Web Crypto is required (HTTPS).');
  return globalThis.crypto.subtle;
}

export function parseNcaKeys(content, previous = new Map()) {
  if (content.length > 1024 * 1024) throw Error('Key file exceeds the 1 MiB safety limit');
  const keys = new Map(previous);
  for (const line of content.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z0-9_]{1,128})\s*=\s*([a-fA-F0-9]{32}|[a-fA-F0-9]{64})\s*(?:[;#].*)?$/.exec(line);
    if (match) keys.set(match[1].toLowerCase(), fromHex(match[2]));
  }
  return keys;
}

export function keyInfo(keys) {
  const header = keys.get('nca_header_key') || keys.get('header_key');
  const titleCount = [...keys.keys()].filter(n => /^(?:titlekey_)?[a-f0-9]{32}$/.test(n)).length;
  return {entries:keys.size,header:header?.length===32,titleCount};
}

export function readKey(keys, ...names) {
  for (const name of names) {
    const key = keys.get(name.toLowerCase());
    if (key) return key;
  }
  return null;
}

async function aesCbcKey(bytes, usages) {
  if (!keysize(bytes?.length)) throw Error('Invalid AES key length');
  return assertCrypto().importKey('raw', bytes, {name:'AES-CBC'}, false, usages);
}

async function aesEcbEncryptBlock(rawKey, block) {
  if (block.length !== 16) throw Error('ECB input must be one block');
  const key = await aesCbcKey(rawKey, ['encrypt']);
  const encrypted = await assertCrypto().encrypt({name:'AES-CBC', iv:ZERO}, key, block);
  return new Uint8Array(encrypted).slice(0, 16);
}

/** Decrypt any number of ECB blocks with two AES-CBC operations, no unpadding corruption. */
export async function aesEcbDecrypt(rawKey, ciphertext) {
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length===0 || ciphertext.length%16)
    throw Error('ECB ciphertext must be nonempty and block-aligned');
  const key = await aesCbcKey(rawKey, ['encrypt','decrypt']);
  const pad = new Uint8Array(16).fill(16);
  const last = ciphertext.subarray(ciphertext.length-16);
  const suffix = new Uint8Array(await assertCrypto().encrypt(
    {name:'AES-CBC',iv:last}, key, pad)).subarray(0,16);
  const framed = new Uint8Array(ciphertext.length+16);
  framed.set(ciphertext);framed.set(suffix,ciphertext.length);
  const decoded = new Uint8Array(await assertCrypto().decrypt(
    {name:'AES-CBC',iv:ZERO},key,framed));
  const output = new Uint8Array(ciphertext.length);
  for (let i=0;i<ciphertext.length;i++)
    output[i] = decoded[i] ^ (i<16 ? 0 : ciphertext[i-16]);
  return output;
}

function doubleTweak(tweak) {
  let carry=0;
  for(let i=0;i<16;i++) {
    const v=tweak[i];
    tweak[i]=((v<<1)&255)|carry;
    carry=v>>>7;
  }
  if(carry)tweak[0]^=0x87;
}
function sectorBytes(index,order) {
  let number=BigInt(index);
  const bytes=new Uint8Array(16);
  for(let i=0;i<16;i++) {
    bytes[order==='big'?15-i:i]=Number(number&255n);
    number >>= 8n;
  }
  return bytes;
}
export async function decryptXts(rawKey, encrypted, firstSector=0, order='big') {
  if (rawKey?.length!==32 || encrypted.length===0 || encrypted.length%0x200)
    throw Error('XTS requires a 32-byte key and complete 0x200-byte sectors');
  if (!Number.isSafeInteger(firstSector) || firstSector<0)throw Error('Invalid sector number');
  const output=new Uint8Array(encrypted.length);
  for(let at=0;at<encrypted.length;at+=0x200) {
    const initial=await aesEcbEncryptBlock(rawKey.subarray(16),sectorBytes(firstSector+at/512,order));
    const tweak=new Uint8Array(initial);
    const raw=encrypted.subarray(at,at+512);
    const transformed=new Uint8Array(512);
    for(let i=0;i<512;i+=16) {
      for(let j=0;j<16;j++)transformed[i+j]=raw[i+j]^tweak[j];
      doubleTweak(tweak);
    }
    const decrypted=await aesEcbDecrypt(rawKey.subarray(0,16),transformed);
    tweak.set(initial);
    for(let i=0;i<512;i+=16) {
      for(let j=0;j<16;j++)output[at+i+j]=decrypted[i+j]^tweak[j];
      doubleTweak(tweak);
    }
  }
  return output;
}

export async function decodeNcaHeader(source, keys) {
  if (source.size < 0xc00) throw Error('NCA header is incomplete');
  const raw=await source.read(0,0xc00);
  const magic=bytes=>bytes[0x200]===78&&bytes[0x201]===67&&bytes[0x202]===65&&bytes[0x203]===51;
  if(magic(raw))return {header:raw,plaintext:true,tweakOrder:'none'};
  const headerKey=readKey(keys,'nca_header_key','header_key');
  if(headerKey?.length!==32)
    throw Error('Encrypted NCA header. Choose a compatible local prod.keys file using Load Keys.');
  for(const order of ['big','little']){
    const result=await decryptXts(headerKey,raw,0,order);
    if(magic(result))return {header:result,plaintext:false,tweakOrder:order};
  }
  throw Error('The selected NCA header key could not decode this header. Check key file and game version.');
}

function signatureTicket(raw) {
  if(raw.length<4)return null;
  const a=(raw[0]<<24)|(raw[1]<<16)|(raw[2]<<8)|raw[3];
  const b=(raw[3]<<24)|(raw[2]<<16)|(raw[1]<<8)|raw[0];
  const offsets=new Map([[0x10000,0x240],[0x10001,0x140],[0x10002,0x80],
    [0x10003,0x240],[0x10004,0x140],[0x10005,0x80],[0x10006,0x40]]);
  return offsets.get(a>>>0)??offsets.get(b>>>0)??null;
}
export function parseNcaTicket(raw) {
  const body=signatureTicket(raw);
  if(body==null || raw.length<body+0x170)return null;
  const type=raw[body+0x141],rights=raw.subarray(body+0x160,body+0x170);
  if((type!==0&&type!==1)||!rights.some(Boolean))return null;
  return {rights:hex(rights),generation:raw[body+0x145],
    type,encrypted:raw.slice(body+0x40,body+0x50)};
}

export async function deriveNcaSectionKeys(header,keys,ticketLookup=null) {
  const generation=Math.max(header[0x206],header[0x220]);
  const revision=Math.max(0,generation-1);
  const fsModes=[0,1,2,3].map(i=>header[0x400+i*0x200+4]);
  if(!fsModes.some(mode=>mode===2||mode===3))return {keys:null,revision,source:'plaintext'};
  const rights=header.subarray(0x230,0x240);
  if(rights.some(Boolean)){
    const identifier=hex(rights);
    let encrypted=readKey(keys,'titlekey_'+identifier,identifier);
    let titleRevision=revision,source='title.keys';
    if(!encrypted && ticketLookup){
      const ticket=await ticketLookup(identifier);
      if(ticket?.type===1)throw Error('Matching personalized ticket is not supported');
      if(ticket){encrypted=ticket.encrypted;titleRevision=ticket.generation;source='package ticket';}
    }
    if(encrypted?.length!==16)
      throw Error('Rights-managed NCA: matching title.keys entry or package ticket is required.');
    const kek=readKey(keys,'titlekek_'+titleRevision.toString(16).padStart(2,'0'),
      'ticket_commonkey_'+titleRevision.toString(16).padStart(2,'0'));
    if(kek?.length!==16)
      throw Error('Missing titlekek for key generation '+titleRevision.toString(16).padStart(2,'0'));
    const key=await aesEcbDecrypt(kek,encrypted);
    return {keys:[key,key,key,key],revision,source};
  }
  const kind=header[0x207];
  if(kind>2)throw Error('Unknown NCA key area type');
  const suffix=['application','ocean','system'][kind];
  const tag=revision.toString(16).padStart(2,'0');
  const areaKey=readKey(keys,'nca_key_area_key_'+suffix+'_'+tag,'key_area_key_'+suffix+'_'+tag);
  if(areaKey?.length!==16)
    throw Error('Missing NCA '+suffix+' key-area key for revision '+tag+'. A compatible local prod.keys is required.');
  const decoded=await aesEcbDecrypt(areaKey,header.subarray(0x300,0x340));
  return {keys:Array.from({length:4},(_,i)=>decoded.slice(i*16,i*16+16)),revision,source:'key area'};
}

async function decryptCtr(rawKey,counterPrefix,encrypted,blockIndex) {
  if(rawKey?.length!==16 || counterPrefix.length!==8)throw Error('Missing AES-CTR content key');
  const counter=new Uint8Array(16);
  counter.set(counterPrefix);
  let value=BigInt(blockIndex);
  for(let i=15;i>=8;i--){counter[i]=Number(value&255n);value>>=8n;}
  const key=await assertCrypto().importKey('raw',rawKey,'AES-CTR',false,['decrypt']);
  return new Uint8Array(await assertCrypto().decrypt(
    {name:'AES-CTR',counter,length:64},key,encrypted));
}

/** Read-only decrypted virtual section; no more than 8 MiB staged per underlying read. */
export function makeNcaSectionSource(source,start,size,fs,encryption,contentKey,tweakOrder='big') {
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(size)||start<0||
     size<0||size>source.size-start)throw Error('NCA section bounds are invalid');
  const prefix=new Uint8Array(fs.subarray(0x140,0x148)).reverse();
  async function readPiece(relative,length) {
    if(!length)return new Uint8Array(0);
    if(encryption===1)return source.read(start+relative,length);
    if(encryption===3) {
      const absolute=start+relative;
      const aligned=absolute-absolute%16;
      const leading=absolute-aligned;
      const data=await source.read(aligned,length+leading);
      const plain=await decryptCtr(contentKey,prefix,data,aligned/16);
      return plain.subarray(leading,leading+length);
    }
    if(encryption===2) {
      const at=Math.floor(relative/512)*512;
      const end=Math.ceil((relative+length)/512)*512;
      if(end>size)throw Error('Unaligned AES-XTS read exceeds NCA section');
      const raw=await source.read(start+at,end-at);
      const plain=await decryptXts(contentKey,raw,at/512,tweakOrder);
      return plain.subarray(relative-at,relative-at+length);
    }
    throw Error('Unsupported NCA section encryption mode '+encryption);
  }
  return {
    size,
    async read(at,len) {
      if(!Number.isSafeInteger(at)||!Number.isSafeInteger(len)||at<0||len<0||
         at>size||len>size-at)throw Error('Read outside NCA filesystem section');
      if(!len)return new Uint8Array(0);
      if(len>64*1024*1024)
        throw Error('Browser read exceeds 64 MiB per request. Use smaller file slices.');
      const result=new Uint8Array(len);
      let pos=0;
      while(pos<len){
        const take=Math.min(4*1024*1024,len-pos);
        const chunk=await readPiece(at+pos,take);
        result.set(chunk,pos);
        pos+=take;
      }
      return result;
    }
  };
}
