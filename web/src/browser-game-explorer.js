import {openGamePackage, openExtractedFolder, exportIndex} from './game-file-reader.js';
import {parseLocalKeys} from './nca-crypto.js';
/** Browser-only UI for large local game files. No native bridge required. */
const el = name => document.getElementById(name);
let game = null, selected = null, matching = [], visible = 250, opening = false;
let localKeys = null, currentPackage = null;

function message(text, error = false) {
  el('webGameNotice').textContent = text;
  el('webGameNotice').classList.toggle('native-error', error);
}
function formatSize(size) {
  if(size >= 1024**3)return (size/(1024**3)).toFixed(2)+' GiB';
  if(size >= 1024**2)return (size/(1024**2)).toFixed(1)+' MiB';
  if(size >= 1024)return (size/1024).toFixed(1)+' KiB';
  return size+' bytes';
}
function download(name, blob) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url; link.download=name.split('/').at(-1)||'game-asset.bin';
  document.body.append(link);
  link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function counts(entries) {
  const result={model:0,archive:0,animation:0,texture:0};
  for (const item of entries) if (item.category in result) result[item.category]++;
  el('webGameModels').textContent=(result.model+result.archive).toLocaleString();
  el('webGameAnimations').textContent=result.animation.toLocaleString();
  el('webGameTextures').textContent=result.texture.toLocaleString();
  el('webGameFiles').textContent=entries.length.toLocaleString();
}
function updateButtons(){
  el('webGamePreview').disabled=!selected || !/\.(gfpak|zip|glb|gltf|fbx|obj|dae|trmdl|trmsh|gfbmdl)$/i.test(selected.name);
  el('webGameExport').disabled=!selected;
}
function select(row, element) {
  selected=row;
  el('webGameRows').querySelectorAll('tr').forEach(tr=>tr.classList.remove('browser-game-selected'));
  element.classList.add('browser-game-selected');
  updateButtons();
  if(row.ncaStatus==='locked')
    message('Encrypted NCA: its internal assets cannot be counted or previewed until the filesystem is decrypted.');
  else message('Selected '+row.name+' · '+formatSize(row.size)+' · '+row.category);
}
function render(reset=true) {
  if (!game) return;
  if (reset) {
    visible=250; selected=null;updateButtons();
  }
  const query=el('webGameSearch').value.toLowerCase().trim();
  const kind=el('webGameCategory').value;
  matching=game.entries.filter(row=>
    (kind==='all'||row.category===kind) && (!query||row.name.toLowerCase().includes(query)));
  const table=el('webGameRows');
  table.replaceChildren();
  const shown=matching.slice(0,visible);
  const fragment=document.createDocumentFragment();
  for (const row of shown) {
    const tr=document.createElement('tr');
    tr.tabIndex=0;
    const status=row.ncaStatus==='locked' ? 'Locked' :
      row.ncaStatus==='partial-plaintext' ? 'Some sections readable' :
      row.ncaStatus==='unsupported' ? 'Unsupported section' :
      row.kind==='plaintext-nca-file' ? 'Read-only, decoded' : 'Read-only';
    for (const value of [row.name,row.category,formatSize(row.size),status]) {
      const td=document.createElement('td');
      td.textContent=value;
      tr.append(td);
    }
    tr.addEventListener('click',()=>select(row,tr));
    tr.addEventListener('dblclick',()=>{select(row,tr);void preview();});
    tr.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();select(row,tr);void preview();}
    });
    fragment.append(tr);
  }
  table.append(fragment);
  if (!shown.length) {
    const tr=document.createElement('tr'),td=document.createElement('td');
    td.colSpan=4;td.textContent='No matching readable assets';tr.append(td);table.append(tr);
  }
  el('webGameMore').hidden=visible>=matching.length;
  el('webGamePage').textContent=shown.length.toLocaleString()+' of '+
    matching.length.toLocaleString()+' matching entries';
}
function showPanel() {
  for(const name of ['viewerPanel','archivePanel','desktopTools','assetBrowser'])
    el(name).hidden=true;
  el('browserGamePanel').hidden=false;
  for(const tab of ['tabViewer','tabArchive','tabConverter','tabAssets','tabBrowserGame']){
    const button=el(tab);
    button.classList.toggle('active',tab==='tabBrowserGame');
    button.setAttribute('aria-selected',String(tab==='tabBrowserGame'));
  }
}
async function ingestPackage(file) {
  if (!file || opening) return;
  if(/\.(gfpak|zip)$/i.test(file.name)){
    // GFPAK/ZIP use the existing full native asset inspector/importer.
    window.dispatchEvent(new CustomEvent('gfpak-web-open-file',{detail:{files:[file]}}));
    return;
  }
  opening=true;
  el('webGameOpenPackage').disabled=true;
  message('Reading complete local package index; examining readable NCA section headers…');
  try {
    const parsed=await openGamePackage(file,{
      keys:localKeys,
      onProgress:(done,total,found)=>{
        message('Checking NCA headers '+done+'/'+total+' · '+found+
          ' indexed files. Encrypted content stays locked.');
      }
    });
    currentPackage=file;
    setGame(parsed);
  } catch(error) {
    message('Could not read package: '+(error.message||error),true);
  } finally {
    opening=false;
    el('webGameOpenPackage').disabled=false;
  }
}
function setGame(parsed){
  game=parsed;selected=null;
  el('webGameTitle').textContent=parsed.name+' · '+parsed.type;
  counts(parsed.entries);
  el('webGameSaveIndex').disabled=false;
  el('webGameSearch').value='';el('webGameCategory').value='all';
  render();
  message('Full readable index: '+parsed.entries.length.toLocaleString()+
    ' files. '+(parsed.warnings.length?parsed.warnings.join(' · '):
    'No package-format warnings.')+
    ' Encrypted NCAs and unsupported compression are never counted as extracted Pokémon.');
  showPanel();
}
async function preview(){
  if(!game||!selected) return;
  try{
    if(/\.(gfpak|zip)$/i.test(selected.name)){
      if(selected.size>400*1024*1024)throw Error('This embedded package is too large to open in browser memory');
      const file=new File([await selected.getBlob()],selected.name.split('/').at(-1));
      window.dispatchEvent(new CustomEvent('gfpak-web-open-file',{detail:{files:[file]}}));
      return;
    }
    if(!/\.(glb|gltf|fbx|obj|dae|trmdl|trmsh|gfbmdl)$/i.test(selected.name))
      throw Error('Choose a supported mesh file or GFPAK archive.');
    const source=selected.name.split('/').slice(0,-1).join('/')+'/';
    const token=selected.name.match(/pm\d{4}(?:_\d{2}){0,2}/i)?.[0].toLowerCase()||'';
    const include=game.entries.filter(row=>{
      if(row.kind==='indexed' && /\.nca$/i.test(row.name))return false;
      if(row===selected)return true;
      if(row.category==='container')return false;
      const common=row.name.startsWith(source);
      if(token && row.name.toLowerCase().includes(token))return true;
      // Common mesh buffers/material/texture/animation assets stay beside
      // the selected model within the same extracted source directory.
      return common && ['model','texture','animation','companion'].includes(row.category);
    }).slice(0,3000);
    const project={
      label:game.name,
      items:include.map(row=>({
        path:row.name,size:row.size,
        getBytes:row.getBytes,
        getText:async()=>new TextDecoder().decode(await row.getBytes())
      }))
    };
    message('Previewing '+selected.name+' with '+(project.items.length-1)+
      ' associated source files. Opening the browser 3D renderer…');
    window.dispatchEvent(new CustomEvent('gfpak-web-preview-model',{
      detail:{project,selected:selected.name}
    }));
  }catch(error){message('Cannot preview: '+(error.message||error),true);}
}
function init(){
  if(window.pywebview?.api){
    el('tabBrowserGame').hidden=true;return;
  }
  el('tabBrowserGame').addEventListener('click',showPanel);
  el('webGameOpenPackage').addEventListener('click',()=>el('webGameFile').click());
  el('webGameOpenFolder').addEventListener('click',()=>el('webGameFolder').click());
  el('webGameOpenKeys').addEventListener('click',()=>el('webGameKeysFile').click());
  el('webGameKeysFile').addEventListener('change',async e=>{
    const file=e.target.files?.[0];e.target.value='';
    if(!file)return;
    try {
      if(file.size>1024*1024)throw Error('Keys file exceeds 1 MiB');
      const loaded=parseLocalKeys(await file.text());
      if(!loaded.size){loaded.clear();throw Error('No recognized AES keys in the selected file');}
      localKeys?.clear();localKeys=loaded;
      el('webGameClearKeys').disabled=false;
      el('webGameKeysStatus').textContent='Local keys loaded ('+loaded.size+
        ' entries) in this browser session. Not uploaded, logged or saved. '+
        'Reopen or rescan your game to read encrypted sections.';
      if(currentPackage)await ingestPackage(currentPackage);
    }catch(error){message('Could not load local keys: '+(error.message||error),true);}
  });
  el('webGameClearKeys').addEventListener('click',()=>{
    localKeys?.clear();localKeys=null;currentPackage=null;
    game=null;selected=null;matching=[];
    el('webGameClearKeys').disabled=true;
    el('webGameKeysStatus').textContent='Keys forgotten. Decrypted file references cleared; reload your game to continue.';
    el('webGameTitle').textContent='No game loaded';
    el('webGameRows').replaceChildren();
    el('webGameSaveIndex').disabled=true;
    el('webGameFiles').textContent='0';
    el('webGameModels').textContent='0';
    el('webGameTextures').textContent='0';
    el('webGameAnimations').textContent='0';
    updateButtons();
  });
  el('webGameFile').addEventListener('change',e=>{
    const file=e.target.files?.[0];e.target.value='';void ingestPackage(file);
  });
  el('webGameFolder').addEventListener('change',e=>{
    try{
      const files=Array.from(e.target.files||[]);e.target.value='';
      if(files.length){currentPackage=null;setGame(openExtractedFolder(files));}
    }catch(error){message(error.message||String(error),true);}
  });
  window.addEventListener('gfpak-web-open-game',e=>void ingestPackage(e.detail?.file));
  el('webGameSearch').addEventListener('input',()=>render());
  el('webGameCategory').addEventListener('change',()=>render());
  el('webGameMore').addEventListener('click',()=>{visible+=250;render(false);});
  el('webGamePreview').addEventListener('click',()=>void preview());
  el('webGameExport').addEventListener('click',async()=>{
    if(!selected)return;
    const row=selected;
    try {
      el('webGameExport').disabled=true;
      message('Reading selected original/decrypted resource locally…');
      const blob=await row.getBlob();
      download(row.name,blob);
      message('Saved '+row.name+' · '+formatSize(row.size));
    }catch(error){message('Export failed: '+(error.message||error),true);}
    finally{updateButtons();}
  });
  el('webGameSaveIndex').addEventListener('click',()=>{
    if(game)download(game.name.replace(/\.[^.]+$/,'')+'-index.json',
      new Blob([JSON.stringify(exportIndex(game),null,2)],
        {type:'application/json'}));
  });
}
init();
