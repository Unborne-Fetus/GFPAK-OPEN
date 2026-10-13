/**
 * Browser-only implementation of the desktop Game File Explorer interface.
 * Reuses the NX-style HTML/CSS; no Python bridge, installers or uploads.
 */
import JSZip from 'jszip';
import {detectGameFromNames,gameCapabilities} from './game-support.js';
import {categoryOf,kindOf,fromBlob,openZip,openXci,readPackage,openGfpak,
        inspectNca,openNcaSection,romChildren} from './browser-package-reader.js';
import {parseHashDictionary} from './gfpak.js';
import {parseNcaKeys,keyInfo,parseNcaTicket} from './browser-nca-crypto.js';
import {buildPokedexZip,modelIdentityFromPath,POKEDEX_GAMES,COMPATIBLE_MODEL_SUFFIXES} from './pokedex3d-export.js';

const byId=id=>document.getElementById(id);
const classSets={
  models:new Set(['model','model archive','asset package','mesh']),
  textures:new Set(['texture']),
  animations:new Set(['animation'])
};
const iconFor=node=>node.children!==null?'▤':
  node.category==='model'?'◇':node.category==='texture'?'▧':
  node.category==='animation'?'▶':node.category==='encrypted container'?'🔒':'▯';
const labelFor=kind=>({
  model:'Model',texture:'Texture',animation:'Animation',skeleton:'Skeleton',
  mesh:'Mesh',material:'Material',folder:'Folder',
  'asset package':'Model/archive package','encrypted container':'NCA file',
  'compressed container':'NCZ (not decoded)',metadata:'Metadata',
  unknown:'Unknown hashed resource',other:'Other file'
}[kind]||kind);
const sizeOf=n=>{
  if(!Number.isFinite(n))return '—';
  for(const [limit,unit] of [[1024**3,'GiB'],[1024**2,'MiB'],[1024,'KiB']])
    if(n>=limit)return (n/limit).toFixed(2)+' '+unit;
  return n+' B';
};
const state={
  root:null,folder:null,selected:null,files:[],nodes:[],
  catalog:[],type:'all',dictionary:new Map(),source:null,
  busy:false,scanning:false,scanRevision:0,scanDone:false,selectedRevision:0,
  treeExpanded:new Set(),listPage:0,thumbnailUrl:null,
  packMeta:null,sourceName:'',keys:new Map(),lastSelection:null,zipExporting:false,
  pokedexButton:null,pokedexGameSelect:null,pokedexHint:null
};
const MAX_SCAN=150000;
const MAX_EXPORT=300*1024*1024;
let idCounter=0;

