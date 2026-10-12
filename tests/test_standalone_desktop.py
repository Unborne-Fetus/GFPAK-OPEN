"""Desktop startup and source streaming require no external model application."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from gfpak_open.desktop_backend import DesktopAPI

class StandaloneDesktopTests(unittest.TestCase):
    def test_ready_offline_and_streams_selected_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            model = root / 'pm0025_00_00.obj'
            model.write_text('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
            with patch('gfpak_open.desktop_backend.settings_path', return_value=root / 'settings.json'):
                api = DesktopAPI()
                try:
                    with patch('subprocess.run', side_effect=AssertionError('External application launched')):
                        status = api.setup_status()
                        self.assertEqual(status['setup']['state'], 'ready')
                        self.assertNotIn('blender', status)
                        api.sources = [model]
                        manifest, = api.source_previews()
                        self.assertEqual(manifest['selected'], model.name)
                        token, index = manifest['items'][0]['url'].split('/')[-2:]
                        size, chunks = api.quick_preview_stream(token, int(index))
                        data = b''.join(chunks)
                        self.assertEqual(size, len(data))
                        self.assertEqual(data, model.read_bytes())
                finally:
                    api.close()

    def test_folder_keeps_cross_directory_companions_and_exports_selected_source(self):
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for directory in ('models', 'animations', 'textures'):
                (root / directory).mkdir()
            (root / 'models/pm0025.trmdl').write_bytes(b'model')
            (root / 'animations/pm0025_idle.tranm').write_bytes(b'clip')
            (root / 'textures/pm0025_body.bntx').write_bytes(b'texture')
            (root / 'textures/pm0026_body.bntx').write_bytes(b'other species')
            with patch('gfpak_open.desktop_backend.settings_path', return_value=root / 'config.json'):
                api = DesktopAPI()
                try:
                    api.sources = [root]
                    model, = api.source_models()['models']
                    manifest = api.source_preview(model['key'])
                    paths = {item['path'] for item in manifest['items']}
                    self.assertIn('pm0025_idle.tranm', paths)
                    self.assertIn('pm0025_body.bntx', paths)
                    self.assertNotIn('pm0026_body.bntx', paths)
                    self.assertEqual(manifest['exportKey'], model['key'])
                    target = root / 'pokemon.zip'
                    with patch.object(api, '_dialog', return_value=[str(target)]):
                        api.source_export_pokemon(model['key'])
                    with zipfile.ZipFile(target) as archive:
                        self.assertEqual(archive.read('pm0025_idle.tranm'), b'clip')
                        self.assertEqual(archive.read('pm0025_body.bntx'), b'texture')
                finally:
                    api.close()

    def test_large_inventory_is_lazy_and_invalid_input_does_not_abort_good_models(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(260):
                (root / ('model%04d.obj' % index)).write_bytes(b'model')
            with patch('gfpak_open.desktop_backend.settings_path', return_value=root / 'config.json'):
                api = DesktopAPI()
                try:
                    api.sources = [root / 'missing.gfpak', root]
                    result = api.source_models()
                    self.assertEqual(len(result['models']), 260)
                    self.assertEqual(len(result['errors']), 1)
                    self.assertFalse(api._quick_previews)
                    api.source_preview(result['models'][0]['key'])
                    self.assertEqual(len(api._quick_previews), 1)
                finally:
                    api.close()

    def test_gfpak_inventories_all_models_once_and_keeps_unknown_assets_in_zip(self):
        import zipfile
        from test_asset_browser import create_resolved_gfpak
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'pm0025_00_00.gfpak'
            create_resolved_gfpak(archive)
            with patch('gfpak_open.desktop_backend.settings_path', return_value=root / 'config.json'):
                api = DesktopAPI()
                try:
                    api.sources = [root]
                    model, = api.source_models()['models']
                    target = root / 'pokemon.zip'
                    with patch.object(api, '_dialog', return_value=[str(target)]):
                        api.source_export_pokemon(model['key'])
                    with zipfile.ZipFile(target) as exported:
                        self.assertEqual(len(exported.namelist()), 5)
                finally:
                    api.close()
