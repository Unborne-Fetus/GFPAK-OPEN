/** Native desktop integration. The hosted web app does not expose these tools. */
const byId = name => document.getElementById(name);
let api;
let seen = 0;
let displayed = new Set();
let polling = false;
let lastSettings = null;
let initialized = false;
let autoOpened = false;

function notice(message, error = false) {
  const status = byId('nativeProgress');
  status.textContent = message;
  status.classList.toggle('native-error', error);
}

async function refreshSetup() {
  if (!api) return;
  const info = await api.setup_status();
  byId('nativeBlenderStatus').textContent = info.blender
    ? '✓ Blender found automatically'
    : 'Blender not found — select blender.exe after installing Blender.';
  const state = info.setup.state;
  byId('nativeAddonStatus').textContent = info.addon
    ? '✓ Pokémon Switch importer ready'
    : state === 'checking' ? 'Downloading Pokémon Switch importer…'
    : 'Importer unavailable: ' + (info.setup.error || 'Check network connection');
  byId('nativeBlender').value = info.blender || '';
  byId('nativeAddon').value = info.addon || '';
  for (const name of ['hashes', 'oodle', 'textures']) {
    byId('native' + name[0].toUpperCase() + name.slice(1)).value = info.settings[name] || '';
  }
  if (!lastSettings) byId('nativeAnimations').checked = !!info.animations;
  lastSettings = info.settings;
  byId('nativeSources').textContent = info.sources.length
    ? info.sources.map(v => v.split(/[\\/]/).pop()).join(' • ')
    : 'No native conversion sources selected.';
  byId('nativeConvert').disabled = !info.blender || !info.addon || !info.sources.length || polling;
}

async function readConvertedGlb(item) {
  const response = await fetch(item.url, {cache: 'no-store'});
  if (!response.ok) throw Error('Could not open converted model in 3D viewer.');
  const file = new File([await response.blob()], item.name, {type:'model/gltf-binary'});
  window.dispatchEvent(new CustomEvent('gfpak-native-model', {detail: file}));
  document.getElementById('tabViewer').click();
}

async function pollConversion() {
  const status = await api.conversion_status();
  for (const message of status.messages.slice(seen)) {
    notice(message, message.startsWith('Failed '));
    const line = document.createElement('div');
    line.textContent = String(message);
    if (message.startsWith('Failed ')) line.className = 'native-error';
    byId('nativeLog').append(line);
    while (byId('nativeLog').childElementCount > 120) byId('nativeLog').firstElementChild.remove();
    byId('nativeLog').scrollTop = byId('nativeLog').scrollHeight;
  }
  seen = status.messages.length;
  for (const item of status.completed) {
    if (displayed.has(item.url)) continue;
    displayed.add(item.url);
    const group = document.createElement('div');
    group.className = 'native-result-row';
    const preview = document.createElement('button');
    preview.className = 'button button-secondary';
    preview.textContent = '◈ Preview ' + item.name;
    preview.addEventListener('click', () => readConvertedGlb(item).catch(e => notice(e.message, true)));
    const save = document.createElement('button');
    save.className = 'button button-secondary';
    save.textContent = '↓ Save GLB';
    save.addEventListener('click', async () => {
      try {
        const result = await api.save_cached_model(item.key);
        if (result) notice('Saved permanent GLB: ' + result);
      } catch (error) { notice(error.message || String(error), true); }
    });
    group.append(preview, save);
    byId('nativeResults').append(group);
  }
  if (!status.running) {
    polling = false;
    if (status.completed.length === 1 && !autoOpened) {
      autoOpened = true;
      readConvertedGlb(status.completed[0]).catch(error => notice(error.message, true));
    }
    if (status.error) notice(status.error, true);
    else if (status.completed.length) notice(
      'Preview ready. The converted GLB is temporary until you choose Save GLB.'
    );
    await refreshSetup();
    return;
  }
  window.setTimeout(() => pollConversion().catch(e => notice(e.message, true)), 600);
}

function beginPolling() {
  seen = 0;
  displayed = new Set();
  autoOpened = false;
  polling = true;
  byId('nativeResults').replaceChildren();
  byId('nativeLog').replaceChildren();
  byId('nativeConvert').disabled = true;
  notice('Preparing temporary Blender preview…');
  pollConversion().catch(error => {
    polling = false;
    notice(error.message || String(error), true);
    refreshSetup().catch(() => {});
  });
}

async function initialize() {
  if (!window.pywebview?.api) return;
  if (initialized) return;
  initialized = true;
  api = window.pywebview.api;
  window.addEventListener('gfpak-native-conversion-started', beginPolling);
  document.body.classList.add('desktop-app');
  byId('tabConverter').hidden = false;
  const converter = byId('desktopTools');
  converter.hidden = true;
  const tabConverter = byId('tabConverter');
  tabConverter.addEventListener('click', () => {
    byId('viewerPanel').hidden = true;
    byId('archivePanel').hidden = true;
    converter.hidden = false;
    for (const id of ['tabViewer', 'tabArchive', 'tabConverter']) {
      const button = byId(id);
      const active = id === 'tabConverter';
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
  });
  for (const id of ['tabViewer', 'tabArchive']) {
    byId(id).addEventListener('click', () => {
      converter.hidden = true;
      tabConverter.classList.remove('active');
      tabConverter.setAttribute('aria-selected', 'false');
    });
  }
  document.querySelector('.top-context').textContent = 'POKÉMON 3D / DESKTOP STUDIO';
  await refreshSetup();
  // Installer runs in a desktop worker; status updates do not block the viewer.
  const waitForSetup = async () => {
    if (polling) return;
    try {
      const result = await api.setup_status();
      await refreshSetup();
      if (result.setup.state === 'checking')
        window.setTimeout(waitForSetup, 1500);
    } catch (e) { notice(e.message, true); }
  };
  waitForSetup();
  byId('nativeChoose').addEventListener('click', async () => {
    try { await api.select_sources('files'); await refreshSetup(); }
    catch (e) { notice(e.message, true); }
  });
  byId('nativeFolder').addEventListener('click', async () => {
    try { await api.select_sources('folder'); await refreshSetup(); }
    catch (e) { notice(e.message, true); }
  });
  document.querySelectorAll('[data-native-pick]').forEach(button => {
    button.addEventListener('click', async () => {
      try { await api.select_option(button.dataset.nativePick); await refreshSetup(); }
      catch (e) { notice(e.message, true); }
    });
  });
  byId('nativeRetryAddon').addEventListener('click', async () => {
    await api.retry_addon();
    await refreshSetup();
    waitForSetup();
  });
  byId('nativeAnimations').addEventListener('change', async () => {
    await api.set_options({animations: byId('nativeAnimations').checked});
  });
  byId('nativeConvert').addEventListener('click', async () => {
    try {
      await api.set_options({animations: byId('nativeAnimations').checked});
      if (!await api.start_conversion()) return;
      beginPolling();
    } catch (e) {
      polling = false;
      notice(e.message, true);
      await refreshSetup();
    }
  });
}

window.addEventListener('pywebviewready', () => initialize().catch(e => notice(e.message, true)));
if (window.pywebview?.api) initialize().catch(e => notice(e.message, true));
