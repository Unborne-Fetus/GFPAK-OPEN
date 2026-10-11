"""Blender's Python packages must be supplied by GFPAK-OPEN, not Blender pip."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gfpak_open import blender_dependencies as dependencies


def fill_required(path):
    for name in dependencies.REQUIRED_PACKAGES:
        folder = path / name
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "__init__.py").write_text("# managed package", encoding="utf-8")


class BlenderDependencyTests(unittest.TestCase):
    def test_cache_reused_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "managed"
            fill_required(path)
            with patch.object(dependencies, "dependency_cache", return_value=path):
                with patch.object(dependencies.subprocess, "run") as pip:
                    self.assertEqual(dependencies.ensure_blender_dependencies(), path)
                    pip.assert_not_called()

    def test_first_launch_installs_outside_blender(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "managed"

            def fake_pip(command, **kwargs):
                self.assertIn("--target", command)
                self.assertIn("flatbuffers==25.2.10", command)
                self.assertIn("requests==2.32.5", command)
                fill_required(Path(command[command.index("--target") + 1]))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with patch.object(dependencies, "dependency_cache", return_value=folder):
                with patch.object(dependencies.subprocess, "run", side_effect=fake_pip):
                    self.assertEqual(dependencies.ensure_blender_dependencies(), folder)
            self.assertTrue(dependencies.has_dependencies(folder))

    def test_failure_does_not_leave_incomplete_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "managed"
            failed = SimpleNamespace(returncode=1, stdout="", stderr="network unavailable")
            with patch.object(dependencies, "dependency_cache", return_value=folder):
                with patch.object(dependencies.subprocess, "run", return_value=failed):
                    with self.assertRaisesRegex(RuntimeError, "network unavailable"):
                        dependencies.ensure_blender_dependencies()
            self.assertFalse(folder.exists())

    def test_frozen_build_must_supply_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bundled"
            with patch.object(dependencies.sys, "_MEIPASS", str(path), create=True):
                with patch.object(dependencies.sys, "frozen", True, create=True):
                    with patch.object(dependencies, "dependency_cache", return_value=Path(tmp) / "empty"):
                        with self.assertRaisesRegex(RuntimeError, "packaged"):
                            dependencies.ensure_blender_dependencies()

if __name__ == "__main__":
    unittest.main()
