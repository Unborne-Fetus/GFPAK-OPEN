import json
import struct
import tempfile
import unittest
from pathlib import Path

from gfpak_open.core import GFPak, GFPakError


class GFPakTests(unittest.TestCase):
    def make_archive(self, path: Path, *, corrupt=False):
        # Tiny synthetic GFLXPACK with one folder and one stored file.
        data = b"GFLXPACK" + struct.pack("<4I", 0x1000, 0, 1, 1)
        data += struct.pack("<QQQ", 88, 48, 56)
        data += struct.pack("<Q", 0x12345678)
        data += struct.pack("<QII", 0x99, 1, 0)
        data += struct.pack("<QII", 0xAB, 0, 0)
        data += struct.pack("<HHIIIII", 0, 0, 5, 5, 0, 112 if not corrupt else 5000, 0)
        data += b"HELLO"
        path.write_bytes(data)

    def test_parse_and_extract(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "sample.gfpak"
            self.make_archive(source)
            arc = GFPak(source)
            self.assertEqual(arc.summary()["file_count"], 1)
            self.assertEqual(arc.summary()["folder_count"], 1)
            self.assertEqual(arc.read_resource(arc.resources[0]), b"HELLO")
            paths = arc.extract(Path(temp) / "out")
            self.assertEqual(paths[0].read_bytes(), b"HELLO")
            report = Path(temp) / "report.json"
            arc.save_report(report)
            self.assertEqual(json.loads(report.read_text())["resources"][0]["file_hash"], "00000000000000ab")

    def test_bad_magic(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "bad.gfpak"
            source.write_bytes(b"NOT A GFPak")
            with self.assertRaises(GFPakError):
                GFPak(source)

    def test_bad_offset(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "bad.gfpak"
            self.make_archive(source, corrupt=True)
            with self.assertRaises(GFPakError):
                GFPak(source)

    def test_compression3_requires_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "sample.gfpak"
            self.make_archive(source)
            data = bytearray(source.read_bytes())
            struct.pack_into("<H", data, 90, 3)
            source.write_bytes(data)
            with self.assertRaisesRegex(GFPakError, "Oodle"):
                arc = GFPak(source)
                arc.read_resource(arc.resources[0])


if __name__ == "__main__":
    unittest.main()
