"""Native NCA3 tests use synthetic ExeFS/RomFS fixtures and disposable test keys.

No Switch keys, Nintendo content, hactool, downloads or subprocesses are needed.
"""
from __future__ import annotations

import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gfpak_open.asset_browser import AssetBrowser
from gfpak_open.nca_native import (
    Keyset, NativeNCA, NativeNCAError, NativeSection, _ivfc_data_region
)
from gfpak_open.nca_sections import LocalNCASections
from gfpak_open.nsp_explorer import NSPAnalyzer


def pfs0_files(files: list[tuple[str, bytes]]):
    names = bytearray()
    table = bytearray()
    payload = bytearray()
    for name, body in files:
        at = len(names)
        names.extend(name.encode() + b"\0")
        table.extend(struct.pack("<QQII", len(payload), len(body), at, 0))
        payload.extend(body)
    return (b"PFS0" + struct.pack("<III", len(files), len(names), 0)
            + table + names + payload)


def native_gfpak_fixture():
    """Small read-only nested archive with a verified model/texture/clip family."""
    from gfpak_open.converter import fnv1a64
    extensions = (".trmdl", ".trmsh", ".trmbf", ".bntx", ".tranm")
    contents = (
        b"model descriptor", b"mesh descriptor", b"buffer data",
        b"BNTX texture", b"native animation"
    )
    count = len(extensions)
    paths_offset = 48
    folder_offset = paths_offset + 8 * count
    table_offset = folder_offset + 16 + 16 * count
    data_offset = table_offset + 24 * count
    result = bytearray(data_offset + sum(map(len, contents)))
    result[:8] = b"GFLXPACK"
    struct.pack_into("<4I", result, 8, 0x1000, 0, count, 1)
    struct.pack_into("<QQQ", result, 24, table_offset, paths_offset, folder_offset)
    struct.pack_into("<QII", result, folder_offset, 0xabcdef, count, 0)
    begin = data_offset
    for idx, (extension, body) in enumerate(zip(extensions, contents)):
        name_hash = int(fnv1a64("pm0025_00_00" + extension), 16)
        struct.pack_into("<Q", result, paths_offset + idx * 8, name_hash)
        struct.pack_into("<QII", result, folder_offset + 16 + 16 * idx,
                         name_hash, idx, 0)
        struct.pack_into("<HHIIIII", result, table_offset + 24 * idx,
                         0, 0, len(body), len(body), 0, begin, 0)
        result[begin:begin+len(body)] = body
        begin += len(body)
    return bytes(result)


def romfs_nested(content: bytes | None = None):
    """Construct a real RomFS table with bin/archive/pokemon nested directories."""
    names = ("", "bin", "archive", "pokemon")
    positions = []
    directory = bytearray()
    for name in names:
        positions.append(len(directory))
        label = name.encode()
        directory.extend(b"\0" * (24 + (len(label) + 3 & ~3)))
    filename = b"pm0025_00_00.gfpak"
    if content is None:
        content = b"GFLXPACK test Pikachu model"
    for i, name in enumerate(names):
        child = positions[i+1] if i < len(names)-1 else 0xFFFFFFFF
        first_file = 0 if i == 3 else 0xFFFFFFFF
        parent = 0xFFFFFFFF if i == 0 else positions[i-1]
        struct.pack_into("<6I", directory, positions[i],
                         parent, 0xFFFFFFFF, child, first_file,
                         0xFFFFFFFF, len(name.encode()))
        directory[positions[i]+24:positions[i]+24+len(name.encode())] = name.encode()
    filetable = (struct.pack("<IIQQII", positions[-1], 0xFFFFFFFF,
                             0, len(content), 0xFFFFFFFF, len(filename)) + filename)
    header = bytearray(0x50)
    dt = 0x50
    ft = dt + len(directory)
    data_off = ft + len(filetable)
    struct.pack_into("<10Q", header, 0, 0x50, 0x50, 0, dt, len(directory),
                     ft, 0, ft, len(filetable), data_off)
    return bytes(header) + bytes(directory) + filetable + content


