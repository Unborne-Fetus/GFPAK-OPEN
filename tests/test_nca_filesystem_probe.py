"""Regression tests for bounded NCA filesystem decryption probes.

These fixtures contain entirely synthetic keys, plaintext, and encrypted data.
"""
import hashlib
import struct
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from gfpak_open.nca_native import Keyset, NativeNCA, inspect_nca3_entry
from gfpak_open.nsp_explorer import NSPAnalyzer

AREA = bytes.fromhex("00441122336655778899aabbccddeeff")
CONTENT = bytes.fromhex("deadbeef0123456789abcdef00112233")


def ecb_encrypt(key, raw):
    ctx = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return ctx.update(raw) + ctx.finalize()


def fake_nca(content_key=CONTENT):
    fs = bytearray(0x200)
    fs[:2] = b"\x02\x00"
    fs[2] = 0
    fs[3] = 3
    fs[4] = 3  # AES-CTR
    fs[8:12] = b"IVFC"
    struct.pack_into("<I", fs, 0x14, 7)
    # IVFC level 5 is the RomFS image.
    struct.pack_into("<QQ", fs, 0x90, 0x100, 0x180)
    fs[0x140:0x148] = bytes.fromhex("1122334455667788")

    header = bytearray(0xC00)
    header[0x200:0x204] = b"NCA3"
    header[0x206] = 2
    header[0x220] = 8
    struct.pack_into("<II", header, 0x240, 6, 8)
    header[0x400:0x600] = fs
    header[0x280:0x2A0] = hashlib.sha256(fs).digest()
    # No RightsId: derive 4 keys from the encrypted NCA key area.
    header[0x300:0x340] = ecb_encrypt(AREA, bytes(32) + content_key + bytes(16))

    section = bytearray(0x400)
    # Minimal but valid 0x50-byte RomFS header.
    struct.pack_into("<10Q", section, 0x100, 0x50, 0, 0, 0x50, 0x18,
                     0, 0, 0x68, 0, 0x70)
    raw_ctr = fs[0x140:0x148][::-1] + (0xC00 // 16).to_bytes(8, "big")
    ctx = Cipher(algorithms.AES(content_key), modes.CTR(raw_ctr)).encryptor()
    encrypted_section = ctx.update(bytes(section)) + ctx.finalize()
    return bytes(header) + encrypted_section


def package(path, nca):
    name = b"program.nca\x00"
    path.write_bytes(
        b"PFS0" + struct.pack("<III", 1, len(name), 0)
        + struct.pack("<QQII", 0, len(nca), 0, 0) + name + nca
    )


class NCAFilesystemProbeTests(unittest.TestCase):
    def test_valid_ctr_romfs_probe_and_section_header_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            p = folder / "fixture.nsp"
            package(p, fake_nca())
            keyfile = folder / "prod.keys"
            keyfile.write_text("nca_key_area_key_application_07 = " + AREA.hex() + "\n")
            keys = Keyset(keyfile)
            reader = NativeNCA(NSPAnalyzer(p), 0, keys)
            section = reader.sections[0]
            self.assertEqual(section.probe_filesystem_header()["status"],
                             "valid-romfs-header")
            report = inspect_nca3_entry(NSPAnalyzer(p), 0, keys)
            self.assertTrue(report["sections"][0]["section_header_sha256_valid"])
            self.assertNotIn("filesystem_header_probes", report)  # rights-free

    def test_wrong_area_key_is_flagged_as_bad_decrypted_romfs(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            p = folder / "fixture.nsp"
            package(p, fake_nca())
            keyfile = folder / "prod.keys"
            keyfile.write_text("nca_key_area_key_application_07 = " + bytes([0x99] * 16).hex() + "\n")
            reader = NativeNCA(NSPAnalyzer(p), 0, Keyset(keyfile))
            self.assertEqual(reader.sections[0].probe_filesystem_header()["status"],
                             "invalid-decoded-romfs-header")

    def test_probe_does_not_return_raw_decrypted_data(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            p = folder / "fixture.nsp"
            package(p, fake_nca())
            keyfile = folder / "prod.keys"
            keyfile.write_text("nca_key_area_key_application_07 = " + AREA.hex() + "\n")
            probe = NativeNCA(NSPAnalyzer(p), 0, Keyset(keyfile)).sections[0].probe_filesystem_header()
            self.assertEqual(set(probe), {"section", "encryption_mode", "filesystem", "status"})
            self.assertNotIn(CONTENT.hex(), str(probe))


if __name__ == "__main__":
    unittest.main()
