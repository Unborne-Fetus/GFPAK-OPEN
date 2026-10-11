import { detectGameFromNames, gameCapabilities } from './game-support.js';
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
let nspPageRevision = 0;
let nspSearchTimeout = null;
const nxTreeItems = new Map();
const nxTreeListings = new Map();
const nxTreePaths = new Map();
let nxSelectedTree = null;
let nxDetailRevision = 0;
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
  if (row.kind === 'nca_file' && /\.(gfpak|trmdl|gfbmdl|glb)$/i.test(row.name)) return true;
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
  const titles = overview.plaintext_cnmt || [];
  id('nspTitles').hidden = titles.length === 0;
  const records = id('nspTitleRecords');
  records.replaceChildren();
  for (const record of titles) {
    const entry = document.createElement('div');
    entry.className = 'nsp-title-record';
    const heading = document.createElement('strong');
    heading.textContent = record.title_id || 'Unknown title ID';
    const details = document.createElement('p');
    details.textContent = (record.type || 'Unknown content type') +
      (record.version ? ' · version ' + record.version : '') +
      ' · ' + (record.contents || []).length + ' referenced content files';
    const file = document.createElement('small');
    file.textContent = record.filename;
    entry.append(heading, details, file);
    records.append(entry);
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


async function refreshNCAReader() {
  if (!api?.browse_nca_settings) return;
  try {
    const state = await api.browse_nca_settings();
    const keyset = state.keyset || 'No keys file selected';
    id('ncaReaderStatus').textContent =
      '✓ Self-contained NCA / RomFS / ExeFS reader · ' + keyset +
      (state.has_keys ? ' · Encrypted NCA keys file selected.' :
                        ' · Encrypted NCA sections require a compatible local keys file.');
    id('ncaReaderStatus').classList.add('ready');
  } catch (error) {
    id('ncaReaderStatus').textContent = String(error.message || error);
  }
}

function invalidateNCASections() {
  // Existing nodes were loaded under old tool settings. Force lazy reload
  // without rebuilding the entire user-opened file tree.
  for (const view of nxTreeItems.values()) {
    if (view.row.kind !== 'nspfile') continue;
    nxTreeListings.delete(view.row.id);
    view.loaded = false;
    view.expanded = false;
    view.children.replaceChildren();
    view.children.hidden = true;
    view.toggle.textContent = '▸';
    view.node.setAttribute('aria-expanded', 'false');
  }
}

async function selectNCASetting(kind) {
  try {
    await api.browse_nca_select(kind);
    invalidateNCASections();
    await refreshNCAReader();
    showNotice('Local keys file selected. Expand an NCA to browse its real sections inside GFPAK-OPEN.');
  } catch (error) { showNotice(error.message || String(error), true); }
}

function nxTreeIcon(row) {
  if (row.kind === 'nsp') return '▣';
  if (row.kind === 'nspfile') return '▣';
  if (row.kind === 'nca_section' || row.kind === 'nca_dir') return '▤';
  if (row.kind === 'nca_dir') return '▤';
  if (row.kind === 'nca_locked') return '🔒';
  if (row.kind === 'linked_dir') return '▤';
  if (row.kind === 'directory' || row.kind === 'zipdir') return '▤';
  if (row.category === 'animation') return '▶';
  if (row.category === 'texture') return '▧';
  if (row.category === 'model' || row.category === 'mesh') return '◇';
  if (row.kind === 'gfpak' || row.kind === 'zip') return '▣';
  return '▯';
}

function nxHighlightTree(row) {
  if (nxSelectedTree) nxSelectedTree.classList.remove('nx-selected');
  const node = row ? nxTreeItems.get(row.id) : null;
  nxSelectedTree = node?.line || null;
  if (nxSelectedTree) nxSelectedTree.classList.add('nx-selected');
}

function nxAddTreeNode(row, depth, lineage, target) {
  if (!row || !row.id) return;
  const node = document.createElement('div');
  node.className = 'nx-tree-node';
  node.setAttribute('role', 'treeitem');
  const expanded = !!row.expandable && depth === 0;
  if (row.expandable) node.setAttribute('aria-expanded', String(expanded));
  const line = document.createElement('div');
  line.className = 'nx-tree-line';
  line.style.paddingLeft = (7 + depth * 15) + 'px';
  line.dataset.node = row.id;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nx-tree-toggle';
  toggle.textContent = row.expandable ? (expanded ? '▾' : '▸') : '';
  toggle.disabled = !row.expandable;
  toggle.setAttribute('aria-label', row.expandable ? 'Expand or collapse ' + row.name : 'File');
  const icon = document.createElement('span');
  icon.className = 'nx-node-icon nx-node-' + row.kind;
  icon.textContent = nxTreeIcon(row);
  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'nx-tree-name';
  label.textContent = row.name;
  label.title = row.name;
  const children = document.createElement('div');
  children.className = 'nx-tree-children';
  children.setAttribute('role', 'group');
  children.hidden = !expanded;
  line.append(toggle, icon, label);
  node.append(line, children);
  target.append(node);
  nxTreeItems.set(row.id, {row, node, line, toggle, children, expanded, loaded: false});
  nxTreePaths.set(row.id, [...lineage, row]);

  toggle.addEventListener('click', event => {
    event.stopPropagation();
    nxToggleTree(row).catch(error => showNotice(error.message || String(error), true));
  });
  label.addEventListener('click', event => {
    event.stopPropagation();
    nxHighlightTree(row);
    if (row.expandable) {
      select(row);
      nxNavigateTree(row).catch(error => showNotice(error.message || String(error), true));
    } else {
      select(row);
    }
  });
  label.addEventListener('dblclick', event => {
    event.stopPropagation();
    if (row.expandable) {
      nxToggleTree(row).catch(error => showNotice(error.message || String(error), true));
    } else if (canPreview(row)) {
      preview(row);
    }
  });
  label.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight' && row.expandable) {
      event.preventDefault();
      nxToggleTree(row, true).catch(error => showNotice(error.message || String(error), true));
    }
    if (event.key === 'ArrowLeft' && row.expandable) {
      event.preventDefault();
      nxToggleTree(row, false).catch(error => showNotice(error.message || String(error), true));
    }
  });
}

