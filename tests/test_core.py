import json
import mmap
import sys
from types import SimpleNamespace
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from unittest.mock import patch

from gfpak_open.core import GFPak, GFPakError, find_oodle_dll


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

    def test_mapped_archive_can_index_oversized_resource_without_reading_it(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "huge.gfpak"
            self.make_archive(source)
            data = bytearray(source.read_bytes())
            huge = 513 * 1024 * 1024
            struct.pack_into("<II", data, 92, huge, huge)
            source.write_bytes(data)
            # A sparse on-disk fixture is huge logically but physically tiny.
            with source.open("r+b") as handle:
                handle.truncate(112 + huge)
            with GFPak(source) as archive:
                self.assertIsInstance(archive._bytes, mmap.mmap)
                resource = archive.resources[0]
                self.assertEqual(resource.size, huge)
                self.assertEqual(archive.summary()["unpacked_bytes"], huge)
                self.assertEqual(archive.peek_resource(resource, 12), (b"HELLO" + b"\\0" * 7, True))
                with self.assertRaisesRegex(GFPakError, "streaming"):
                    archive.read_resource(resource)

    def test_copy_resource_streams_and_refuses_overwrites(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "regular.gfpak"
            self.make_archive(source)
            with GFPak(source) as archive:
                resource = archive.resources[0]
                destination = Path(temp) / "out.bin"
                archive.copy_resource(resource, destination)
                self.assertEqual(destination.read_bytes(), b"HELLO")
                with self.assertRaises(FileExistsError):
                    archive.copy_resource(resource, destination)
                self.assertEqual(destination.read_bytes(), b"HELLO")
                packed = Path(temp) / "packed.bin"
                archive.copy_resource(resource, packed, packed=True)
                self.assertEqual(packed.read_bytes(), b"HELLO")

    def test_auto_detect_nearby_oodle_dll(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / "pm0025_00_00.gfpak"
            archive.write_bytes(b"archive placeholder")
            dll = Path(temp) / "oo2core_9_win64.dll"
            dll.write_bytes(b"test stub, not loaded")
            with patch.dict("os.environ", {"GFPAK_OODLE_DLL": ""}):
                self.assertEqual(find_oodle_dll(archive), dll.resolve())

    def test_explicit_oodle_path(self):
        with tempfile.TemporaryDirectory() as temp:
            dll = Path(temp) / "oo2core_9_win64.dll"
            dll.write_bytes(b"test stub, not loaded")
            with patch.dict("os.environ", {"GFPAK_OODLE_DLL": str(dll)}):
                self.assertEqual(find_oodle_dll(), dll.resolve())

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

    def test_compression3_open_source_backend(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "sample.gfpak"
            self.make_archive(source)
            data = bytearray(source.read_bytes())
            struct.pack_into("<H", data, 90, 3)
            source.write_bytes(data)
            archive = GFPak(source)
            engine = SimpleNamespace(decompress=lambda raw, size: b"HELLO")
            with patch.dict(sys.modules, {"ooz": engine}):
                self.assertEqual(archive.read_resource(archive.resources[0]), b"HELLO")

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
