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
