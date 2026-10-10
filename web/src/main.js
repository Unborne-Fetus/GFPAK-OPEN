/** GFPAK Open Web — all user data remains inside the browser. */
import './style.css';
import { ModelStage } from './stage.js';
import { GAMES, gameById, detectGameFromNames, describeSource, identifyFormat } from './game-support.js';
import {
  projectFromFiles, projectFromZip, loadModel, modelStats, exportGlb,
  downloadBlob, demoModel, extension
} from './model.js';
import {
  parseGfpak, summary, extractResource, parseHashDictionary, resolvedName
} from './gfpak.js';

const el = id => document.getElementById(id);
const state = {
  stage: null,
  project: null,
  archive: null,
  dictionary: new Map(),
  loaded: null,
  resource: null,
  busy: false,
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
  el('loadSelected').disabled = value || !state.project?.models.length;
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
  el('exportButton').disabled = true;
  el('emptyState').hidden = false;
}

function setModel(result, format, packageName) {
  if (!state.stage) throw new Error('WebGL is not available in this browser');
  const previous = state.loaded;
  state.stage.setModel(result.root, result.animations);
  previous?.disposeAssets?.();
  state.loaded = result;
  const info = modelStats(result.root, result.animations);
  const mapping = [
    ['statMeshes', info.meshes], ['statVertices', info.vertices],
    ['statTriangles', info.triangles], ['statMaterials', info.materials],
    ['statBones', info.bones], ['statClips', info.clips]
  ];
  for (const [id, n] of mapping) el(id).textContent = Number(n).toLocaleString();
  el('inspectorState').textContent = 'LOADED';
  el('objectName').textContent = result.selected.split('/').pop() || result.selected;
  el('objectSubtitle').textContent = info.meshes + ' mesh(es) ready for GLB export';
  el('originalFormat').textContent = format.replace('.', '').toUpperCase();
  el('packageName').textContent = packageName;
  el('activeGame').textContent = currentGame().name;
  el('emptyState').hidden = true;
  el('exportButton').disabled = false;
  const clean = result.selected.split('/').pop().replace(/\.(glb|gltf|fbx|obj|dae|stl|ply|3ds)$/i, '') || 'model';
  el('outputName').value = clean.slice(0, 130);
  currentFile(result.selected.split('/').pop());
  const clips = el('clipSelect');
  clips.replaceChildren();
  result.animations.forEach((a, index) => clips.add(new Option(a.name || 'Animation ' + (index + 1), String(index))));
  if (!result.animations.length) clips.add(new Option('No animations available', ''));
  clips.disabled = !result.animations.length;
  el('toggleAnimation').disabled = !result.animations.length;
  el('toggleAnimation').textContent = result.animations.length ? 'Ⅱ PAUSE ANIMATION' : '▶ PLAY ANIMATION';
  log('Loaded ' + info.meshes + ' mesh(es) and ' + info.clips + ' animation clip(s).', 'success');
}

async function openModel() {
  if (state.busy || !state.project) return;
  const selected = el('modelSelect').value;
  if (!selected) return;
  busy(true, 'Loading model', 'Reading mesh and texture resources…');
  try {
    const result = await loadModel(state.project, selected, message => log(message));
    setModel(result, extension(selected), state.project.label);
    showTab('viewer');
  } catch (err) {
    errorMessage(err);
  } finally {
    busy(false);
  }
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
    suggestGame([project.label, ...project.items.map(item => item.path)]);
    displayNativeGuidance(project.items.map(item => item.path));
    updateSource(project.label + ' · ' + project.models.length + ' renderable model(s)' + (project.native?.length ? ' · ' + project.native.length + ' original resource(s)' : ''));
    el('modelChoice').hidden = !project.models.length;
    el('modelFilter').value = '';
    filterModels();
    log('Imported ' + project.items.length + ' files, found ' + project.models.length + ' supported model(s).', 'success');
    if (!project.models.length) {
      const notice = describeSource(currentGame().id, project.items.map(item => item.path));
      log(notice.title + ': ' + notice.message, notice.kind === 'native' ? 'info' : 'error');
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
  const archive = parseGfpak(await file.arrayBuffer(), file.name);
  state.archive = archive;
  state.project = null;
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
  el('archiveSearch').value = '';
  renderArchiveTable();
  showTab('archive');
  log('Opened ' + file.name + ': ' + archive.count + ' entries in ' + archive.folderCount + ' folders.', 'success');
  if (archive.compressionTypes['3']) {
    log('Found ' + archive.compressionTypes['3'] + ' Oodle-compressed resources: browser extraction of those files is not supported.');
  }
}

function codecName(c) { return c === 0 ? 'Stored' : c === 2 ? 'LZ4' : c === 3 ? 'Oodle' : 'Type ' + c; }
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
      log('Selected resource ' + r.index + ' (' + codecName(r.compression) + ').');
    });
    fragment.append(tr);
  }
  body.append(fragment);
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
  } catch (err) { errorMessage(err); }
}

async function downloadSelectedResource() {
  if (!state.archive || !state.resource) return;
  try {
    const packed = el('savePacked').checked;
    const data = extractResource(state.archive, state.resource, { packed });
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
  state.archive = null;
  el('modelChoice').hidden = true;
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
      const buffer = await item.getBytes();
      await loadArchive({name: item.path.split('/').pop(), arrayBuffer: async () => buffer});
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
  el('exportButton').addEventListener('click', exportModel);
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
  el('archiveSearch').addEventListener('input', renderArchiveTable);
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

function start() {
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
  });
}

start();
