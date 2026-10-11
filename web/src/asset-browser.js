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

async function loadNSPDashboard(root) {
  if (!root || root.kind !== 'nsp') return;
  activeNSP = root;
  id('nspWorkbench').hidden = false;
  const overview = await api.browse_nsp_summary(root.id);
  if (activeNSP?.id !== root.id) return;
  id('nspPackageTitle').textContent = overview.filename;
  id('nspBytes').textContent = formatSize(overview.bytes);
  id('nspFiles').textContent = overview.files.toLocaleString();
  const ncaCount = (overview.formats['Encrypted NCA'] || 0);
  id('nspNcas').textContent = ncaCount.toLocaleString();
  id('nspHeader').textContent = formatSize(overview.header_bytes);
  const breakdown = id('nspRoleBreakdown');
  breakdown.replaceChildren();
  const data = Object.entries(overview.roles).sort((a, b) => b[1] - a[1]);
  const total = Math.max(1, overview.files);
  for (const [role, count] of data) {
    const card = document.createElement('div');
    card.className = 'nsp-role-card';
    const heading = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = role;
    const amount = document.createElement('strong');
    amount.textContent = count + ' files · ' + formatSize(overview.role_bytes[role]);
    heading.append(name, amount);
    const bar = document.createElement('div');
    bar.className = 'nsp-role-bar';
    const fill = document.createElement('span');
    fill.style.width = Math.max(1, (count / total * 100)).toFixed(1) + '%';
    bar.append(fill);
    card.append(heading, bar);
    breakdown.append(card);
  }
  const warnings = overview.warnings || [];
  id('nspWarningCount').textContent = warnings.length ? warnings.length + ' warnings' : 'No structural warnings';
  const lines = id('nspWarnings');
  lines.replaceChildren();
  if (!warnings.length) {
    lines.textContent = 'The PFS0 index passed structural checks. This does not validate encrypted NCA contents.';
  } else {
    for (const warning of warnings) {
      const p = document.createElement('p');
      p.textContent = warning;
      lines.append(p);
    }
  }
}

async function showNSPSelection(row) {
  const revision = ++selectionRevision;
  const active = row?.kind === 'nspfile';
  id('nspSelection').hidden = !active;
  if (!active) return;
  const list = id('nspEntryMetadata');
  list.replaceChildren();
  const fields = [
    ['Role', row.role || 'Unidentified'],
    ['Format', row.format || 'Opaque'],
    ['File size', formatSize(row.size) + ' (' + row.size.toLocaleString() + ' bytes)'],
    ['Absolute offset', '0x' + Number(row.offset || 0).toString(16).toUpperCase()],
    ...(row.content_id ? [['Content ID', row.content_id]] : []),
  ];
  for (const [label, value] of fields) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    list.append(dt, dd);
  }
  id('nspHexOffset').value = '0';
  id('nspHashResult').textContent = '';
  id('nspHexDump').textContent = 'Loading bounded preview…';
  await readHexDump(revision);
}

async function readHexDump(revision = selectionRevision) {
  if (!selected || selected.kind !== 'nspfile') return;
  const row = selected;
  const offset = Number(id('nspHexOffset').value);
  const length = Number(id('nspHexLength').value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Enter a nonnegative byte offset.');
  }
  const data = await api.browse_nsp_inspect(row.id, offset, length);
  if (revision !== selectionRevision || selected?.id !== row.id) return;
  const text = data.hex_lines.map(line => {
    const offsetText = line.offset.toString(16).padStart(8, '0').toUpperCase();
    return offsetText + '  ' + line.hex.padEnd(47, ' ') + '  |' + line.ascii + '|';
  }).join('\n');
  id('nspHexDump').textContent = text || '(No raw preview available for this entry)';
  id('nspSignature').textContent = data.signature + ' · ' + data.note;
}

async function startNSPTask(kind, row) {
  if (!row || nspTaskPolling) return;
  const label = kind === 'hash' ? 'Computing SHA-256' :
                kind === 'extract' ? 'Saving raw package entry' :
                'Auditing every NSP entry';
  try {
    const accepted = await api.browse_nsp_start_task(kind, row.id);
    if (!accepted) return;
    nspTaskPolling = true;
    id('nspTaskPanel').hidden = false;
    id('nspProgressBar').style.width = '0%';
    id('nspTaskLabel').textContent = label;
    id('nspTaskDetails').textContent = 'Starting…';
    id('nspCancel').disabled = false;
    const poll = async () => {
      try {
        const status = await api.browse_nsp_task_status();
        const pct = status.total
          ? Math.min(100, Math.round(100 * status.done / status.total))
          : (status.running ? 0 : 100);
        id('nspProgressBar').style.width = pct + '%';
        id('nspTaskDetails').textContent = pct + '% · ' + formatSize(status.done) +
                                           ' / ' + formatSize(status.total);
        if (status.running) {
          window.setTimeout(poll, 350);
          return;
        }
        nspTaskPolling = false;
        id('nspCancel').disabled = true;
        if (status.error) {
          id('nspTaskDetails').textContent = 'Stopped: ' + status.error;
          showNotice(status.error, true);
          return;
        }
        if (kind === 'hash' && status.result) {
          id('nspHashResult').textContent = 'SHA-256: ' + status.result.sha256 +
            (status.result.content_id_comparison
              ? '\nNCA content-ID prefix: ' + status.result.content_id_comparison +
                ' (advisory, not an authenticity guarantee)' : '');
          showNotice('Selected file SHA-256 computed successfully.');
        } else if (kind === 'extract' && status.result) {
          id('nspTaskDetails').textContent = status.result.message +
                                             '\nSaved: ' + status.result.saved;
          showNotice('Raw file saved successfully. No data was decrypted.');
        } else if (kind === 'audit' && status.result) {
          const result = status.result;
          id('nspTaskDetails').textContent =
            result.files_checked + ' files hashed · ' +
            formatSize(result.bytes_hashed) + ' examined · ' +
            result.content_id_differences +
            ' advisory content-ID differences. ' + result.warning;
          showNotice('Full PFS0 payload audit finished. All files were read for SHA-256.');
        }
      } catch (error) {
        nspTaskPolling = false;
        id('nspCancel').disabled = true;
        showNotice(error.message || String(error), true);
      }
    };
    await poll();
  } catch (error) { showNotice(error.message || String(error), true); }
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
