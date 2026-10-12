/** GFPAK Open Web — all user data remains inside the browser. */
import './style.css';
import {exportPokemonZip} from './pokemon-export.js';
import {prepareGfpakModelPreview} from './native-gfpak-preview.js';
import {textureVariantForItem} from './texture-loader.js';
import { ModelStage } from './stage.js';
import { GAMES, gameById, detectGameFromNames, describeSource, identifyFormat } from './game-support.js';
import { loadGfbmdl } from './gfbmdl-model.js';
import {
  inspectTexture, drawTextureSurface, texturePngName, isInspectableTexture,
  detectTextureExtension
} from './texture-inspector.js';
import {
  projectFromFiles, projectFromZip, loadModel, modelStats, exportGlb,
  downloadBlob, demoModel, extension
} from './model.js';
import {
  parseGfpakFile, summary, extractResourceAsync, parseHashDictionary, resolvedName
} from './gfpak.js';

const el = id => document.getElementById(id);
const state = {
  stage: null,
  project: null,
  exportProject: null,
  desktopSource: false,
  desktopExport: null,
  archive: null,
  dictionary: new Map(),
  loaded: null,
  loadedFormat: '',
  loadedPackage: '',
  resource: null,
  busy: false,
  textureVariant: 'regular',
  textureInfo: null,
  textureDispose: null,
  textureRevision: 0,
};

function currentGame() { return gameById(el('gameSource').value); }

function updateGameProfile() {
  const game = currentGame();
  el('gameEngine').textContent = game.engine.toUpperCase();
  el('gameYear').textContent = game.year || 'ALL GAMES';
  el('gameHint').textContent = game.hint;
  el('activeGame').textContent = game.id === 'auto' ? 'Auto' : game.name;
  if (state.project) displayNativeGuidance(state.project.items.map(item => item.path));
  else if (state.archive) displayNativeGuidance([state.archive.filename]);
}

function suggestGame(names) {
  if (el('gameSource').value !== 'auto') return;
  const auto = detectGameFromNames(names);
  if (auto.id !== 'auto') {
    el('gameSource').value = auto.id;
    log('Detected ' + auto.name + ' from filenames (you can change this selection).');
  }
  updateGameProfile();
}

function displayNativeGuidance(names) {
  const description = describeSource(currentGame().id, names);
  const hasNative = identifyFormat(names).native.length > 0;
  const panel = el('nativeGuide');
  panel.hidden = !hasNative;
  if (!hasNative) return;
  el('nativeTitle').textContent = description.title;
  el('nativeExplanation').textContent = description.message;
  const archiveInZip = state.project?.items.some(item => item.path.toLowerCase().endsWith('.gfpak'));
  el('inspectPackagedArchive').hidden = !archiveInZip;
}

function initGameOptions() {
  const picker = el('gameSource');
  picker.replaceChildren(...GAMES.map(game => new Option(game.name, game.id)));
  picker.value = 'auto';
  updateGameProfile();
}


function updateStatus(status) {
  el('footerStatus').textContent = status.toUpperCase();
}

function log(message, level = 'info') {
  const row = document.createElement('div');
  if (level === 'error') row.className = 'error';
  const prefix = document.createElement('span');
  prefix.textContent = '[' + (level === 'error' ? 'ERROR' : level === 'success' ? 'OK' : 'INFO') + ']';
  row.append(prefix, document.createTextNode(String(message)));
  el('logBody').append(row);
  while (el('logBody').childElementCount > 100) el('logBody').firstElementChild.remove();
  el('logBody').scrollTop = el('logBody').scrollHeight;
  updateStatus(level === 'error' ? 'ACTION REQUIRED' : String(message).slice(0, 55));
}

function errorMessage(err) {
  log(err?.message || String(err), 'error');
  console.error(err);
}

function busy(value, title = 'Processing assets', message = '') {
  state.busy = value;
  el('busyOverlay').hidden = !value;
  el('busyTitle').textContent = title;
  el('busyMessage').textContent = message;
  el('exportButton').disabled = value || !state.loaded;
  el('exportPokemonButton').disabled = value || !state.loaded || (!state.exportProject && !state.desktopSource);
  el('loadSelected').disabled = value || !state.project?.models.length;
  el('inspectSelectedTexture').disabled = value || !state.project?.items.some(item =>
    isInspectableTexture(item.path));
  if (el('textureVariantSelect')) el('textureVariantSelect').disabled =
    value || el('textureVariantSelect').hidden;
}

function currentFile(text) {
  el('currentModelTag').textContent = text.toUpperCase();
}

function updateSource(text, isLoaded = true) {
  const summaryNode = el('sourceSummary');
  summaryNode.lastElementChild.textContent = text;
  summaryNode.firstElementChild.style.background = isLoaded ? '#62e0b7' : '#627d8f';
}

function showTab(which) {
  const archive = which === 'archive';
  el('browserGamePanel').hidden = true;
  el('tabBrowserGame').classList.remove('active');
  el('tabBrowserGame').setAttribute('aria-selected', 'false');
  el('viewerPanel').hidden = archive;
  el('archivePanel').hidden = !archive;
  el('tabViewer').classList.toggle('active', !archive);
  el('tabArchive').classList.toggle('active', archive);
  el('tabViewer').setAttribute('aria-selected', String(!archive));
  el('tabArchive').setAttribute('aria-selected', String(archive));
  if (!archive && state.stage) requestAnimationFrame(() => state.stage.resize());
}

