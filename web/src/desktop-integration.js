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
  byId('nativeDecoderStatus').textContent = '✓ Built-in model, texture, skeleton and animation decoders ready';
  lastSettings = info.settings;
  byId('nativeSources').textContent = info.sources.length
    ? info.sources.map(v => v.split(/[\\/]/).pop()).join(' • ')
    : 'No native conversion sources selected.';
  byId('nativeConvert').disabled = !info.sources.length || polling;
}

async function initialize() {
  if (!window.pywebview?.api) return;
  if (initialized) return;
  initialized = true;
  api = window.pywebview.api;
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
  byId('nativeChoose').addEventListener('click', async () => {
    try { await api.select_sources('files'); await refreshSetup(); }
    catch (e) { notice(e.message, true); }
  });
  byId('nativeFolder').addEventListener('click', async () => {
    try { await api.select_sources('folder'); await refreshSetup(); }
    catch (e) { notice(e.message, true); }
  });
  byId('nativeConvert').addEventListener('click', async () => {
    try {
      const manifests = await api.source_previews();
      if (!manifests.length) throw Error('No supported model sources found');
      byId('nativeResults').replaceChildren();
      for (const manifest of manifests) {
        const button = document.createElement('button');
        button.className = 'button button-secondary';
        button.textContent = 'Preview ' + manifest.label;
        const open = () => new Promise((resolve, reject) => {
          document.getElementById('tabViewer').click();
          window.dispatchEvent(new CustomEvent('gfpak-fast-native-preview', {
            detail: {manifest, finish: (success, reason) => success ? resolve() : reject(Error(reason))}
          }));
          if (!window.gfpakFastPreviewAvailable) reject(Error('Native viewer unavailable'));
        });
        button.addEventListener('click', () => open().catch(e => notice(e.message, true)));
        byId('nativeResults').append(button);
        if (manifests.length === 1) await open();
      }
      notice('Preview ready. Use Export GLB in the 3D viewer to save the model with compatible animations and textures.');
    } catch (e) {
      polling = false;
      notice(e.message, true);
      await refreshSetup();
    }
  });
}

window.addEventListener('pywebviewready', () => initialize().catch(e => notice(e.message, true)));
if (window.pywebview?.api) initialize().catch(e => notice(e.message, true));