function nxPopulateChildren(row, listing) {
  const node = nxTreeItems.get(row.id);
  if (!node) return;
  node.children.replaceChildren();
  const ancestry = nxTreePaths.get(row.id) || [row];
  for (const child of listing.entries || []) {
    nxAddTreeNode(child, ancestry.length, ancestry, node.children);
  }
  node.loaded = true;
  if (row.kind === 'nsp' && listing.pagination && listing.pagination.total > 250) {
    const hint = document.createElement('div');
    hint.className = 'nx-tree-more';
    hint.textContent = 'More package entries: use Search and Next →';
    node.children.append(hint);
  }
}

function nxResetTree(root, listing) {
  nxTreeItems.clear();
  nxTreeListings.clear();
  nxTreePaths.clear();
  nxSelectedTree = null;
  const target = id('assetTree');
  target.replaceChildren();
  if (!root) {
    target.textContent = 'Open a package or folder to start browsing.';
    id('nxTreeStatus').textContent = 'No source loaded';
    return;
  }
  nxTreeListings.set(root.id, listing);
  nxAddTreeNode(root, 0, [], target);
  nxPopulateChildren(root, listing);
  nxHighlightTree(root);
  id('nxTreeStatus').textContent =
    (listing.entries || []).length + ' items at this location';
}

async function nxToggleTree(row, force = null) {
  const view = nxTreeItems.get(row.id);
  if (!view || !row.expandable) return;
  const expanded = force === null ? !view.expanded : !!force;
  if (expanded && !view.loaded) {
    view.toggle.textContent = '⋯';
    if (row.kind === 'nspfile') {
      showNotice('Reading NCA section headers directly with the built-in reader.');
    } else if (row.kind === 'nca_section') {
      showNotice('Opening the ' + row.name + ' filesystem index, without bulk extraction…');
    }
    try {
      const listing = nxTreeListings.get(row.id) || await api.browse_children(row.id);
      nxTreeListings.set(row.id, listing);
      nxPopulateChildren(row, listing);
      if (listing.note) showNotice(listing.note);
    } catch (error) {
      view.toggle.textContent = '▸';
      throw error;
    }
  }
  view.expanded = expanded;
  view.children.hidden = !expanded;
  view.toggle.textContent = expanded ? '▾' : '▸';
  view.node.setAttribute('aria-expanded', String(expanded));
}