function resetInspector() {
  const defaults = ['statMeshes', 'statVertices', 'statTriangles', 'statMaterials', 'statBones', 'statClips'];
  for (const id of defaults) el(id).textContent = '—';
  el('objectName').textContent = 'No active object';
  el('objectSubtitle').textContent = 'Load a 3D model to inspect its details.';
  el('inspectorState').textContent = 'IDLE';
  el('originalFormat').textContent = '—';
  el('packageName').textContent = '—';
  el('clipSelect').replaceChildren(new Option('No animations available', ''));
  el('clipSelect').disabled = true;
  el('toggleAnimation').disabled = true;
  el('toggleAnimation').textContent = '▶ PLAY ANIMATION';
  el('textureVariantLabel').hidden = true;
  el('textureVariantSelect').hidden = true;
  el('textureVariantSelect').disabled = true;
  el('exportButton').disabled = true;
  el('exportPokemonButton').disabled = true;
  el('emptyState').hidden = false;
}

function setModel(result, format, packageName) {
  if (!state.stage) throw new Error('WebGL is not available in this browser');
  const previous = state.loaded;
  state.stage.setModel(result.root, result.animations);
  previous?.disposeAssets?.();
  state.loaded = result;
  state.loadedFormat = format;
  state.loadedPackage = packageName;
  // Native models populate textures/clips asynchronously. Never package a
  // half-loaded preview as a ready-to-import Pokédex model.
  result.companionsReady = !result.postLoad;
  const info = modelStats(result.root, result.animations);
  const mapping = [
    ['statMeshes', info.meshes], ['statVertices', info.vertices],
    ['statTriangles', info.triangles], ['statMaterials', info.materials],
    ['statBones', info.bones], ['statClips', info.clips]
  ];
  for (const [id, n] of mapping) el(id).textContent = Number(n).toLocaleString();
  el('inspectorState').textContent = result.postLoad
    ? 'IMPORTING COMPANIONS' : 'LOADED';
  el('objectName').textContent = result.selected.split('/').pop() || result.selected;
  el('objectSubtitle').textContent = info.meshes + ' mesh(es)' +
    (result.postLoad
      ? ' visible · matched textures and animations importing…'
      : ' ready for GLB export');
  el('originalFormat').textContent = format.replace('.', '').toUpperCase();
  el('packageName').textContent = packageName;
  el('activeGame').textContent = currentGame().name;
  el('emptyState').hidden = true;
  // Exporting before asynchronous texture/animation import completes would
  // silently create a GLB without those linked assets.
  el('exportButton').disabled = !!result.postLoad;
  el('exportPokemonButton').disabled = !state.exportProject && !state.desktopSource;
  const clean = result.selected.split('/').pop().replace(/\.(glb|gltf|fbx|obj|dae|stl|ply|3ds|gfbmdl)$/i, '') || 'model';
  el('outputName').value = clean.slice(0, 130);
  currentFile(result.selected.split('/').pop());
  refreshAnimationControls(result);
  refreshTextureVariantControls();
  log('Loaded ' + info.meshes + ' mesh(es)' +
    (result.postLoad ? '; companion textures and clips are loading in the background.' :
      ' and ' + info.clips + ' animation clip(s).'), 'success');
}

function projectHasVariantTextures() {
  return (state.project?.items || []).some(item =>
    item.linkedKind === 'texture' ||
    /\.(bntx|dds|png|jpe?g|webp)$/i.test(item.path || '') ||
    (item.textureVariant === 'shiny' || item.textureVariant === 'mixed' ||
      /(?:^|[_\-.])(shiny|rare|color[ _-]?1|col[ _-]?1|s1)(?:$|[_\-.])/i
        .test(String(item.path || '') + ' ' + String(item.textureNames || ''))));
}

function refreshTextureVariantControls() {
  const select = el('textureVariantSelect');
  const items=state.project?.items||[];
  const visible = ['TRMDL', 'GFBMDL'].includes(state.loaded?.sourceFormat) &&
    projectHasVariantTextures();
  const shinyAvailable=items.some(item=>
    (item.linkedKind==='texture'||/\\.(bntx|dds|png|jpe?g|webp)$/i.test(item.path||'')) &&
    ['shiny','mixed'].includes(textureVariantForItem(item)));
  // Do not offer a fake shiny switch for an archive which has no recognized
  // shiny texture surface. The regular option stays the default.
  const regular=new Option('Regular textures','regular');
  const shiny=new Option(shinyAvailable?'Shiny textures':
    'Shiny textures (not found)','shiny');
  shiny.disabled=!shinyAvailable;
  select.replaceChildren(regular,shiny);
  if(state.textureVariant==='shiny'&&!shinyAvailable)state.textureVariant='regular';
  el('textureVariantLabel').hidden = !visible;
  select.hidden = !visible;
  select.disabled = !visible || state.busy;
  select.value = state.textureVariant;
}

async function reloadTextureVariant() {
  if (!state.project || !state.loaded || state.busy) return;
  const selected = state.loaded.selected;
  if (!selected || !state.project.items.some(item => item.path === selected)) return;
  busy(true, 'Switching textures', 'Reloading native material maps…');
  try {
    const result = await loadModel(state.project, selected, message => log(message), {
      fastPreview: true,
      textureVariant: state.textureVariant
    });
    setModel(result, state.loadedFormat || extension(selected), state.loadedPackage || state.project.label);
    completeFastPreview(result);
  } catch (error) {
    errorMessage(error);
  } finally {
    busy(false);
  }
}

function refreshAnimationControls(result) {
  const clips = el('clipSelect');
  clips.replaceChildren();
  result.animations.forEach((a, index) =>
    clips.add(new Option(a.name || 'Animation ' + (index + 1), String(index))));
  if (!result.animations.length) clips.add(new Option(
    result.postLoad ? 'Animation clips loading…' : 'No animations available', ''));
  clips.disabled = !result.animations.length;
  el('toggleAnimation').disabled = !result.animations.length;
  el('toggleAnimation').textContent = result.animations.length ?
    'Ⅱ PAUSE ANIMATION' : '▶ PLAY ANIMATION';
  el('statClips').textContent = result.postLoad && !result.companionsReady &&
    !result.animations.length ? '…' : Number(result.animations.length).toLocaleString();
}

