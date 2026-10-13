"""Test diagnostics on the exact tree nodes shown after an NCA unlocks.

Uses synthetic PFS0 and NCA headers; no Nintendo/game keys are needed.
"""
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from gfpak_open.asset_browser import AssetBrowser
from gfpak_open.desktop_backend import DesktopAPI


def create_test_nsp(path):
    nca = bytearray(0xE00)
    nca[0x200:0x204] = b"NCA3"
    nca[0x206] = 2
    struct.pack_into("<II", nca, 0x240, 6, 7)
    nca[0x400:0x402] = b"\x02\x00"
    nca[0x402] = 0  # RomFS
    nca[0x403] = 3  # IVFC
    nca[0x404] = 1  # Unencrypted data for this synthetic fixture.
    nca[0x408:0x40C] = b"IVFC"
    struct.pack_into("<I", nca, 0x414, 7)
    struct.pack_into("<QQ", nca, 0x490, 0x100, 0x80)
    name = b"synthetic.nca\x00"
    path.write_bytes(
        b"PFS0" + struct.pack("<III", 1, len(name), 0)
        + struct.pack("<QQII", 0, len(nca), 0, 0) + name + nca
    )


class SelectedNCADiagnosticTests(unittest.TestCase):
    def test_section_and_nested_nodes_generate_their_containing_nca_report(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "test.nsp"
            create_test_nsp(source)
            browser = AssetBrowser(nca_workspace=base / "workspace")
            root = browser.open(source)
            archive = browser.children(root["id"])["entries"][0]
            section = browser.children(archive["id"])["entries"][0]
            self.assertEqual(section["kind"], "nca_section")
            # Mimic selected nested descendants even when the RomFS cannot open.
            nested = browser._node(
                "nca_dir", source,
                inner=section["id"] + ":0:0:folder", name="folder"
            )
            file_node = browser._node(
                "nca_file", source,
                inner=nested["id"] + ":0:0:file", name="file"
            )
            api = SimpleNamespace(_lock=threading.RLock(), _browser=browser)
            for node_id in (archive["id"], section["id"], nested["id"], file_node["id"]):
                report = DesktopAPI.browse_nca_diagnostics(api, node_id)
                self.assertIn("Archive: synthetic.nca", report)
                self.assertIn("Header inspection:", report)
                self.assertIn("filesystem_header_probes", report)
                self.assertNotIn("keys:", report.lower().split("production keys recognized")[0])
            section_report = DesktopAPI.browse_nca_diagnostics(api, section["id"])
            self.assertIn("Selected section: 0", section_report)

    def test_other_files_cannot_be_mistaken_for_nca_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "test.nsp"
            create_test_nsp(source)
            browser = AssetBrowser(nca_workspace=base / "workspace")
            root = browser.open(source)
            api = SimpleNamespace(_lock=threading.RLock(), _browser=browser)
            with self.assertRaises(ValueError):
                DesktopAPI.browse_nca_diagnostics(api, root["id"])


if __name__ == "__main__":
    unittest.main()
