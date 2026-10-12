"""Read-only game file explorer tests with synthetic user-selected assets."""
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

from gfpak_open.asset_browser import AssetBrowser, classify, pfs0_entries
from gfpak_open.converter import fnv1a64


def create_gfpak(path):
    # One valid stored synthetic resource, following the existing core test layout.
    data = b"GFLXPACK" + struct.pack("<4I", 0x1000, 0, 1, 1)
    data += struct.pack("<QQQ", 88, 48, 56)
    data += struct.pack("<Q", 0x12345678)
    data += struct.pack("<QII", 0x99, 1, 0)
    data += struct.pack("<QII", 0xAB, 0, 0)
    data += struct.pack("<HHIIIII", 0, 0, 5, 5, 0, 112, 0)
    path.write_bytes(data + b"HELLO")


def create_resolved_gfpak(path):
    """Synthetic model family with verified texture/animation references."""
    contents = [
        b"model description body.bntx\x00pikachu_idle.tranm\x00",
        b"triangle indices", b"vertex buffers", b"fake BNTX", b"fake animation",
    ]
    names = ["pm0025_00_00.trmdl", "pm0025_00_00.trmsh",
             "pm0025_00_00.trmbf", "body.bntx", "pikachu_idle.tranm"]
    count = len(names)
    paths = 48
    folder_offset = paths + 8 * count
    table_offset = folder_offset + 16 + count * 16
    data_start = table_offset + count * 24
    output = bytearray(data_start + sum(len(part) for part in contents))
    output[:8] = b"GFLXPACK"
    struct.pack_into("<4I", output, 8, 0x1000, 0, count, 1)
    struct.pack_into("<QQ", output, 24, table_offset, paths)
    struct.pack_into("<Q", output, 40, folder_offset)
    struct.pack_into("<QII", output, folder_offset, 0xABCDEF, count, 0)
    offset = data_start
    for index, (name, part) in enumerate(zip(names, contents)):
        hash_ = int(fnv1a64(name), 16)
        struct.pack_into("<Q", output, paths + index * 8, hash_)
        struct.pack_into("<QII", output, folder_offset + 16 + index * 16,
                         hash_, index, 0)
        struct.pack_into("<HHIIIII", output, table_offset + index * 24,
                         0, 0, len(part), len(part), 0, offset, 0)
        output[offset:offset + len(part)] = part
        offset += len(part)
    path.write_bytes(output)


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

    def test_gfpak_hash_verified_metadata_labels_textures_animations(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "pm0025_00_00.gfpak"
            create_resolved_gfpak(archive)
            browser = AssetBrowser()
            root = browser.open(archive)
            listing = browser.children(root["id"])
            self.assertEqual(listing["counts"]["model"], 1)
            self.assertEqual(listing["counts"]["mesh"], 2)
            self.assertEqual(listing["counts"]["texture"], 1)
            self.assertEqual(listing["counts"]["animation"], 1)

    def test_full_gfpak_catalog_sees_beyond_visible_pages_and_unknown_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "pm0025_00_00.gfpak"
            create_resolved_gfpak(archive)
            browser = AssetBrowser()
            opened = browser.open(archive)
            catalog = browser.scan_gfpak_assets(opened["id"])
            self.assertEqual(catalog["counts"]["model"], 1)
            self.assertEqual(catalog["counts"]["texture"], 1)
            self.assertEqual(catalog["counts"]["animation"], 1)
            self.assertEqual(catalog["counts"]["mesh"], 2)
            self.assertFalse(catalog["unresolved"])
            self.assertEqual(len(catalog["assets"]), 5)

            unknown = Path(tmp) / "unnamed.gfpak"
            create_gfpak(unknown)
            other = browser.open(unknown)
            incomplete = browser.scan_gfpak_assets(other["id"])
            self.assertEqual(incomplete["counts"]["unknown"], 1)
            self.assertTrue(incomplete["unresolved"])

    def test_fast_gfpak_preview_streams_native_assets_without_conversion(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "pm0025_00_00.gfpak"
            create_resolved_gfpak(archive)
            browser = AssetBrowser()
            root = browser.open(archive)
            manifest = browser.fast_preview_items(root["id"])
            self.assertEqual(manifest["selected"], "pm0025_00_00.trmdl")
            self.assertEqual(manifest["items"][0]["source"][0], "gfpak")
            self.assertEqual({row["path"] for row in manifest["items"]}, {
                "pm0025_00_00.trmdl", "pm0025_00_00.trmsh",
                "pm0025_00_00.trmbf", "body.bntx", "pikachu_idle.tranm"
            })
            size, chunks = browser.stream_fast_preview_item(
                manifest["items"][0]["source"])
            decoded = b"".join(chunks)
            self.assertEqual(len(decoded), size)
            self.assertIn(b"body.bntx", decoded)
            self.assertTrue(archive.exists())
            # Opening a model resource selects that exact model, not an
            # unrelated model from the same game archive.
            listing = browser.children(root["id"])
            model = next(row for row in listing["entries"]
                         if row["category"] == "model")
            matched = browser.fast_preview_items(model["id"])
            self.assertEqual(matched["selected"], manifest["selected"])

    def test_native_texture_preview_is_single_file_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            source = folder / "body.bntx"
            source.write_bytes(b"BNTX test native surface")
            companion = folder / "idle.tranm"
            companion.write_bytes(b"animation must not be decoded here")
            browser = AssetBrowser()
            root = browser.open(folder)
            files = browser.children(root["id"])["entries"]
            texture = next(row for row in files if row["category"] == "texture")
            manifest = browser.fast_texture_item(texture["id"])
            self.assertEqual(manifest["path"], "body.bntx")
            size, chunks = browser.stream_fast_preview_item(manifest["source"])
            self.assertEqual(b"".join(chunks), source.read_bytes())
            self.assertEqual(size, source.stat().st_size)
            animation = next(row for row in files if row["category"] == "animation")
            with self.assertRaisesRegex(ValueError, "recognized texture"):
                browser.fast_texture_item(animation["id"])
            self.assertTrue(companion.exists())

    def test_native_texture_preview_from_gfpak_uses_verified_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "pm0025_00_00.gfpak"
            create_resolved_gfpak(archive)
            browser = AssetBrowser()
            root = browser.open(archive)
            files = browser.children(root["id"])["entries"]
            texture = next(row for row in files if row["category"] == "texture")
            manifest = browser.fast_texture_item(texture["id"])
            self.assertEqual(manifest["path"], "body.bntx")
            size, chunks = browser.stream_fast_preview_item(manifest["source"])
            self.assertEqual(b"".join(chunks), b"fake BNTX")
            self.assertEqual(size, len(b"fake BNTX"))

    def test_link_extracted_folder_under_nsp_and_browse_full_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            nsp = root / "Pokemon Legends Arceus.nsp"
            create_pfs0(nsp)
            extracted = root / "already_extracted"
            models = extracted / "bin" / "archive" / "pokemon"
            models.mkdir(parents=True)
            (models / "pm0025_00_00.gfpak").write_bytes(b"demo asset")
            browser = AssetBrowser()
            base = browser.open(nsp)
            with self.assertRaisesRegex(ValueError, "directory"):
                browser.attach_extracted(nsp)
            linked = browser.attach_extracted(extracted)
            self.assertTrue(linked["expandable"])
            self.assertEqual(linked["category"], "folder")
            overview = browser.children(base["id"])
            self.assertEqual(overview["entries"][0]["id"], linked["id"])
            node = linked
            for folder in ("bin", "archive", "pokemon"):
                listing = browser.children(node["id"])
                node = next(entry for entry in listing["entries"] if entry["name"] == folder)
                self.assertEqual(node["category"], "folder")
            model = browser.children(node["id"])["entries"][0]
            self.assertEqual(model["name"], "pm0025_00_00.gfpak")
            self.assertEqual(model["category"], "model archive")
            self.assertEqual(browser.preview_source(model["id"]).resolve(),
                             (models / "pm0025_00_00.gfpak").resolve())
            self.assertTrue(nsp.read_bytes().startswith(b"PFS0"))

    def test_link_real_extracted_files_under_selected_nca(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package = root / "game.nsp"
            create_pfs0(package)
            extraction = root / "extracted"
            section = extraction / "Section 1" / "bin" / "archive" / "pokemon"
            section.mkdir(parents=True)
            (section / "pm0025_00_00.gfpak").write_bytes(b"sample")
            browser = AssetBrowser(nca_workspace=root / "staging")
            pkg = browser.open(package)
            ncafile = browser.children(pkg["id"])["entries"][0]
            self.assertTrue(ncafile["expandable"])
            child = browser.attach_extracted_nca(ncafile["id"], extraction)
            self.assertEqual(child["category"], "folder")
            folders = browser.children(ncafile["id"])
            self.assertEqual(folders["entries"][0]["id"], child["id"])
            for name in ("Section 1", "bin", "archive", "pokemon"):
                rows = browser.children(child["id"])
                child = next(row for row in rows["entries"] if row["name"] == name)
            model = browser.children(child["id"])["entries"][0]
            self.assertEqual(model["name"], "pm0025_00_00.gfpak")
            self.assertEqual(model["category"], "model archive")
            self.assertTrue(package.read_bytes().startswith(b"PFS0"))

    def test_detailed_inspection_returns_bounded_bytes_and_png_preview(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            image = root / "model.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"test")
            browser = AssetBrowser()
            node = browser.open(root)
            image_node = browser.children(node["id"])["entries"][0]
            info = browser.item_details(image_node["id"])
            self.assertEqual(info["category"], "texture")
            self.assertEqual(info["signature"], "PNG image")
            self.assertTrue(info["thumbnail"].startswith("data:image/png;base64,"))
            self.assertTrue(info["hex_lines"])

    def test_large_local_folder_and_zip_show_every_file_via_pagination(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / "large"
            directory.mkdir()
            for i in range(503):
                (directory / f"pm{i:04d}_00_00.trmdl").write_bytes(b"model")
            bundle = root / "models.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                for i in range(503):
                    archive.writestr(f"pokemon/pm{i:04d}_00_00.trmdl", b"model")
            browser = AssetBrowser()
            for source in (directory, bundle):
                top = browser.open(source)
                node = top
                if source == bundle:
                    node = browser.children(top["id"])["entries"][0]
                rows, cursor = [], None
                while True:
                    page = browser.children(node["id"], cursor=cursor)
                    rows.extend(page["entries"])
                    cursor = page.get("next_cursor")
                    if not cursor:
                        break
                self.assertEqual(len(rows), 503)
                self.assertEqual(len({row["id"] for row in rows}), 503)
                self.assertEqual(rows[-1]["name"], "pm0502_00_00.trmdl")
                with self.assertRaisesRegex(ValueError, "cursor"):
                    browser.children(node["id"], "o:ffffffffff")

    def test_zip_image_thumbnail_and_session_cache_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "assets.zip"
            second = root / "other.zip"
            with zipfile.ZipFile(first, "w") as archive:
                archive.writestr("pokemon/face.png", b"\x89PNG\r\n\x1a\n" + b"picture")
            with zipfile.ZipFile(second, "w") as archive:
                archive.writestr("readme.txt", b"safe")
            browser = AssetBrowser(nca_workspace=root / "owned-cache")
            source = browser.open(first)
            folder = browser.children(source["id"])["entries"][0]
            asset = browser.children(folder["id"])["entries"][0]
            info = browser.item_details(asset["id"])
            self.assertTrue(info["thumbnail"].startswith("data:image/png;base64,"))
            cache = root / "owned-cache"
            (cache / "ncz").mkdir()
            (cache / "preview").mkdir()
            (cache / "ncz" / "old.nca").write_bytes(b"temporary")
            (cache / "preview" / "old.glb").write_bytes(b"temporary")
            keep = root / "user_original.nca"
            keep.write_bytes(b"original")
            browser.open(second)
            self.assertFalse((cache / "ncz" / "old.nca").exists())
            self.assertFalse((cache / "preview" / "old.glb").exists())
            self.assertEqual(keep.read_bytes(), b"original")

    def test_export_selected_file_zip_member_and_gfpak_resource(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / "sample.tranm"
            original.write_bytes(b"animation bytes")
            zip_path = root / "assets.zip"
            with zipfile.ZipFile(zip_path, "w") as archive:
                archive.writestr("pokemon/body.png", b"PNG test")
            pack = root / "pm0025_00_00.gfpak"
            create_gfpak(pack)
            browser = AssetBrowser()
            folder = browser.open(root)
            entries = browser.children(folder["id"])["entries"]
            animation = next(e for e in entries if e["name"] == "sample.tranm")
            output = root / "exported.tranm"
            browser.export_item(animation["id"], output)
            self.assertEqual(output.read_bytes(), b"animation bytes")
            with self.assertRaises(FileExistsError):
                browser.export_item(animation["id"], output)
            archive_node = next(e for e in entries if e["name"] == "assets.zip")
            category = browser.children(archive_node["id"])["entries"][0]
            image_node = browser.children(category["id"])["entries"][0]
            zip_output = root / "saved.png"
            browser.export_item(image_node["id"], zip_output)
            self.assertEqual(zip_output.read_bytes(), b"PNG test")
            pack_node = next(e for e in entries if e["name"] == "pm0025_00_00.gfpak")
            resource = browser.children(pack_node["id"])["entries"][0]
            pack_output = root / "saved-resource.bin"
            browser.export_item(resource["id"], pack_output)
            self.assertEqual(pack_output.read_bytes(), b"HELLO")
            packed_output = root / "saved-resource.bin.packed"
            browser.export_item(resource["id"], packed_output, packed=True)
            self.assertEqual(packed_output.read_bytes(), b"HELLO")
            with self.assertRaisesRegex(ValueError, "Packed export"):
                browser.export_item(animation["id"], root / "not-a-packed-file", packed=True)
            self.assertTrue(pack.read_bytes().startswith(b"GFLXPACK"))
            with self.assertRaisesRegex(ValueError, "Select a file"):
                browser.export_item(category["id"], root / "cannot-export-folder")

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
            with self.assertRaisesRegex(ValueError, "entry .*outside"):
                pfs0_entries(file)


if __name__ == "__main__":
    unittest.main()