function completeFastPreview(result) {
  if (typeof result.postLoad !== 'function') return;
  // Kick off auxiliary downloads only after a frame has been presented.
  // This keeps massive animation and BNTX loads off the first-paint path.
  requestAnimationFrame(() => window.setTimeout(() => {
    if (state.loaded !== result) return;
    result.postLoad().then(() => {
      if (state.loaded !== result) return;
      state.stage.setAnimations(result.animations);
      result.companionsReady = true;
      refreshAnimationControls(result);
      el('inspectorState').textContent = 'LOADED';
      el('objectSubtitle').textContent =
        modelStats(result.root, result.animations).meshes +
        ' mesh(es) with decoded companion assets ready for GLB export';
      el('exportButton').disabled = false;
      if (result.sourceFormat === 'TRMDL') {
        const items=state.project?.items||[];
        const hasRig=items.some(item=>/\.trskl$/i.test(item.path));
        const hasClips=items.some(item=>/\.(tranm|gfbanm)$/i.test(item.path));
        const hasMaps=items.some(item=>item.linkedKind==='texture');
        let textured=0;
        result.root.traverse(node=>{
          if(!node.isMesh)return;
          for(const mat of Array.isArray(node.material)?node.material:[node.material]){
            if(mat?.map||mat?.normalMap||mat?.emissiveMap||
              mat?.nativeDisplacementMap||mat?.layerMaskMap)textured++;
          }
        });
        const problems=[];
        const isPokemon=/pm\d{4}/i.test(
          String(result.selected)+' '+String(state.project?.label||''));
        if(isPokemon&&!hasRig)
          problems.push('no TRSKL skeleton identified in the readable Pokémon archives');
        if(isPokemon&&!hasClips)
          problems.push('no compatible native animation resource identified');
        if(isPokemon&&!hasMaps)
          problems.push('no decodable image/BNTX texture resource identified');
        if(hasRig&&!modelStats(result.root,result.animations).bones)
          problems.push('TRSKL file found but no bones were bound');
        if(hasClips&&!result.animations.length)
          problems.push('animation data found but no compatible bone tracks were bound');
        if(hasMaps&&!textured)
          problems.push('texture resources found but none could be applied to model materials');
        if(problems.length){
          el('inspectorState').textContent='UNMATCHED ASSETS';
          el('objectSubtitle').textContent=problems.join('; ');
          log('Unmatched model assets: '+problems.join('; ')+
            '. Check earlier scan/decoder messages for the specific resource.', 'info');
        } else {
          log('Verified model companions: '+textured+' textured surface(s), '+
            modelStats(result.root,result.animations).bones+' bones, '+
            result.animations.length+' animation clip(s).','success');
        }
      }
      log('Imported model textures and ' + result.animations.length +
        ' compatible animation clip(s). Select a clip to play it.', 'success');
    }).catch(error => {
      if (state.loaded === result) {
        result.companionsReady = false;
        el('inspectorState').textContent = 'PARTIAL IMPORT';
        el('exportButton').disabled = false;
        log('Some companion resources could not be loaded: ' +
          (error.message || error), 'info');
      }
    });
  }, 0));
}

async function openModel() {
  if (state.busy || !state.project) return;
  const selected = el('modelSelect').value;
  if (!selected) return;
  busy(true, 'Loading model', 'Reading mesh and texture resources…');
  try {
    const result = await loadModel(state.project, selected, message => log(message), {
      textureVariant: state.textureVariant
    });
    state.exportProject = state.project; state.desktopSource=false;
    setModel(result, extension(selected), state.project.label);
    showTab('viewer');
  } catch (err) {
    errorMessage(err);
  } finally {
    busy(false);
  }
}

function listProjectTextures(project) {
  return project.items.filter(item => isInspectableTexture(item.path));
}

function populateTextureSelect(project) {
  const textures = listProjectTextures(project);
  const select = el('textureSelect');
  select.replaceChildren(...textures.slice(0, 1200).map(item => new Option(item.path, item.path)));
  // A multi-row SELECT has no guaranteed default selection; otherwise a
  // single imported BNTX appears in the list but the Inspect button does nothing.
  if (select.options.length) select.selectedIndex = 0;
  el('textureCount').textContent = textures.length + ' file(s)';
  el('textureChoice').hidden = !textures.length;
  el('inspectSelectedTexture').disabled = !textures.length;
}

function disposeTexturePreview() {
  state.textureRevision++;
  state.textureDispose?.();
  state.textureDispose = null;
  state.textureInfo = null;
  el('textureCanvasHost').replaceChildren();
  el('textureSavePng').disabled = true;
}

async function drawCurrentTexture() {
  const info = state.textureInfo;
  if (!info) return;
  const revision = ++state.textureRevision;
  state.textureDispose?.();
  state.textureDispose = null;
  el('textureSavePng').disabled = true;
  const host = el('textureCanvasHost');
  host.replaceChildren();
  const index = Number(el('textureSurface').value);
  const surface = info.surfaces[index];
  if (!surface) return;
  el('textureMetadata').textContent =
    [surface.width && surface.height ? surface.width + ' × ' + surface.height : '',
      surface.format !== undefined ? 'BNTX format 0x' + surface.format.toString(16) : '',
      surface.mips ? surface.mips + ' mip level(s)' : ''].filter(Boolean).join(' · ');
  el('texturePreviewStatus').textContent = 'Decoding ' + surface.name + ' locally…';
  const canvas = document.createElement('canvas');
  try {
    const drawn = await drawTextureSurface(info,index,canvas);
    if (revision !== state.textureRevision || !el('textureDialog').open) {
      drawn.dispose();
      return;
    }
    host.replaceChildren(canvas);
    state.textureDispose = drawn.dispose;
    el('textureSavePng').disabled = false;
    el('textureMetadata').textContent = drawn.width + ' × ' + drawn.height +
      (surface.format !== undefined ? ' · BNTX 0x' + surface.format.toString(16) : '');
    el('texturePreviewStatus').textContent = 'Texture ready · ' +
      'choose another surface or export this preview as PNG.';
  } catch (error) {
    if (revision === state.textureRevision)
      el('texturePreviewStatus').textContent = String(error.message || error);
  }
}

