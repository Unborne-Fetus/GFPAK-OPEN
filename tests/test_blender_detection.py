"""Blender detection must not accept executable paths that are access denied."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gfpak_open.blender_detection import can_launch_blender


class BlenderDetectionTests(unittest.TestCase):
    def test_access_denied_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "blender.exe"
            path.write_bytes(b"fake")
            with patch("gfpak_open.blender_detection.subprocess.run",
                       side_effect=PermissionError(13, "Access is denied")):
                self.assertFalse(can_launch_blender(path))

    def test_valid_blender_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "blender.exe"
            path.write_bytes(b"fake")
            value = type("Result", (), {
                "returncode": 0, "stdout": "Blender 4.5.0\\nGFPAK_BLENDER_OK\\n"
            })()
            with patch("gfpak_open.blender_detection.subprocess.run", return_value=value):
                self.assertTrue(can_launch_blender(path))

    def test_missing_blender_path(self):
        self.assertFalse(can_launch_blender(""))

if __name__ == "__main__":
    unittest.main()
