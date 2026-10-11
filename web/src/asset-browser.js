/** Desktop-only NX-style read-only archive and extracted-asset explorer. */
const id = name => document.getElementById(name);
let api;
let initialized = false;
let pathStack = [];
let current = [];
let selected = null;
let scanListing = null;
let activeNSP = null;
let selectionRevision = 0;
let nspTaskPolling = false;
const categories = {
  model: 'Model', 'model archive': 'Model archive',
  animation: 'Animation', texture: 'Texture', skeleton: 'Skeleton',
  material: 'Material', mesh: 'Mesh', folder: 'Folder',
  archive: 'Archive', 'encrypted container': 'Encrypted NCA',
  unknown: 'Unidentified', metadata: 'Metadata', other: 'Other'
};

function showNotice(message, error = false) {
  id('assetNotice').textContent = message;
  id('assetNotice').classList.toggle('native-error', error);
}

function canPreview(row) {
  if (!row) return false;
  if (row.kind === 'gfpak') return true;
  if (row.kind === 'gfpak_resource') return row.category === 'model';
  return row.kind === 'file' && /\.(glb|trmdl|gfbmdl|gfpak)$/i.test(row.name);
}

function formatSize(n) {
  const value = Number(n) || 0;
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GiB';
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MiB';
  if (value >= 1024) return (value / 1024).toFixed(1) + ' KiB';
  return value + ' B';
}

function summary(counts = {}) {
  id('assetCountModel').textContent = (counts.model || 0) + (counts['model archive'] || 0);
  id('assetCountAnimation').textContent = counts.animation || 0;
  id('assetCountTexture').textContent = counts.texture || 0;
  id('assetCountOther').textContent = Object.entries(counts).reduce(
    (n, [key, count]) => n + (!['model', 'model archive', 'animation', 'texture', 'folder'].includes(key) ? count : 0), 0
  );
}

function select(row) {
  selected = row;
  id('assetSelected').textContent = row?.name || 'Nothing selected';
  const type = categories[row?.category] || row?.category || 'Select an asset';
  id('assetSelectedInfo').textContent = row
    ? type + ' • ' + formatSize(row.size) +
      (row.relative ? '\n' + row.relative : '') +
      (row.kind === 'nspfile' ? '\nEncrypted NCA contents cannot be decoded here.' : '')
    : 'Select an asset to inspect or preview it.';
  id('assetPreview').disabled = !canPreview(row);
  id('assetPreview').textContent = canPreview(row) ? '◈ Preview in 3D' : 'Preview unavailable for this resource';
  showNSPSelection(row).catch(error => showNotice(error.message || String(error), true));
}

function renderRows(rows) {
  current = rows;
  const needle = id('assetSearch').value.trim().toLowerCase();
  const filter = id('assetCategory').value;
  const visible = rows.filter(row => {
    return (!needle || (row.name + ' ' + (row.relative || '')).toLowerCase().includes(needle)) &&
      (filter === 'all' || row.category === filter);
  });
  const body = id('assetRows');
  body.replaceChildren();
  if (!visible.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'table-empty';
    cell.textContent = 'No assets match this filter or directory.';
    row.append(cell);
    body.append(row);
    return;
  }
  for (const item of visible) {
    const row = document.createElement('tr');
    row.className = 'asset-row';
    row.tabIndex = 0;
    if (item.id === selected?.id) row.classList.add('selected');
    const name = document.createElement('td');
    const icon = document.createElement('span');
    icon.className = 'asset-file-icon';
    icon.textContent = item.expandable ? '▣' :
      item.category === 'animation' ? '▶' :
      item.category === 'texture' ? '◈' :
      item.category === 'model' || item.category === 'mesh' ? '◇' : '▤';
    name.append(icon, document.createTextNode(item.relative || item.name));
    const type = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = 'asset-type ' + (item.category || 'other').replaceAll(' ', '-');
    tag.textContent = categories[item.category] || item.category;
    type.append(tag);
    const size = document.createElement('td');
    size.textContent = item.expandable ? '—' : formatSize(item.size);
    const action = document.createElement('td');
    const button = document.createElement('button');
    button.className = 'asset-open';
    button.type = 'button';
    button.textContent = item.expandable ? 'Open →' : canPreview(item) ? 'Preview ↗' : 'Details';
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (item.expandable) openNode(item);
      else if (canPreview(item)) preview(item);
      else select(item);
    });
    action.append(button);
    row.append(name, type, size, action);
    row.addEventListener('click', () => {
      select(item);
      for (const sibling of body.querySelectorAll('tr')) sibling.classList.remove('selected');
      row.classList.add('selected');
    });
    row.addEventListener('dblclick', () => item.expandable ? openNode(item) :
                         canPreview(item) ? preview(item) : select(item));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (item.expandable) openNode(item);
        else if (canPreview(item)) preview(item);
        else select(item);
      }
    });
    body.append(row);
  }
}