async function inspectSourceTexture(item) {
  if (state.busy || !item) return false;
  busy(true,'Opening texture','Reading a native texture without requiring a model…');
  try {
    if (item.size > 256 * 1024 * 1024)
      throw new Error('Standalone texture preview is limited to 256 MiB');
    const resource = await item.getBytes();
    const bytes = resource instanceof Blob ? await resource.arrayBuffer() : resource;
    const inferred = isInspectableTexture(item.path) ? null : detectTextureExtension(bytes);
    if (!isInspectableTexture(item.path) && !inferred)
      throw new Error('The selected resource is not a recognized BNTX/DDS/image. ' +
        'Select a texture or supply a filename dictionary.');
    const name = inferred ? item.path.replace(/\.[^./\\]+$/, '') + inferred : item.path;
    const info = inspectTexture(bytes,name);
    disposeTexturePreview();
    state.textureInfo = info;
    const select = el('textureSurface');
    select.replaceChildren(...info.surfaces.map(surface => new Option(
      surface.name + (surface.width ? ' · ' + surface.width + '×' + surface.height : ''),
      String(surface.index)
    )));
    el('textureSourceName').textContent = info.filename + ' · ' +
      info.surfaces.length + ' texture surface(s)';
    if (!el('textureDialog').open) el('textureDialog').showModal();
    await drawCurrentTexture();
    log('Opened ' + item.path + ' with ' + info.surfaces.length + ' texture surface(s).','success');
  } catch (error) { errorMessage(error); return false; }
  finally { busy(false); }
  return true;
}

function inspectSelectedTexture() {
  const item = state.project?.items.find(entry => entry.path === el('textureSelect').value);
  return inspectSourceTexture(item);
}

function filterModels() {
  if (!state.project) return;
  const filter = el('modelFilter').value.toLowerCase().trim();
  const visible = state.project.models.filter(m => m.path.toLowerCase().includes(filter));
  const select = el('modelSelect');
  const saved = select.value;
  const items = document.createDocumentFragment();
  for (const file of visible.slice(0, 1200)) {
    const opt = document.createElement('option');
    opt.value = file.path;
    opt.textContent = file.path.length > 95 ? '…' + file.path.slice(-94) : file.path;
    items.append(opt);
  }
  select.replaceChildren(items);
  if (visible.some(f => f.path === saved)) select.value = saved;
  else if (select.options.length) select.selectedIndex = 0;
  el('modelCount').textContent = visible.length + ' / ' + state.project.models.length;
}

async function chooseProject(files) {
  if (state.busy) return;
  if (!files.length) return;
  busy(true, 'Reading source package', 'Scanning files and supported model formats…');
  try {
    const only = files.length === 1 ? files[0] : null;
    if (only && /\.(nsp|nsz|xci|xcz)$/i.test(only.name)) {
      window.dispatchEvent(new CustomEvent('gfpak-web-open-game',{detail:{file:only}}));
      return;
    }
    if (only && extension(only.name) === '.gfpak') {
      await loadArchive(only);
      return;
    }
    const project = only && extension(only.name) === '.zip' ?
      await projectFromZip(only, message => log(message)) : projectFromFiles(files);
    state.loaded?.disposeAssets?.();
    state.loaded = null;
    state.stage?.clear();
    resetInspector();
    state.project = project;
    state.archive = null;
    populateTextureSelect(project);
    suggestGame([project.label, ...project.items.map(item => item.path)]);
    displayNativeGuidance(project.items.map(item => item.path));
    updateSource(project.label + ' · ' + project.models.length + ' renderable model(s) · ' +
      listProjectTextures(project).length + ' inspectable texture(s)' +
      (project.native?.length ? ' · ' + project.native.length + ' original resource(s)' : ''));
    el('modelChoice').hidden = !project.models.length;
    el('modelFilter').value = '';
    filterModels();
    log('Imported ' + project.items.length + ' files, found ' + project.models.length + ' supported model(s).', 'success');
    if (!project.models.length) {
      if (listProjectTextures(project).length)
        log('Native texture files found. Choose one under NATIVE TEXTURES for surface inspection.', 'success');
      else {
        const notice = describeSource(currentGame().id, project.items.map(item => item.path));
        log(notice.title + ': ' + notice.message, notice.kind === 'native' ? 'info' : 'error');
      }
      showTab('viewer');
    } else if (project.models.length === 1) {
      // Open on the next frame, once the loading overlay has closed.
      setTimeout(openModel, 0);
    } else {
      log('Choose a model in the file list, then click LOAD SELECTED MODEL.');
      showTab('viewer');
    }
  } catch (err) {
    errorMessage(err);
  } finally {
    busy(false);
  }
}

