import {exportModelBatch} from './native-batch.js';
/** Native desktop integration. The hosted web app does not expose these tools. */
const byId = name => document.getElementById(name);
let api;
let polling = false;
let models = [];
let initialized = false;

function notice(message, error = false) {
  const status = byId('nativeProgress');
  status.textContent = message;
  status.classList.toggle('native-error', error);
}

async function refreshSetup() {
  if (!api) return;
  const info = await api.setup_status();
  byId('nativeDecoderStatus').textContent = '✓ Built-in model, texture, skeleton and animation decoders ready';
  byId('nativeSources').textContent = info.sources.length
    ? info.sources.map(v => v.split(/[\\/]/).pop()).join(' • ')
    : 'No native conversion sources selected.';
  byId('nativeAnimations').checked = info.animations !== false;
  for (const key of ['hashes', 'textures']) byId('native' + key[0].toUpperCase() + key.slice(1)).value = info.settings?.[key] || '';
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
  byId('nativeAnimations').addEventListener('change', () => api.set_options({animations:byId('nativeAnimations').checked}));
  document.querySelectorAll('[data-native-pick]').forEach(button => button.addEventListener('click', async () => {
    try { await api.select_option(button.dataset.nativePick); await refreshSetup(); }
    catch(error) {notice(error.message,true);}
  }));
  document.querySelectorAll('[data-native-clear]').forEach(button => button.addEventListener('click', async () => {
    await api.set_options({[button.dataset.nativeClear]:''}); await refreshSetup();
  }));
  byId('nativeConvert').addEventListener('click', async () => {
    try {
      polling = true;
      byId('nativeBatchExport').disabled = true;
      await refreshSetup();
      notice('Scanning all selected models and their companions…');
      const inventory = await api.source_models();
      models = inventory.models;
      byId('nativeResults').replaceChildren();
      byId('nativeLog').replaceChildren();
      for (const error of inventory.errors) {
        const line = document.createElement('div');
        line.textContent = error;
        line.className = 'native-error';
        byId('nativeLog').append(line);
      }
      if (!models.length) throw Error(inventory.errors.join('\n') || 'No supported model sources found');
      for (const model of models) {
        const button = document.createElement('button');
        button.className = 'button button-secondary';
        button.textContent = 'Preview ' + model.name;
        const open = async () => {
          const manifest = await api.source_preview(model.key);
          return new Promise((resolve, reject) => {
            document.getElementById('tabViewer').click();
            window.dispatchEvent(new CustomEvent('gfpak-fast-native-preview', {
              detail: {manifest, finish: (success, reason) => success ? resolve() : reject(Error(reason))}
            }));
            if (!window.gfpakFastPreviewAvailable) reject(Error('Native viewer unavailable'));
          });
        };
        button.addEventListener('click', () => open().catch(e => notice(e.message, true)));
        byId('nativeResults').append(button);
        if (models.length === 1) await open();
      }
      byId('nativeBatchExport').disabled = false;
      notice('Preview ready. Use Export GLB in the 3D viewer to save the model with compatible animations and textures.');
    } catch (e) {
      polling = false;
      notice(e.message, true);
      await refreshSetup();
    } finally {
      polling = false;
      await refreshSetup();
    }
  });
  byId('nativeBatchExport').addEventListener('click', async () => {
    byId('nativeBatchExport').disabled = true;
    polling = true;
    await refreshSetup();
    try {
      const result = await exportModelBatch(models, key => api.source_preview(key), message => notice(message));
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'converted-models.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      notice(result.completed + ' models exported. ' + result.errors.length + ' failed; see export-report.json in the ZIP.', !!result.errors.length);
    } catch (error) { notice(error.message, true); }
    finally { polling = false; await refreshSetup(); byId('nativeBatchExport').disabled = !models.length; }
  });
}

window.addEventListener('pywebviewready', () => initialize().catch(e => notice(e.message, true)));
if (window.pywebview?.api) initialize().catch(e => notice(e.message, true));
