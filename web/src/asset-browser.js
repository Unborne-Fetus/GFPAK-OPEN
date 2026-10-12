import { detectGameFromNames, gameCapabilities } from './game-support.js';
/** Desktop-only NX-style read-only archive and extracted-asset explorer. */
const id = name => document.getElementById(name);
let api;
let initialized = false;
let pathStack = [];
let current = [];
let selected = null;
let scanListing = null;
let assetCatalog = null;
let catalogBusy = false;
let catalogRevision = 0;
let assetClass = 'all';
const classKinds = {
  models: new Set(['model', 'model archive', 'mesh']),
  textures: new Set(['texture']),
  animations: new Set(['animation'])
};
function belongsToClass(row, group) {
  return group === 'all' || !!classKinds[group]?.has(row.category);
}
function selectAssetClass(group) {
  assetClass = group;
  for (const button of document.querySelectorAll('[data-asset-class]')) {
    const active = button.dataset.assetClass === group;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (group !== 'all') id('assetCategory').value = 'all';
  scanListing = group !== 'all' ? assetCatalog : null;
  if (pathStack.length) renderListing();
}
function setScanAvailability() {
  const root = pathStack.at(-1)?.root;
  const source = pathStack[0]?.root;
  const searchable = ['nca_section', 'nca_dir', 'nspfile', 'xci_partition']
    .includes(root?.kind) ||
    ['directory', 'gfpak', 'nsp', 'xci'].includes(source?.kind);
  id('assetScan').disabled = !searchable || catalogBusy;
}

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
  'compressed container': 'NCZ compressed NCA',
  unknown: 'Unidentified', metadata: 'Metadata', other: 'Other'
};

function showNotice(message, error = false) {
  id('assetNotice').textContent = message;
  id('assetNotice').classList.toggle('native-error', error);
}

function canInspectTexture(row) {
  return !!row && row.category === 'texture' &&
    ['file', 'zipfile', 'nca_file', 'gfpak_resource'].includes(row.kind) &&
    /\.(bntx|dds|png|jpe?g|webp)$/i.test(row.name);
}

function canPreview(row) {
  if (!row) return false;
  if (row.kind === 'gfpak') return true;
  if (row.kind === 'nca_file' && /\.(gfpak|trmdl|trmsh|gfbmdl|glb)$/i.test(row.name)) return true;
  if (row.kind === 'zipfile' && /\.(trmdl|trmsh|gfbmdl|glb|gltf|fbx|obj|dae)$/i.test(row.name)) return true;
  if (row.kind === 'gfpak_resource') return row.category === 'model';
  return row.kind === 'file' && /\.(glb|gltf|fbx|obj|dae|trmdl|trmsh|gfbmdl|gfpak)$/i.test(row.name);
}

function formatSize(n) {
  const value = Number(n) || 0;
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GiB';
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MiB';
  if (value >= 1024) return (value / 1024).toFixed(1) + ' KiB';
  return value + ' B';
}