async function loadArchive(file) {
  const archive = await parseGfpakFile(file, file.name);
  state.archive = archive;
  state.project = null;
  el('textureChoice').hidden = true;
  suggestGame([file.name]);
  displayNativeGuidance([file.name]);
  state.resource = null;
  state.loaded?.disposeAssets?.();
  state.loaded = null;
  state.stage?.clear();
  el('modelChoice').hidden = true;
  resetInspector();
  updateSource(file.name + ' · ' + archive.count + ' internal resources');
  currentFile(file.name);
  el('archiveResources').textContent = archive.count.toLocaleString();
  el('archiveFolders').textContent = archive.folderCount.toLocaleString();
  el('archiveBytes').textContent = formatBytes(archive.packedBytes);
  el('archiveCodec').textContent = Object.entries(archive.compressionTypes)
    .map(([key, value]) => codecName(Number(key)) + ' ' + value).join(' / ');
  el('downloadIndex').disabled = false;
  el('downloadResource').disabled = true;
  updateArchiveModelButton();
  updateArchiveTextureButton();
  el('archiveSearch').value = '';
  renderArchiveTable();
  showTab('archive');
  log('Opened ' + file.name + ': ' + archive.count + ' entries in ' + archive.folderCount + ' folders.', 'success');
  if (archive.compressionTypes['3']) {
    log('Found ' + archive.compressionTypes['3'] + ' Oodle resources. Browser WASM will decode supported Kraken/Mermaid/Selkie/Leviathan blocks on demand.', 'success');
  }
}

function usableArchiveModels() {
  if (!state.archive) return [];
  const nativeMeshes = new Set(['.gfbmdl', '.trmdl', '.trmsh']);
  const names = state.archive.resources.map(resource => ({
    resource, name: resolvedName(resource, state.dictionary) || ''
  }));
  const dirsWithTrmdl = new Set(names.filter(row => row.name.toLowerCase().endsWith('.trmdl'))
    .map(row => row.name.replaceAll('\\', '/').split('/').slice(0, -1).join('/').toLowerCase()));
  return names.filter(row => {
    const suffix = extension(row.name);
    if (!nativeMeshes.has(suffix)) return false;
    if (suffix === '.trmsh') {
      const dir = row.name.replaceAll('\\', '/').split('/').slice(0, -1).join('/').toLowerCase();
      if (dirsWithTrmdl.has(dir)) return false;
    }
    return true;
  }).map(row => row.resource);
}

function usableArchiveTextures() {
  if (!state.archive) return [];
  return state.archive.resources.filter(resource => {
    const name = resolvedName(resource,state.dictionary);
    return name && isInspectableTexture(name);
  });
}

function updateArchiveTextureButton() {
  const textures = usableArchiveTextures();
  const button = el('previewArchiveTexture');
  button.disabled = !textures.length && !state.resource;
  button.textContent = state.resource && textures.includes(state.resource)
    ? '▧ INSPECT SELECTED TEXTURE'
    : state.resource ? '▧ PROBE SELECTED TEXTURE'
      : '▧ INSPECT TEXTURES (' + textures.length + ')';
}

async function inspectArchiveTexture() {
  if (!state.archive || state.busy) return;
  const available = usableArchiveTextures();
  const resource = state.resource || available[0];
  if (!resource) {
    log('Load the archive filename hash dictionary to identify BNTX or image entries.', 'error');
    return;
  }
  const name = resolvedName(resource,state.dictionary) ||
    'resource_' + String(resource.index).padStart(4,'0') + '.bin';
  // Bind the archive that owns this resource; a previous refactor left
  // sourceArchive undefined and prevented anonymous BNTX inspection.
  const sourceArchive = state.archive;
  await inspectSourceTexture({
    path:name,size:resource.size,
    getBytes:async()=>extractResourceAsync(sourceArchive,resource)
  });
}

function updateArchiveModelButton() {
  const candidates = usableArchiveModels();
  const selected = state.resource;
  const preview = el('previewArchiveModel');
  const recoverable=state.archive?.resources.some(row=>[0,2,3].includes(row.compression));
  preview.disabled = !candidates.length && !recoverable;
  preview.textContent = selected && candidates.includes(selected)
    ? '◈ PREVIEW SELECTED 3D MESH'
    : candidates.length
      ? '◈ PREVIEW NATIVE 3D MESH ('+candidates.length+')'
      : '◈ AUTO-DETECT 3D MODEL';
}

async function previewGfbmdlInArchive() {
  if (!state.archive || state.busy) return;
  const archive=state.archive, dictionary=state.dictionary;
  const models=usableArchiveModels();
  const selectedResource=models.includes(state.resource)?state.resource:models[0];
  busy(true, 'Decoding archive model', 'Finding Trinity meshes, buffers and companion files…');
  try {
    let project,name;
    if(selectedResource){
      name=resolvedName(selectedResource,dictionary);
      const allowed=new Set(['.gfbmdl','.trmdl','.trmsh','.trmbf','.trskl','.trmtr',
        '.tranm','.gfbanm','.tracm','.png','.jpg','.jpeg','.webp','.bntx','.dds']);
      const resources=archive.resources
        .map(resource=>({resource,name:resolvedName(resource,dictionary)}))
        .filter(item=>item.name&&allowed.has(extension(item.name)));
      project={label:archive.filename,items:resources.map(({resource,name:path})=>({
        path,size:resource.size,
        getBytes:async()=>{
          const raw=await extractResourceAsync(archive,resource);
          return raw instanceof Blob?raw.arrayBuffer():
            raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
        }
      }))};
    }else{
      const prepared=await prepareGfpakModelPreview(
        archive.file||new Blob([archive.buffer]),archive.filename,
        info=>log(info),dictionary);
      project=prepared.project;name=prepared.selected;
    }
    const result=await loadModel(project,name,message=>log(message),{
      fastPreview:true, textureVariant:state.textureVariant
    });
    // Preserve original decoded archive members, including unknown files.
    // The project used for preview may contain only the model companions.
    state.exportProject={items:archive.resources.map(resource=>({
      path:resolvedName(resource,dictionary)||resource.index+'_'+resource.pathHash+'.bin',
      getBytes:async()=>extractResourceAsync(archive,resource)
    }))};
    state.desktopSource=false;
    state.project=project;
    setModel(result,extension(name),archive.filename);
    showTab('viewer');
    completeFastPreview(result);
    log(name+' decoded into real 3D meshes inside the browser.', 'success');
  }catch(error){
    errorMessage(error);
  }finally{busy(false);}
}