def plain_nca(sources: list[tuple[str, bytes]], encrypted=False, headerkey=None,
              areakey=None, contentkey=None, rights_id=None, key_generation=1):
    header = bytearray(0xC00)
    header[0x200:0x204] = b"NCA3"
    if encrypted:
        header[0x206] = min(key_generation, 2)
        header[0x220] = key_generation
        if rights_id is not None:
            assert len(rights_id) == 16
            header[0x230:0x240] = rights_id
        assert len(headerkey) == 32 and len(areakey) == len(contentkey) == 16
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        slots = b"\0"*32 + contentkey + b"\0"*16
        ctx = Cipher(algorithms.AES(areakey), modes.ECB()).encryptor()
        header[0x300:0x340] = ctx.update(slots) + ctx.finalize()
    body = bytearray()
    for i, (kind, payload) in enumerate(sources):
        padded = payload + b"\0" * (-len(payload) % 0x200)
        offset = 0xC00 + len(body)
        struct.pack_into("<II", header, 0x240 + i*16, offset//0x200,
                         (offset+len(padded))//0x200)
        fs = 0x400 + i * 0x200
        header[fs:fs+2] = b"\x02\x00"
        header[fs+4] = 3 if encrypted else 1
        if kind == "pfs":
            header[fs+2] = 2
            header[fs+3] = 2
            struct.pack_into("<Q", header, fs+0x40, 0)
        else:
            header[fs+2] = 3
            header[fs+3] = 3
            header[fs+8:fs+12] = b"IVFC"
            # Nintendo's MaxLayers includes the external master-hash layer.
            # Seven levels therefore have six region descriptors. The sixth
            # descriptor (index 5) is the real RomFS data layer.
            struct.pack_into("<I", header, fs+0x14, 7)
            struct.pack_into("<QQII", header, fs+0x18+5*0x18,
                             0, len(payload), 12, 0)
        if encrypted:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            counter = bytes.fromhex("0011223344556677")
            header[fs+0x140:fs+0x148] = counter[::-1]
            iv = counter + (offset//16).to_bytes(8, "big")
            enc = Cipher(algorithms.AES(contentkey), modes.CTR(iv)).encryptor()
            padded = enc.update(padded) + enc.finalize()
        body.extend(padded)
    content = bytes(header) + bytes(body)
    if not encrypted:
        return content
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    encrypted_header = bytearray()
    for number in range(6):
        sector = header[number*0x200:(number+1)*0x200]
        tweak = number.to_bytes(16, "big")
        encrypt = Cipher(algorithms.AES(headerkey), modes.XTS(tweak)).encryptor()
        encrypted_header.extend(encrypt.update(sector) + encrypt.finalize())
    return bytes(encrypted_header) + bytes(body)


def package(path: Path, entries: list[tuple[str, bytes]]):
    names = bytearray()
    table = bytearray()
    data = bytearray()
    for filename, value in entries:
        start = len(names)
        names.extend(filename.encode() + b"\0")
        table.extend(struct.pack("<QQII", len(data), len(value), start, 0))
        data.extend(value)
    path.write_bytes(b"PFS0" + struct.pack("<III", len(entries), len(names), 0) +
                     table + names + data)


class NativeNCAIntegrationTests(unittest.TestCase):
    def test_seven_level_ivfc_uses_last_of_six_descriptors(self):
        # Actual Switch NCAs normally report MaxLayers=7, even though
        # only six 0x18-byte descriptors follow the count. The old reader
        # rejected these headers, particularly visible in large RomFS NCAs.
        romfs = romfs_nested()
        nca_bytes = plain_nca([("romfs", romfs)])
        fs_header = nca_bytes[0x400:0x600]
        offset, size = _ivfc_data_region(fs_header)
        self.assertEqual((offset, size), (0, len(romfs)))
        self.assertEqual(struct.unpack_from("<I", fs_header, 0x14)[0], 7)
        with tempfile.TemporaryDirectory() as tmp:
            package_path = Path(tmp) / "game.nsp"
            package(package_path, [("program.nca", nca_bytes)])
            section = NativeNCA(NSPAnalyzer(package_path), 0).sections[0]
            self.assertEqual(section.filesystem().children()[0]["name"], "bin")

    def test_large_ivfc_data_offset_is_64_bit_and_read_lazily(self):
        # Exercise a huge logical section without creating a multi-GB fixture.
        # All actual bytes are mapped by a fake sparse read-only source.
        from types import SimpleNamespace
        romfs = romfs_nested()
        large_offset = (1 << 32) + 0x200
        header = bytearray(0x200)
        header[2:5] = bytes([3, 3, 1])
        header[8:12] = b"IVFC"
        struct.pack_into("<I", header, 0x14, 7)
        struct.pack_into("<QQII", header, 0x18 + 5*0x18,
                         large_offset, len(romfs), 12, 0)
        physical_start = 0xC00
        requested = []
        def read_raw(offset, size):
            requested.append((offset, size))
            start = physical_start + large_offset
            if offset < start or offset + size > start + len(romfs):
                raise AssertionError("Reader escaped the virtual RomFS region")
            return romfs[offset-start:offset-start+size]
        nca = SimpleNamespace(read_raw=read_raw)
        section = NativeSection(
            nca, number=0, start=physical_start,
            size=large_offset + len(romfs), fs_header=bytes(header),
            encryption=1, key=None
        )
        filesystem = section.filesystem()
        self.assertEqual(filesystem.children()[0]["name"], "bin")
        self.assertTrue(requested)
        self.assertTrue(all(length <= 65536 for _, length in requested))

    def test_ivfc_rejects_invalid_counts_and_truncated_real_layer(self):
        header = bytearray(0x200)
        header[8:12] = b"IVFC"
        for bad in (0, 1, 8, 0xFFFFFFFF):
            struct.pack_into("<I", header, 0x14, bad)
            with self.subTest(bad=bad), self.assertRaisesRegex(
                NativeNCAError, "invalid IVFC level count"
            ):
                _ivfc_data_region(header)
        struct.pack_into("<I", header, 0x14, 7)
        with self.assertRaisesRegex(NativeNCAError, "zero length"):
            _ivfc_data_region(header)

    def test_read_plaintext_sections_and_nested_romfs_directly(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            nsp = root / "synthetic.nsp"
            data = plain_nca([
                ("pfs", pfs0_files([("main", b"EXE"), ("main.npdm", b"NPDM")])),
                ("romfs", romfs_nested()),
            ])
            package(nsp, [("program.nca", data)])
            browser = AssetBrowser(nca_workspace=root / "cache")
            source = browser.open(nsp)
            nca = browser.children(source["id"])["entries"][0]
            with patch("gfpak_open.nsp_explorer.NSPAnalyzer.export_raw",
                       side_effect=AssertionError("Bulk NCA staging should never happen")):
                sections = browser.children(nca["id"])["entries"]
                self.assertEqual([node["name"] for node in sections],
                                 ["Section 0", "Section 1"])
                exefs = browser.children(sections[0]["id"])["entries"]
                self.assertEqual({node["name"] for node in exefs}, {"main", "main.npdm"})
                romfs = browser.children(sections[1]["id"])["entries"]
                self.assertEqual([node["name"] for node in romfs], ["bin"])
                directory = romfs[0]
                for name in ("archive", "pokemon"):
                    directory = next(node for node in browser.children(directory["id"])["entries"]
                                     if node["name"] == name)
                model = browser.children(directory["id"])["entries"][0]
                self.assertEqual(model["name"], "pm0025_00_00.gfpak")
                self.assertEqual(model["category"], "model archive")
                details = browser.item_details(model["id"])
                self.assertEqual(details["signature"], "Game Freak GFPAK archive")
                export = root / "saved-model.gfpak"
                browser.export_item(model["id"], export)
                self.assertEqual(export.read_bytes(), b"GFLXPACK test Pikachu model")
                self.assertEqual(browser.preview_source(model["id"]).read_bytes(),
                                 b"GFLXPACK test Pikachu model")
            self.assertFalse(list((root / "cache").glob("*.nca")))
            self.assertTrue(nsp.read_bytes().startswith(b"PFS0"))

    def test_unlocked_nested_romfs_preview_export_survives_key_refresh(self):
        """Model nodes discovered after unlock must survive a reader rebuild.

        Reproduces: load keys, scan nested Sword/Shield-style RomFS, focus the
        window (unchanged keys), then replace the key file (same valid keys).
        Preview and Pokémon ZIP must both locate the same original resources.
        """
        import zipfile
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            header_key = bytes(range(32))
            area_key = bytes(range(0x20, 0x30))
            content_key = bytes(range(0x40, 0x50))
            inner = native_gfpak_fixture()
            romfs = romfs_nested(inner)
            encrypted = plain_nca([("romfs", romfs)], encrypted=True,
                                  headerkey=header_key, areakey=area_key,
                                  contentkey=content_key)
            game = root / "locked-then-unlocked.nsp"
            package(game, [("program.nca", encrypted)])
            keys = root / "local.keys"
            original = ("nca_header_key = " + header_key.hex() + "\n" +
                        "nca_key_area_key_application_00 = " + area_key.hex() + "\n")
            keys.write_text(original)
            browser = AssetBrowser(nca_workspace=root / "cache")
            self.assertTrue(browser.configure_nca_reader(keys))
            game_node = browser.open(game)
            nca = browser.children(game_node["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            catalog = browser.scan_nca_assets(section["id"])
            model = next(row for row in catalog["assets"]
                         if row["name"] == "pm0025_00_00.gfpak")
            reader = browser._nca_sources[model["id"]]
            old_fs = browser._nca_sections.filesystem(reader, 0, 0)
            self.assertFalse(browser.configure_nca_reader(keys))
            self.assertIs(old_fs, browser._nca_sections.filesystem(reader, 0, 0))

            # An actual key-file revision invalidates the reader's in-memory
            # directory names while leaving the user-visible model selectable.
            keys.write_text(original + "# refreshed by user\n")
            self.assertTrue(browser.configure_nca_reader(keys))
            new_fs = browser._nca_sections.filesystem(reader, 0, 0)
            self.assertIsNot(old_fs, new_fs)
            self.assertEqual(set(new_fs._directories), {""})
            browser._virtual_gfpaks.clear()

            preview = browser.preview_source(model["id"])
            self.assertEqual(preview.read_bytes(), inner)
            manifest = browser.fast_preview_items(model["id"])
            self.assertEqual(manifest["selected"], "pm0025_00_00.trmdl")
            model_data = next(item for item in manifest["items"]
                              if item["path"] == "pm0025_00_00.trmdl")
            size, chunks = browser.stream_fast_preview_item(model_data["source"])
            self.assertEqual((size, b"".join(chunks)), (len(b"model descriptor"), b"model descriptor"))
            export = root / "pokemon.zip"
            browser.export_pokemon(model["id"], export)
            with zipfile.ZipFile(export) as zipped:
                self.assertIn("pm0025_00_00.trmdl", zipped.namelist())
                self.assertEqual(zipped.read("pm0025_00_00.trmdl"), b"model descriptor")

    def test_unlocked_romfs_unknown_paths_still_fail_closed(self):
        """Folder recovery only discovers real metadata, never fabricated paths."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            game = root / "sample.nsp"
            package(game, [("program.nca", plain_nca([("romfs", romfs_nested())]))])
            browser = AssetBrowser(nca_workspace=root / "cache")
            game_node = browser.open(game)
            nca = browser.children(game_node["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            reader = browser._nca_sources[section["id"]]
            fs = browser._nca_sections.filesystem(reader, 0, 0)
            self.assertEqual(fs.children_page("bin/archive/pokemon")["entries"][0]["name"],
                             "pm0025_00_00.gfpak")
            with self.assertRaisesRegex(NativeNCAError, "Unknown RomFS folder"):
                fs.children_page("bin/archive/not-real")
            with self.assertRaisesRegex(NativeNCAError, "Unknown RomFS folder"):
                fs.children_page("../bin")

    def test_nca_asset_catalog_locates_models_textures_animations(self):
        # Only file metadata is needed; no model conversion or extraction.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nsp = root / "catalog.nsp"
            package(nsp, [("program.nca", plain_nca([("pfs", pfs0_files([
                ("pm0025_00_00.trmdl", b"model"),
                ("pm0025_body.bntx", b"texture"),
                ("pm0025_idle.tranm", b"animation"),
                ("pm0025_00_00.trmsh", b"mesh"),
                ("unrelated.txt", b"misc")
            ]))]))])
            browser = AssetBrowser(nca_workspace=root / "cache")
            source = browser.open(nsp)
            nca = browser.children(source["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            catalog = browser.scan_nca_assets(section["id"])
            self.assertEqual(catalog["counts"], {
                "model": 1, "texture": 1, "animation": 1, "mesh": 1
            })
            self.assertEqual(catalog["scanned"], 5)
            self.assertFalse(catalog["truncated"])
            self.assertEqual(len(catalog["assets"]), 4)
            for asset in catalog["assets"]:
                self.assertEqual(asset["kind"], "nca_file")
                self.assertEqual(
                    browser.node(asset["id"])["name"], asset["name"])
            limited = browser.scan_nca_assets(section["id"], limit=2)
            self.assertEqual(limited["scanned"], 2)
            self.assertTrue(limited["truncated"])

    def test_game_wide_package_catalog_detects_nested_assets_from_nca_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game = root / "whole-game.nsp"
            content = plain_nca([
                ("pfs", pfs0_files([
                    ("pm0025_00_00.trmdl", b"model"),
                    ("body.bntx", b"texture"),
                    ("idle.tranm", b"animation")
                ])),
                ("romfs", romfs_nested())
            ])
            package(game, [("program.nca", content)])
            browser = AssetBrowser(nca_workspace=root / "cache")
            main = browser.open(game)
            catalog = browser.scan_game_assets(main["id"])
            self.assertGreaterEqual(catalog["counts"].get("model", 0), 1, repr(catalog))
            self.assertGreaterEqual(catalog["counts"].get("texture", 0), 1)
            self.assertGreaterEqual(catalog["counts"].get("animation", 0), 1)
            self.assertGreaterEqual(catalog["counts"].get("model archive", 0), 1)
            self.assertTrue(catalog["unresolved"])  # An actual nested GFPAK is opaque.
            self.assertEqual(catalog["scanned_ncas"], 1)
            self.assertEqual(catalog["total_ncas"], 1)
            self.assertGreater(catalog["scanned"], 3)
            self.assertTrue(all(browser.node(row["id"]) for row in catalog["assets"]))
            limited = browser.scan_game_assets(main["id"], limit=2)
            self.assertTrue(limited["truncated"])
            self.assertLessEqual(limited["scanned"], 2)

    def test_full_game_catalog_scans_more_than_old_64_nca_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game = root / "many-nca.nsp"
            entries = [
                (f"program{i:03d}.nca", plain_nca([
                    ("pfs", pfs0_files([(f"pm{i:04d}_idle.tranm", b"clip")]))
                ]))
                for i in range(66)
            ]
            package(game, entries)
            browser = AssetBrowser(nca_workspace=root / "cache")
            source = browser.open(game)
            catalog = browser.scan_game_assets(source["id"])
            self.assertEqual(catalog["total_ncas"], 66)
            self.assertEqual(catalog["scanned_ncas"], 66)
            self.assertEqual(catalog["counts"]["animation"], 66)
            self.assertFalse(catalog["truncated"])
            self.assertEqual(len(catalog["assets"]), 66)

    def test_package_locked_sections_are_marked_unresolved_instead_of_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game = root / "locked-game.nsp"
            package(game, [("program.nca", b"not an NCA")])
            browser = AssetBrowser(nca_workspace=root / "cache")
            opened = browser.open(game)
            catalog = browser.scan_game_assets(opened["id"])
            self.assertTrue(catalog["unresolved"])
            self.assertEqual(catalog["counts"], {})
            self.assertTrue(catalog["warnings"])

    def test_nested_romfs_gfpak_native_assets_browse_and_stream_without_staging(self):
        """Prove direct discovery/preview of all three classes within an NCA GFPAK."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game = root / "game.nsp"
            inner = native_gfpak_fixture()
            package(game, [("program.nca", plain_nca([
                ("pfs", pfs0_files([("pm0025_00_00.gfpak", inner)]))
            ]))])
            browser = AssetBrowser(nca_workspace=root / "workspace")
            package_node = browser.open(game)
            nca = browser.children(package_node["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            inner_node = browser.children(section["id"])["entries"][0]
            self.assertTrue(inner_node["expandable"])
            self.assertEqual(inner_node["category"], "model archive")
            listing = browser.children(inner_node["id"])
            self.assertEqual(listing["counts"]["model"], 1)
            self.assertEqual(listing["counts"]["mesh"], 2)
            self.assertEqual(listing["counts"]["texture"], 1)
            self.assertEqual(listing["counts"]["animation"], 1)
            mounted = browser.scan_mounted_gfpak_assets(inner_node["id"])
            self.assertFalse(mounted["unresolved"])
            self.assertEqual(len(mounted["assets"]), 5)
            manifest = browser.fast_preview_items(inner_node["id"])
            self.assertEqual(manifest["selected"], "pm0025_00_00.trmdl")
            self.assertEqual(len(manifest["items"]), 5)
            _, content = browser.stream_fast_preview_item(manifest["items"][0]["source"])
            self.assertEqual(b"".join(content), b"model descriptor")
            texture = next(row for row in listing["entries"]
                           if row["category"] == "texture")
            texture_meta = browser.fast_texture_item(texture["id"])
            _, content = browser.stream_fast_preview_item(texture_meta["source"])
            self.assertEqual(b"".join(content), b"BNTX texture")
            self.assertFalse((root / "workspace" / "preview").exists(),
                             "Fast nested GFPAK previews must not stage files on disk")

    def test_swsh_model_inside_romfs_gfpak_previews_without_trinity_hashes(self):
        """Sword/Shield GFBMDL has geometry in one resource, not a Trinity trio."""
        from test_resource_discovery import gfbmdl_triangle
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = gfbmdl_triangle()
            packed = bytearray(112 + len(source))
            packed[:8] = b"GFLXPACK"
            struct.pack_into("<4I", packed, 8, 0x1000, 0, 1, 1)
            struct.pack_into("<QQQ", packed, 24, 88, 48, 56)
            # Deliberately unrecognized hash values: format evidence is the
            # only way to find the native GFBMDL model here.
            struct.pack_into("<Q", packed, 48, 0x123456789)
            struct.pack_into("<QII", packed, 56, 0xAA, 1, 0)
            struct.pack_into("<QII", packed, 72, 0x123456789, 0, 0)
            struct.pack_into("<HHIIIII", packed, 88,
                             0, 0, len(source), len(source), 0, 112, 0)
            packed[112:] = source
            game = root / "swsh.nsp"
            package(game, [("program.nca", plain_nca([
                ("romfs", romfs_nested(bytes(packed)))
            ]))])
            browser = AssetBrowser(nca_workspace=root / "cache")
            opened = browser.open(game)
            nca = browser.children(opened["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            catalog = browser.scan_nca_assets(section["id"])
            archive_node = next(row for row in catalog["assets"]
                                if row["name"] == "pm0025_00_00.gfpak")
            _, resolved = browser._mounted_gfpak(archive_node["id"])
            self.assertEqual(len(resolved), 1)
            self.assertTrue(resolved[0].endswith(".gfbmdl"))
            manifest = browser.fast_preview_items(archive_node["id"])
            self.assertTrue(manifest["selected"].endswith(".gfbmdl"))
            self.assertEqual(len(manifest["items"]), 1)
            length, stream = browser.stream_fast_preview_item(
                manifest["items"][0]["source"])
            self.assertEqual(length, len(source))
            self.assertEqual(b"".join(stream), source)

    def test_model_diagnostics_explain_failed_oodle_resource_without_exposing_keys(self):
        """Unavailable compressed contents must not be mislabeled model data."""
        import json
        from gfpak_open.core import GFPakError
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = b"not-an-oodle-bitstream"
            archive = bytearray(112 + len(payload))
            archive[:8] = b"GFLXPACK"
            struct.pack_into("<4I", archive, 8, 0x1000, 0, 1, 1)
            struct.pack_into("<QQQ", archive, 24, 88, 48, 56)
            struct.pack_into("<Q", archive, 48, 0x12345678)
            struct.pack_into("<QII", archive, 56, 0x55, 1, 0)
            struct.pack_into("<QII", archive, 72, 0x444444, 0, 0)
            struct.pack_into("<HHIIIII", archive, 88,
                             0, 3, 512, len(payload), 0, 112, 0)
            archive[112:] = payload
            game = root / "game.nsp"
            package(game, [("program.nca", plain_nca([
                ("romfs", romfs_nested(bytes(archive)))
            ]))])
            browser = AssetBrowser(nca_workspace=root / "cache")
            source = browser.open(game)
            nca = browser.children(source["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            catalog = browser.scan_nca_assets(section["id"])
            selected = next(row for row in catalog["assets"]
                            if row["name"].endswith(".gfpak"))
            with patch("gfpak_open.core.GFPak.read_resource",
                       side_effect=GFPakError("Oodle decoder failed")):
                diagnostic = browser.model_diagnostics(selected["id"])
                with self.assertRaisesRegex(ValueError, "Oodle-compressed"):
                    browser.fast_preview_items(selected["id"])
            self.assertEqual(diagnostic["resources"], 1)
            self.assertEqual(diagnostic["recognized_models"], 0)
            self.assertEqual(diagnostic["compression_types"], {"3": 1})
            self.assertEqual(diagnostic["discovery"]["oodle_failures"], 1)
            self.assertNotIn("12345678", json.dumps(diagnostic))
            self.assertNotIn(str(root), json.dumps(diagnostic))

    def test_model_diagnostics_report_verified_hash_family(self):
        """A real model hash triplet remains identifiable without decoding."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game = root / "game.nsp"
            package(game, [("program.nca", plain_nca([
                ("romfs", romfs_nested(native_gfpak_fixture()))
            ]))])
            browser = AssetBrowser(nca_workspace=root / "cache")
            source = browser.open(game)
            nca = browser.children(source["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            catalog = browser.scan_nca_assets(section["id"])
            selected = next(row for row in catalog["assets"]
                            if row["name"].endswith(".gfpak"))
            diagnostic = browser.model_diagnostics(selected["id"])
            self.assertGreaterEqual(diagnostic["recognized_models"], 1)
            self.assertEqual(diagnostic["status"], "Native model identified")
            self.assertEqual(diagnostic["compression_types"], {"0": 5})

    def test_raw_nested_romfs_gfpak_zip_never_requires_3d_preview(self):
        """A valid model archive can be exported even when geometry is unsupported."""
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game = root / "encrypted-model.nsp"
            original = native_gfpak_fixture()
            package(game, [("program.nca", plain_nca([
                ("romfs", romfs_nested(original))
            ]))])
            browser = AssetBrowser(nca_workspace=root / "cache")
            source = browser.open(game)
            nca = browser.children(source["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            catalog = browser.scan_nca_assets(section["id"])
            mounted = next(row for row in catalog["assets"]
                           if row["name"] == "pm0025_00_00.gfpak")
            # Model conversion can fail if its geometry is not supported; the
            # original files are nevertheless accessible and must be exportable.
            with patch.object(browser, "fast_preview_items",
                              side_effect=ValueError("Unsupported native 3D model")):
                output = browser.export_pokemon(mounted["id"], root / "raw-assets.zip")
            with zipfile.ZipFile(output) as zipped:
                names = zipped.namelist()
                self.assertIn("pm0025_00_00.trmdl", names)
                self.assertIn("pm0025_00_00.trmsh", names)
                self.assertIn("pm0025_00_00.bntx", names)
                self.assertIn("pm0025_00_00.tranm", names)
                self.assertNotIn("pokedex3d/regular.glb", names)
                self.assertEqual(zipped.read("pm0025_00_00.trmdl"),
                                 b"model descriptor")

    def test_raw_zip_preserves_packed_nca_gfpak_members_when_decoder_unavailable(self):
        """A missing Oodle decoder cannot discard original compressed bytes."""
        from dataclasses import replace
        from gfpak_open.core import GFPakError
        import json
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            game = root / "romfs.nsp"
            package(game, [("program.nca", plain_nca([
                ("romfs", romfs_nested(native_gfpak_fixture()))
            ]))])
            browser = AssetBrowser(nca_workspace=root / "cache")
            source = browser.open(game)
            nca = browser.children(source["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            catalog = browser.scan_nca_assets(section["id"])
            node = next(item for item in catalog["assets"]
                        if item["name"] == "pm0025_00_00.gfpak")
            archive, names = browser._mounted_gfpak(node["id"])
            packed_index = next(idx for idx, name in names.items()
                                if name.endswith(".bntx"))
            packed_resource = archive.resources[packed_index]
            archive.resources[packed_index] = replace(packed_resource, compression=3)
            with patch.object(archive, "read_resource",
                              side_effect=GFPakError("Oodle decoder missing")):
                target = browser.export_pokemon(node["id"], root / "stored-assets.zip")
            with zipfile.ZipFile(target) as zipped:
                name = names[packed_index] + ".packed"
                self.assertIn(name, zipped.namelist())
                self.assertEqual(zipped.read(name),
                                 archive._range(packed_resource.offset,
                                                packed_resource.packed_size))
                manifest = json.loads(zipped.read("raw-assets-manifest.json"))
                entry = next(item for item in manifest["packedMembers"]
                             if item["storedPath"] == name)
                self.assertEqual(entry["compression"], 3)
                self.assertEqual(entry["decodedSize"], packed_resource.size)
                self.assertIn("pm0025_00_00.trmdl", zipped.namelist())
                self.assertNotIn("pokedex3d/regular.glb", zipped.namelist())

    def test_native_nca_png_thumbnail_and_linked_folder_dont_hide_sections(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            nsp = root / "textures.nsp"
            image = b"\x89PNG\r\n\x1a\n" + b"synthetic image"
            data = plain_nca([("pfs", pfs0_files([
                ("body.png", image),
                ("main", b"EXE"),
            ]))])
            package(nsp, [("program.nca", data)])
            browser = AssetBrowser(nca_workspace=root / "cache")
            source = browser.open(nsp)
            nca = browser.children(source["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            picture = next(row for row in browser.children(section["id"])["entries"]
                           if row["name"] == "body.png")
            details = browser.item_details(picture["id"])
            self.assertTrue(details["thumbnail"].startswith("data:image/png;base64,"))
            directory = root / "linked"
            directory.mkdir()
            browser.attach_extracted_nca(nca["id"], directory)
            listing = browser.children(nca["id"])["entries"]
            self.assertEqual([row["name"] for row in listing],
                             ["Extracted files (linked)", "Section 0"])

    def test_model_preview_stages_matching_real_animation_and_texture_companions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package_path = root / "pokemon.nsp"
            packed = plain_nca([("pfs", pfs0_files([
                ("pm0025_00_00.trmdl", b"model"),
                ("pm0025_00_00.trmsh", b"mesh"),
                ("pm0025_00_00.trmbf", b"buffer"),
                ("pm0025_idle.tranm", b"animation"),
                ("pm0025_body.dds", b"texture"),
                ("pm0026_00_00.trmsh", b"other species"),
            ]))])
            package(package_path, [("program.nca", packed)])
            browser = AssetBrowser(nca_workspace=root / "cache")
            nsp = browser.open(package_path)
            nca = browser.children(nsp["id"])["entries"][0]
            section = browser.children(nca["id"])["entries"][0]
            files = browser.children(section["id"])["entries"]
            model = next(row for row in files if row["name"].endswith(".trmdl"))
            preview = browser.preview_source(model["id"])
            self.assertTrue(preview.exists())
            self.assertEqual(preview.read_bytes(), b"model")
            self.assertEqual((preview.parent / "pm0025_idle.tranm").read_bytes(), b"animation")
            self.assertEqual((preview.parent / "pm0025_body.dds").read_bytes(), b"texture")
            self.assertFalse((preview.parent / "pm0026_00_00.trmsh").exists())

    def test_native_aes_xts_header_and_aes_ctr_section(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            header_key = bytes(range(32))
            area_key = bytes(range(0x20, 0x30))
            content_key = bytes(range(0x40, 0x50))
            encrypted = plain_nca(
                [("pfs", pfs0_files([("main", b"Test executable payload")]))],
                encrypted=True,headerkey=header_key,areakey=area_key,contentkey=content_key
            )
            nsp = root / "protected.nsp"
            package(nsp, [("program.nca", encrypted)])
            reader = NSPAnalyzer(nsp)
            with self.assertRaisesRegex(NativeNCAError, "keys file"):
                NativeNCA(reader, 0)
            keyfile = root / "fixture.keys"
            keyfile.write_text(
                "nca_header_key = " + header_key.hex() + "\n" +
                "nca_key_area_key_application_00 = " + area_key.hex() + "\n"
            )
            native = NativeNCA(reader, 0, Keyset(keyfile))
            self.assertFalse(native.plaintext)
            fs = native.sections[0].filesystem()
            self.assertEqual(fs.children()[0]["name"], "main")
            self.assertEqual(native.sections[0].read(fs.file("main").offset, 23),
                             b"Test executable payload")

    def test_ticket_revision_mismatch_requires_valid_filesystem_header(self):
        """A fake/common ticket's revision must not silently override a valid NCA key."""
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            rights = bytes.fromhex("0102030405060708090a0b0c0d0e0f08")
            header_key = bytes(range(32))
            actual_content_key = bytes(range(0x40, 0x50))
            # Header generation 8 means master-key revision 7. A ticket with a
            # revision field of 0 would previously always pick titlekek_00.
            encrypted_nca = plain_nca(
                [("pfs", pfs0_files([("main", b"validated-content")]))],
                encrypted=True, headerkey=header_key,
                areakey=bytes(range(0x20, 0x30)),
                contentkey=actual_content_key,
                rights_id=rights, key_generation=8,
            )
            real_kek = bytes(range(0x60, 0x70))
            wrong_kek = bytes(range(0x70, 0x80))
            cipher = Cipher(algorithms.AES(real_kek), modes.ECB()).encryptor()
            encrypted_title_key = (
                cipher.update(actual_content_key) + cipher.finalize()
            )
            ticket = bytearray(0x400)
            # Common ticket, signature type 0x010004, little-endian producer.
            ticket[:4] = (0x010004).to_bytes(4, "little")
            body = 0x140
            ticket[body + 0x40:body + 0x50] = encrypted_title_key
            ticket[body + 0x145] = 0
            ticket[body + 0x160:body + 0x170] = rights
            nsp = root / "revision-mismatch.nsp"
            package(nsp, [("program.nca", encrypted_nca),
                          ("content.tik", bytes(ticket))])
            keys_path = root / "fixture.keys"
            keys_path.write_text(
                "nca_header_key = " + header_key.hex() + "\n" +
                "ticket_commonkey_00 = " + wrong_kek.hex() + "\n" +
                "ticket_commonkey_07 = " + real_kek.hex() + "\n"
            )
            native = NativeNCA(NSPAnalyzer(nsp), 0, Keyset(keys_path))
            self.assertEqual(native.content_key_source, "package-ticket")
            self.assertEqual(native.ticket_master_key_revision, 0)
            self.assertEqual(native.nca_master_key_revision, 7)
            self.assertEqual(native.content_key_revision, 7)
            self.assertEqual(native.content_key_validation,
                             "verified-by-filesystem-header")
            self.assertEqual(len(native.content_key_revision_candidates), 2)
            fs = native.sections[0].filesystem()
            info = fs.file("main")
            self.assertEqual(native.sections[0].read(info.offset, info.size),
                             b"validated-content")
            # Correctly mark a ticket as unverified if no candidate passes.
            keys_path.write_text(
                "nca_header_key = " + header_key.hex() + "\n" +
                "ticket_commonkey_00 = " + wrong_kek.hex() + "\n"
            )
            bad = NativeNCA(NSPAnalyzer(nsp), 0, Keyset(keys_path))
            self.assertEqual(bad.content_key_revision, 0)
            self.assertEqual(bad.content_key_validation,
                             "no-valid-filesystem-header")
            self.assertEqual(bad.sections[0].probe_filesystem_header()["status"],
                             "invalid-decoded-partitionfs-header")

    def test_decrypted_header_does_not_mistake_encrypted_sections_for_plaintext(self):
        """A locally decoded NCA header may still have encrypted AES-CTR data."""
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            headerkey = bytes(range(32))
            area_key = bytes(range(0x20, 0x30))
            content_key = bytes(range(0x40, 0x50))
            encrypted = plain_nca(
                [("pfs", pfs0_files([("main", b"encrypted executable")] ))],
                encrypted=True, headerkey=headerkey,
                areakey=area_key, contentkey=content_key)
            restored_header = bytearray()
            for i in range(6):
                sector = encrypted[i * 0x200:(i + 1) * 0x200]
                cipher = Cipher(algorithms.AES(headerkey),
                                modes.XTS(i.to_bytes(16, "big"))).decryptor()
                restored_header.extend(cipher.update(sector) + cipher.finalize())
            game = root / "decoded_header.nsp"
            package(game, [("program.nca", bytes(restored_header) + encrypted[0xC00:])])
            keys = root / "local.keys"
            keys.write_text("nca_key_area_key_application_00 = " + area_key.hex())
            native = NativeNCA(NSPAnalyzer(game), 0, Keyset(keys))
            self.assertTrue(native.plaintext)
            meta = native.sections[0].filesystem().file("main")
            self.assertEqual(native.sections[0].read(meta.offset, meta.size),
                             b"encrypted executable")

    def test_update_patch_sparse_compressed_layers_are_identified_without_blocking_exefs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = bytearray(plain_nca([
                ("pfs", pfs0_files([("main", b"readable exefs")])),
                ("romfs", romfs_nested()),
            ]))
            # Mark the second NCA section as an update BKTR/CTR-Ex patch.
            header = 0x400 + 0x200
            archive[header + 4] = 4
            struct.pack_into("<QQ", archive, header + 0x100, 0x1000, 0x800)
            # Patch recognition must not hide the unaffected ExeFS section.
            game = root / "update.nsp"
            package(game, [("patch.nca", bytes(archive))])
            reader = NativeNCA(NSPAnalyzer(game), 0)
            self.assertEqual(reader.sections[0].filesystem().children()[0]["name"], "main")
            self.assertTrue(reader.sections[1].compatibility()["update_patch"])
            self.assertTrue(reader.sections[1].compatibility()["needs_base_nca"])
            with self.assertRaisesRegex(NativeNCAError, "matching base NCA"):
                reader.sections[1].filesystem()
            # Sparse and compressed tables are recognized separately; neither is
            # decoded as a normal RomFS because that would misrepresent contents.
            archive[header + 4] = 1
            struct.pack_into("<QQ", archive, header + 0x100, 0, 0)
            struct.pack_into("<QQ", archive, header + 0x148, 0x2000, 0x180)
            struct.pack_into("<QQ", archive, header + 0x178, 0x3000, 0x200)
            package(game, [("patch.nca", bytes(archive))])
            newer = NativeNCA(NSPAnalyzer(game), 0)
            info = newer.sections[1].compatibility()
            self.assertTrue(info["sparse"])
            self.assertTrue(info["compressed_storage"])
            with self.assertRaisesRegex(NativeNCAError, "Combined sparse/compressed"):
                newer.sections[1].filesystem()

    def test_plaintext_compressed_nca_bucket_tree_opens_romfs(self):
        # Synthetic compressed NCA using an uncompressed BucketTree entry.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            romfs = romfs_nested()
            table = bytearray(0x8000)
            struct.pack_into("<IIQ", table, 0, 0, 1, len(romfs))
            struct.pack_into("<IIQ", table, 0x4000, 0, 1, len(romfs))
            struct.pack_into("<qqBb2sI", table, 0x4010, 0, 0, 0, 0, b"\\0\\0", 0xffffffff)
            raw = bytearray(plain_nca([("romfs", romfs + bytes((-len(romfs)) % 0x400) + table)]))
            fs = 0x400
            struct.pack_into("<QQ", raw, fs+0x178, 0x400, len(table))
            struct.pack_into("<4sIII", raw, fs+0x188, b"BKTR", 1, 1, 0)
            filename = root / "compressed.nsp"
            package(filename, [("compressed.nca", bytes(raw))])
            section = NativeNCA(NSPAnalyzer(filename), 0).sections[0]
            self.assertTrue(section.compatibility()["compressed_storage"])
            # A file read before opening the tree still uses virtual mapping.
            self.assertEqual(section.read(0, 4), romfs[:4])
            files = section.filesystem()
            entries = files.children_page()["entries"]
            self.assertEqual(entries[0]["name"], "bin")
            self.assertEqual(section.read(0, 4), romfs[:4])

    def test_compressed_partitionfs_can_exceed_physical_nca_section_size(self):
        # A tiny LZ4 block represents a much larger virtual filesystem.
        # File bounds must be checked against the decompressed logical size.
        try:
            import lz4.block
        except ImportError:
            self.skipTest("lz4 Python dependency is not available")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            virtual = pfs0_files([("large.bin", b"A" * 100_000)])
            packed = lz4.block.compress(virtual, store_size=False)
            self.assertLess(len(packed), 0x400)
            table = bytearray(0x8000)
            struct.pack_into("<IIQ", table, 0, 0, 1, len(virtual))
            struct.pack_into("<IIQ", table, 0x4000, 0, 1, len(virtual))
            struct.pack_into("<qqBb2sI", table, 0x4010,
                             0, 0, 3, 0, bytes(2), len(packed))
            raw = bytearray(plain_nca([("pfs", packed.ljust(0x400, bytes(1)) + table)]))
            fs_header = 0x400
            struct.pack_into("<QQ", raw, fs_header + 0x178, 0x400, len(table))
            struct.pack_into("<4sIII", raw, fs_header + 0x188, b"BKTR", 1, 1, 0)
            archive = root / "compressed-large.nsp"
            package(archive, [("compressed-large.nca", bytes(raw))])
            section = NativeNCA(NSPAnalyzer(archive), 0).sections[0]
            fs = section.filesystem()
            self.assertGreater(section.logical_size, section.size)
            file_info = fs.file("large.bin")
            self.assertEqual(file_info.size, 100_000)
            self.assertEqual(section.read(file_info.offset + 99_990, 10), b"A" * 10)

    def test_plaintext_bktr_patch_reads_matching_base_nca_overlay(self):
        """A linked original NCA plus patch ranges produces readable RomFS."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            romfs = romfs_nested()
            logical_end = len(romfs)
            original_file = root / "base.nsp"
            package(original_file, [("original.nca", plain_nca([("romfs", romfs)]))])

            table = bytearray(0x8000)
            struct.pack_into("<IIQ", table, 0, 0, 1, logical_end)
            struct.pack_into("<IIQ", table, 0x4000, 0, 2, logical_end)
            struct.pack_into("<QQI", table, 0x4010, 0, 0, 0)
            struct.pack_into("<QQI", table, 0x4010 + 20,
                             logical_end - 2, logical_end, 1)
            patch_payload = bytes(logical_end) + b"OK" + bytes(table)
            patched = bytearray(plain_nca([("romfs", patch_payload)]))
            fs_header = 0x400
            struct.pack_into("<QQ", patched, fs_header + 0x100,
                             logical_end + 2, len(table))
            struct.pack_into("<4sIII", patched, fs_header + 0x110,
                             b"BKTR", 1, 2, 0)
            update_file = root / "update.nsp"
            package(update_file, [("update.nca", bytes(patched))])

            original = NativeNCA(NSPAnalyzer(original_file), 0)
            updated = NativeNCA(NSPAnalyzer(update_file), 0)
            with self.assertRaisesRegex(NativeNCAError, "matching base NCA"):
                updated.sections[0].filesystem()
            self.assertEqual(updated.attach_base(original), 1)
            section = updated.sections[0]
            filesystem = section.filesystem()
            self.assertEqual(section.read(logical_end - 2, 2), b"OK")
            self.assertEqual(filesystem.children_page()["entries"][0]["name"], "bin")
            filesystem.children_page("bin")
            filesystem.children_page("bin/archive")
            filesystem.children_page("bin/archive/pokemon")
            file_info = filesystem.file("bin/archive/pokemon/pm0025_00_00.gfpak")
            self.assertEqual(section.read(file_info.offset + file_info.size - 2, 2), b"OK")
            self.assertEqual(original.sections[0].read(logical_end - 2, 2), romfs[-2:])

            # The desktop file explorer resolves the same overlay through an
            # explicit base-file selection, without modifying either archive.
            base_file = root / "original.nca"
            base_file.write_bytes(plain_nca([("romfs", romfs)]))
            browser = AssetBrowser(nca_workspace=root / "cache")
            browse_root = browser.open(update_file)
            update_node = browser.children(browse_root["id"])["entries"][0]
            linked = browser.attach_base_nca(update_node["id"], base_file)
            self.assertEqual(linked["matching_sections"], 1)
            section_node = browser.children(update_node["id"])["entries"][0]
            self.assertEqual(section_node["name"], "Section 0")
            self.assertEqual(browser.children(section_node["id"])["entries"][0]["name"], "bin")

    def test_plaintext_sparse_nca_maps_data_and_zero_filled_holes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            romfs = romfs_nested()
            table = bytearray(0x8000)
            struct.pack_into("<IIQ", table, 0, 0, 1, len(romfs)+64)
            struct.pack_into("<IIQ", table, 0x4000, 0, 2, len(romfs)+64)
            struct.pack_into("<QQI", table, 0x4010, 0, 0, 0)
            struct.pack_into("<QQI", table, 0x4010+20, len(romfs), 0, 1)
            raw = bytearray(plain_nca([("romfs", romfs)]))
            fs = 0x400
            physical = len(raw)
            raw.extend(table)
            struct.pack_into("<QQ", raw, fs+0x148, 0, len(table))
            struct.pack_into("<4sIII", raw, fs+0x158, b"BKTR", 1, 2, 0)
            struct.pack_into("<Q", raw, fs+0x168, physical)
            filename = root / "sparse.nsp"
            package(filename, [("sparse.nca", bytes(raw))])
            section = NativeNCA(NSPAnalyzer(filename), 0).sections[0]
            self.assertTrue(section.compatibility()["sparse"])
            self.assertEqual(section.read(len(romfs), 64), bytes(64))
            self.assertEqual(section.filesystem().children_page()["entries"][0]["name"], "bin")
            self.assertEqual(section.read(len(romfs)-8, 16), romfs[-8:] + bytes(8))
            self.assertEqual(section.read(len(romfs), 64), bytes(64))

    def test_locked_nca_has_help_and_no_fabricated_sections(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            nsp = root / "locked.nsp"
            package(nsp, [("program.nca", b"not actually an NCA")])
            browser = AssetBrowser(nca_workspace=root / "cache")
            main = browser.open(nsp)
            entry = browser.children(main["id"])["entries"][0]
            result = browser.children(entry["id"])
            self.assertTrue(result["entries"][0]["name"].startswith("Sections unavailable"))
            self.assertNotIn("Section 1", str(result["entries"]))
            self.assertIn("incomplete", result["note"])
            details = browser.item_details(result["entries"][0]["id"])
            self.assertTrue(any("incomplete" in note for note in details["notes"]))

    def test_invalid_keys_and_out_of_range_reads(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            keyfile = root / "keys.txt"
            keyfile.write_text("nca_header_key=XYZ\n")
            self.assertFalse(Keyset(keyfile).has_header)
            package(root / "test.nsp", [("a.nca", plain_nca([
                ("pfs", pfs0_files([("main", b"hello")]))
            ]))])
            native = NativeNCA(NSPAnalyzer(root / "test.nsp"), 0)
            with self.assertRaisesRegex(NativeNCAError, "outside"):
                native.sections[0].read(999999, 100)


if __name__ == "__main__":
    unittest.main()
