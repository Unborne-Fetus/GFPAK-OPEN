/** Native desktop integration. The hosted web app does not expose these tools. */
const byId = name => document.getElementById(name);
let api;
let seen = 0;
let displayed = new Set();
let polling = false;
let lastSettings = null;

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
  for (const message of status.messages.slice(seen)) notice(message, message.startsWith('Failed '));
  seen = status.messages.length;
  for (const item of status.completed) {
    if (displayed.has(item.url)) continue;
    displayed.add(item.url);
    const button = document.createElement('button');
    button.className = 'button button-secondary';
    button.textContent = 'Preview ' + item.name + ' in 3D ↗';
    button.addEventListener('click', () => readConvertedGlb(item).catch(e => notice(e.message, true)));
    byId('nativeResults').append(button);
    // One completed model opens automatically in the existing model viewport.
    if (status.completed.length === 1 && !status.running)
      readConvertedGlb(item).catch(e => notice(e.message, true));
  }
  if (!status.running) {
    polling = false;
    if (status.error) notice(status.error, true);
    else if (status.completed.length) notice('Conversion finished. Select a result to preview or export.');
    await refreshSetup();
    return;
  }
  window.setTimeout(() => pollConversion().catch(e => notice(e.message, true)), 600);
}

async function initialize() {
  if (!window.pywebview?.api) return;
  api = window.pywebview.api;
  byId('desktopTools').hidden = false;
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
      seen = 0;
      displayed = new Set();
      byId('nativeResults').replaceChildren();
      polling = true;
      byId('nativeConvert').disabled = true;
      notice('Converting native model with Blender…');
      await pollConversion();
    } catch (e) {
      polling = false;
      notice(e.message, true);
      await refreshSetup();
    }
  });
}

window.addEventListener('pywebviewready', () => initialize().catch(e => notice(e.message, true)));
if (window.pywebview?.api) initialize().catch(e => notice(e.message, true));