function summary(counts = null) {
  // A directory listing is not a game inventory. Until a real scan finishes,
  // show an unknown count rather than the misleading "0" in each category.
  const unknown = catalogBusy ? '…' : '—';
  if (!counts) {
    for (const name of ['assetCountModel', 'assetCountTexture',
      'assetCountAnimation', 'assetCountOther', 'assetClassModels',
      'assetClassTextures', 'assetClassAnimations']) {
      id(name).textContent = unknown;
    }
    return;
  }
  const models = (counts.model || 0) + (counts['model archive'] || 0) +
    (counts.mesh || 0);
  const value = (name, count) => { id(name).textContent = count.toLocaleString(); };
  value('assetCountModel', models);
  value('assetCountAnimation', counts.animation || 0);
  value('assetCountTexture', counts.texture || 0);
  value('assetClassModels', models);
  value('assetClassTextures', counts.texture || 0);
  value('assetClassAnimations', counts.animation || 0);
  value('assetCountOther', Object.entries(counts).reduce(
    (n, [key, count]) => n + (!['model', 'mesh', 'model archive', 'animation',
      'texture', 'folder'].includes(key) ? count : 0), 0
  ));
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
  if (row.kind === 'nsp' || row.kind === 'xci' || row.kind === 'xci_partition') return '▣';
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

function nxAppendMoreControl(row, listing, view) {
  if (!listing?.next_cursor || !view) return;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'nx-tree-more nx-load-more';
  more.textContent = '＋ Load next 250 files…';
  more.setAttribute('aria-label', 'Load more files in ' + row.name);
  more.addEventListener('click', event => {
    event.stopPropagation();
    nxLoadMoreTree(row).catch(error => showNotice(error.message || String(error), true));
  });
  view.children.append(more);
}

async function nxLoadMoreTree(row) {
  const listing = nxTreeListings.get(row.id);
  const view = nxTreeItems.get(row.id);
  if (!listing?.next_cursor || view?.loadingMore) return;
  const cursor = listing.next_cursor;
  if (view) view.loadingMore = true;
  const previous = view?.children.querySelector('.nx-load-more');
  if (previous) {
    previous.disabled = true;
    previous.textContent = 'Loading the next 250 files…';
  }
  try {
    // Only the next metadata page is read, not the whole RomFS/NCA.
    const incoming = await api.browse_children(row.id, cursor);
    if (nxTreeListings.get(row.id) !== listing) return;
    if (incoming?.next_cursor === cursor) throw new Error('Directory cursor did not advance.');
    const known = new Set(listing.entries.map(item => item.id));
    const added = (incoming.entries || []).filter(item => !known.has(item.id));
    listing.entries.push(...added);
    listing.next_cursor = incoming.next_cursor || null;
    listing.truncated = Boolean(listing.next_cursor);
    for (const item of added) {
      const category = item.category || 'other';
      listing.counts[category] = (listing.counts[category] || 0) + 1;
    }
    if (view) {
      if (!view.loaded) {
        nxPopulateChildren(row, listing);
      } else {
        previous?.remove();
        const ancestry = nxTreePaths.get(row.id) || [row];
        for (const child of added) nxAddTreeNode(child, ancestry.length, ancestry, view.children);
        nxAppendMoreControl(row, listing, view);
      }
      view.expanded = true;
      view.children.hidden = false;
      view.toggle.textContent = '▾';
      view.node.setAttribute('aria-expanded', 'true');
    }
    if (pathStack.at(-1)?.root.id === row.id) {
      pathStack.at(-1).listing = listing;
      renderListing();
    }
    showNotice('Showing ' + listing.entries.length.toLocaleString() +
      ' files in this folder' + (listing.next_cursor ? ' · More pages available.' : ' · All entries loaded.'));
  } catch (error) {
    if (previous?.isConnected) {
      previous.disabled = false;
      previous.textContent = '＋ Retry loading more files';
    }
    throw error;
  } finally {
    if (view) view.loadingMore = false;
  }
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
  nxAppendMoreControl(row, listing, node);
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
    ...(info.packed_size !== undefined ? [['Stored bytes', formatSize(info.packed_size)]] : []),
    ...(info.offset !== undefined ? [['Archive offset', '0x' + Number(info.offset).toString(16).toUpperCase()]] : []),
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
      (row.kind === 'nspfile' && /\.nca$/i.test(row.name) ?
        '\nExpand this NCA to browse readable sections with the built-in reader.' : '')
    : 'Select an asset to inspect or preview it.';
  id('assetPreview').disabled = !canPreview(row) && !canInspectTexture(row);
  id('assetPreview').textContent = canPreview(row) ? '◈ Preview in 3D' :
    canInspectTexture(row) ? '▧ View texture' : 'Preview unavailable for this resource';
  id('assetSaveFile').disabled = !row || !['file', 'zipfile', 'gfpak_resource', 'nspfile', 'nca_file'].includes(row.kind);
  id('assetSavePacked').hidden = row?.kind !== 'gfpak_resource';
  id('assetSavePacked').disabled = row?.kind !== 'gfpak_resource';
  id('assetAttachNCA').disabled = !(row?.kind === 'nspfile' && /\.nca$/i.test(row.name));
  id('assetAttachBaseNCA').disabled = !(row?.kind === 'nspfile' && /\.(nca|ncz)$/i.test(row.name));
  showNSPSelection(row).catch(error => showNotice(error.message || String(error), true));
  nxLoadDetails(row).catch(error => showNotice(error.message || String(error), true));
}

function renderRows(rows) {
  current = rows;
  const needle = id('assetSearch').value.trim().toLowerCase();
  const filter = id('assetCategory').value;
  const visible = pathStack.at(-1)?.root.kind === 'nsp' && assetClass === 'all'
    ? rows
    : rows.filter(row => {
        return (!needle || (row.name + ' ' + (row.relative || '')).toLowerCase().includes(needle)) &&
          (filter === 'all' || row.category === filter) &&
          belongsToClass(row, assetClass);
      });
  const body = id('assetRows');
  body.replaceChildren();
  if (!visible.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'table-empty';
    cell.textContent = assetClass !== 'all' && !assetCatalog
      ? (catalogBusy ? 'Locating game assets…' :
          'Game inventory not ready. Select Locate assets to search beyond this folder.')
      : assetClass !== 'all' && assetCatalog?.truncated
        ? 'No matching asset in the partial scan. More files may exist; narrow to a readable section.'
        : 'No assets match this filter or directory.';
    row.append(cell);
    body.append(row);
    // A match may exist on a later NCA page. Keep Load more visible.
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
    button.textContent = item.expandable ? 'Open →' :
      canPreview(item) ? 'Preview ↗' : canInspectTexture(item) ? 'View texture ↗' : 'Details';
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (item.expandable) openNode(item);
      else if (canPreview(item)) preview(item);
      else if (canInspectTexture(item)) inspectTexture(item);
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
                         canPreview(item) ? preview(item) :
                         canInspectTexture(item) ? inspectTexture(item) : select(item));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (item.expandable) openNode(item);
        else if (canPreview(item)) preview(item);
        else if (canInspectTexture(item)) inspectTexture(item);
        else select(item);
      }
    });
    body.append(row);
  }
  const step = pathStack.at(-1);
  if (!scanListing && step?.listing?.next_cursor) {
    const moreRow = document.createElement('tr');
    moreRow.className = 'nx-pagination-row';
    const cell = document.createElement('td');
    cell.colSpan = 4;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'nx-pagination-button button button-secondary';
    more.textContent = '＋ Load next 250 entries (' +
      step.listing.entries.length.toLocaleString() + ' loaded)';
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = 'Reading next 250 entries…';
      try {
        await nxLoadMoreTree(step.root);
      } catch (error) {
        more.disabled = false;
        more.textContent = '＋ Retry loading more entries';
        showNotice(error.message || String(error), true);
      }
    });
    cell.append(more);
    moreRow.append(cell);
    body.append(moreRow);
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
  id('assetBreadcrumb').textContent = scanListing ? breadcrumbs + '  /  Asset catalog' : breadcrumbs;
  setScanAvailability();
  id('assetBack').disabled = pathStack.length <= 1 && !scanListing;
  summary(assetCatalog?.counts ?? null);
  if (scanListing) renderRows(scanListing.assets);
  else if (assetClass !== 'all') renderRows([]);
  else renderRows(node.listing.entries);
  const notice = scanListing
    ? (scanListing.note || 'Showing verified files discovered by the asset scanner.')
    : node.listing.note;
  id('assetClassHint').textContent = catalogBusy
    ? 'Discovering game assets in the background… Counts will appear when the scan completes.'
    : assetCatalog
      ? (assetCatalog.truncated ? 'Partial catalog: scan limit reached. ' : 'Catalog ready. ') +
        'Found assets are organized across the full scanned source; some files in locked NCAs or hashed GFPAKs may remain unidentified.'
      : 'These are game-wide totals, not counts from the current folder. Choose Locate assets to discover them.';
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
    ++catalogRevision;
    assetCatalog = null;
    scanListing = null;
    catalogBusy = false;
    activeNSP = null;
    pathStack = [{root: result.root, listing: result.children}];
    nxResetTree(result.root, result.children);
    id('assetAttach').disabled = result.root.kind !== 'nsp';
    const nativeArchive = ['nsp', 'xci'].includes(result.root.kind);
    id('ncaReaderBar').hidden = !nativeArchive;
    if (nativeArchive) refreshNCAReader();
    id('assetSearch').value = '';
    id('assetCategory').value = 'all';
    selectAssetClass('all');
    setScanAvailability();
    id('assetScanSummary').textContent = 'Game inventory has not been scanned.';
    renderListing();
    if (['directory', 'gfpak', 'nsp', 'xci'].includes(result.root.kind))
      void scanFolder(result.root.id, true);
  } catch (error) { showNotice(error.message || String(error), true); }
}