async function nxNavigateTree(row) {
  const lineage = nxTreePaths.get(row.id) || [row];
  const stack = [];
  for (const node of lineage) {
    const listing = nxTreeListings.get(node.id) || await api.browse_children(node.id);
    nxTreeListings.set(node.id, listing);
    stack.push({root: node, listing});
  }
  pathStack = stack;
  scanListing = null;
  renderListing();
  nxHighlightTree(row);
  select(row); // Keep chosen NCA selected after its child listing loads.
  id('nxTreeStatus').textContent = row.name + ' · ' +
    (stack.at(-1)?.listing.entries || []).length + ' visible items';
}

async function nxRevealExistingBranch(row) {
  const path = nxTreePaths.get(row.id);
  if (!path) return;
  for (const parent of path.slice(0, -1)) {
    const view = nxTreeItems.get(parent.id);
    if (view && !view.expanded) await nxToggleTree(parent, true);
  }
  nxHighlightTree(row);
}

async function nxLoadDetails(row) {
  const revision = ++nxDetailRevision;
  const properties = id('assetFileMetadata');
  const hex = id('assetGeneralHex');
  const thumbnail = id('assetThumbnail');
  const signature = id('assetSignature');
  properties.replaceChildren();
  hex.hidden = true;
  hex.textContent = '';
  thumbnail.hidden = true;
  thumbnail.removeAttribute('src');
  signature.textContent = '';
  id('assetFamily').hidden = true;
  if (!row) return;
  let info;
  try {
    info = await api.browse_item_details(row.id);
  } catch (error) {
    if (revision === nxDetailRevision) signature.textContent = String(error.message || error);
    return;
  }
  if (revision !== nxDetailRevision || selected?.id !== row.id) return;
  const entries = [
    ['Type', info.category || info.kind],
    ['Size', formatSize(info.size)],
    ['Container / location', info.location],
    ...(info.hash ? [['Resource hash', info.hash]] : []),
    ...(info.compression !== undefined ? [['Compression', String(info.compression)]] : []),
  ];
  for (const [term, value] of entries) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = term;
    dd.textContent = value;
    properties.append(dt, dd);
  }
  signature.textContent = (info.signature || '') +
    (info.notes?.length ? ' · ' + info.notes.join(' · ') : '');
  if (info.thumbnail) {
    thumbnail.src = info.thumbnail;
    thumbnail.hidden = false;
  }
  if (api?.browse_asset_family) {
    try {
      const family = await api.browse_asset_family(row.id);
      if (revision === nxDetailRevision && selected?.id === row.id && family?.asset_id) {
        id('assetFamily').hidden = false;
        id('assetFamilyId').textContent = family.asset_id;
        const counts = id('assetFamilyCounts');
        counts.replaceChildren();
        for (const [kind, count] of Object.entries(family.counts || {})) {
          const chip = document.createElement('span');
          chip.textContent = kind + ': ' + count;
          counts.append(chip);
        }
        const files = id('assetFamilyFiles');
        files.replaceChildren();
        for (const asset of (family.files || []).slice(0, 12)) {
          const item = document.createElement('div');
          item.textContent = asset.kind + ' · ' + asset.path.split(/[/\\]/).at(-1);
          item.title = asset.path;
          files.append(item);
        }
        id('assetFamily').title = family.note || '';
      }
    } catch (error) { /* Asset relationship hints are optional. */ }
  }
  if (info.hex_lines?.length && row.kind !== 'nspfile') {
    hex.textContent = info.hex_lines.map(line =>
      line.offset.toString(16).padStart(8, '0') + '   ' +
      line.hex.padEnd(47, ' ') + '  |' + line.ascii + '|'
    ).join('\n');
    hex.hidden = false;
  }
}

function select(row) {
  selected = row;
  id('assetSelected').textContent = row?.name || 'Nothing selected';
  const type = categories[row?.category] || row?.category || 'Select an asset';
  id('assetSelectedInfo').textContent = row
    ? type + ' • ' + formatSize(row.size) +
      (row.relative ? '\n' + row.relative : '') +
      (row.kind === 'nspfile' && row.format === 'Encrypted NCA' ? '\nEncrypted NCA contents cannot be decoded here.' : '')
    : 'Select an asset to inspect or preview it.';
  id('assetPreview').disabled = !canPreview(row);
  id('assetPreview').textContent = canPreview(row) ? '◈ Preview in 3D' : 'Preview unavailable for this resource';
  id('assetSaveFile').disabled = !row || !['file', 'zipfile', 'gfpak_resource', 'nspfile', 'nca_file'].includes(row.kind);
  id('assetAttachNCA').disabled = !(row?.kind === 'nspfile' && /\.nca$/i.test(row.name));
  showNSPSelection(row).catch(error => showNotice(error.message || String(error), true));
  nxLoadDetails(row).catch(error => showNotice(error.message || String(error), true));
}