function renderListing() {
  const node = pathStack.at(-1);
  if (!node) return;
  const breadcrumbs = pathStack.map(step => step.root.name).join('  /  ');
  id('assetBreadcrumb').textContent = scanListing ? breadcrumbs + '  /  Scan results' : breadcrumbs;
  id('assetBack').disabled = pathStack.length <= 1 && !scanListing;
  if (scanListing) {
    summary(scanListing.counts);
    renderRows(scanListing.assets);
  } else {
    summary(node.listing.counts);
    renderRows(node.listing.entries);
  }
  const notice = scanListing ? 'Showing recognized files from the folder scan.' : node.listing.note;
  showNotice(notice || (node.listing.truncated ? 'This directory has more files than the visible display limit.' : ''));
  select(null);
  if (node.root.kind === 'nsp') {
    loadNSPDashboard(node.root).catch(error => showNotice(error.message || String(error), true));
  } else {
    activeNSP = null;
    id('nspWorkbench').hidden = true;
    id('nspSelection').hidden = true;
  }
}

async function openNode(row) {
  if (!row.expandable) return select(row);
  try {
    const listing = await api.browse_children(row.id);
    scanListing = null;
    pathStack.push({root: row, listing});
    renderListing();
  } catch (error) { showNotice(error.message || String(error), true); }
}

async function openSource(mode) {
  try {
    showNotice('Opening selected files…');
    const result = await api.browse_choose(mode);
    if (!result) return;
    scanListing = null;
    pathStack = [{root: result.root, listing: result.children}];
    id('assetSearch').value = '';
    id('assetCategory').value = 'all';
    id('assetScan').disabled = mode !== 'folder';
    id('assetScanSummary').textContent = 'Browse directories or scan extracted files for model, texture and animation references.';
    renderListing();
  } catch (error) { showNotice(error.message || String(error), true); }
}

async function preview(row = selected) {
  if (!canPreview(row)) return;
  try {
    select(row);
    showNotice('Preparing a temporary 3D preview — Blender runs locally.');
    await api.preview_browser_item(row.id);
    window.dispatchEvent(new CustomEvent('gfpak-native-conversion-started'));
  } catch (error) { showNotice(error.message || String(error), true); }
}

async function scanFolder() {
  try {
    if (!await api.browse_start_scan()) return;
    id('assetScan').disabled = true;
    id('assetScanSummary').textContent = 'Scanning extracted game directories…';
    const poll = async () => {
      try {
        const state = await api.browse_scan_status();
        if (state.running) {
          window.setTimeout(poll, 650);
          return;
        }
        id('assetScan').disabled = false;
        if (state.error) {
          showNotice(state.error, true);
          return;
        }
        if (state.result) {
          scanListing = state.result;
          const count = Object.values(scanListing.counts).reduce((a, b) => a + b, 0);
          id('assetScanSummary').textContent = count + ' recognized assets across ' +
            scanListing.scanned + ' files' + (scanListing.truncated ? ' (partial scan)' : '') +
            '. Select a file to preview, or go Back to browse folders.';
          renderListing();
        }
      } catch (error) { showNotice(error.message || String(error), true); }
    };
    poll();
  } catch (error) {
    id('assetScan').disabled = false;
    showNotice(error.message || String(error), true);
  }
}

function openTab() {
  for (const name of ['viewerPanel', 'archivePanel', 'desktopTools']) id(name).hidden = true;
  id('assetBrowser').hidden = false;
  for (const key of ['tabViewer', 'tabArchive', 'tabConverter', 'tabAssets']) {
    const button = id(key);
    const active = key === 'tabAssets';
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
}

function initialize() {
  if (initialized || !window.pywebview?.api) return;
  initialized = true;
  api = window.pywebview.api;
  id('tabAssets').hidden = false;
  id('tabAssets').addEventListener('click', openTab);
  for (const tab of ['tabViewer', 'tabArchive', 'tabConverter']) {
    id(tab).addEventListener('click', () => {
      id('assetBrowser').hidden = true;
      id('tabAssets').classList.remove('active');
      id('tabAssets').setAttribute('aria-selected', 'false');
    });
  }
  id('assetOpenFolder').addEventListener('click', () => openSource('folder'));
  id('assetOpenFile').addEventListener('click', () => openSource('file'));
  id('assetBack').addEventListener('click', () => {
    if (scanListing) scanListing = null;
    else if (pathStack.length > 1) pathStack.pop();
    renderListing();
  });
  id('assetSearch').addEventListener('input', () => renderRows(current));
  id('assetCategory').addEventListener('change', () => renderRows(current));
  id('assetPreview').addEventListener('click', () => preview());
  id('assetScan').addEventListener('click', scanFolder);
  id('nspManifest').addEventListener('click', async () => {
    if (!activeNSP) return;
    try {
      const saved = await api.browse_nsp_manifest(activeNSP.id);
      if (saved) showNotice('Package inventory saved: ' + saved);
    } catch (error) { showNotice(error.message || String(error), true); }
  });
  id('nspAudit').addEventListener('click', () => startNSPTask('audit', activeNSP));
  id('nspHash').addEventListener('click', () => startNSPTask('hash', selected));
  id('nspExtract').addEventListener('click', () => startNSPTask('extract', selected));
  id('nspReadHex').addEventListener('click', () => readHexDump());
  id('nspCancel').addEventListener('click', () => api.browse_nsp_cancel_task());

}

window.addEventListener('pywebviewready', initialize);
if (window.pywebview?.api) initialize();
