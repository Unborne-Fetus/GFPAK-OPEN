import {openGamePackage, openExtractedFolder, exportIndex} from './game-file-reader.js';
import {parseLocalKeys} from './nca-crypto.js';

/** Desktop-style file viewer backed entirely by local browser File/Blob slices.
 * Index each game once, but render only expanded directories and 250 list rows
 * at a time. Never make one DOM element for every file in a large RomFS.
 */
const el = id => document.getElementById(id);
const PREVIEWABLE = /\.(gfpak|zip|glb|gltf|fbx|obj|dae|trmdl|trmsh|gfbmdl)$/i;
const MAX_ROWS = 250, MAX_TREE_CHILDREN = 250;
let game=null, selected=null, currentPackage=null, localKeys=null;
let folders=new Map(), fileByPath=new Map(), currentPath='', expanded=new Set(['']);
let visible=MAX_ROWS, opening=false, revision=0, activeClass='all';
let displayed=[], lastNotice='';

function formatSize(size) {
  if(size>=1024**3)return (size/1024**3).toFixed(2)+' GiB';
  if(size>=1024**2)return (size/1024**2).toFixed(1)+' MiB';
  if(size>=1024)return (size/1024).toFixed(1)+' KiB';
  return size+' bytes';
}
function message(value,error=false) {
  lastNotice=String(value);
  el('webGameNotice').textContent=lastNotice;
  el('webGameNotice').classList.toggle('native-error',error);
}
function download(filename,blob) {
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download=filename.split('/').at(-1)||'asset.bin';
  document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function fileState(row) {
  if(row.ncaStatus==='locked')return 'Locked (keys required)';
  if(row.ncaStatus==='unsupported')return 'Unsupported section';
  if(row.ncaStatus==='unavailable')return 'Unavailable';
  if(row.ncaStatus==='decrypted')return 'NCA sections readable';
  if(row.kind==='decrypted-nca-file')return 'Decrypted locally';
  if(row.kind==='plaintext-nca-file')return 'Decoded locally';
  if(row.category==='container')return 'Read-only container';
  return 'Read-only';
}
function modelType(row) {
  return row?.category==='archive' ? 'Model archive' :
    row?.category==='model' ? 'Model' :
    row?.category==='animation' ? 'Animation' :
    row?.category==='texture' ? 'Texture' :
    row?.category==='container' ? 'NCA / NCZ' :
    row?.category==='companion' ? 'Companion' : 'Other file';
}
function constructIndex() {
  folders=new Map();
  fileByPath=new Map();
  folders.set('',{path:'',name:game.name,parent:null,children:new Map(),files:[]});
  for(const row of game.entries) {
    const full=row.name.replaceAll('\\','/');
    if(!full || full.startsWith('/') || full.split('/').some(x=>!x||x==='..'))continue;
    row.viewPath=full;
    fileByPath.set(full,row);
    const parts=full.split('/');
    let path='';
    for(let i=0;i<parts.length-1;i++) {
      const child=path ? path+'/'+parts[i] : parts[i];
      if(!folders.has(child)) {
        const folder={path:child,name:parts[i],parent:path,children:new Map(),files:[]};
        folders.set(child,folder);
        folders.get(path).children.set(child,folder);
      }
      path=child;
    }
    folders.get(path).files.push(row);
  }
  expanded=new Set(['']);currentPath='';visible=MAX_ROWS;selected=null;
}
function updateCounts() {
  const types={model:0,archive:0,texture:0,animation:0};
  for(const row of game.entries)if(types[row.category]!==undefined)types[row.category]++;
  el('webGameModels').textContent=(types.model+types.archive).toLocaleString();
  el('webGameTextures').textContent=types.texture.toLocaleString();
  el('webGameAnimations').textContent=types.animation.toLocaleString();
  el('webGameFiles').textContent=game.entries.length.toLocaleString();
  el('webGameFormat').textContent=game.type;
}
function globalMode() {
  return !!el('webGameSearch').value.trim() || el('webGameCategory').value!=='all';
}
function currentEntries() {
  const search=el('webGameSearch').value.trim().toLowerCase();
  const group=el('webGameCategory').value;
  if(search || group!=='all'){
    const matches=game.entries.filter(row=>
      (group==='all'||row.category===group) &&
      (!search||row.name.toLowerCase().includes(search)));
    return matches.map(row=>({row,name:row.viewPath||row.name,kind:'file',path:row.viewPath}));
  }
  const folder=folders.get(currentPath);
  if(!folder)return [];
  const directories=[...folder.children.values()].sort((a,b)=>a.name.localeCompare(b.name))
    .map(node=>({kind:'directory',node,name:node.name,path:node.path,
      row:fileByPath.get(node.path)||null}));
  const files=folder.files.filter(row=>!folder.children.has(row.viewPath))
    .sort((a,b)=>a.name.localeCompare(b.name))
    .map(row=>({kind:'file',row,path:row.viewPath,name:row.name.split('/').at(-1)}));
  return [...directories,...files];
}
function fileIcon(row) {
  if(!row)return '▤';
  if(row.category==='model')return '◇';
  if(row.category==='texture')return '▧';
  if(row.category==='animation')return '▶';
  if(row.category==='archive'||row.category==='container')return '▣';
  return '▯';
}
function updateInspector() {
  const title=el('webGameSelected'),dl=el('webGameMetadata'),family=el('webGameFamily');
  dl.replaceChildren();el('webGameFamilyFiles').replaceChildren();family.hidden=true;
  el('webGamePreview').disabled=!selected||!PREVIEWABLE.test(selected.name);
  el('webGameExport').disabled=!selected;
  if(!selected){
    title.textContent='Nothing selected';
    el('webGameSignature').textContent='Select a resource to inspect its type, location, and preview options.';
    return;
  }
  title.textContent=selected.name.split('/').at(-1);
  const info=[
    ['Type',modelType(selected)],['Size',formatSize(selected.size)],
    ['Status',fileState(selected)],['Source',game.type],
    ['Path',selected.name]
  ];
  if(selected.offset!==undefined)info.push(['Offset','0x'+selected.offset.toString(16).toUpperCase()]);
  const id=selected.name.match(/pm\d{4}(?:_\d{2}){0,2}/i)?.[0];
  if(id)info.push(['Pokémon ID',id.toLowerCase()]);
  for(const [label,value] of info){
    const dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=label;dd.textContent=String(value);
    dl.append(dt,dd);
  }
  el('webGameSignature').textContent=selected.ncaStatus==='locked'
    ? 'Encrypted NCA. Supply compatible keys and rescan to browse its files.'
    :selected.ncaStatus==='unsupported' || selected.ncaStatus==='unavailable'
    ?'Some sections use an unsupported filesystem, storage layout, or key revision.'
    :PREVIEWABLE.test(selected.name)
    ? 'Double-click or choose Preview in 3D to open this asset in the shared viewer.'
    :'Original resource can be saved locally without modifying the game.';
  if(!id)return;
  const relatives=game.entries.filter(row=>row!==selected &&
    row.name.toLowerCase().includes(id.toLowerCase()) &&
    ['model','texture','animation','companion','archive'].includes(row.category));
  if(!relatives.length)return;
  family.hidden=false;
  for(const row of relatives.slice(0,18)){
    const button=document.createElement('button');
    button.type='button';button.className='nx-companion-entry';
    button.textContent=fileIcon(row)+' '+row.name.split('/').at(-1);
    button.title=row.name;
    button.addEventListener('click',()=>revealFile(row));
    el('webGameFamilyFiles').append(button);
  }
}
function select(row,element=null) {
  selected=row;
  el('webGameRows').querySelectorAll('tr').forEach(tr=>tr.classList.remove('selected','browser-game-selected'));
  if(element)element.classList.add('selected','browser-game-selected');
  updateInspector();
  message(row.ncaStatus==='locked'
    ?'Selected locked NCA: its readable contents depend on a matching local content/title key.'
    :'Selected '+row.name+' · '+formatSize(row.size)+' · '+modelType(row));
}
function clearSelection() {selected=null;updateInspector();}
function renderRows(reset=true) {
  if(!game)return;
  if(reset){visible=MAX_ROWS;clearSelection();}
  displayed=currentEntries();
  const list=displayed.slice(0,visible),table=el('webGameRows');
  const fragment=document.createDocumentFragment();
  for(const entry of list){
    const row=entry.row;
    const tr=document.createElement('tr');
    tr.className='asset-row'+(row===selected?' selected browser-game-selected':'');
    tr.tabIndex=0;
    const name=document.createElement('td');
    const icon=document.createElement('span');icon.className='asset-file-icon';
    icon.textContent=entry.kind==='directory'?'▤':fileIcon(row);
    name.append(icon,document.createTextNode('  '+entry.name));
    const type=document.createElement('td');
    const tag=document.createElement('span');
    tag.className='asset-type '+(row?.category||'folder');
    tag.textContent=entry.kind==='directory'
      ?(row?.category==='container'?'NCA container':'Folder')
      :modelType(row);
    type.append(tag);
    const size=document.createElement('td');
    size.textContent=row?formatSize(row.size):'—';
    const state=document.createElement('td');
    state.textContent=row?fileState(row):'Browse';
    tr.append(name,type,size,state);
    tr.addEventListener('click',()=>{
      if(row)select(row,tr);
      else {clearSelection();message('Folder: '+entry.path);}
    });
    tr.addEventListener('dblclick',()=>{
      if(entry.kind==='directory')navigate(entry.path);
      else if(row) {select(row,tr);void preview();}
    });
    tr.addEventListener('keydown',event=>{
      if(event.key==='Enter'){
        event.preventDefault();
        if(entry.kind==='directory')navigate(entry.path);
        else if(row){select(row,tr);void preview();}
      }
    });
    fragment.append(tr);
  }
  table.replaceChildren(fragment);
  if(!list.length){
    const tr=document.createElement('tr'),td=document.createElement('td');
    td.colSpan=4;td.className='table-empty';
    td.textContent=globalMode()?'No matching indexed files':'This folder has no directly indexed files';
    tr.append(td);table.append(tr);
  }
  el('webGameMore').hidden=visible>=displayed.length;
  el('webGamePage').textContent=list.length.toLocaleString()+' of '+
    displayed.length.toLocaleString()+(globalMode()?' matches':' items');
  el('webGameFolderCount').textContent=displayed.length.toLocaleString();
  el('webGameTitle').textContent=game.name+'  ›  '+(
    globalMode()?'Filtered game assets':currentPath||'Root'
  );
  el('webGameBack').disabled=globalMode()||currentPath==='';
}
function treeNode(folder,depth=0) {
  const host=document.createElement('div');host.className='nx-tree-node';
  host.setAttribute('role','treeitem');host.dataset.path=folder.path;
  const expandedHere=expanded.has(folder.path),hasChildren=folder.children.size||folder.files.length;
  const line=document.createElement('div');line.className='nx-tree-line';
  if(folder.path===currentPath)line.classList.add('nx-selected');
  line.style.paddingLeft=(7+depth*14)+'px';
  const toggle=document.createElement('button');
  toggle.type='button';toggle.className='nx-tree-toggle';
  toggle.textContent=hasChildren?(expandedHere?'▾':'▸'):'';
  toggle.disabled=!hasChildren;toggle.setAttribute('aria-label','Expand '+folder.name);
  const icon=document.createElement('span');icon.className='nx-node-icon';
  icon.textContent=folder.path===''?'▣':fileByPath.has(folder.path)?'▣':'▤';
  const label=document.createElement('button');
  label.type='button';label.className='nx-tree-name';label.textContent=folder.name;
  label.title=folder.path||game.name;
  line.append(toggle,icon,label);
  const children=document.createElement('div');children.className='nx-tree-children';
  children.setAttribute('role','group');children.hidden=!expandedHere;
  host.setAttribute('aria-expanded',String(expandedHere));
  host.append(line,children);
  toggle.addEventListener('click',event=>{
    event.stopPropagation();
    if(expanded.has(folder.path))expanded.delete(folder.path);
    else expanded.add(folder.path);
    renderTree();
  });
  label.addEventListener('click',()=>{
    navigate(folder.path);
    expanded.add(folder.path);
    renderTree();
  });
  if(expandedHere) {
    const entries=[...folder.children.values()].sort((a,b)=>a.name.localeCompare(b.name));
    for(const child of entries)children.append(treeNode(child,depth+1));
    const direct=folder.files.filter(row=>!folder.children.has(row.viewPath));
    const limit=folder.treeLimit||MAX_TREE_CHILDREN;
    for(const row of direct.slice(0,limit)){
      const leaf=document.createElement('div');leaf.className='nx-tree-line nx-tree-leaf';
      leaf.style.paddingLeft=(7+(depth+1)*14)+'px';
      const bullet=document.createElement('span');bullet.className='nx-node-icon';
      bullet.textContent=fileIcon(row);
      const link=document.createElement('button');
      link.type='button';link.className='nx-tree-name';
      link.textContent=row.name.split('/').at(-1);link.title=row.name;
      link.addEventListener('click',()=>revealFile(row));
      link.addEventListener('dblclick',()=>{revealFile(row);void preview();});
      leaf.append(bullet,link);children.append(leaf);
    }
    if(direct.length>limit){
      const more=document.createElement('button');more.type='button';
      more.className='nx-tree-more';
      more.textContent='＋ Load next '+Math.min(MAX_TREE_CHILDREN,direct.length-limit)+' files…';
      more.addEventListener('click',()=>{
        folder.treeLimit=limit+MAX_TREE_CHILDREN;
        renderTree();
      });
      children.append(more);
    }
  }
  return host;
}
function renderTree() {
  const tree=el('webGameTree');tree.replaceChildren();
  if(!game)return;
  tree.append(treeNode(folders.get('')));
  el('webGameTreeStatus').textContent=folders.size.toLocaleString()+
    ' indexed folders · '+game.entries.length.toLocaleString()+' files';
}
function navigate(path) {
  if(!game||!folders.has(path))return;
  currentPath=path;
  let parent=path;
  while(parent!==null) {
    expanded.add(parent);
    parent=folders.get(parent)?.parent??null;
  }
  renderRows();renderTree();
}
function revealFile(row){
  el('webGameSearch').value='';el('webGameCategory').value='all';
  setAssetClass('all',false);
  navigate(row.viewPath.includes('/')?row.viewPath.slice(0,row.viewPath.lastIndexOf('/')):'');
  visible=Math.max(MAX_ROWS,displayed.findIndex(entry=>entry.row===row)+1);
  renderRows(false);
  const entryIndex=displayed.findIndex(entry=>entry.row===row);
  const tr=el('webGameRows').children[entryIndex];
  if(tr){select(row,tr);tr.scrollIntoView({block:'nearest'});}
}
function setAssetClass(group,changeSelect=true) {
  activeClass=group;
  el('webGameCategory').value=group;
  for(const button of document.querySelectorAll('[data-web-asset-class]')){
    const active=button.dataset.webAssetClass===group;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  }
  if(changeSelect&&game)renderRows();
}
function setGame(parsed){
  game=parsed;constructIndex();updateCounts();
  el('webGameSaveIndex').disabled=false;
  el('webGameRescan').disabled=!currentPackage;
  el('webGameSearch').value='';setAssetClass('all',false);
  renderTree();renderRows();
  message('Indexed '+game.entries.length.toLocaleString()+' readable files. '+
    (game.warnings.length?game.warnings.join(' · '):'No package warnings.')+
    ' Locked and unsupported NCA contents are not counted as extracted assets.');
  showPanel();
}
function showPanel(){
  for(const name of ['viewerPanel','archivePanel','desktopTools','assetBrowser'])
    el(name).hidden=true;
  el('browserGamePanel').hidden=false;
  for(const tab of ['tabViewer','tabArchive','tabConverter','tabAssets','tabBrowserGame']){
    const node=el(tab);
    node.classList.toggle('active',tab==='tabBrowserGame');
    node.setAttribute('aria-selected',String(tab==='tabBrowserGame'));
  }
}
async function ingestPackage(file){
  if(!file||opening)return;
  if(/\.(gfpak|zip)$/i.test(file.name)){
    window.dispatchEvent(new CustomEvent('gfpak-web-open-file',{detail:{files:[file]}}));
    return;
  }
  opening=true;const request=++revision;
  el('webGameOpenPackage').disabled=true;el('webGameRescan').disabled=true;
  message('Reading game index and scanning readable NCA files…');
  try{
    const parsed=await openGamePackage(file,{
      keys:localKeys,
      onProgress:(done,total,found)=>{
        if(revision===request)message('Scanning NCA '+done+'/'+total+
          ' · '+found.toLocaleString()+' readable indexed files…');
      }
    });
    if(request!==revision)return;
    currentPackage=file;
    setGame(parsed);
  }catch(error){
    if(request===revision)message('Could not read package: '+(error.message||error),true);
  }finally{
    opening=false;
    el('webGameOpenPackage').disabled=false;
    el('webGameRescan').disabled=!currentPackage;
  }
}
async function preview(){
  if(!game||!selected)return;
  try{
    if(/\.(gfpak|zip)$/i.test(selected.name)){
      if(selected.size>400*1024*1024)
        throw Error('This embedded package is too large for an in-memory browser preview');
      const file=new File([await selected.getBlob()],selected.name.split('/').at(-1));
      window.dispatchEvent(new CustomEvent('gfpak-web-open-file',{detail:{files:[file]}}));
      return;
    }
    if(!PREVIEWABLE.test(selected.name))throw Error('Choose a supported model or GFPAK archive');
    const source=selected.name.split('/').slice(0,-1).join('/')+'/';
    const token=selected.name.match(/pm\d{4}(?:_\d{2}){0,2}/i)?.[0].toLowerCase()||'';
    const items=game.entries.filter(row=>{
      if(row===selected)return true;
      if(row.category==='container')return false;
      if(token&&row.name.toLowerCase().includes(token))return true;
      return row.name.startsWith(source) &&
        ['model','texture','animation','companion'].includes(row.category);
    }).slice(0,3000).map(row=>({
      path:row.name,size:row.size,getBytes:row.getBytes,
      getText:async()=>new TextDecoder().decode(await row.getBytes())
    }));
    const project={label:game.name,items};
    message('Opening model with '+(items.length-1)+' related source assets…');
    window.dispatchEvent(new CustomEvent('gfpak-web-preview-model',{
      detail:{project,selected:selected.name}
    }));
  }catch(error){message('Cannot preview: '+(error.message||error),true);}
}
async function exportSelected(){
  if(!selected)return;
  const row=selected;
  try{
    el('webGameExport').disabled=true;
    message('Reading and saving '+row.name+' locally…');
    const blob=await row.getBlob();
    download(row.name,blob);
    message('Saved '+row.name+' · '+formatSize(row.size));
  }catch(error){message('Export failed: '+(error.message||error),true);}
  finally{updateInspector();}
}
function saveIndex() {
  if(!game)return;
  download(game.name.replace(/\.[^.]+$/,'')+'-index.json',
    new Blob([JSON.stringify(exportIndex(game),null,2)],{type:'application/json'}));
}
function clearLoadedKeys(){
  ++revision;
  localKeys?.clear();localKeys=null;currentPackage=null;
  game=null;selected=null;folders.clear();fileByPath.clear();expanded=new Set(['']);
  el('webGameClearKeys').disabled=true;
  el('webGameKeysStatus').textContent='Keys forgotten. Decrypted file references cleared; reopen the game to continue.';
  el('webGameTitle').textContent='No game loaded';
  el('webGameTree').replaceChildren();
  el('webGameRows').replaceChildren();
  for(const id of ['webGameFiles','webGameModels','webGameTextures','webGameAnimations','webGameFolderCount'])
    el(id).textContent='0';
  el('webGameTreeStatus').textContent='No package loaded';
  el('webGameFormat').textContent='No game loaded';
  el('webGameSaveIndex').disabled=true;el('webGameRescan').disabled=true;
  updateInspector();
}
function init(){
  if(window.pywebview?.api){el('tabBrowserGame').hidden=true;return;}
  el('tabBrowserGame').addEventListener('click',showPanel);
  el('webGameOpenPackage').addEventListener('click',()=>el('webGameFile').click());
  el('webGameOpenFolder').addEventListener('click',()=>el('webGameFolder').click());
  el('webGameOpenKeys').addEventListener('click',()=>el('webGameKeysFile').click());
  el('webGameKeysFile').addEventListener('change',async event=>{
    const file=event.target.files?.[0];event.target.value='';
    if(!file)return;
    try{
      if(file.size>1024*1024)throw Error('Keys file exceeds 1 MiB');
      const keys=parseLocalKeys(await file.text());
      if(!keys.size){keys.clear();throw Error('No recognized AES keys found');}
      ++revision;localKeys?.clear();localKeys=keys;
      el('webGameClearKeys').disabled=false;
      el('webGameKeysStatus').textContent='Local keys loaded ('+keys.size+
        ' entries) in this browser session. Not uploaded, logged, or saved.';
      if(currentPackage)await ingestPackage(currentPackage);
    }catch(error){message('Could not load local keys: '+(error.message||error),true);}
  });
  el('webGameClearKeys').addEventListener('click',clearLoadedKeys);
  el('webGameFile').addEventListener('change',event=>{
    const file=event.target.files?.[0];event.target.value='';void ingestPackage(file);
  });
  el('webGameFolder').addEventListener('change',event=>{
    try{
      const files=Array.from(event.target.files||[]);event.target.value='';
      if(files.length){++revision;currentPackage=null;setGame(openExtractedFolder(files));}
    }catch(error){message(error.message||String(error),true);}
  });
  window.addEventListener('gfpak-web-open-game',event=>void ingestPackage(event.detail?.file));
  el('webGameSearch').addEventListener('input',()=>renderRows());
  el('webGameCategory').addEventListener('change',()=>{
    setAssetClass(el('webGameCategory').value);
  });
  for(const button of document.querySelectorAll('[data-web-asset-class]'))
    button.addEventListener('click',()=>setAssetClass(button.dataset.webAssetClass));
  el('webGameBack').addEventListener('click',()=>{
    if(game&&!globalMode())navigate(folders.get(currentPath)?.parent??'');
  });
  el('webGameMore').addEventListener('click',()=>{visible+=MAX_ROWS;renderRows(false);});
  el('webGamePreview').addEventListener('click',()=>void preview());
  el('webGameExport').addEventListener('click',()=>void exportSelected());
  el('webGameSaveIndex').addEventListener('click',saveIndex);
  el('webGameRescan').addEventListener('click',()=>void ingestPackage(currentPackage));
  const actions={
    webMenuOpenPackage:()=>el('webGameFile').click(),
    webMenuOpenFolder:()=>el('webGameFolder').click(),
    webMenuLoadKeys:()=>el('webGameKeysFile').click(),
    webMenuFocusTree:()=>el('webGameTree').querySelector('.nx-tree-name')?.focus(),
    webMenuClearSearch:()=>{
      el('webGameSearch').value='';setAssetClass('all');renderTree();
    },
    webMenuRescan:()=>currentPackage&&void ingestPackage(currentPackage),
    webMenuExportIndex:saveIndex,
    webMenuAbout:()=>message('Browser File Viewer: same folder navigation and resource inspector as the desktop app. Decryption uses local keys only; unsupported game storage remains locked.')
  };
  for(const [id,action] of Object.entries(actions))
    el(id).addEventListener('click',()=>{
      for(const menu of document.querySelectorAll('#browserGamePanel .nx-menu'))menu.open=false;
      action();
    });
}
init();
