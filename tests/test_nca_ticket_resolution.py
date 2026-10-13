"""Synthetic tests for bounded common-ticket matching in NSP game archives."""
import json
import struct
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from gfpak_open.nca_native import Keyset, NativeNCA, inspect_nca3_entry
from gfpak_open.nsp_explorer import NSPAnalyzer

RIGHTS = bytes.fromhex("00112233445566778899aabbccddeeff")
TITLEKEK = bytes.fromhex("102132435465768798a9babbdcddedef")
CONTENT = bytes.fromhex("ffeeccbbaa9988776655443322110011")


def encrypt_key(key, value):
    cipher = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return cipher.update(value) + cipher.finalize()


def nca():
    raw = bytearray(0xE00)
    raw[0x200:0x204] = b"NCA3"
    raw[0x206] = 2
    raw[0x220] = 8  # master key revision 07
    raw[0x230:0x240] = RIGHTS
    struct.pack_into("<II", raw, 0x240, 6, 7)
    raw[0x400:0x402] = b"\x02\x00"
    raw[0x404] = 3  # AES-CTR
    return bytes(raw)


def ticket(rights=RIGHTS, key_type=0, revision=7):
    raw = bytearray(0x400)
    raw[:4] = (0x010004).to_bytes(4, "big")
    raw[0x140+0x140] = 2
    raw[0x140+0x141] = key_type
    raw[0x140+0x145] = revision
    raw[0x140+0x160:0x140+0x170] = rights
    raw[0x140+0x40:0x140+0x50] = encrypt_key(TITLEKEK, CONTENT)
    return bytes(raw)


def package(path, members):
    names = b""
    records = b""
    data = b""
    for name, payload in members:
        name_at = len(names)
        names += name.encode("utf-8") + b"\0"
        records += struct.pack("<QQII", len(data), len(payload), name_at, 0)
        data += payload
    path.write_bytes(
        b"PFS0" + struct.pack("<III", len(members), len(names), 0) + records + names + data
    )


class TicketResolutionTests(unittest.TestCase):
    def test_common_ticket_auto_matches_and_decrypts_with_local_titlekek(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            path = folder / "game.nsp"
            package(path, [
                ("unrelated.tik", ticket(bytes.fromhex("11" * 16))),
                ("program.nca", nca()), ("match.tik", ticket()),
            ])
            prod = folder / "prod.keys"
            prod.write_text("titlekek_07 = " + TITLEKEK.hex() + "\n")
            analyzer = NSPAnalyzer(path)
            keys = Keyset(prod)
            reader = NativeNCA(analyzer, 1, keys)
            self.assertEqual(reader.sections[0].key, CONTENT)
            report = inspect_nca3_entry(analyzer, 1, keys)
            self.assertEqual(report["content_key_source"], "package-ticket")
            self.assertEqual(report["content_key_status"], "resolved-unverified")
            self.assertEqual(report["package_ticket_entries"], 2)
            serialized = json.dumps(report)
            self.assertNotIn(RIGHTS.hex(), serialized)
            self.assertNotIn(CONTENT.hex(), serialized)
            self.assertNotIn(TITLEKEK.hex(), serialized)

    def test_titlekeys_are_decrypted_with_revision_titlekek(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            path = folder / "game.nsp"
            package(path, [("program.nca", nca())])
            prod = folder / "prod.keys"
            prod.write_text("titlekek_07 = " + TITLEKEK.hex() + "\n")
            titles = folder / "title.keys"
            titles.write_text(RIGHTS.hex() + " = " +
                              encrypt_key(TITLEKEK, CONTENT).hex() + "\n")
            reader = NativeNCA(NSPAnalyzer(path), 0, Keyset(prod, titles))
            self.assertEqual(reader.sections[0].key, CONTENT)

    def test_personalized_ticket_is_reported_not_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "game.nsp"
            package(path, [("program.nca", nca()), ("match.tik", ticket(key_type=1))])
            report = inspect_nca3_entry(NSPAnalyzer(path), 0, Keyset(None))
            self.assertEqual(report["content_key_source"], "package-ticket")
            self.assertEqual(report["content_key_status"], "personalized-ticket-unsupported")

    def test_missing_titlekek_is_explicit(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "game.nsp"
            package(path, [("program.nca", nca()), ("match.tik", ticket())])
            report = inspect_nca3_entry(NSPAnalyzer(path), 0, Keyset(None))
            self.assertEqual(report["content_key_status"],
                             "titlekek-unavailable-revision-07")

    def test_no_matching_key_or_ticket_is_explicit(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "game.nsp"
            package(path, [("program.nca", nca()),
                           ("unrelated.tik", ticket(bytes.fromhex("11" * 16)))])
            report = inspect_nca3_entry(NSPAnalyzer(path), 0, Keyset(None))
            self.assertEqual(report["content_key_status"],
                             "no-matching-titlekey-or-package-ticket")
            self.assertEqual(report["package_ticket_entries"], 1)


if __name__ == "__main__":
    unittest.main()
