"""NSP analyzer fixtures use self-created PFS0 files with no game assets or keys."""
from __future__ import annotations

import hashlib
import json
import struct
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from gfpak_open.nsp_explorer import NSPAnalyzer, describe_entry
from gfpak_open.desktop_backend import DesktopAPI


def create_pfs0(path: Path, entries: list[tuple[str, bytes]]):
    names = bytearray()
    data = bytearray()
    table = bytearray()
    for name, content in entries:
        name_offset = len(names)
        names.extend(name.encode("utf-8") + b"\0")
        table.extend(struct.pack("<QQII", len(data), len(content), name_offset, 0))
        data.extend(content)
    path.write_bytes(b"PFS0" + struct.pack("<III", len(entries), len(names), 0)
                     + table + names + data)


class NSPAnalyzerTests(unittest.TestCase):
    def test_roles_and_streaming_hex(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "demo.nsp"
            create_pfs0(path, [
                ("a" * 32 + ".nca", b"abcdef"),
                ("b" * 32 + ".cnmt.nca", b"content"),
                ("license.tik", b"private-ticket-bytes"),
                ("license.cert", b"certificate"),
                ("cover.png", b"\x89PNG\r\n\x1a\n"),
                ("model.gfpak", b"GFLXPACK"),
            ])
            reader = NSPAnalyzer(path)
            report = reader.summary()
            self.assertEqual(report["files"], 6)
            self.assertEqual(report["formats"]["Encrypted NCA"], 2)
            self.assertEqual(report["content_ids"], 2)
            self.assertEqual(reader.inspect(4)["signature"], "PNG image")
            self.assertEqual(reader.inspect(5)["signature"], "GFLXPACK asset archive")
            self.assertEqual(reader.inspect(0, 3, 2)["hex_lines"][0]["hex"], "64 65")
            self.assertEqual(reader.inspect(2)["hex_lines"], [])
            self.assertIn("hidden", reader.inspect(2)["signature"])
            self.assertEqual(reader.get(1).role, "Content metadata NCA")
            self.assertEqual(reader.sha256(0)["sha256"], hashlib.sha256(b"abcdef").hexdigest())
            with self.assertRaisesRegex(ValueError, "outside"):
                reader.inspect(4, 99)
            with self.assertRaises(ValueError):
                reader.inspect(4, 0, 2000)

    def test_metadata_manifest_and_raw_export(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "sample.nsp"
            create_pfs0(source, [("a.nca", b"A" * (2 * 1024 * 1024 + 11)),
                                 ("note.json", b'{"ok":true}')])
            reader = NSPAnalyzer(source)
            progress = []
            digest = reader.sha256(0, progress=lambda done, total: progress.append(done))
            self.assertEqual(digest["bytes_hashed"], 2 * 1024 * 1024 + 11)
            self.assertGreater(len(progress), 1)
            output = root / "copied.nca"
            reader.export_raw(0, output)
            self.assertEqual(output.stat().st_size, 2 * 1024 * 1024 + 11)
            with self.assertRaises(FileExistsError):
                reader.export_raw(0, output)
            self.assertTrue(source.exists())
            inventory = root / "manifest.json"
            reader.write_manifest(inventory)
            parsed = json.loads(inventory.read_text())
            self.assertEqual(parsed["entries"][0]["role"], "Content archive NCA")
            self.assertEqual(parsed["summary"]["files"], 2)
            with self.assertRaises(FileExistsError):
                reader.write_manifest(inventory)

    def test_detect_overlapping_data_and_duplicate_names(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "overlap.nsp"
            create_pfs0(path, [("first.nca", b"AAAA"), ("first.nca", b"BBBB")])
            data = bytearray(path.read_bytes())
            struct.pack_into("<Q", data, 16 + 24, 2)
            path.write_bytes(data)
            warnings = NSPAnalyzer(path).summary()["warnings"]
            self.assertTrue(any("Duplicate" in s for s in warnings))
            self.assertTrue(any("overlaps" in s for s in warnings))

    def test_corrupt_index_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "bad.nsp"
            path.write_bytes(b"PFS0" + struct.pack("<III", 1, 100, 0))
            with self.assertRaisesRegex(ValueError, "table extends"):
                NSPAnalyzer(path)
            path.write_bytes(b"BAD!" + b"\0" * 128)
            with self.assertRaisesRegex(ValueError, "Not a standard"):
                NSPAnalyzer(path)

    def test_cancelled_extraction_cleans_partial_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pkg = root / "sample.nsp"
            create_pfs0(pkg, [("file.bin", b"X" * 4096)])
            target = root / "partial.bin"
            def stop(done, total):
                raise RuntimeError("Stop test")
            with self.assertRaisesRegex(RuntimeError, "Stop test"):
                NSPAnalyzer(pkg).export_raw(0, target, progress=stop)
            self.assertFalse(target.exists())

    def test_tickets_not_exposed_in_hex(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "sample.nsp"
            create_pfs0(path, [("license.tik", b"secret data")])
            preview = NSPAnalyzer(path).inspect(0)
            self.assertFalse(preview["hex_lines"])
            self.assertNotIn("secret", repr(preview))
            self.assertEqual(preview["sample_size"], 0)

    def test_file_type_classification(self):
        self.assertEqual(describe_entry("foo.cnmt.nca")[0], "Content metadata NCA")
        self.assertEqual(describe_entry("foo.nsz")[1], "Unsupported compressed content")
        self.assertEqual(describe_entry("control.xml")[1], "Text metadata")

    def test_bridge_hash_inspect_extract_and_report(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pkg = root / "demo.nsp"
            create_pfs0(pkg, [("abc.nca", b"ABCDEF"), ("art.png", b"\x89PNG\r\n\x1a\n")])
            with patch("gfpak_open.desktop_backend.settings_path",
                       return_value=root / "settings.json"):
                api = DesktopAPI()
                try:
                    with patch.object(api, "_dialog", return_value=[str(pkg)]):
                        browser = api.browse_choose("file")
                    root_id = browser["root"]["id"]
                    first = browser["children"]["entries"][0]
                    self.assertEqual(api.browse_nsp_summary(root_id)["files"], 2)
                    self.assertEqual(api.browse_nsp_inspect(first["id"])["sample_size"], 6)
                    self.assertTrue(api.browse_nsp_start_task("hash", first["id"]))
                    for _ in range(100):
                        if not api.browse_nsp_task_status()["running"]:
                            break
                        time.sleep(.01)
                    job = api.browse_nsp_task_status()
                    self.assertFalse(job["running"])
                    self.assertEqual(job["result"]["sha256"], hashlib.sha256(b"ABCDEF").hexdigest())
                    copy = root / "copy.nca"
                    with patch.object(api, "_dialog", return_value=[str(copy)]):
                        self.assertTrue(api.browse_nsp_start_task("extract", first["id"]))
                    for _ in range(100):
                        if not api.browse_nsp_task_status()["running"]:
                            break
                        time.sleep(.01)
                    self.assertEqual(copy.read_bytes(), b"ABCDEF")
                    manifest = root / "inventory.json"
                    with patch.object(api, "_dialog", return_value=[str(manifest)]):
                        api.browse_nsp_manifest(root_id)
                    self.assertEqual(json.loads(manifest.read_text())["summary"]["files"], 2)
                    self.assertEqual(pkg.read_bytes()[:4], b"PFS0")
                finally:
                    api.close()


if __name__ == "__main__":
    unittest.main()