function codecName(c) { return c === 0 ? 'Stored' : c === 2 ? 'LZ4' : c === 3 ? 'Oodle (WASM)' : 'Type ' + c; }
function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function validResourceName(name) { return name.replace(/[/\\:*?"<>|]+/g, '_').slice(-160); }

function renderArchiveTable() {
  const body = el('archiveTableBody');
  body.replaceChildren();
  if (!state.archive) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = 'Open a .gfpak to inspect its internal resources.';
    td.className = 'table-empty';
    tr.append(td); body.append(tr); return;
  }
  const needle = el('archiveSearch').value.toLowerCase().trim();
  const all = state.archive.resources.filter(r => !needle ||
    String(r.index).includes(needle) || r.pathHash.includes(needle) ||
    (r.fileHash && r.fileHash.includes(needle)) ||
    (resolvedName(r, state.dictionary) || '').toLowerCase().includes(needle));
  const visible = all.slice(0, 1500);
  const fragment = document.createDocumentFragment();
  for (const r of visible) {
    const tr = document.createElement('tr');
    tr.dataset.index = String(r.index);
    if (state.resource?.index === r.index) tr.className = 'selected';
    const name = resolvedName(r, state.dictionary) || r.pathHash;
    const values = [String(r.index).padStart(4, '0'), r.folder == null ? '—' : String(r.folder).padStart(2, '0'), name,
      codecName(r.compression), formatBytes(r.packedSize), formatBytes(r.size)];
    for (const [i, value] of values.entries()) {
      const td = document.createElement('td');
      td.textContent = value;
      if (i === 3) td.className = r.compression === 3 ? 'code-oodle' : r.compression === 2 ? 'code-lz4' : '';
      td.title = value;
      tr.append(td);
    }
    tr.addEventListener('click', () => {
      state.resource = r;
      body.querySelectorAll('tr.selected').forEach(row => row.classList.remove('selected'));
      tr.classList.add('selected');
      el('downloadResource').disabled = false;
      updateArchiveModelButton();
      updateArchiveTextureButton();
      log('Selected resource ' + r.index + ' (' + codecName(r.compression) + ').');
    });
    fragment.append(tr);
  }
  body.append(fragment);
  updateArchiveModelButton();
  updateArchiveTextureButton();
  el('archiveRowCount').textContent = visible.length.toLocaleString() + ' of ' + all.length.toLocaleString() +
    (all.length > visible.length ? ' matching resources (first 1,500 shown)' : ' matching resources');
}

async function readHashFile(file) {
  try {
    const text = await file.text();
    state.dictionary = parseHashDictionary(text, extension(file.name) === '.json');
    el('hashStatus').textContent = 'Loaded ' + state.dictionary.size + ' hash mappings from ' + file.name;
    log('Loaded filename dictionary ' + file.name + ' (' + state.dictionary.size + ' entries).', 'success');
    renderArchiveTable();
    const models = usableArchiveModels();
    if (models.length) log('Identified ' + models.length + ' model resource(s). Preview accepts stored, LZ4 and supported Oodle blocks.', 'success');
  } catch (err) { errorMessage(err); }
}

async function downloadSelectedResource() {
  if (!state.archive || !state.resource) return;
  try {
    const packed = el('savePacked').checked;
    const data = await extractResourceAsync(state.archive, state.resource, { packed });
    const sourceName = resolvedName(state.resource, state.dictionary) ||
      String(state.resource.index).padStart(4, '0') + '_' + state.resource.pathHash + '.bin';
    downloadBlob(validResourceName(sourceName) + (packed ? '.packed' : ''), data);
    log('Exported resource ' + state.resource.index + (packed ? ' as compressed bytes.' : ' as decoded bytes.'), 'success');
  } catch (err) { errorMessage(err); }
}

async function exportModel() {
  if (!state.loaded || state.busy) return;
  busy(true, 'Exporting GLB', 'Packing geometry, textures and available animation data…');
  try {
    const name = (el('outputName').value.trim() || 'converted-model').replace(/[\\/:*?"<>|]/g, '_') + '.glb';
    const data = await exportGlb(state.loaded.root, state.loaded.animations);
    downloadBlob(name, data, 'model/gltf-binary');
    log('Exported ' + name + ' (' + formatBytes(data.byteLength) + ').', 'success');
  } catch (err) {
    errorMessage(err);
  } finally {
    busy(false);
  }
}

function addDemo() {
  if (state.busy) return;
  state.project = null;
  state.exportProject = null; state.desktopSource=false;
  state.archive = null;
  el('modelChoice').hidden = true;
  el('textureChoice').hidden = true;
  el('nativeGuide').hidden = true;
  updateSource('Built-in geometric demo model');
  setModel(demoModel(), '.glb', 'Built-in demo');
  el('outputName').value = 'gfpak-demo';
  showTab('viewer');
}

function attachEvents() {
  el('gameSource').addEventListener('change', updateGameProfile);
  el('inspectPackagedArchive').addEventListener('click', async () => {
    const item = state.project?.items.find(entry => entry.path.toLowerCase().endsWith('.gfpak'));
    if (!item) return;
    try {
      const blob = new Blob([await item.getBytes()]);
      const file = Object.assign(blob, {name: item.path.split('/').pop()});
      await loadArchive(file);
    } catch (error) { errorMessage(error); }
  });
  el('chooseFiles').addEventListener('click', event => { event.stopPropagation(); el('fileInput').click(); });
  el('dropZone').addEventListener('click', event => {
    if (event.target.closest('button')) return;
    el('fileInput').click();
  });
  el('dropZone').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el('fileInput').click(); }
  });
  el('chooseFolder').addEventListener('click', () => el('folderInput').click());
  el('fileInput').addEventListener('change', event => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    chooseProject(files);
  });
  el('folderInput').addEventListener('change', event => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    chooseProject(files);
  });
  el('dropZone').addEventListener('dragover', event => {
    event.preventDefault(); el('dropZone').classList.add('drag-over');
  });
  el('dropZone').addEventListener('dragleave', () => el('dropZone').classList.remove('drag-over'));
  el('dropZone').addEventListener('drop', event => {
    event.preventDefault(); el('dropZone').classList.remove('drag-over');
    chooseProject(Array.from(event.dataTransfer?.files ?? []));
  });
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => event.preventDefault());
  el('demoButton').addEventListener('click', addDemo);
  el('emptyDemo').addEventListener('click', addDemo);
  el('modelFilter').addEventListener('input', filterModels);
  el('modelSelect').addEventListener('dblclick', openModel);
  el('loadSelected').addEventListener('click', openModel);
  el('textureSelect').addEventListener('dblclick', inspectSelectedTexture);
  el('inspectSelectedTexture').addEventListener('click', inspectSelectedTexture);
  el('textureSurface').addEventListener('change', drawCurrentTexture);
  el('textureClose').addEventListener('click', () => el('textureDialog').close());
  el('textureDialog').addEventListener('close', disposeTexturePreview);
  el('textureSavePng').addEventListener('click', () => {
    const canvas = el('textureCanvasHost').querySelector('canvas');
    if (!canvas || !state.textureInfo) return;
    const fileName = texturePngName(state.textureInfo, Number(el('textureSurface').value));
    canvas.toBlob(blob => {
      if (blob) {
        downloadBlob(fileName,blob,'image/png');
        log('Exported decoded texture image ' + fileName, 'success');
      } else log('Could not encode this preview as PNG.','error');
    },'image/png');
  });
  el('exportButton').addEventListener('click', exportModel);
  el('exportPokemonButton').addEventListener('click', async () => {
    if (!state.loaded || state.busy) return;
    if (!state.exportProject) {
      if (state.desktopSource) {
        window.dispatchEvent(new CustomEvent('gfpak-export-pokemon', {detail: state.desktopExport}));
      }
      return;
    }
    busy(true,'Exporting Pokémon','Packing original resources and a converted Pokédex model…');
    try {
      let glb = null;
      if (state.loaded.companionsReady) {
        try {
          glb = await exportGlb(state.loaded.root,state.loaded.animations);
        } catch (error) {
          log('GLB could not be included: ' + (error.message || error) +
            '. Original assets are still being exported.', 'info');
        }
      } else {
        log('Textures or animations have not finished importing. Exporting original assets only.', 'info');
      }
      const blob = await exportPokemonZip(state.exportProject,state.loaded.selected,{
        sourceGame:currentGame().id,glb
      });
      const name = state.loaded.selected.split('/').at(-1).replace(/\.[^.]+$/,'')+'.zip';
      downloadBlob(name,blob,'application/zip');
      log('Exported ' + name + (glb ? ' with converted GLB and original companions.' :
        ' with original assets only; a Pokédex-ready GLB is not yet available.'),'success');
    } catch(error) {errorMessage(error);}
    finally {busy(false);}
  });
  el('tabViewer').addEventListener('click', () => showTab('viewer'));
  el('tabArchive').addEventListener('click', () => showTab('archive'));
  el('gridToggle').addEventListener('change', event => state.stage?.setGrid(event.target.checked));
  el('spinToggle').addEventListener('change', event => state.stage?.setSpin(event.target.checked));
  el('axesToggle').addEventListener('change', event => state.stage?.setAxes(event.target.checked));
  el('viewReset').addEventListener('click', () => state.stage?.frame());
  el('frameModel').addEventListener('click', () => state.stage?.frame());
  el('clipSelect').addEventListener('change', event => {
    if (!state.stage) return;
    const playing = state.stage.playAnimation(Number(event.target.value));
    el('toggleAnimation').textContent = playing ? 'Ⅱ PAUSE ANIMATION' : '▶ PLAY ANIMATION';
  });
  el('toggleAnimation').addEventListener('click', () => {
    if (!state.stage) return;
    const playing = state.stage.toggleAnimation(Number(el('clipSelect').value) || 0);
    el('toggleAnimation').textContent = playing ? 'Ⅱ PAUSE ANIMATION' : '▶ PLAY ANIMATION';
  });
  el('textureVariantSelect').addEventListener('change', event => {
    state.textureVariant = event.target.value === 'shiny' ? 'shiny' : 'regular';
    reloadTextureVariant();
  });
  el('archiveSearch').addEventListener('input', renderArchiveTable);
  el('previewArchiveModel').addEventListener('click', previewGfbmdlInArchive);
  el('previewArchiveTexture').addEventListener('click', inspectArchiveTexture);
  el('chooseHashes').addEventListener('click', () => el('hashInput').click());
  el('hashInput').addEventListener('change', event => {
    if (event.target.files?.[0]) readHashFile(event.target.files[0]);
    event.target.value = '';
  });
  el('downloadIndex').addEventListener('click', () => {
    if (!state.archive) return;
    const data = JSON.stringify(summary(state.archive), null, 2);
    downloadBlob(state.archive.filename.replace(/\.gfpak$/i, '') + '_index.json', data, 'application/json');
    log('Saved GFPAK metadata index.', 'success');
  });
  el('downloadResource').addEventListener('click', downloadSelectedResource);
  el('clearLog').addEventListener('click', () => el('logBody').replaceChildren());
}

