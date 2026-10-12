import JSZip from 'jszip';
import {loadModel, exportGlb} from './model.js';

export function projectFromManifest(manifest) {
  return {
    label: manifest.label,
    items: manifest.items.filter(item => manifest.animations !== false || !/\.(tranm|gfbanm|tracm)$/i.test(item.path)).map(item => {
      let bytes;
      const getBytes = () => bytes ||= fetch(item.url, {cache:'no-store'}).then(response => {
        if (!response.ok) throw Error('Cannot read ' + item.path + ': HTTP ' + response.status);
        return response.arrayBuffer();
      });
      return {...item, getBytes, getText:async () => new TextDecoder().decode(await getBytes())};
    })
  };
}

export async function exportModelBatch(models, getManifest, report = () => {},
  decoder = loadModel, exporter = exportGlb) {
  if (!models.length) throw Error('Select models before exporting');
  const zip = new JSZip(), errors = [];
  let completed = 0;
  // Convert sequentially so a whole batch never holds decoded scenes in memory.
  for (const [index, model] of models.entries()) {
    let loaded;
    report('Exporting ' + (index + 1) + '/' + models.length + ': ' + model.name);
    try {
      const manifest = await getManifest(model.key);
      loaded = await decoder(projectFromManifest(manifest), manifest.selected, report);
      if (loaded.postLoad) await loaded.postLoad();
      const bytes = await exporter(loaded.root, loaded.animations);
      const name = String(model.name).split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
        .replace(/[<>:"|?*\x00-\x1f]/g, '_') || 'model';
      zip.file(String(index + 1).padStart(4,'0') + '_' + name + '.glb', bytes);
      completed++;
    } catch (error) {
      errors.push({model:model.name, error:error.message || String(error)});
    } finally {
      loaded?.disposeAssets?.();
      loaded?.root?.traverse(object => {
        object.geometry?.dispose();
        for (const material of [object.material].flat().filter(Boolean)) material.dispose();
      });
    }
  }
  zip.file('export-report.json', JSON.stringify({completed, failed:errors.length, errors}, null, 2));
  return {blob:await zip.generateAsync({type:'blob',compression:'DEFLATE'}), completed, errors};
}
