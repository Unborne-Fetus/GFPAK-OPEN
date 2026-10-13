"""Synthetic, key-safe regression tests for the NCA rights-ID diagnostics."""
import json
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from gfpak_open.nca_native import (
    Keyset, NativeNCA, NativeNCAError, decode_nca3_header,
    inspect_nca3_entry, inspect_nca3_header,
)


def nca3_header(rights: bytes = bytes(16), with_section: bool = True) -> bytes:
    raw = bytearray(0xC00)
    raw[0x200:0x204] = b"NCA3"
    raw[0x206] = 2
    raw[0x220] = 3
    raw[0x207] = 0
    raw[0x230:0x240] = rights
    if with_section:
        struct.pack_into("<II", raw, 0x240, 6, 7)
        raw[0x400:0x402] = b"\\x02\\x00"
        raw[0x404] = 3
    return bytes(raw)


class NCAHeaderDiagnosticsTests(unittest.TestCase):
    def test_shared_decoder_accepts_plaintext_nca3(self):
        header = nca3_header()
        decoded, plaintext, tweak = decode_nca3_header(header, Keyset(None))
        self.assertEqual(decoded, header)
        self.assertTrue(plaintext)
        self.assertEqual(tweak, "none")

    def test_shared_decoder_rejects_missing_header_key(self):
        with self.assertRaises(NativeNCAError):
            decode_nca3_header(bytes(0xC00), Keyset(None))

    def test_exact_title_key_lookup_and_metadata_are_safe(self):
        rights = bytes.fromhex("00112233445566778899aabbccddeeff")
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "title.keys"
            path.write_text(rights.hex() + " = " + "ab" * 16 + "\\n", encoding="utf-8")
            keys = Keyset(None, path)
            details = inspect_nca3_header(nca3_header(rights), keys)
        self.assertEqual(details["rights_id_key_match"], "exact-match")
        self.assertEqual(details["rights_id_header_offset"], "0x230")
        self.assertEqual(details["key_generation"], 3)
        self.assertEqual(details["sections"][0]["encryption_mode"], 3)
        dump = json.dumps(details)
        self.assertNotIn(rights.hex(), dump)
        self.assertNotIn("ab" * 16, dump)

    def test_reversed_entry_is_diagnosed_but_never_used_as_valid(self):
        rights = bytes.fromhex("00112233445566778899aabbccddeeff")
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "title.keys"
            path.write_text(rights[::-1].hex() + " = " + "cd" * 16 + "\\n", encoding="utf-8")
            details = inspect_nca3_header(nca3_header(rights), Keyset(None, path))
        self.assertEqual(details["rights_id_key_match"],
                         "byte-reversed-entry-only (not used for decryption)")

    def test_missing_and_rights_free_are_distinct(self):
        rights = bytes.fromhex("00112233445566778899aabbccddeeff")
        self.assertEqual(inspect_nca3_header(nca3_header(rights), Keyset(None))
                         ["rights_id_key_match"], "missing")
        self.assertEqual(inspect_nca3_header(nca3_header(), Keyset(None))
                         ["rights_id_key_match"], "not-rights-managed")

    def test_inspection_reads_only_header_for_large_declared_nca(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "small-fixture.nsp"
            path.write_bytes(nca3_header(with_section=False))
            entry = SimpleNamespace(
                name="large.nca", offset=0, size=4_610_588_672)
            analyzer = SimpleNamespace(path=path, get=lambda _: entry)
            info = inspect_nca3_entry(analyzer, 0, Keyset(None))
            self.assertEqual(info["nca_magic"], "NCA3")
            self.assertEqual(path.stat().st_size, 0xC00)

    def test_regular_reader_uses_same_header_decoder(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "sample.nsp"
            path.write_bytes(nca3_header(with_section=False))
            entry = SimpleNamespace(name="sample.nca", offset=0, size=0xC00)
            analyzer = SimpleNamespace(path=path, get=lambda _: entry)
            reader = NativeNCA(analyzer, 0, Keyset(None))
            self.assertTrue(reader.plaintext)
            self.assertEqual(reader.header_tweak, "none")
            self.assertEqual(reader.sections, {})


if __name__ == "__main__":
    unittest.main()
