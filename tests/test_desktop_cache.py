"""Session-only generated model cache and explicit Save GLB regression tests."""
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gfpak_open.desktop_backend import DesktopAPI


def sample_glb(path):
    scene = {"asset": {"version": "2.0"},
             "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}]}
    body = json.dumps(scene).encode("utf-8")
    body += b" " * (-len(body) % 4)
    header = b"glTF" + struct.pack("<II", 2, len(body) + 20)
    path.write_bytes(header + struct.pack("<II", len(body), 0x4E4F534A) + body)


class TemporaryPreviewTests(unittest.TestCase):
    def test_conversion_cache_removed_when_next_preview_begins_and_at_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = root / "source.glb"
            sample_glb(original)
            with patch("gfpak_open.desktop_backend.settings_path", return_value=root / "config.json"):
                studio = DesktopAPI()
                try:
                    self.assertTrue(studio._begin_conversion([original]))
                    studio._worker.join(timeout=3)
                    first = studio.conversion_status()
                    self.assertFalse(first["running"])
                    self.assertEqual(len(first["completed"]), 1)
                    key = first["completed"][0]["key"]
                    preview = studio.output_file(key)
                    self.assertTrue(preview.exists())
                    self.assertNotEqual(preview, original)
                    with patch.object(studio, "_dialog", return_value=[str(root / "saved.glb")]):
                        saved = studio.save_cached_model(key)
                    self.assertTrue(Path(saved).is_file())
                    self.assertTrue(studio._begin_conversion([original]))
                    self.assertFalse(preview.exists())
                    studio._worker.join(timeout=3)
                    second = studio.conversion_status()["completed"][0]["key"]
                    second_path = studio.output_file(second)
                    self.assertTrue(second_path.exists())
                    with self.assertRaisesRegex(ValueError, "expired"):
                        studio.save_cached_model(key)
                finally:
                    studio.close()
                self.assertFalse(second_path.exists())
                self.assertTrue(original.exists())
                self.assertTrue((root / "saved.glb").exists())

    def test_output_key_cannot_fetch_arbitrary_local_files(self):
        with patch("gfpak_open.desktop_backend.settings_path",
                   return_value=Path(tempfile.gettempdir()) / "gfpak-test-config-missing.json"):
            studio = DesktopAPI()
            try:
                self.assertIsNone(studio.output_file("outside-file"))
            finally:
                studio.close()


if __name__ == "__main__":
    unittest.main()
