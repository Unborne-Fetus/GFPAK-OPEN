/** Browser-only, read-only game package explorer. Never calls the desktop bridge. */
import JSZip from 'jszip';
const $ = id => document.getElementById(id);
const decoder = new TextDecoder();
const files = [];
let selected = null;
const LIMIT = 100000;
function u32(view, pos) { return view.getUint32(pos, true); }
function u64(view, pos) {
  const n = view.getBigUint64(pos, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('File offset exceeds browser precision');
  return Number(n);
}
function checkedRange(size, start, length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
      start < 0 || length < 0 || start > size || length > size - start)
    throw Error('Package entry extends beyond its container');
}
async function readBlob(blob, start, length) {
  checkedRange(blob.size, start, length);
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}
function classify(name) {
  if (/\.(gfbmdl|trmdl|trmsh|glb|fbx|obj)$/i.test(name)) return 'Model';
  if (/\.(bntx|dds|trtex|png|jpg|webp)$/i.test(name)) return 'Texture';
  if (/\.(tranm|gfbanm)$/i.test(name)) return 'Animation';
  if (/\.(trskl|gfskl)$/i.test(name)) return 'Skeleton';
  if (/\.(nca|ncz)$/i.test(name)) return 'NCA';
  if (/\.(gfpak|zip)$/i.test(name)) return 'Archive';
  return 'Other';
}
function add(name, size, getSlice, group = '') {
  if (files.length >= LIMIT) throw Error('Too many indexed entries (100,000 maximum)');
  files.push({name: group ? group + '/' + name : name, size, getSlice, category: classify(name)});
}
function parsePfs(bytes, base, total, group, magic) {
  if (bytes.length < 16 || decoder.decode(bytes.subarray(0,4)) !== magic)
    throw Error('Invalid ' + magic + ' index');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = u32(view,4), namesSize = u32(view,8);
  const hfs = magic === 'HFS0', entrySize = hfs ? 0x40 : 0x18;
  if (count > LIMIT || count * entrySize + namesSize + 16 > bytes.length)
    throw Error('Package index incomplete or too large');
  const namesStart = 16 + count * entrySize;
  const dataStart = namesStart + namesSize;
  const nameTable = bytes.subarray(namesStart,namesStart + namesSize);
  const result = [];
  for (let i=0; i<count; i++) {
    const entry = 16 + i*entrySize;
    const offset = u64(view, entry), size = u64(view, entry + 8);
    const nameAt = u32(view, entry + 16);
    if (nameAt >= namesSize) throw Error('Invalid filename offset');
    const end = nameTable.indexOf(0,nameAt);
    if (end < 0) throw Error('Unterminated package entry name');
    const name = decoder.decode(nameTable.subarray(nameAt,end));
    const absolute = base + dataStart + offset;
    checkedRange(total,absolute,size);
    result.push({name,size,absolute,group});
  }
  return result;
}
async function indexPackage(blob, name, start=0, size=blob.size, group=name, depth=0) {
  if (depth > 3) return;
  const prefix = await readBlob(blob,start,Math.min(size,16));
  const magic = decoder.decode(prefix.subarray(0,4));
  if (!['PFS0','HFS0'].includes(magic))
    throw Error('This container is not a readable PFS0/NSP or HFS0/XCI index.');
  const view = new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength);
  const count = u32(view,4), namesSize = u32(view,8);
  const entriesBytes = 16 + count * (magic === 'HFS0' ? 0x40 : 0x18) + namesSize;
  if (count > LIMIT || entriesBytes > size || entriesBytes > 24*1024*1024)
    throw Error('Package index exceeds supported bounds');
  const raw = await readBlob(blob,start,entriesBytes);
  const rows = parsePfs(raw,start,blob.size,group,magic);
  for (const row of rows) {
    add(row.name,row.size,(offset,len)=>readBlob(blob,row.absolute+offset,len),row.group);
    // HFS0 gamecard partitions can contain another HFS0 index.
    if (magic === 'HFS0' && depth < 3 && row.size >= 16) {
      const head = await readBlob(blob,row.absolute,4);
      if (decoder.decode(head) === 'HFS0')
        await indexPackage(blob,row.name,row.absolute,row.size,group+'/'+row.name,depth+1);
    }
  }
}
async function indexZip(blob) {
  const zip = await JSZip.loadAsync(blob);
  for (const item of Object.values(zip.files)) {
    if (item.dir) continue;
    const size = item._data?.uncompressedSize ?? 0;
    add(item.name,size,async (start,len)=>{
      if (size > 256*1024*1024) throw Error('ZIP member too large for browser extraction');
      const raw = new Uint8Array(await item.async('arraybuffer'));
      checkedRange(raw.byteLength,start,len);
      return raw.subarray(start,start+len);
    },blob.name);
  }
}
function message(value) { $('webGameStatus').textContent = value; }
function display() {
  const q = $('webGameSearch').value.trim().toLowerCase();
  const category = $('webGameType').value;
  const target = $('webGameList');
  target.replaceChildren();
  const matches = files.filter(f => (!q || f.name.toLowerCase().includes(q)) &&
    (category === 'All' || category === f.category));
  for (const item of matches.slice(0,1000)) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'web-game-row';
    row.textContent = item.name + '  ·  ' + item.category + '  ·  ' + item.size.toLocaleString() + ' B';
    row.addEventListener('click',()=>choose(item));
    target.append(row);
  }
  $('webGameCount').textContent = matches.length.toLocaleString() +
    ' entries' + (matches.length>1000?' (first 1,000 shown)':'');
}
async function choose(item) {
  selected = item;
  $('webGameSelected').textContent = item.name+' · '+item.category+' · '+item.size.toLocaleString()+' bytes';
  $('webGameSave').disabled = false;
  $('webGameHex').textContent = 'Reading first bytes…';
  try {
    const bytes = await item.getSlice(0,Math.min(256,item.size));
    const lines = [];
    for(let i=0;i<bytes.length;i+=16) {
      const chunk = bytes.subarray(i,i+16);
      lines.push(i.toString(16).padStart(8,'0')+'  '+
        Array.from(chunk,b=>b.toString(16).padStart(2,'0')).join(' ').padEnd(47,' ')+
        '  '+Array.from(chunk,b=>b>=32&&b<127?String.fromCharCode(b):'.').join(''));
    }
    $('webGameHex').textContent = lines.join('\n') || '(empty file)';
  } catch(e) { $('webGameHex').textContent = e.message; }
}
async function loadInputs(input, folder=false) {
  files.length=0;selected=null;$('webGameSave').disabled=true;
  $('webGameHex').textContent='';$('webGameSelected').textContent='Select a file to inspect.';
  try {
    for(const blob of input) {
      message('Reading '+blob.name+' locally…');
      if(folder) {
        add(blob.webkitRelativePath || blob.name,blob.size,
          (offset,len)=>readBlob(blob,offset,len));
      } else if (/\.zip$/i.test(blob.name)) await indexZip(blob);
      else if (/\.(nsp|xci)$/i.test(blob.name)) {
        if (/\.xci$/i.test(blob.name)) {
          // Switch gamecard root HFS0 begins at offset 0xF000.
          await indexPackage(blob,blob.name,0xF000,blob.size-0xF000);
        } else await indexPackage(blob,blob.name);
      } else {
        add(blob.name,blob.size,(offset,len)=>readBlob(blob,offset,len));
      }
    }
    display();
    message('Indexed '+files.length.toLocaleString()+' file(s). Encrypted NCA contents remain locked in browser mode.');
  } catch(e) {display();message('Inspection incomplete: '+e.message);}
}
$('tabWebGame').addEventListener('click',()=>{
  $('viewerPanel').hidden=true;$('archivePanel').hidden=true;
  $('webGamePanel').hidden=false;
  for(const tab of ['tabViewer','tabArchive','tabWebGame']) {
    $(tab).classList.toggle('active',tab==='tabWebGame');
    $(tab).setAttribute('aria-selected',String(tab==='tabWebGame'));
  }
});
for(const tab of ['tabViewer','tabArchive']) $(tab).addEventListener('click',()=>{
  $('webGamePanel').hidden=true;$('tabWebGame').classList.remove('active');
  $('tabWebGame').setAttribute('aria-selected','false');
});
$('webGameOpen').addEventListener('click',()=>$('webGameInput').click());
$('webGameFolder').addEventListener('click',()=>$('webGameFolderInput').click());
$('webGameInput').addEventListener('change',event=>{void loadInputs(event.target.files);event.target.value='';});
$('webGameFolderInput').addEventListener('change',event=>{void loadInputs(event.target.files,true);event.target.value='';});
$('webGameSearch').addEventListener('input',display);
$('webGameType').addEventListener('change',display);
$('webGameSave').addEventListener('click',async()=>{
  if(!selected)return;
  try {
    if(selected.size>512*1024*1024) throw Error('Browser export is limited to 512 MiB per file');
    message('Preparing selected file…');
    const raw=await selected.getSlice(0,selected.size);
    const url=URL.createObjectURL(new Blob([raw]));
    const a=document.createElement('a');a.href=url;a.download=selected.name.split('/').at(-1);
    a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    message('Saved selected file.');
  } catch(e){message('Export failed: '+e.message);}
});
