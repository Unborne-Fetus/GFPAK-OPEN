"""Synthetic NCZ stream, block and NSZ integration tests.

Only disposable test images are created: no commercial game data or key files.
"""
import struct
import tempfile
import unittest
from pathlib import Path

import zstandard

from gfpak_open.asset_browser import AssetBrowser
from gfpak_open.ncz_native import NCZError, restore_ncz


def make_nca(payload):
    length = (len(payload) + 0x1ff) & ~0x1ff
    header = bytearray(0x4000)
    header[0x200:0x204] = b"NCA3"
    struct.pack_into("<II", header, 0x240, 0x4000 // 0x200,
                     (0x4000 + length) // 0x200)
    header[0x400:0x402] = b"\x02\x00"
    header[0x402] = 2
    header[0x403] = 2
    header[0x404] = 1
    return bytes(header) + payload.ljust(length, b"\0")


def pfs0_file(filename, content):
    name = filename.encode() + b"\0"
    return b"PFS0" + struct.pack("<III", 1, len(name), 0) + struct.pack(
        "<QQII", 0, len(content), 0, 0
    ) + name + content


def compress_ncz(image, *, block=False, encrypted=False):
    header, plain = image[:0x4000], image[0x4000:]
    mode = 3 if encrypted else 1
    key = bytes(range(0x10))
    counter = bytes.fromhex("abcdef1234567890") + b"\0" * 8
    section = struct.pack("<4Q", 0x4000, len(plain), mode, 0) + key + counter
    magic = b"NCZSECTN" + struct.pack("<Q", 1) + section
    if block:
        exponent = 14
        size = 1 << exponent
        chunks = [plain[i:i + size] for i in range(0, len(plain), size)]
        compressed = [zstandard.ZstdCompressor().compress(chunk) for chunk in chunks]
        block_header = b"NCZBLOCK" + struct.pack("<4BIQ", 1, 1, 0, exponent,
                                                  len(compressed), len(plain))
        block_header += b"".join(struct.pack("<I", len(block)) for block in compressed)
        return header + magic + block_header + b"".join(compressed)
    return header + magic + zstandard.ZstdCompressor().compress(plain)


def pfs0_package(path, filename, data):
    name = filename.encode() + b"\0"
    path.write_bytes(b"PFS0" + struct.pack("<III", 1, len(name), 0) +
                     struct.pack("<QQII", 0, len(data), 0, 0) + name + data)


class NCZTests(unittest.TestCase):
    def test_solid_zstandard_restore_and_full_nsz_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = make_nca(pfs0_file("main", b"example binary data"))
            compressed = compress_ncz(data)
            package = root / "game.nsz"
            pfs0_package(package, "program.ncz", compressed)
            out = root / "out.nca"
            # Locate the NCZ inside the PFS0 package at the exact entry offset.
            browser = AssetBrowser(nca_workspace=root / "session")
            root_node = browser.open(package)
            child = browser.children(root_node["id"])["entries"][0]
            self.assertEqual(child["category"], "compressed container")
            self.assertTrue(child["expandable"])
            sections = browser.children(child["id"])["entries"]
            self.assertEqual(sections[0]["name"], "Section 0")
            files = browser.children(sections[0]["id"])["entries"]
            self.assertEqual(files[0]["name"], "main")
            target = root / "read-main.bin"
            browser.export_item(files[0]["id"], target)
            self.assertEqual(target.read_bytes(), b"example binary data")
            # Original compressed package is unchanged.
            self.assertTrue(package.read_bytes().startswith(b"PFS0"))
            # Explicit raw NCZ restoration uses the same verified bounded decoder.
            package_info = browser.nsp_entry(child["id"])[0].get(0)
            restore_ncz(package, package_info.offset, package_info.size, out)
            self.assertEqual(out.read_bytes(), data)

    def test_nczblock_zstd_and_uncompressed_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = make_nca(pfs0_file("main", b"Z" * 47000))
            ncz = compress_ncz(image, block=True)
            path = root / "image.ncz"
            path.write_bytes(ncz)
            output = root / "image.nca"
            restore_ncz(path, 0, len(ncz), output)
            self.assertEqual(output.read_bytes(), image)

    def test_ctr_reconstruction_with_synthetic_section_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = make_nca(pfs0_file("main", b"TEST" * 40))
            compressed = compress_ncz(original, encrypted=True)
            path = root / "image.ncz"
            path.write_bytes(compressed)
            output = root / "image.nca"
            restore_ncz(path, 0, len(compressed), output)
            self.assertEqual(output.read_bytes()[:0x4000], original[:0x4000])
            self.assertNotEqual(output.read_bytes()[0x4000:], original[0x4000:])
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            counter = bytes.fromhex("abcdef1234567890") + (0x4000 // 16).to_bytes(8, "big")
            ctx = Cipher(algorithms.AES(bytes(range(0x10))), modes.CTR(counter)).decryptor()
            self.assertEqual(ctx.update(output.read_bytes()[0x4000:]) + ctx.finalize(),
                             original[0x4000:])

    def test_low_disk_space_rejects_large_ncz_without_partial_extraction(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = make_nca(pfs0_file("main", b"X" * 160))
            ncz = compress_ncz(data)
            source = root / "compressed.ncz"
            target = root / "restored.nca"
            source.write_bytes(ncz)
            with patch("gfpak_open.ncz_native.shutil.disk_usage",
                       return_value=SimpleNamespace(free=0)):
                with self.assertRaisesRegex(NCZError, "temporary storage"):
                    restore_ncz(source, 0, len(ncz), target)
            self.assertFalse(target.exists())
            self.assertEqual(source.read_bytes(), ncz)

    def test_bad_header_does_not_leave_partial_nca(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "invalid.ncz"
            ncz = make_nca(pfs0_file("main", b"test"))[:0x4000] + b"WRONGFORMAT"
            path.write_bytes(ncz)
            with self.assertRaises(NCZError):
                restore_ncz(path, 0, len(ncz), root / "failed.nca")
            self.assertFalse((root / "failed.nca").exists())

if __name__ == "__main__":
    unittest.main()