function notice(message,error=false){
  byId('assetNotice').textContent=String(message);
  byId('assetNotice').classList.toggle('native-error',error);
}
function mk(name,options={},parent=null) {
  const node={
    id:'browser_'+(++idCounter),name,
    parent,children:options.folder?new Map():null,
    size:options.size??0,category:options.category??categoryOf(name),
    kind:options.kind??kindOf(name),source:options.source||null,
    loader:options.loader||null,loaded:!options.loader,
    error:null, metadata:options.metadata||{},
    lazySource:options.loadSource||null,
    packedSource:options.loadPackedSource||null,
    path:parent?(parent.path+'/'+name):name
  };
  if(node.children!==null && ['directory','nca_dir','nca_section'].includes(node.kind))
    node.category='folder';
  return node;
}
function ensureFolder(parent,name){
  let current=parent.children.get(name);
  if(current && current.children===null)throw Error('File/folder name collision: '+name);
  if(!current){
    current=mk(name,{folder:true,kind:'directory'},parent);
    parent.children.set(name,current);
    state.nodes.push(current);
  }
  return current;
}
function attachPath(parent,raw,options={}){
  const parts=String(raw).replace(/\\/g,'/').split('/').filter(Boolean);
  if(!parts.length || parts.some(p=>p==='.'||p==='..'||p.includes('\0')))
    throw Error('Unsafe or empty archive path');
  if(parts.length>128)throw Error('Archive path exceeds nesting limit');
  let cursor=parent;
  for(const segment of parts.slice(0,-1))cursor=ensureFolder(cursor,segment);
  const name=parts.at(-1);
  // Some archives contain duplicate names. Expose safely without clobbering an entry.
  const label=cursor.children.has(name)?name+' ('+(cursor.children.size+1)+')':name;
  const node=mk(label,options,cursor);
  cursor.children.set(label,node);
  state.nodes.push(node);
  if(node.children===null || ['nca','gfpak','zip','package'].includes(node.kind))
    state.files.push(node);
  return node;
}
function recordOption(entry,source){
  const kind=entry.kind||kindOf(entry.name);
  return {
    size:entry.size,category:entry.category||categoryOf(entry.name),kind,
    source:source||entry.source||null,loadSource:entry.loadSource||null,
    loadPackedSource:entry.loadPackedSource||null,
    metadata:{offset:entry.offset,hash:entry.hash,
      compression:entry.compression,packedSize:entry.packedSize},
    folder:['nca','gfpak','zip','package'].includes(kind) ||
      (kind==='file' && ['secure','normal','update','logo'].includes(entry.name)),
    loader:async node=>{
      const src=await ensureSource(node);
      if(kind==='nca')await expandNca(node);
      else if(kind==='gfpak')await expandGfpak(node);
      else if(kind==='zip')await expandZip(node);
      else {
        const header=await src.read(0,Math.min(4,src.size));
        if(new TextDecoder().decode(header)==='HFS0')
          await populatePackage(node,await readPackage(src,0,'HFS0'));
        else if(new TextDecoder().decode(header)==='PFS0')
          await populatePackage(node,await readPackage(src,0,'PFS0'));
        else throw Error('This file is not a readable nested package');
      }
    }
  };
}
async function ensureSource(node){
  if(!node?.source&&node?.lazySource){
    node.pendingSource ||= node.lazySource();
    node.source=await node.pendingSource;
  }
  if(!node?.source)throw Error('This file has no readable source');
  return node.source;
}
function activeRoot(node){
  let current=node;
  while(current?.parent)current=current.parent;
  return current===state.root;
}
async function addRows(parent,entries){
  if(!activeRoot(parent))throw Error('Source changed while reading package');
  for(const entry of entries){
    if(state.nodes.length>=MAX_SCAN)throw Error('Index limit reached ('+MAX_SCAN.toLocaleString()+' entries)');
    const options=recordOption(entry);
    // Do not make raw files expandable until format was established.
    const isArchive=options.folder;
    if(!isArchive)delete options.loader;
    attachPath(parent,entry.name,options);
  }
}
async function populatePackage(parent,result){
  await addRows(parent,result.entries);
  parent.metadata.indexSize=result.indexSize;
  parent.metadata.format=result.magic;
}
async function expandZip(node){
  let blob=node.source.file;
  if(!blob){
    if(node.size>256*1024*1024)throw Error('Nested ZIP too large to open in browser');
    blob=new Blob([await node.source.read(0,node.size)]);
  }
  await addRows(node,await openZip(blob));
  node.metadata.format='ZIP';
}
async function expandGfpak(node){
  let blob=node.source.file;
  if(!blob){
    if(node.size>256*1024*1024)throw Error('Nested GFPAK too large to materialize in browser');
    blob=new Blob([await node.source.read(0,node.size)]);
  }
  await addRows(node,await openGfpak(blob,state.dictionary));
  node.metadata.format='GFLXPACK';
}
async function lookupLocalPackageTicket(identifier) {
  const tickets=state.files.filter(file=>/\\.tik$/i.test(file.name)&&
    file.size>=0x1b0&&file.size<=1024*1024).slice(0,256);
  for(const node of tickets){
    try{
      const src=await ensureSource(node);
      const raw=await src.read(0,Math.min(node.size,0x500));
      const ticket=parseNcaTicket(raw);
      if(ticket?.rights===identifier)return ticket;
    }catch{ /* An inaccessible ticket never proves the NCA is readable. */ }
  }
  return null;
}
async function expandNca(node){
  const sections=await inspectNca(node.source,state.keys,lookupLocalPackageTicket);
  if(!activeRoot(node))throw Error('Source changed during NCA read');
  if(!sections.length)throw Error('NCA contains no readable filesystem sections');
  for(const section of sections){
    const child=mk(section.name,{
      folder:true,kind:'nca_section',size:section.size,
      metadata:{encryption:section.encryption,
        fsType:section.fsType,hashType:section.hashType},
      loader:async holder=>{
        const result=await openNcaSection(section);
        if(result.type==='pfs')await populatePackage(holder,result);
        else await populateRomfs(holder,result,0);
      }
    },node);
    node.children.set(child.name,child);
    state.nodes.push(child);
  }
  node.metadata.header='NCA3 (read with local keyset when required)';
}
async function populateRomfs(node,fs,at){
  const entries=await romChildren(fs,at);
  if(!activeRoot(node))throw Error('Source changed during RomFS read');
  for(const entry of entries){
    if(state.nodes.length>=MAX_SCAN)throw Error('File index limit reached');
    if(entry.kind==='folder'){
      const folder=mk(entry.name,{folder:true,kind:'nca_dir',
        loader:child=>populateRomfs(child,fs,entry.at)},node);
      node.children.set(entry.name,folder);
      state.nodes.push(folder);
    }else{
      const file=mk(entry.name,{source:entry.source,size:entry.size,
        category:entry.category,kind:entry.kind},node);
      node.children.set(entry.name,file);
      state.nodes.push(file);state.files.push(file);
    }
  }
}
async function expand(node){
  if(node.children===null)return;
  if(node.loaded)return;
  if(node.loading)return node.loading;
  node.loading=(async()=>{
    try{
      await node.loader?.(node);
      node.loaded=true;node.error=null;
    }catch(e){
      // Only validated entries remain visible; no imaginary NCA files.
      node.error=e.message||String(e);
      throw e;
    }finally{node.loading=null;}
  })();
  return node.loading;
}
function descendantsOf(node){
  let cursor=node;
  while(cursor){if(cursor===state.folder)return true;cursor=cursor.parent;}
  return false;
}
async function go(node){
  if(node.children===null){select(node);return;}
  try{
    await expand(node);
    state.folder=node;state.type='all';state.listPage=0;
    state.treeExpanded.add(node.id);
    for(const button of document.querySelectorAll('#assetBrowser [data-asset-class]')){
      const active=button.dataset.assetClass==='all';
      button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    }
    render();
  }catch(e){notice((node.name+': '+(e.message||String(e))),true);select(node);}
}
function sourceRoot(file,kind){
  const root=mk(file.name,{folder:true,kind,size:file.size,metadata:{bytes:file.size}});
  state.nodes=[root];state.files=[];state.root=root;state.folder=root;
  state.source=file;state.sourceName=file.name;
  state.treeExpanded=new Set([root.id]);
  state.packMeta=null;state.scanDone=false;state.type='all';
  byId('assetSearch').value='';byId('assetCategory').value='all';
  return root;
}
async function openInput(files,folder=false){
  if(state.scanning){state.scanRevision++;state.scanning=false;state.busy=false;}
  if(state.busy)return;
  const selectedFiles=Array.from(files||[]);
  if(!selectedFiles.length)return;
  state.lastSelection={files:selectedFiles,folder};
  state.busy=true;
  state.scanRevision++;
  try{
    const root=sourceRoot(selectedFiles[0],folder?'directory':kindOf(selectedFiles[0].name));
    notice('Indexing selected game data locally…');
    if(folder){
      root.name=selectedFiles[0].webkitRelativePath?.split('/')[0]||'Game folder';
      root.path=root.name;
      for(const item of selectedFiles){
        const name=item.webkitRelativePath?
          item.webkitRelativePath.split('/').slice(1).join('/'):item.name;
        if(!name)continue;
        attachPath(root,name,recordOption({
          name,size:item.size,kind:kindOf(item.name),category:categoryOf(item.name),
          source:fromBlob(item)
        }));
      }
    }else if(selectedFiles.length===1){
      root.source=fromBlob(selectedFiles[0]);
      root.size=root.source.size;
      if(root.kind==='package'){
        const pack=/\.(xci|xcz)$/i.test(selectedFiles[0].name)?
          await openXci(root.source):await readPackage(root.source,0,'PFS0');
        await populatePackage(root,pack);
        state.packMeta={count:pack.entries.length,indexSize:pack.indexSize,bytes:selectedFiles[0].size};
      }else if(root.kind==='zip')await expandZip(root);
      else if(root.kind==='gfpak')await expandGfpak(root);
      else if(root.kind==='nca')await expandNca(root);
      else attachPath(root,selectedFiles[0].name,{source:root.source,size:root.source.size});
      root.loaded=true;
    }else{
      root.name='Selected files';root.path=root.name;
      for(const item of selectedFiles)attachPath(root,item.name,{
        ...recordOption({name:item.name,size:item.size,source:fromBlob(item)}),
        source:fromBlob(item)
      });
    }
    const names=state.files.slice(0,100).map(n=>n.name);
    const detected=detectGameFromNames([root.name,...names]);
    const support=gameCapabilities(detected.id);
    const detectedGame=detected.id==='pla'?'la':detected.id;
    const chosenGame=document.getElementById('gameSource')?.value;
    if(state.pokedexGameSelect && POKEDEX_GAMES.includes(chosenGame==='pla'?'la':chosenGame)){
      state.pokedexGameSelect.value=chosenGame==='pla'?'la':chosenGame;
    }else if(state.pokedexGameSelect && POKEDEX_GAMES.includes(detectedGame)){
      state.pokedexGameSelect.value=detectedGame;
    }
    byId('assetGameProfile').hidden=false;
    byId('assetGameName').textContent=detected.id==='auto'?'Game unrecognized':detected.name;
    byId('assetGameEngine').textContent=detected.engine||'Unknown engine';
    byId('assetGameSupport').textContent=
      'Models: '+support.models+' · Textures: '+support.textures+
      ' · Animations: '+support.animations;
    byId('assetNcaAutoReport').hidden=true;
    byId('assetScanSummary').textContent='Indexed '+state.files.length+
      ' known files. Locate assets to explore supported nested archives.';
    state.treeExpanded.add(root.id);
    render();
    updateNspDashboard();
    notice('Loaded '+root.name+' · '+state.nodes.length.toLocaleString()+
      ' known entries. Starting read-only asset discovery…');
    setTimeout(()=>{if(state.root===root&&!state.busy)void scan();},0);
  }catch(e){render();notice('Could not inspect package: '+(e.message||String(e)),true);}
  finally{state.busy=false;}
}
function rowsToShow(){
  const q=byId('assetSearch').value.trim().toLowerCase();
  const category=byId('assetCategory').value;
  const nodes=state.type==='all'?
    Array.from(state.folder?.children?.values()||[]):state.files.filter(n=>
      classSets[state.type]?.has(n.category));
  return nodes.filter(n=>(!q || n.path.toLowerCase().includes(q) ||
      (n.metadata.hash||'').includes(q)) &&
    (category==='all'||n.category===category)).sort((a,b)=>{
      const d=(b.children!==null)-(a.children!==null);
      return d||a.name.localeCompare(b.name,undefined,{numeric:true});
    });
}
function render(){
  // Scans can finish after the user switches tabs; never reopen the explorer automatically.
  byId('assetBack').disabled=!state.folder?.parent;
  byId('assetBreadcrumb').textContent=state.folder?
    state.folder.path.replaceAll('/','  /  '):'No game source selected';
  byId('assetScan').disabled=!state.root||(state.busy&&!state.scanning);
  renderTree();renderRows();renderCounts();
}
function renderTree(){
  const host=byId('assetTree');host.replaceChildren();
  if(!state.root){host.textContent='Choose a game package or folder';return;}
  let total=0;
  function visit(node,parent,depth){
    if(total++>3000)return;
    const wrap=document.createElement('div');wrap.className='nx-tree-node';wrap.setAttribute('role','treeitem');
    const line=document.createElement('div');line.className='nx-tree-line';
    line.style.paddingLeft=(7+15*depth)+'px';
    if(node===state.folder)line.classList.add('nx-selected');
    const expandButton=document.createElement('button');
    expandButton.className='nx-tree-toggle';expandButton.type='button';
    expandButton.textContent=node.children===null?'':state.treeExpanded.has(node.id)?'▾':'▸';
    expandButton.disabled=node.children===null;
    const icon=document.createElement('span');icon.className='nx-node-icon';
    icon.textContent=iconFor(node);
    const label=document.createElement('button');label.type='button';
    label.className='nx-tree-name';label.textContent=node.name;
    expandButton.addEventListener('click',async()=>{
      const open=!state.treeExpanded.has(node.id);
      if(open){
        try{await expand(node);state.treeExpanded.add(node.id);}
        catch(e){notice(e.message||String(e),true);}
      }else state.treeExpanded.delete(node.id);
      renderTree();
    });
    label.addEventListener('click',()=>node.children===null?select(node):void go(node));
    label.addEventListener('dblclick',()=>node.children!==null?void go(node):void preview(node));
    line.append(expandButton,icon,label);wrap.append(line);parent.append(wrap);
    if(node.children!==null&&state.treeExpanded.has(node.id)){
      const children=document.createElement('div');children.className='nx-tree-children';
      children.setAttribute('role','group');wrap.append(children);
      const folderChildren=Array.from(node.children.values()).sort((a,b)=>
        (b.children!==null)-(a.children!==null)||a.name.localeCompare(b.name));
      for(const child of folderChildren.slice(0,250))visit(child,children,depth+1);
      if(folderChildren.length>250){
        const more=document.createElement('div');more.className='nx-tree-more';
        more.textContent='+'+(folderChildren.length-250)+' more · open folder to browse all';
        children.append(more);
      }
    }
  }
  visit(state.root,host,0);
  byId('nxTreeStatus').textContent=state.folder?.name+' · '+
    (state.folder?.children?.size||0)+' entries in this folder';
}
function renderRows(){
  const host=byId('assetRows');host.replaceChildren();
  if(!state.folder){
    const tr=document.createElement('tr');tr.innerHTML='<td colspan="4">Open a source to start.</td>';host.append(tr);return;
  }
  const rows=rowsToShow(),pageSize=250;
  const start=state.listPage*pageSize;
  for(const node of rows.slice(start,start+pageSize)){
    const tr=document.createElement('tr');tr.className='asset-row';
    if(node===state.selected)tr.classList.add('selected');
    tr.tabIndex=0;
    const name=document.createElement('td');
    const icon=document.createElement('span');icon.className='asset-file-icon';
    icon.textContent=iconFor(node);
    name.append(icon,document.createTextNode(state.type==='all'?node.name:node.path));
    const cat=document.createElement('td');const badge=document.createElement('span');
    badge.className='asset-type '+node.category.replaceAll(' ','-');
    badge.textContent=labelFor(node.category);cat.append(badge);
    const size=document.createElement('td');size.textContent=node.children!==null?'—':sizeOf(node.size);
    const action=document.createElement('td');
    const button=document.createElement('button');button.type='button';button.className='asset-open';
    button.textContent=node.children!==null?'Open →':canPreview(node)?'Preview ↗':
      node.category==='texture'?'View texture ↗':'Details';
    button.addEventListener('click',event=>{
      event.stopPropagation();
      if(node.children!==null)void go(node);
      else if(canPreview(node)||node.category==='texture')void preview(node);
      else select(node);
    });
    action.append(button);tr.append(name,cat,size,action);
    tr.addEventListener('click',()=>select(node));
    tr.addEventListener('dblclick',()=>node.children!==null?void go(node):void preview(node));
    tr.addEventListener('keydown',event=>{
      if(event.key==='Enter'){event.preventDefault();node.children!==null?void go(node):select(node);}
    });
    host.append(tr);
  }
  if(!rows.length){
    const tr=document.createElement('tr');const td=document.createElement('td');
    td.colSpan=4;td.className='table-empty';
    td.textContent='No matching files in this location. Encrypted or unidentified resources are not guessed.';
    tr.append(td);host.append(tr);
  }
  if(rows.length>pageSize){
    const tr=document.createElement('tr');const td=document.createElement('td');
    td.colSpan=4;td.className='nx-pagination-row';
    const previous=document.createElement('button');previous.className='button button-secondary';
    previous.textContent='← Previous';previous.disabled=state.listPage===0;
    previous.addEventListener('click',()=>{state.listPage--;renderRows();});
    const next=document.createElement('button');next.className='button button-secondary';
    next.textContent='Next 250 →';next.disabled=start+pageSize>=rows.length;
    next.addEventListener('click',()=>{state.listPage++;renderRows();});
    td.append(previous,document.createTextNode('  '+(start+1)+'–'+Math.min(rows.length,start+pageSize)+
      ' / '+rows.length+'  '),next);tr.append(td);host.append(tr);
  }
}
function renderCounts(){
  const counts={};for(const file of state.files)counts[file.category]=(counts[file.category]||0)+1;
  const count=cat=>counts[cat]||0;
  const models=count('model')+count('mesh')+count('asset package');
  for(const [key,value] of Object.entries({
    assetCountModel:models,assetClassModels:models,
    assetCountTexture:count('texture'),assetClassTextures:count('texture'),
    assetCountAnimation:count('animation'),assetClassAnimations:count('animation'),
    assetCountOther:state.files.length-models-count('texture')-count('animation')
  }))byId(key).textContent=value.toLocaleString()+(state.scanDone?'':'+');
  byId('assetClassHint').textContent=state.scanDone?
    'Scan finished. Locked NCAs and unknown hashes remain unresolved.' :
    'Counts reflect discovered files only. Use Locate assets to inspect nested readable files.';
}
function select(node){
  state.selected=node;state.selectedRevision++;
  if(state.thumbnailUrl){URL.revokeObjectURL(state.thumbnailUrl);state.thumbnailUrl=null;}
  byId('assetSelected').textContent=node?.name||'Nothing selected';
  byId('assetSelectedInfo').textContent=node?
    (labelFor(node.category)+' · '+sizeOf(node.size)+(node.error?' · '+node.error:'')) :
    'Select a file to inspect its details.';
  byId('assetPreview').disabled=!canPreview(node)&&node?.category!=='texture';
  byId('assetPreview').textContent=node?.category==='texture'?'▧ View texture':'◈ Preview in 3D';
  byId('assetExportPokemon').disabled=!node || !['model','asset package'].includes(node.category);
  if(state.pokedexButton) {
    let compatible=!!node && node.children===null && COMPATIBLE_MODEL_SUFFIXES.test(node.name);
    if(compatible) {
      try{modelIdentityFromPath(node.path.slice(state.root.path.length+1));}
      catch{compatible=false;}
    }
    state.pokedexButton.disabled=!compatible||state.zipExporting;
    state.pokedexButton.title=compatible?
      'Convert original assets without displaying a preview, validate textured geometry and idle animations, then export the Pokédex 3D Max import ZIP.':
      'Choose a model file with a recognizable pm#### Pokémon ID; raw packages cannot be converted automatically.';
  }
  byId('assetSaveFile').disabled=!node||(!node.source&&!node.lazySource);
  byId('assetSavePacked').hidden=!node?.packedSource;
  byId('assetSavePacked').disabled=!node?.packedSource;
  byId('assetCopyNcaDiagnostics').disabled=!node||!['nca','nca_section'].includes(node.kind);
  byId('assetThumbnail').hidden=true;
  byId('assetGeneralHex').hidden=true;
  byId('assetFamily').hidden=true;
  if(node?.category==='model') renderFamily(node);
  byId('assetNcaAutoReport').hidden=true;
  byId('assetFileMetadata').replaceChildren();
  byId('nspSelection').hidden=!node||node.children!==null||(!node.source&&!node.lazySource);
  renderRows();
  if(node)void details(node,state.selectedRevision);
}
async function details(node,revision){
  const pairs=[
    ['Type',labelFor(node.category)],['Size',sizeOf(node.size)],
    ['Location',node.path],...Object.entries(node.metadata).filter(([,v])=>v!==undefined)
      .map(([k,v])=>[k,String(v)])
  ];
  const host=byId('assetFileMetadata');
  for(const [term,value] of pairs){
    const dt=document.createElement('dt');dt.textContent=term;
    const dd=document.createElement('dd');dd.textContent=value;
    host.append(dt,dd);
  }
  byId('assetSignature').textContent=node.error||'';
  if(!node.source&&!node.lazySource)return;
  try{
    const source=await ensureSource(node);
    const bytes=await source.read(0,Math.min(256,node.size));
    if(revision!==state.selectedRevision)return;
    byId('assetGeneralHex').textContent=hexDump(bytes,0);
    byId('assetGeneralHex').hidden=false;
    byId('assetSignature').textContent=node.error||
      ('Signature: '+Array.from(bytes.subarray(0,8),b=>String.fromCharCode(b>=32&&b<127?b:46)).join(''));
    if(node.category==='texture'&&/\.(png|jpg|jpeg|webp)$/i.test(node.name)&&node.size<=16*1024*1024){
      const raw=await source.read(0,node.size);
      if(revision!==state.selectedRevision)return;
      const url=URL.createObjectURL(new Blob([raw]));
      state.thumbnailUrl=url;byId('assetThumbnail').src=url;byId('assetThumbnail').hidden=false;
    }
    if(node.parent===state.root && /\.(nca|ncz)$/i.test(node.name)){
      byId('nspSelection').hidden=false;
      byId('nspSignature').textContent=node.error||'Raw NCA signature (encrypted contents may be unreadable).';
      byId('nspEntryMetadata').textContent=node.path+' · '+sizeOf(node.size);
    }
  }catch(e){
    if(revision===state.selectedRevision)byId('assetSignature').textContent=e.message||String(e);
  }
}
function hexDump(bytes,offset){
  const lines=[];
  for(let i=0;i<bytes.length;i+=16){
    const part=bytes.subarray(i,i+16);
    lines.push((offset+i).toString(16).padStart(8,'0')+'   '+
      Array.from(part,b=>b.toString(16).padStart(2,'0')).join(' ').padEnd(48)+
      ' |'+Array.from(part,b=>b>=32&&b<127?String.fromCharCode(b):'.').join('')+'|');
  }
  return lines.join('\n')||'(empty)';
}
function canPreview(node){
  return !!node&&(node.kind==='gfpak'||
    (node.children===null&&node.category==='model'));
}
function matchingAssets(model){
  // Desktop parity: include decoded companions from a selected GFPAK and from
  // sibling archives, but never merge files explicitly owned by another pm####.
  const lower=s=>String(s||'').replaceAll('\\','/').toLowerCase();
  const token=p=>lower(p).match(/(?:^|[/_.-])(pm\d{4})(?=$|[/_.-])/)?.[1]||'';
  const family=token(model.path);
  const modelPrefix=model.name.replace(/\.[^.]+$/,'').toLowerCase();
  let archive=model.parent;
  while(archive && !['gfpak','zip'].includes(archive.kind))archive=archive.parent;
  const sameArchive=node=>{
    let parent=node.parent;
    while(parent){if(parent===archive)return true;parent=parent.parent;}
    return false;
  };
  const archiveModels=archive?state.files.filter(item=>item.category==='model'&&sameArchive(item)):[];
  const archiveFamilies=new Set(archiveModels.map(item=>token(item.path)).filter(Boolean));
  const archiveIsMixed=archiveFamilies.size>1;
  const immediateModelCount=state.files.filter(item=>
    item.parent===model.parent && item.category==='model').length;
  const companions=state.files.filter(other=>{
    if(other===model||other.children!==null||(!other.source&&!other.lazySource))return false;
    if(!['model','mesh','texture','skeleton','animation','material','other','unknown'].includes(other.category))
      return false;
    const otherFamily=token(other.path);
    if(family&&otherFamily&&otherFamily!==family)return false;
    const sibling=other.parent===model.parent;
    const sameFamily=!!family&&otherFamily===family;
    const filename=other.name.toLowerCase();
    const modelRelated=filename.startsWith(modelPrefix+'_')||
      filename.startsWith(modelPrefix+'.');
    // Export all members of a single-model GFPAK, including unnamed hashes:
    // skeleton/texture/animation files often have no recognizable extension.
    const insideArchive=archive&&sameArchive(other);
    if(insideArchive && (!archiveIsMixed||sameFamily))return true;
    if(sameFamily)return true;
    if(sibling&&immediateModelCount===1)return true;
    if(sibling&&modelRelated)return true;
    return false;
  });
  return [model,...companions];
}
async function preview(node){
  if(!node)return;
  if(node.kind!=='gfpak'&&node.category!=='model'&&node.category!=='texture')return;
  try{
    await ensureSource(node);
    if(node.kind==='gfpak'){
      if(node.size>MAX_EXPORT)throw Error('This GFPAK exceeds browser preview memory cap');
      const source=await node.source.read(0,node.size);
      const file=new File([source],node.name);
      window.dispatchEvent(new CustomEvent('gfpak-native-model',{detail:file}));
      byId('tabArchive').click();
      notice('Opening GFPAK in the existing archive inspector.');return;
    }
    if(node.category==='texture'){
      if(node.size>MAX_EXPORT)throw Error('Texture exceeds preview memory cap');
      const bytes=await node.source.read(0,node.size);
      window.dispatchEvent(new CustomEvent('gfpak-browser-texture',{
        detail:{name:node.name,bytes}
      }));
      notice('Texture sent to the web viewer.');
      return;
    }
    const matched=matchingAssets(node);
    const total=matched.reduce((n,v)=>n+v.size,0);
    if(total>MAX_EXPORT)throw Error('Model and companion files exceed the 300 MiB browser preview limit');
    if(matched.length===1){
      const raw=await node.source.read(0,node.size);
      const file=new File([raw],node.name);
      window.dispatchEvent(new CustomEvent('gfpak-native-model',{detail:file}));
    }else{
      const zip=new JSZip();
      for(const asset of matched){
        const relative=asset.path.slice(state.root.path.length+1);
        const source=await ensureSource(asset);
        zip.file(relative,await source.read(0,asset.size));
      }
      const blob=await zip.generateAsync({type:'blob',compression:'STORE'});
      const file=new File([blob],'browser-preview.zip',{type:'application/zip'});
      window.dispatchEvent(new CustomEvent('gfpak-native-model',{detail:file}));
    }
    byId('tabViewer').click();
    notice('Opening '+node.name+' in 3D · '+(matched.length-1)+' linked companions.');
  }catch(e){notice('Preview could not start: '+(e.message||String(e)),true);}
}
function rawArchiveMembers(archive) {
  const members=[];
  const pending=[archive];
  while(pending.length){
    const folder=pending.pop();
    if(folder.children===null){
      members.push(folder);continue;
    }
    for(const child of folder.children.values())pending.push(child);
  }
  return members;
}
async function exportAssetPack(node){
  if(!node||!['model','asset package'].includes(node.category))return;
  try{
    // Unlike the converted Pokédex ZIP, this export never invokes loadModel,
    // exportGlb, the canvas renderer, or a 3D preview.
    if(node.kind==='gfpak')await expand(node);
    const matches=node.kind==='gfpak'?rawArchiveMembers(node):matchingAssets(node);
    if(!matches.length)
      throw Error('This archive has no indexed resources. Open the GFPAK or load its hash dictionary first.');
    const total=matches.reduce((n,item)=>n+item.size,0);
    if(total>MAX_EXPORT)
      throw Error('Raw asset ZIP exceeds the current 300 MiB browser memory limit; select fewer resources.');
    const zip=new JSZip(),used=new Set();
    for(const item of matches){
      const source=await ensureSource(item);
      const relative=node.kind==='gfpak'?
        item.path.slice(node.path.length+1):
        item.path.slice(state.root.path.length+1);
      const path=relative.replaceAll('\\','/');
      if(!path||path.startsWith('/')||/^[a-z]:/i.test(path)||
         path.split('/').some(part=>part==='..'||part==='.'||!part))
        throw Error('Unsafe archived filename: '+path);
      if(used.has(path.toLowerCase()))
        throw Error('Conflicting archived filename: '+path);
      used.add(path.toLowerCase());
      // Store original *decoded* resources (including unidentified hashes),
      // preserving their names exactly as the desktop export does.
      zip.file(path,await source.read(0,source.size));
    }
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;
    a.download=node.name.replace(/\.[^.]+$/,'')+'-assets.zip';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    notice('Exported '+matches.length+' original asset files as ZIP (no rendering). '+
      'For an importable Pokédex 3D Max model use the separate Pokédex ZIP button.');
  }catch(e){notice('Raw asset ZIP failed: '+(e.message||String(e)),true);}
}

