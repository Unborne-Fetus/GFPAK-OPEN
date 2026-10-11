"""Read-only game file explorer tests with synthetic user-selected assets."""
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

from gfpak_open.asset_browser import AssetBrowser, classify, pfs0_entries


def create_gfpak(path):
    # One valid stored synthetic resource, following the existing core test layout.
    data = b"GFLXPACK" + struct.pack("<4I", 0x1000, 0, 1, 1)
    data += struct.pack("<QQQ", 88, 48, 56)
    data += struct.pack("<Q", 0x12345678)
    data += struct.pack("<QII", 0x99, 1, 0)
    data += struct.pack("<QII", 0xAB, 0, 0)
    data += struct.pack("<HHIIIII", 0, 0, 5, 5, 0, 112, 0)
    path.write_bytes(data + b"HELLO")


def create_pfs0(path):
    names = b"model.nca\0meta.cnmt.nca\0"
    first = struct.pack("<QQII", 0, 4, 0, 0)
    second = struct.pack("<QQII", 4, 3, len(b"model.nca\0"), 0)
    header = b"PFS0" + struct.pack("<III", 2, len(names), 0)
    path.write_bytes(header + first + second + names + b"AAAABBB")


class AssetBrowserTests(unittest.TestCase):
    def test_detect_models_animations_and_textures(self):
        cases = {
            "pm0025_00_00.gfpak": "model archive",
            "pm0025_00_00.trmdl": "model",
            "walking.tranm": "animation",
            "scene.gfbanm": "animation",
            "body.bntx": "texture",
            "body.png": "texture",
            "pm0025_00_00.trskl": "skeleton",
            "pm0025_00_00.trmtr": "material",
            "mystery_012343.bin": "other",
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(classify(name), expected)

    def test_folder_browse_and_recursive_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pokemon = root / "pokemon"
            pokemon.mkdir()
            (pokemon / "pm0025_00_00.trmdl").write_bytes(b"model")
            (pokemon / "pikachu_idle.tranm").write_bytes(b"animation")
            (pokemon / "pikachu.bntx").write_bytes(b"texture")
            browser = AssetBrowser()
            root_node = browser.open(root)
            initial = browser.children(root_node["id"])
            self.assertEqual(initial["entries"][0]["category"], "folder")
            detail = browser.children(initial["entries"][0]["id"])
            self.assertEqual(detail["counts"]["model"], 1)
            self.assertEqual(detail["counts"]["animation"], 1)
            self.assertEqual(detail["counts"]["texture"], 1)
            report = browser.scan()
            self.assertEqual(report["counts"]["model"], 1)
            self.assertEqual(report["counts"]["animation"], 1)
            self.assertEqual(report["counts"]["texture"], 1)
            model = next(e for e in detail["entries"] if e["category"] == "model")
            self.assertEqual(browser.preview_source(model["id"]).resolve(), (pokemon / "pm0025_00_00.trmdl").resolve())
            texture = next(e for e in detail["entries"] if e["category"] == "texture")
            with self.assertRaises(ValueError):
                browser.preview_source(texture["id"])
            with self.assertRaises(ValueError):
                browser.preview_source("random-untrusted-id")

    def test_archive_resource_inspection_is_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "pm0025_00_00.gfpak"
            create_gfpak(archive)
            browser = AssetBrowser()
            base = browser.open(archive)
            report = browser.children(base["id"])
            self.assertEqual(len(report["entries"]), 1)
            self.assertEqual(report["entries"][0]["category"], "unknown")
            self.assertEqual(browser.preview_source(base["id"]).resolve(), archive.resolve())
            self.assertTrue(archive.is_file())
            with self.assertRaises(ValueError):
                browser.preview_source(report["entries"][0]["id"])

    def test_zip_tree_rejects_traversal_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "models.zip"
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("../outside.trmdl", b"unsafe")
                z.writestr("pokemon/idle.tranm", b"animation")
                z.writestr("pokemon/body.png", b"texture")
            browser = AssetBrowser()
            root = browser.open(archive)
            top = browser.children(root["id"])
            self.assertEqual([e["name"] for e in top["entries"]], ["pokemon"])
            children = browser.children(top["entries"][0]["id"])
            self.assertEqual({e["category"] for e in children["entries"]},
                             {"animation", "texture"})

    def test_pfs0_nsp_shows_metadata_not_decrypted_game_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "game.nsp"
            create_pfs0(file)
            rows = pfs0_entries(file)
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["name"], "model.nca")
            self.assertEqual(rows[1]["offset"], 16 + 2 * 24 + len(b"model.nca\0meta.cnmt.nca\0") + 4)
            browser = AssetBrowser()
            node = browser.open(file)
            listing = browser.children(node["id"])
            self.assertEqual(listing["counts"]["encrypted container"], 2)
            self.assertIn("encrypted", listing["note"].lower())
            for entry in listing["entries"]:
                with self.assertRaises(ValueError):
                    browser.preview_source(entry["id"])

    def test_nsp_bad_bounds_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "bad.nsp"
            file.write_bytes(b"PFS0" + struct.pack("<III", 1, 3, 0) +
                             struct.pack("<QQII", 0, 99999, 0, 0) +
                             b"a\0x")
            with self.assertRaisesRegex(ValueError, "index entry"):
                pfs0_entries(file)


if __name__ == "__main__":
    unittest.main()
