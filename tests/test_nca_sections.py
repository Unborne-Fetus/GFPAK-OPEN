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
from gfpak_open.nca_native import Keyset, NativeNCA, NativeNCAError
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


def romfs_nested():
    """Construct a real RomFS table with bin/archive/pokemon nested directories."""
    names = ("", "bin", "archive", "pokemon")
    positions = []
    directory = bytearray()
    for name in names:
        positions.append(len(directory))
        label = name.encode()
        directory.extend(b"\0" * (24 + (len(label) + 3 & ~3)))
    filename = b"pm0025_00_00.gfpak"
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
              areakey=None, contentkey=None):
    header = bytearray(0xC00)
    header[0x200:0x204] = b"NCA3"
    if encrypted:
        header[0x206] = 1
        header[0x220] = 1
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
            struct.pack_into("<I", header, fs+0x14, 1)
            struct.pack_into("<Q", header, fs+0x18, 0)
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
            self.assertEqual(result["entries"][0]["name"], "Sections unavailable")
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