async function exportPokedex3dPack(node){
  if(!node||state.zipExporting)return;
  const startRoot=state.root;
  const button=state.pokedexButton;
  state.zipExporting=true;
  button.disabled=true;
  button.textContent='◷ BUILDING POKÉDEX ZIP…';
  try{
    const game=state.pokedexGameSelect?.value||'';
    const matches=matchingAssets(node);
    if(!matches.length||matches[0]!==node)throw Error('Selected model no longer exists.');
    const prefix=startRoot.path+'/';
    const entries=matches.map(asset=>{
      const path=asset.path.startsWith(prefix)?asset.path.slice(prefix.length):asset.path;
      return {
        path,size:asset.size,
        linkedKind:asset.category,
        getBytes:async()=>{
          if(state.root!==startRoot)throw Error('Game source changed during Pokémon export.');
          const source=await ensureSource(asset);
          if(source.size>256*1024*1024)
            throw Error('A companion file exceeds the 256 MiB in-browser decoder limit: '+asset.name);
          const bytes=await source.read(0,source.size);
          return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
        },
        getText:async()=>{
          const src=await ensureSource(asset);
          if(src.size>16*1024*1024)throw Error('Text resource is too large');
          return new TextDecoder().decode(await src.read(0,src.size));
        }
      };
    });
    const selected=node.path.slice(prefix.length);
    const project={
      label:state.sourceName||startRoot.name,
      items:entries,
      models:entries.filter(item=>COMPATIBLE_MODEL_SUFFIXES.test(item.path))
    };
    const {blob,report}=await buildPokedexZip(project,selected,game,
      message=>notice('Pokédex ZIP · '+message));
    if(state.root!==startRoot)throw Error('Game source changed during Pokémon export.');
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;
    a.download=node.name.replace(/\.[^.]+$/,'')+'-pokedex3d.zip';
    document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    notice('Pokédex 3D Max ZIP exported: '+report.meshCount+' meshes, '+
      report.textureCount+' embedded textures, '+report.animations.length+
      ' animation clips (idle: '+report.idle+'). No preview or render required.');
  }catch(error){
    notice('Pokédex 3D Max ZIP could not be exported: '+
      (error.message||String(error))+
      ' Raw Asset ZIP remains available for source-file backups.',true);
  }finally{
    state.zipExporting=false;
    button.textContent='↓ EXPORT POKÉDEX 3D MAX ZIP';
    if(state.root===startRoot)select(state.selected);
  }
}

