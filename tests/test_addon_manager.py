"""Synthetic add-on installer tests: no network or Blender installation required."""
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from gfpak_open import addon_manager as installer

def archive_bytes():
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name in ("__init__.py", "gfbmdl_import.py", "gfbanm_importer.py"):
            archive.writestr("Pokemon-Switch-Model-Importer-Blender-main/" + name, "# test")
    return data.getvalue()

class ImporterSetupTests(unittest.TestCase):
    def test_reuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            for name in ("__init__.py", "gfbmdl_import.py", "gfbanm_importer.py"):
                (target / name).write_text("# test")
            with patch.object(installer.urllib.request, "urlopen") as download:
                self.assertEqual(installer.ensure_addon(target), str(target.resolve()))
                download.assert_not_called()

    def test_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "addon"
            with patch.object(installer, "managed_addon", return_value=target):
                with patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(archive_bytes())):
                    self.assertEqual(installer.ensure_addon(), str(target))
            self.assertTrue(installer.is_addon(target))

if __name__ == "__main__":
    unittest.main()
