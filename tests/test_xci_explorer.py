"""Synthetic XCI/HFS0 structure tests. No Nintendo content or keys."""
import struct
import tempfile
import unittest
from pathlib import Path

from gfpak_open.xci_explorer import XCIImage, XCIPartition, read_hfs0
from gfpak_open.asset_browser import AssetBrowser


def hfs0(files):
    names = bytearray()
    records = bytearray()
    content = bytearray()
    for filename, payload in files:
        where = len(names)
        names += filename.encode() + b"\0"
        records += struct.pack("<QQIIQ", len(content), len(payload), where, 0, 0)
        records += b"\0" * 32
        content += payload
    header = b"HFS0" + struct.pack("<III", len(files), len(names), 0) + records + names
    return header + content


def make_xci(path: Path, *, bad_partition=False):
    program = bytearray(0xC00)
    program[0x200:0x204] = b"NCA3"
    # Real header is syntactically present but contains no sections here.
    secure = hfs0([("program.nca", bytes(program)),
                   ("other.txt", b"plain auxiliary metadata")])
    root = hfs0([("secure", secure), ("normal", hfs0([]))])
    header = bytearray(0x400)
    header[0x100:0x104] = b"HEAD"
    struct.pack_into("<QQ", header, 0x130, 0x400, len(root) - len(secure) - len(hfs0([])))
    path.write_bytes(header + root)
    if bad_partition:
        data = bytearray(path.read_bytes())
        # The secure entry intentionally references outside the root HFS0.
        struct.pack_into("<Q", data, 0x400 + 0x10 + 8, 2**60)
        path.write_bytes(data)


class XCIReaderTests(unittest.TestCase):
    def test_nested_hfs0_and_raw_extraction(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture.xci"
            make_xci(path)
            image = XCIImage(path)
            self.assertEqual([p.name for p in image.partitions], ["secure", "normal"])
            secure = image.open_partition("secure")
            self.assertEqual([r.name for r in secure.entries], ["program.nca", "other.txt"])
            self.assertEqual(secure.inspect(1)["hex_lines"][0]["ascii"][:5], "plain")
            exported = Path(tmp) / "out.txt"
            secure.export_raw(1, exported)
            self.assertEqual(exported.read_bytes(), b"plain auxiliary metadata")
            self.assertEqual(secure.summary()["files"], 2)
            with self.assertRaises(ValueError):
                image.open_partition("none")

    def test_asset_browser_exposes_nested_xci_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "game.xci"
            make_xci(path)
            browser = AssetBrowser()
            root = browser.open(path)
            self.assertTrue(root["expandable"])
            partitions = browser.children(root["id"])["entries"]
            self.assertEqual(partitions[0]["name"], "secure")
            secure = browser.children(partitions[0]["id"])["entries"]
            nca = secure[0]
            self.assertTrue(nca["expandable"])
            self.assertEqual(nca["category"], "encrypted container")
            inspected = browser.item_details(secure[1]["id"])
            self.assertIn("plain", inspected["hex_lines"][0]["ascii"])
            # File bytes are streamed from their nested XCI offsets.
            output = Path(tmp) / "export.bin"
            browser.export_item(secure[1]["id"], output)
            self.assertEqual(output.read_bytes(), b"plain auxiliary metadata")

    def test_two_partitions_do_not_share_nca_cache_or_virtual_nodes(self):
        """Same filename/index can occur in different gamecard partitions."""
        def nca_with_payload(value):
            filename = b"main\\0"
            body = (b"PFS0" + struct.pack("<III", 1, len(filename), 0)
                    + struct.pack("<QQII", 0, len(value), 0, 0)
                    + filename + value)
            body += b"\\0" * (-len(body) % 0x200)
            header = bytearray(0xC00)
            header[0x200:0x204] = b"NCA3"
            struct.pack_into("<II", header, 0x240, 6, 6 + len(body) // 0x200)
            header[0x400:0x402] = b"\\x02\\x00"
            header[0x402] = 2
            header[0x403] = 2
            header[0x404] = 1
            return bytes(header) + body

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            game = root / "multi.xci"
            secure = hfs0([("program.nca", nca_with_payload(b"from secure"))])
            normal = hfs0([("program.nca", nca_with_payload(b"from normal"))])
            index = hfs0([("secure", secure), ("normal", normal)])
            header = bytearray(0x400)
            header[0x100:0x104] = b"HEAD"
            struct.pack_into("<Q", header, 0x130, 0x400)
            game.write_bytes(header + index)
            browser = AssetBrowser(nca_workspace=root / "cache")
            root_node = browser.open(game)
            partitions = browser.children(root_node["id"])["entries"]
            ncas = [browser.children(p["id"])["entries"][0] for p in partitions]
            self.assertNotEqual(ncas[0]["id"], ncas[1]["id"])
            sections = [browser.children(nca["id"])["entries"][0] for nca in ncas]
            self.assertNotEqual(sections[0]["id"], sections[1]["id"])
            files = [browser.children(section["id"])["entries"][0] for section in sections]
            self.assertNotEqual(files[0]["id"], files[1]["id"])
            self.assertEqual(browser._nca_sections.preview_bytes(
                browser._nca_sources[files[0]["id"]], 0, 0, "main"), b"from secure")
            self.assertEqual(browser._nca_sections.preview_bytes(
                browser._nca_sources[files[1]["id"]], 0, 0, "main"), b"from normal")
            extracted = root / "linked"
            extracted.mkdir()
            browser.attach_extracted_nca(ncas[0]["id"], extracted)
            self.assertEqual(browser.children(ncas[0]["id"])["entries"][0]["name"],
                             "Extracted files (linked)")
            self.assertEqual(browser.children(ncas[1]["id"])["entries"][0]["name"],
                             "Section 0")

    def test_rejects_out_of_bounds(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.xci"
            make_xci(path, bad_partition=True)
            with self.assertRaisesRegex(ValueError, "exceeds"):
                XCIImage(path)
            path.write_bytes(b"WRONG" + b"\0" * 0x500)
            with self.assertRaisesRegex(ValueError, "HEAD"):
                XCIImage(path)

if __name__ == "__main__":
    unittest.main()