function renderRows(rows) {
  current = rows;
  const needle = id('assetSearch').value.trim().toLowerCase();
  const filter = id('assetCategory').value;
  const visible = pathStack.at(-1)?.root.kind === 'nsp'
    ? rows
    : rows.filter(row => {
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

async function loadNSPPage(page = 0) {
  if (!activeNSP) return;
  const root = activeNSP;
  const revision = ++nspPageRevision;
  try {
    const listing = await api.browse_nsp_page(
      root.id, page, id('assetSearch').value, id('assetCategory').value
    );
    if (revision !== nspPageRevision || activeNSP?.id !== root.id) return;
    const currentNode = pathStack.at(-1);
    if (currentNode?.root.id !== root.id) return;
    currentNode.listing = listing;
    renderListing();
  } catch (error) { showNotice(error.message || String(error), true); }
}

function scheduleNSPSearch() {
  if (nspSearchTimeout) window.clearTimeout(nspSearchTimeout);
  nspSearchTimeout = window.setTimeout(() => loadNSPPage(0), 170);
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
    if (activeNSP?.id !== node.root.id) {
      loadNSPDashboard(node.root).catch(error => showNotice(error.message || String(error), true));
    }
    const page = node.listing.pagination;
    id('nspPager').hidden = !page;
    if (page) {
      id('nspPagerLabel').textContent = page.total
        ? 'Files ' + page.first.toLocaleString() + '–' + page.last.toLocaleString() +
          ' of ' + page.total.toLocaleString() + ' · Page ' +
          (page.page + 1) + ' / ' + page.pages
        : 'No matching NSP entries';
      id('nspPrev').disabled = page.page <= 0;
      id('nspNext').disabled = page.page + 1 >= page.pages;
    }
  } else {
    activeNSP = null;
    ++nspPageRevision;
    id('nspPager').hidden = true;
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
    nxTreeListings.set(row.id, listing);
    if (nxTreeItems.has(row.id)) {
      nxPopulateChildren(row, listing);
      const item = nxTreeItems.get(row.id);
      item.expanded = true;
      item.children.hidden = false;
      item.toggle.textContent = '▾';
      item.node.setAttribute('aria-expanded', 'true');
      nxRevealExistingBranch(row).catch(() => {});
    }
    renderListing();
  } catch (error) { showNotice(error.message || String(error), true); }
}

function updateGameCompatibility(result) {
  const filenames = [result.root?.name || '', result.directory || '',
                     ...(result.children?.entries || []).slice(0, 30).map(row => row.name)];
  const detected = detectGameFromNames(filenames);
  const support = gameCapabilities(detected.id);
  id('assetGameProfile').hidden = false;
  id('assetGameName').textContent = detected.id === 'auto'
    ? 'Game unknown · engine detection pending' : detected.name;
  id('assetGameEngine').textContent = detected.engine || 'Unidentified engine';
  id('assetGameSupport').textContent =
    'Models: ' + support.models + ' · Textures: ' + support.textures +
    ' · Animations: ' + support.animations;
}

async function openSource(mode) {
  try {
    showNotice('Opening selected files…');
    const result = await api.browse_choose(mode);
    if (!result) return;
    updateGameCompatibility(result);
    scanListing = null;
    activeNSP = null;
    pathStack = [{root: result.root, listing: result.children}];
    nxResetTree(result.root, result.children);
    id('assetAttach').disabled = result.root.kind !== 'nsp';
    id('ncaReaderBar').hidden = result.root.kind !== 'nsp';
    if (result.root.kind === 'nsp') refreshNCAReader();
    id('assetSearch').value = '';
    id('assetCategory').value = 'all';
    id('assetScan').disabled = mode !== 'folder';
    id('assetScanSummary').textContent = 'Browse directories or scan extracted files for model, texture and animation references.';
    renderListing();
  } catch (error) { showNotice(error.message || String(error), true); }
}

async function nxSaveSelectedFile() {
  if (!selected) return;
  const row = selected;
  if (row.kind === 'nspfile') {
    await startNSPTask('extract', row);
    return;
  }
  try {
    const result = await api.browse_save_item(row.id);
    if (result) showNotice('Saved: ' + result);
  } catch (error) { showNotice(error.message || String(error), true); }
}

async function nxAttachToSelectedNCA() {
  const row = selected;
  if (row?.kind !== 'nspfile' || !/\.nca$/i.test(row.name)) {
    showNotice('Select an NCA entry in the left tree first.', true);
    return;
  }
  try {
    showNotice('Choose an existing extracted folder for this NCA.');
    const result = await api.browse_attach_extracted_nca(row.id);
    if (!result) return;
    nxTreeListings.set(row.id, result.children);
    const view = nxTreeItems.get(row.id);
    if (view) {
      nxPopulateChildren(row, result.children);
      view.expanded = true;
      view.children.hidden = false;
      view.toggle.textContent = '▾';
      view.node.setAttribute('aria-expanded', 'true');
    }
    showNotice('Linked an existing extraction beneath ' + row.name +
      '. Expand Extracted files (linked) to browse actual folders.');
    await nxNavigateTree(row);
  } catch (error) {
    showNotice(error.message || String(error), true);
  }
}

async function nxAttachExtractedFolder() {
  try {
    const attached = await api.browse_attach_extracted();
    if (!attached) return;
    activeNSP = null;
    scanListing = null;
    pathStack = [{root: attached.root, listing: attached.children}];
    nxResetTree(attached.root, attached.children);
    renderListing();
    showNotice('Existing extracted directory linked under the NSP. Expand the folder in the tree to browse its files.');
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
  id('assetAttach').addEventListener('click', nxAttachExtractedFolder);
  id('assetAttachNCA').addEventListener('click', nxAttachToSelectedNCA);
  id('ncaSelectKeyset').addEventListener('click', () => selectNCASetting('keyset'));
  id('assetOpenFile').addEventListener('click', () => openSource('file'));
  id('assetBack').addEventListener('click', () => {
    if (scanListing) scanListing = null;
    else if (pathStack.length > 1) pathStack.pop();
    renderListing();
  });
  id('assetSearch').addEventListener('input', () => {
    if (pathStack.at(-1)?.root.kind === 'nsp') scheduleNSPSearch();
    else renderRows(current);
  });
  id('assetCategory').addEventListener('change', () => {
    if (pathStack.at(-1)?.root.kind === 'nsp') loadNSPPage(0);
    else renderRows(current);
  });
  id('nspPrev').addEventListener('click', () => {
    const page = pathStack.at(-1)?.listing.pagination;
    if (page && page.page > 0) loadNSPPage(page.page - 1);
  });
  id('nspNext').addEventListener('click', () => {
    const page = pathStack.at(-1)?.listing.pagination;
    if (page && page.page + 1 < page.pages) loadNSPPage(page.page + 1);
  });
  id('assetPreview').addEventListener('click', () => preview());
  id('assetSaveFile').addEventListener('click', nxSaveSelectedFile);
  id('assetScan').addEventListener('click', scanFolder);
  const menuActions = {
    nxMenuOpenPackage: () => id('assetOpenFile').click(),
    nxMenuOpenFolder: () => id('assetOpenFolder').click(),
    nxMenuLinkFolder: () => id('assetAttach').click(),
    nxMenuFocusTree: () => id('assetTree').querySelector('.nx-tree-name')?.focus(),
    nxMenuClearSearch: () => {
      id('assetSearch').value = '';
      id('assetCategory').value = 'all';
      if (pathStack.at(-1)?.root.kind === 'nsp') loadNSPPage(0);
      else renderRows(current);
    },
    nxMenuScan: () => id('assetScan').click(),
    nxMenuHash: () => id('nspAudit').click(),
    nxMenuManifest: () => id('nspManifest').click(),
    nxMenuAbout: () => showNotice(
      'NX-style file tree with native GFPAK/ZIP and outer NSP inspection. ' +
      'GFPAK-OPEN includes its own NCA3 and RomFS reader: expand an NCA to browse compatible sections. ' +
      'Encrypted content requires compatible local keys; patch formats may be unsupported.'
    )
  };
  for (const [name, action] of Object.entries(menuActions)) {
    id(name).addEventListener('click', () => {
      for (const menu of document.querySelectorAll('.nx-fileviewer .nx-menu')) menu.open = false;
      action();
    });
  }

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
  id('nspReadHex').addEventListener('click', () =>
    readHexDump().catch(error => showNotice(error.message || String(error), true)));
  id('nspCancel').addEventListener('click', () =>
    api.browse_nsp_cancel_task().catch(error => showNotice(error.message || String(error), true)));

}

window.addEventListener('pywebviewready', initialize);
if (window.pywebview?.api) initialize();