async function openFastDesktopPreview(detail) {
  const finished = typeof detail?.finish === 'function' ? detail.finish : () => {};
  if (state.busy || !state.stage) {
    finished(false, '3D viewer is currently busy or unavailable');
    return;
  }
  busy(true, 'Fast native 3D preview', 'Loading only the model components needed for rendering…');
  try {
    const manifest = detail.manifest;
    if (!manifest?.selected || !manifest.items?.length)
      throw new Error('Native preview manifest is missing files');
    const cached = new Map();
    const project = {
      label: manifest.label || 'Game File Explorer',
      items: manifest.items.filter(item => manifest.animations !== false || !/\.(tranm|gfbanm|tracm)$/i.test(item.path)).map(item => {
        const getBytes = async () => {
          if (!cached.has(item.url)) {
            cached.set(item.url, (async () => {
              const response = await fetch(item.url, {cache:'no-store'});
              if (!response.ok)
                throw new Error('Model resource ' + item.path + ' could not be read (' +
                  response.status + ')');
              return response.arrayBuffer();
            })());
          }
          return cached.get(item.url);
        };
        return {
          path:item.path, size:item.size, getBytes,
          linkedKind:item.linkedKind || null,
          textureVariant:item.textureVariant || null,
          matchConfidence:item.matchConfidence || null,
          matchReason:item.matchReason || '',
          getText:async () => new TextDecoder().decode(await getBytes())
        };
      })
    };
    if (manifest.matched && Object.keys(manifest.matched).length) {
      const linked = Object.entries(manifest.matched)
        .filter(([,count]) => count > 0)
        .map(([kind,count]) => count + ' ' + kind + (count !== 1 ? 's' : ''));
      log('Model-linked assets detected: ' + linked.join(', ') +
        '. Importing compatible textures and animations automatically.');
    }
    const result = await loadModel(project, manifest.selected,
      message => log(message), {fastPreview:true, textureVariant:state.textureVariant});
    state.exportProject = project; state.desktopSource=true;
    state.project = project;
    state.desktopExport = {key: manifest.exportKey || null, nodeId: manifest.exportNodeId || null};
    setModel(result, extension(manifest.selected), project.label);
    // The desktop explorer is a separate tab; make the loaded 3D viewport
    // actually visible instead of leaving it obscured behind File Explorer.
    el('assetBrowser').hidden = true;
    el('desktopTools').hidden = true;
    el('tabAssets').classList.remove('active');
    el('tabAssets').setAttribute('aria-selected', 'false');
    el('tabConverter').classList.remove('active');
    el('tabConverter').setAttribute('aria-selected', 'false');
    showTab('viewer');
    log('Fast native geometry preview loaded without launching Blender.', 'success');
    finished(true);
    completeFastPreview(result);
  } catch (error) {
    log('Fast preview: ' + (error.message || String(error)) + '. Built-in preview unavailable.', 'info');
    finished(false, error.message || String(error));
  } finally {
    busy(false);
  }
}