async function nxSaveSelectedFile(packed = false) {
  if (!selected) return;
  const row = selected;
  if (row.kind === 'nspfile') {
    await startNSPTask('extract', row);
    return;
  }
  try {
    const result = await api.browse_save_item(row.id, packed);
    if (result) showNotice('Saved: ' + result);
  } catch (error) { showNotice(error.message || String(error), true); }
}

async function nxAttachBaseNCA() {
  const row = selected;
  if (row?.kind !== 'nspfile' || !/\.(nca|ncz)$/i.test(row.name)) {
    showNotice('Select the update NCA entry in the tree first.', true);
    return;
  }
  try {
    const result = await api.browse_attach_base_nca(row.id);
    if (!result) return;
    // Refresh section nodes so a previously locked BKTR can be expanded.
    const refreshed = await api.browse_children(row.id);
    nxTreeListings.set(row.id, refreshed);
    const view = nxTreeItems.get(row.id);
    if (view) {
      nxPopulateChildren(row, refreshed);
      view.expanded = true;
      view.children.hidden = false;
      view.toggle.textContent = '▾';
      view.node.setAttribute('aria-expanded', 'true');
    }
    showNotice('Base NCA linked: ' + result.basename + ' (' +
      result.matching_sections + ' matching sections). Compatible plaintext BKTR files can now be browsed.');
    await nxNavigateTree(row);
  } catch (error) {
    showNotice(error.message || String(error), true);
  }
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

let previewInFlight = false;
async function inspectTexture(row = selected) {
  if (!canInspectTexture(row) || previewInFlight) return;
  previewInFlight = true;
  try {
    select(row);
    if (!api.browse_fast_texture || !window.gfpakFastTextureAvailable) {
      showNotice('Texture preview is not available in this desktop viewer.', true);
      return;
    }
    showNotice('Opening selected texture in the built-in preview…');
    const manifest = await api.browse_fast_texture(row.id);
    const result = await new Promise(resolve => {
      window.dispatchEvent(new CustomEvent('gfpak-fast-native-texture', {
        detail:{manifest,finish:(success,reason)=>resolve({success,reason})}
      }));
    });
    showNotice(result.success ? 'Texture ready for inspection and PNG export.' :
      'Texture preview unavailable: ' + result.reason, !result.success);
  } catch (error) { showNotice(error.message || String(error), true); }
  finally {
    previewInFlight = false;
    id('assetPreview').disabled = !canPreview(selected) && !canInspectTexture(selected);
  }
}

async function fastPreview(manifest) {
  // Wait for the viewer's async decoder, not just the DOM event dispatch.
  // Do not launch Blender if genuine native meshes loaded successfully.
  return new Promise(resolve => {
    let settled = false;
    const finish = (success, reason = '') => {
      if (settled) return;
      settled = true;
      resolve({success: !!success, reason});
    };
    window.dispatchEvent(new CustomEvent('gfpak-fast-native-preview', {
      detail: {manifest, finish}
    }));
    // If the viewer is not installed (e.g. older desktop builds), fall back.
    if (!window.gfpakFastPreviewAvailable) finish(false, 'Native viewer unavailable');
  });
}

async function preview(row = selected) {
  if (!canPreview(row) || previewInFlight) return;
  previewInFlight = true;
  id('assetPreview').disabled = true;
  try {
    select(row);
    const direct = (['gfpak', 'gfpak_resource'].includes(row.kind) ||
      (/\.(glb|gltf|fbx|obj|dae|trmdl|trmsh|gfbmdl)$/i.test(row.name) &&
       ['file', 'zipfile', 'nca_file'].includes(row.kind)));
    if (direct && typeof api.browse_fast_preview === 'function') {
      try {
        showNotice('Fast preview: reading only the selected model and matching companions…');
        const manifest = await api.browse_fast_preview(row.id);
        const outcome = await fastPreview(manifest);
        if (outcome.success) {
          showNotice('Native 3D preview loaded without Blender or temporary conversion.');
          return;
        }
        showNotice('Native decoder unavailable (' + outcome.reason +
          '); trying Blender only for this unsupported model.');
      } catch (error) {
        showNotice('Fast preview unavailable (' + (error.message || error) +
          '); trying the existing converter.');
      }
    }
    showNotice('Preparing fallback 3D preview with the local converter…');
    const started = await api.preview_browser_item(row.id);
    if (started !== false) window.dispatchEvent(new CustomEvent('gfpak-native-conversion-started'));
    else showNotice('A conversion is already running.', true);
  } catch (error) { showNotice(error.message || String(error), true); }
  finally {
    previewInFlight = false;
    id('assetPreview').disabled = !canPreview(selected) && !canInspectTexture(selected);
  }
}

async function scanFolder(requested = null, automatic = false) {
  const origin = pathStack[0]?.root;
  const target = requested ? origin :
    pathStack.at(-1)?.root || origin;
  if (!target || catalogBusy) return;
  const useId = ['nca_section', 'nca_dir', 'gfpak', 'nsp', 'xci',
    'nspfile', 'xci_partition'].includes(target.kind);
  if (!useId && origin?.kind !== 'directory') {
    showNotice('Open a game package, GFPAK, folder, or readable RomFS.', true);
    return;
  }
  const revision = ++catalogRevision;
  catalogBusy = true;
  summary(null);
  setScanAvailability();
  id('assetScanSummary').textContent = 'Finding models, textures and animations throughout ' +
    (useId ? target.name : origin.name) + '…';
  try {
    const started = await api.browse_start_scan(useId ? target.id : null);
    if (!started) {
      catalogBusy = false;
      setScanAvailability();
      id('assetScanSummary').textContent = 'A scan is already in progress. Please retry shortly.';
      return;
    }
    const poll = async () => {
      if (revision !== catalogRevision) return;
      try {
        const status = await api.browse_scan_status();
        if (revision !== catalogRevision) return;
        if (status.running) {
          window.setTimeout(poll, 450);
          return;
        }
        catalogBusy = false;
        setScanAvailability();
        if (status.error) {
          id('assetScanSummary').textContent = 'Discovery failed: ' + status.error;
          showNotice(status.error, true);
          summary(null);
          return;
        }
        if (!status.result) {
          summary(null);
          return;
        }
        assetCatalog = status.result;
        scanListing = assetClass !== 'all' ? assetCatalog : null;
        const counts = assetCatalog.counts || {};
        const located = ['model','model archive','mesh','texture','animation']
          .reduce((n, key) => n + (counts[key] || 0), 0);
        const warnings = assetCatalog.warnings || [];
        id('assetScanSummary').textContent =
          located.toLocaleString() + ' recognizable assets across ' +
          (assetCatalog.scanned || 0).toLocaleString() + ' scanned entries' +
          (assetCatalog.truncated ? ' (partial scan)' : '') +
          (warnings.length ? '. ' + warnings.length + ' inaccessible/unsupported areas.' : '') +
          (assetCatalog.note ? ' ' + assetCatalog.note : '');
        renderListing();
        if (!automatic && assetClass === 'all' && located > 0)
          selectAssetClass('models');
      } catch (error) {
        if (revision !== catalogRevision) return;
        catalogBusy = false;
        setScanAvailability();
        id('assetScanSummary').textContent = String(error.message || error);
        showNotice(error.message || String(error), true);
      }
    };
    void poll();
  } catch (error) {
    if (revision !== catalogRevision) return;
    catalogBusy = false;
    setScanAvailability();
    id('assetScanSummary').textContent = String(error.message || error);
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
  id('assetAttachBaseNCA').addEventListener('click', nxAttachBaseNCA);
  id('ncaSelectKeyset').addEventListener('click', () => selectNCASetting('keyset'));
  id('assetOpenFile').addEventListener('click', () => openSource('file'));
  id('assetBack').addEventListener('click', () => {
    if (scanListing) selectAssetClass('all');
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
  id('assetPreview').addEventListener('click', () =>
    canInspectTexture(selected) ? inspectTexture() : preview());
  id('assetSaveFile').addEventListener('click', () => nxSaveSelectedFile());
  id('assetSavePacked').addEventListener('click', () => nxSaveSelectedFile(true));
  id('assetScan').addEventListener('click', () => scanFolder());
  for (const button of document.querySelectorAll('[data-asset-class]')) {
    button.addEventListener('click', () => selectAssetClass(button.dataset.assetClass));
  }
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