async function saveSourceToDisk(node,source,fileName){
  const chunkSize=4*1024*1024;
  if(typeof window.showSaveFilePicker==='function'){
    // A genuine click is required by browsers; ask before lengthy decoding.
    const handle=await window.showSaveFilePicker({suggestedName:fileName});
    const writable=await handle.createWritable();
    try{
      for(let offset=0;offset<source.size;offset+=chunkSize){
        const length=Math.min(chunkSize,source.size-offset);
        await writable.write(await source.read(offset,length));
      }
      await writable.close();
    }catch(error){await writable.abort().catch(()=>{});throw error;}
  }else{
    if(source.size>512*1024*1024)
      throw Error('Large file export needs a browser with streamed Save File support.');
    const parts=[];
    for(let offset=0;offset<source.size;offset+=chunkSize)
      parts.push(await source.read(offset,Math.min(chunkSize,source.size-offset)));
    const url=URL.createObjectURL(new Blob(parts)),a=document.createElement('a');
    a.href=url;a.download=fileName;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
}
async function savePacked(node){
  if(!node?.packedSource)return;
  try{
    // Collect user save permission while the click gesture is active.
    const source=await node.packedSource();
    await saveSourceToDisk(node,source,node.name.replace(/\\.[^.]+$/,'')+'.packed');
    notice('Saved packed bytes. Compression preserved; no decoded model was invented.');
  }catch(e){
    if(e?.name==='AbortError')return;
    notice('Packed extraction failed: '+(e.message||String(e)),true);
  }
}
function renderFamily(model){
  const files=matchingAssets(model).slice(1);
  if(!files.length)return;
  const family=model.name.match(/pm\d{3,5}(?:_\d{2})?/i)?.[0]||'same-folder';
  byId('assetFamily').hidden=false;byId('assetFamilyId').textContent=family;
  const counts={};
  for(const node of files)counts[node.category]=(counts[node.category]||0)+1;
  const chips=byId('assetFamilyCounts');chips.replaceChildren();
  for(const [kind,n] of Object.entries(counts)){
    const chip=document.createElement('span');chip.textContent=kind+': '+n;chips.append(chip);
  }
  const list=byId('assetFamilyFiles');list.replaceChildren();
  for(const node of files.slice(0,40)){
    const button=document.createElement('button');button.type='button';
    button.className='nx-companion-entry';button.textContent=node.category+' · '+node.name;
    button.title=node.path;button.addEventListener('click',()=>select(node));
    list.append(button);
  }
  if(files.length>40){
    const more=document.createElement('div');more.className='nx-companion-entry';
    more.textContent='+'+(files.length-40)+' additional companions';list.append(more);
  }
}
async function save(node){
  if(!node)return;
  try{
    const source=await ensureSource(node);
    await saveSourceToDisk(node,source,node.name);
    notice('Saved '+node.name);
  }catch(e){
    if(e?.name==='AbortError')return;
    notice('Export failed: '+(e.message||String(e)),true);
  }
}
async function scan(){
  if(!state.root||state.busy)return;
  state.busy=true;state.scanning=true;const revision=++state.scanRevision;
  byId('assetScan').textContent='◼ Stop scan';
  byId('assetScan').disabled=false;
  const queue=[state.root];let head=0,seen=0,warnings=[];
  byId('assetScanSummary').textContent='Scanning reachable game files…';
  while(head<queue.length&&seen<MAX_SCAN&&revision===state.scanRevision){
    const node=queue[head++];seen++;
    if(node.children!==null){
      try{await expand(node);}
      catch(e){warnings.push(node.name+': '+(e.message||String(e)));continue;}
      queue.push(...node.children.values());
    }
    if(seen%75===0){
      byId('assetScanSummary').textContent='Indexed '+state.files.length.toLocaleString()+
        ' files · scanned '+seen.toLocaleString()+' nodes…';
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  if(revision!==state.scanRevision)return;
  state.busy=false;state.scanning=false;state.scanDone=true;
  byId('assetScan').textContent='⌕ Locate assets';
  byId('assetScanSummary').textContent=
    'Scanned '+seen.toLocaleString()+' entries; found '+state.files.length.toLocaleString()+
    ' files. '+warnings.length+' locked/unsupported areas'+
    (seen>=MAX_SCAN?' · scan safety limit reached':'')+'.';
  state.listPage=0;render();
  notice(warnings.length?'Scan completed with '+warnings.length+' unsupported sections.' :
    'Scan completed for all reachable readable indexes.');
}
function updateNspDashboard(){
  const meta=state.packMeta;
  const visible=!!meta;
  byId('nspWorkbench').hidden=!visible;
  if(!visible)return;
  byId('nspPackageTitle').textContent=state.root.name;
  byId('nspBytes').textContent=sizeOf(meta.bytes);
  byId('nspFiles').textContent=meta.count.toLocaleString();
  byId('nspNcas').textContent=state.files.filter(n=>/\.nca$/i.test(n.name)).length.toLocaleString();
  byId('nspHeader').textContent=sizeOf(meta.indexSize);
  byId('nspWarningCount').textContent='Read-only index checked';
  byId('nspWarnings').textContent='Package index bounds validated. Individual encrypted NCA sections require native support.';
  const roles=new Map();
  for(const file of state.files)roles.set(labelFor(file.category),(roles.get(labelFor(file.category))||0)+1);
  const host=byId('nspRoleBreakdown');host.replaceChildren();
  for(const [role,count] of roles){
    const card=document.createElement('div');card.className='nsp-role-card';
    card.textContent=role+' · '+count.toLocaleString()+' files';host.append(card);
  }
}
async function exportManifest(){
  if(!state.root)return;
  const data={name:state.root.name,format:state.packMeta?.indexSize?'NSP/XCI':'Folder/archive',
    totalFiles:state.files.length,files:state.files.map(n=>({
      path:n.path,size:n.size,category:n.category,
      compression:n.metadata.compression??null,
      offset:n.metadata.offset??null
    }))};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='gfpak-game-index.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function install(){
  // Vite sets base '/' for desktop builds; do not initialize in an EXE.
  if(import.meta.env.BASE_URL==='/' || window.pywebview?.api)return;
  byId('tabAssets').hidden=false;
  byId('tabAssets').textContent='▤  GAME FILE EXPLORER';
  byId('tabAssets').addEventListener('click',()=>{
    // The original desktop NX-style CSS is scoped under .desktop-app.
    // Activate it only for this web panel; the Python bridge stays disabled.
    document.body.classList.add('desktop-app');
    for(const panel of ['viewerPanel','archivePanel','desktopTools'])
      byId(panel).hidden=true;
    byId('assetBrowser').hidden=false;
    for(const id of ['tabViewer','tabArchive','tabAssets']){
      byId(id).classList.toggle('active',id==='tabAssets');
      byId(id).setAttribute('aria-selected',String(id==='tabAssets'));
    }
  });
  for(const id of ['tabViewer','tabArchive']){
    byId(id).addEventListener('click',()=>{
      document.body.classList.remove('desktop-app');
      byId('assetBrowser').hidden=true;
      byId('tabAssets').classList.remove('active');
      byId('tabAssets').setAttribute('aria-selected','false');
    });
  }
  // Use exactly the desktop explorer's panel: no competing second inspector UI.
  const readerBar=byId('ncaReaderBar');
  const label=document.createElement('span');
  label.className='nca-reader-label';label.textContent='LOCAL NCA READER';
  const selectKey=byId('ncaSelectKeyset');
  selectKey.textContent='📁 Load prod.keys / title.keys';
  const keyStatus=byId('ncaReaderStatus');
  const clearKey=document.createElement('button');clearKey.type='button';
  clearKey.className='button button-secondary';clearKey.textContent='Clear keys';
  const keyInput=document.createElement('input');
  keyInput.type='file';keyInput.multiple=true;keyInput.accept='.keys,.txt';
  keyInput.hidden=true;
  readerBar.replaceChildren(label,selectKey,clearKey,keyStatus,keyInput);
  const updateKeyStatus=()=>{
    const info=keyInfo(state.keys);
    keyStatus.textContent=(info.header?'✓ NCA header key loaded':'No NCA header key')+
      ' · '+info.entries+' key entries · '+info.titleCount+' title keys · locally held in this tab only.';
  };
  updateKeyStatus();
  selectKey.addEventListener('click',()=>keyInput.click());
  keyInput.addEventListener('change',async event=>{
    const chosen=Array.from(event.target.files||[]);
    event.target.value='';
    if(!chosen.length)return;
    try{
      let loaded=new Map(state.keys), recognized=0;
      for(const file of chosen){
        if(file.size>1024*1024)throw Error('Key files must be under 1 MiB each.');
        const parsed=parseNcaKeys(await file.text());
        recognized+=parsed.size;
        for(const [name,value] of parsed)loaded.set(name,value);
      }
      if(!recognized)throw Error('No valid key entries found in the selected files.');
      state.keys=loaded;
      updateKeyStatus();
      notice('Local key file accepted. Reopening selected game source to retry encrypted NCA sections.');
      if(state.lastSelection)await openInput(state.lastSelection.files,state.lastSelection.folder);
    }catch(e){notice('Could not load keys: '+(e.message||String(e)),true);}
  });
  clearKey.addEventListener('click',async()=>{
    for(const bytes of state.keys.values())bytes.fill(0);
    state.keys=new Map();
    updateKeyStatus();
    notice('Local keys cleared.');
    if(state.lastSelection)await openInput(state.lastSelection.files,state.lastSelection.folder);
  });
  byId('assetAttach').hidden=true;byId('assetAttachNCA').hidden=true;byId('assetAttachBaseNCA').hidden=true;
  byId('assetCopyNcaDiagnostics').hidden=true;byId('assetSavePacked').hidden=true;
  byId('nspAudit').hidden=true;byId('nxMenuHash').hidden=true;
  byId('nxMenuLinkFolder').hidden=true;byId('assetExportPokemon').hidden=false;
  byId('assetExportPokemon').textContent='↓ EXPORT RAW ASSET ZIP';
  const gameLabel=document.createElement('label');
  gameLabel.className='input-label';
  gameLabel.textContent='SOURCE GAME FOR POKÉDEX 3D MAX';
  const gameSelect=document.createElement('select');
  gameSelect.id='pokedexExportGame';
  gameSelect.className='field';gameSelect.setAttribute('aria-label','Source game for Pokédex 3D Max ZIP');
  const games=[
    ['', 'Choose game to build compatible ZIP…'],
    ['lgpe',"Let's Go Pikachu / Eevee"],
    ['swsh','Sword / Shield'],
    ['bdsp','Brilliant Diamond / Shining Pearl'],
    ['la','Legends: Arceus'],
    ['sv','Scarlet / Violet'],
    ['za','Legends: Z-A']
  ];
  for(const [value,label] of games){
    const option=document.createElement('option');
    option.value=value;option.textContent=label;gameSelect.append(option);
  }
  state.pokedexGameSelect=gameSelect;
  const pokedexButton=document.createElement('button');
  pokedexButton.type='button';
  pokedexButton.id='assetExportPokedex3d';
  pokedexButton.className='button button-primary';
  pokedexButton.textContent='↓ EXPORT POKÉDEX 3D MAX ZIP';
  pokedexButton.disabled=true;
  pokedexButton.addEventListener('click',()=>void exportPokedex3dPack(state.selected));
  state.pokedexButton=pokedexButton;
  const hint=document.createElement('p');
  hint.className='helper-copy';
  hint.textContent='Raw Asset ZIP: original files only, never renders. Pokédex ZIP: builds a real GLB in memory without opening a preview; it requires embedded textures and a usable idle animation.';
  state.pokedexHint=hint;
  byId('assetExportPokemon').after(gameLabel,gameSelect,pokedexButton,hint);
  const input=document.createElement('input');input.type='file';input.multiple=true;input.hidden=true;
  input.accept='.nsp,.nsz,.xci,.xcz,.ncz,.zip,.gfpak,.nca,.glb,.gltf,.trmdl,.gfbmdl,.bntx';
  const folderInput=document.createElement('input');folderInput.type='file';
  folderInput.webkitdirectory=true;folderInput.multiple=true;folderInput.hidden=true;
  byId('assetBrowser').append(input,folderInput);
  const chooseFile=()=>input.click(),chooseFolder=()=>folderInput.click();
  input.addEventListener('change',event=>{void openInput(event.target.files);event.target.value='';});
  folderInput.addEventListener('change',event=>{void openInput(event.target.files,true);event.target.value='';});
  for(const id of ['assetOpenFile','nxMenuOpenPackage'])byId(id).addEventListener('click',chooseFile);
  for(const id of ['assetOpenFolder','nxMenuOpenFolder'])byId(id).addEventListener('click',chooseFolder);
  byId('assetBack').addEventListener('click',()=>{
    if(state.folder?.parent){
      state.folder=state.folder.parent;state.type='all';state.listPage=0;render();
    }
  });
  byId('assetSearch').addEventListener('input',()=>{state.listPage=0;renderRows();});
  byId('assetCategory').addEventListener('change',()=>{state.listPage=0;renderRows();});
  for(const button of document.querySelectorAll('#assetBrowser [data-asset-class]')){
    button.addEventListener('click',()=>{
      state.type=button.dataset.assetClass;state.listPage=0;
      for(const b of document.querySelectorAll('#assetBrowser [data-asset-class]')){
        b.classList.toggle('active',b===button);
        b.setAttribute('aria-pressed',String(b===button));
      }
      renderRows();
    });
  }
  byId('assetScan').addEventListener('click',()=>{
    if(state.scanning){
      state.scanRevision++;state.scanning=false;state.busy=false;
      byId('assetScan').textContent='⌕ Locate assets';
      byId('assetScanSummary').textContent='Scan stopped. Discovered entries remain available.';
      notice('Scanning stopped; indexed results are retained.');return;
    }
    void scan();
  });
  byId('assetPreview').addEventListener('click',()=>void preview(state.selected));
  byId('assetExportPokemon').addEventListener('click',()=>void exportAssetPack(state.selected));
  byId('assetSaveFile').addEventListener('click',()=>void save(state.selected));
  byId('assetSavePacked').addEventListener('click',()=>void savePacked(state.selected));
  byId('nspExtract').addEventListener('click',()=>void save(state.selected));
  byId('nspReadHex').addEventListener('click',async()=>{
    const node=state.selected;if(!node)return;
    try{
      await ensureSource(node);
      const offset=Number(byId('nspHexOffset').value),length=Number(byId('nspHexLength').value);
      const bytes=await node.source.read(offset,Math.min(length,node.size-offset));
      byId('nspHexDump').textContent=hexDump(bytes,offset);
    }catch(e){notice(e.message||String(e),true);}
  });
  byId('nspHash').addEventListener('click',async()=>{
    const node=state.selected;if(!node)return;
    try{
      await ensureSource(node);
      if(node.size>256*1024*1024)throw Error('Browser SHA-256 capped at 256 MiB');
      const bytes=await node.source.read(0,node.size);
      const result=await crypto.subtle.digest('SHA-256',bytes);
      byId('nspHashResult').textContent=Array.from(new Uint8Array(result),
        b=>b.toString(16).padStart(2,'0')).join('');
    }catch(e){notice(e.message||String(e),true);}
  });
  for(const id of ['nspManifest','nxMenuManifest'])byId(id).addEventListener('click',()=>void exportManifest());
  for(const id of ['nxMenuScan'])byId(id).addEventListener('click',()=>void scan());
  byId('nxMenuClearSearch').addEventListener('click',()=>{
    byId('assetSearch').value='';byId('assetCategory').value='all';renderRows();
  });
  byId('nxMenuFocusTree').addEventListener('click',()=>byId('assetTree').querySelector('button')?.focus());
  byId('nxMenuAbout').addEventListener('click',()=>notice(
    'Web game-file browser uses the desktop NX-style layout. Locally reads ZIP, GFPAK, NSP, XCI, and plaintext ExeFS/RomFS, without a desktop bridge.'));
  // Optional local filename dictionary reveals hashed GFPAK assets.
  const hashes=document.createElement('input');hashes.type='file';hashes.hidden=true;hashes.accept='.txt,.json';
  byId('assetBrowser').append(hashes);
  const hashesButton=document.createElement('button');hashesButton.type='button';
  hashesButton.className='button button-secondary';hashesButton.textContent='Load GFPAK hash dictionary';
  byId('assetOpenFile').after(hashesButton);
  byId('assetOpenFile').textContent='Open GFPAK / ZIP / NSP / XCI / NSZ / XCZ';
  hashesButton.addEventListener('click',()=>hashes.click());
  hashes.addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    try{
      state.dictionary=parseHashDictionary(await file.text(),file.name.toLowerCase().endsWith('.json'));
      notice('Loaded '+state.dictionary.size+' hash mappings. Reopen GFPAK archives to refresh names.');
    }catch(e){notice('Dictionary error: '+(e.message||String(e)),true);}
    event.target.value='';
  });
  for(const menu of document.querySelectorAll('#assetBrowser .nx-menu button'))
    menu.addEventListener('click',()=>{for(const parent of document.querySelectorAll('#assetBrowser .nx-menu'))parent.open=false;});
  // Keep limitations visible rather than incorrectly claiming native decryption.
  const guidance=byId('assetBrowser').querySelector('.asset-guidance');
  if(guidance)guidance.textContent=
    'Browser-native file tree: view nested ZIP/GFPAK, NSP/XCI indexes and plaintext NCA ExeFS/RomFS. '+
    'Compatible encrypted NCA headers and AES-CTR/XTS sections use locally supplied keys in Web Crypto. '+
    'NCZ and advanced patch, sparse and compressed mappings remain unsupported. Keys and files stay in this browser tab.';
  byId('assetClassHint').textContent='Select a package or folder, then Locate assets to index its readable children.';
}
install();