async function previewBrowserGameModel(detail) {
  const finished=typeof detail?.finish==='function'?detail.finish:()=>{};
  if(state.busy||!state.stage){
    finished(false,'3D renderer is unavailable or busy');
    return;
  }
  const {project,selected}=detail||{};
  if(!selected||!project?.items?.some(item=>item.path===selected)){
    const reason='Browser preview is missing the selected model resource';
    log(reason,'error');
    finished(false,reason);
    return;
  }
  busy(true,'Opening game model','Matching meshes, textures and animation companions…');
  try {
    // A PLA game archive may have dozens of BNTX/TRANM resources. Render the
    // geometry first, then decode companions while the viewport is responsive.
    const result=await loadModel(project,selected,message=>log(message),{
      fastPreview:true, textureVariant:state.textureVariant
    });
    state.exportProject=project;
    state.project=project;
    state.desktopSource=false;
    state.archive=null;
    suggestGame([project.label,selected]);
    setModel(result,extension(selected),project.label);
    showTab('viewer');
    finished(true);
    completeFastPreview(result);
    log('Opened model directly from local game files without Blender.','success');
  }catch(error){
    errorMessage(error);
    finished(false,error.message||String(error));
  }finally{busy(false);}
}

function start() {
  window.addEventListener('gfpak-web-open-file', event => {
    const files=event.detail?.files;
    if(files?.length) void chooseProject(files);
  });
  window.addEventListener('gfpak-web-preview-model', event => {
    void previewBrowserGameModel(event.detail);
  });
  window.gfpakFastPreviewAvailable = true;
  window.gfpakFastTextureAvailable = true;
  window.addEventListener('gfpak-fast-native-texture', event => {
    const info = event.detail?.manifest;
    if (!info?.url || !info?.path) {
      event.detail?.finish?.(false, 'Invalid texture source');
      return;
    }
    inspectSourceTexture({
      path:info.path, size:info.size,
      getBytes:async () => {
        const response = await fetch(info.url, {cache:'no-store'});
        if (!response.ok) throw new Error('Texture request failed (' + response.status + ')');
        return response.arrayBuffer();
      }
    }).then(success => event.detail?.finish?.(success !== false))
      .catch(error => event.detail?.finish?.(false,error.message));
  });
  window.addEventListener('gfpak-fast-native-preview', event =>
    openFastDesktopPreview(event.detail).catch(error =>
      event.detail?.finish?.(false, error.message || String(error))
    ));
  window.addEventListener('gfpak-native-model', event => {
    if (event.detail instanceof File) chooseProject([event.detail]);
  });
  initGameOptions();
  attachEvents();
  resetInspector();
  try {
    state.stage = new ModelStage(el('canvasHost'));
    state.stage.setGrid(el('gridToggle').checked);
    log('3D renderer initialized. Files stay entirely on your device.', 'success');
  } catch (err) {
    errorMessage(new Error('3D preview cannot start: ' + err.message));
    el('exportButton').disabled = true;
    el('emptyState').querySelector('p').textContent = 'This browser or device does not currently support WebGL. You can still inspect GFPak archives.';
  }
  window.addEventListener('beforeunload', () => {
    state.loaded?.disposeAssets?.();
    state.stage?.dispose();
    disposeTexturePreview();
  });
}

start();
